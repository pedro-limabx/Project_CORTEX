// V18: read-only Google Calendar access via OAuth 2.0 authorization code + PKCE.
// All requests go to fixed Google HTTPS endpoints. Never log codes or tokens.
import crypto from "node:crypto";
import type {Pool} from "pg";
import {agendaWindow,type AgendaPeriod} from "../reminders/agenda.js";

export const GOOGLE_CALENDAR_SCOPE="https://www.googleapis.com/auth/calendar.events.readonly";
const GOOGLE_AUTHORIZE="https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN="https://oauth2.googleapis.com/token";
const GOOGLE_EVENTS="https://www.googleapis.com/calendar/v3/calendars/primary/events";
const OAUTH_TTL_MS=10*60_000;
type Settings={
  clientId:string;clientSecret:string;redirectUri:string;encryptionKey:string;
};
type TokenReply={
  access_token?:unknown;refresh_token?:unknown;expires_in?:unknown;
  scope?:unknown;token_type?:unknown;
};
type TokenRow={access_ciphertext:string;refresh_ciphertext:string;expires_at:Date|string};
type StateRow={user_id:string;verifier_ciphertext:string;expires_at:Date|string};

export class GoogleCalendarConfigError extends Error {}
export class GoogleCalendarAuthError extends Error {}
export class GoogleCalendarRemoteError extends Error {}

export function validateGoogleCalendarSettings(input:Settings):Settings {
  const url=new URL(input.redirectUri);
  const loopback=["localhost","127.0.0.1","[::1]"].includes(url.hostname);
  if((url.protocol!=="https:" && !(url.protocol==="http:"&&loopback))
     ||url.username||url.password||url.hash||url.search
     ||url.pathname!=="/api/integrations/google-calendar/callback"
     ||!/^[0-9a-f]{64}$/i.test(input.encryptionKey)
     ||!input.clientId.trim()||!input.clientSecret.trim()){
    throw new GoogleCalendarConfigError(
      "Google Agenda requer credenciais, chave hexadecimal de 32 bytes e redirect URI HTTPS válido.");
  }
  return input;
}
function digest(value:string):string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
export function pkceChallenge(verifier:string):string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}
function sealed(key:Buffer,user:string,kind:string,value:string):string {
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv("aes-256-gcm",key,iv);
  cipher.setAAD(Buffer.from(user+"\0"+kind));
  const encrypted=Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString("base64url");
}
function unseal(key:Buffer,user:string,kind:string,value:string):string {
  const encoded=Buffer.from(value,"base64url");
  if(encoded.length<29)throw new GoogleCalendarAuthError("Credenciais locais inválidas");
  try{
    const decipher=crypto.createDecipheriv("aes-256-gcm",key,encoded.subarray(0,12));
    decipher.setAAD(Buffer.from(user+"\0"+kind));
    decipher.setAuthTag(encoded.subarray(12,28));
    return Buffer.concat([decipher.update(encoded.subarray(28)),decipher.final()]).toString("utf8");
  }catch{
    throw new GoogleCalendarAuthError("Falha ao recuperar credenciais Google. Reconecte sua conta.");
  }
}
async function googleJson(fetcher:typeof fetch,url:string,init:RequestInit):Promise<unknown> {
  let response:Response;
  try{
    response=await fetcher(url,{...init,redirect:"error",signal:AbortSignal.timeout(12_000)});
  }catch{throw new GoogleCalendarRemoteError("Não foi possível alcançar o Google. Tente novamente.");}
  if(!response.ok){
    if(response.status===401||response.status===400)
      throw new GoogleCalendarAuthError("O Google recusou a credencial. Reconecte sua conta.");
    throw new GoogleCalendarRemoteError("Google Agenda indisponível no momento.");
  }
  try{return await response.json();}catch{
    throw new GoogleCalendarRemoteError("Resposta inválida do Google Agenda.");
  }
}
function tokenForm(data:Record<string,string>) {
  return new URLSearchParams(data).toString();
}
function parsedToken(value:unknown,requireRefresh:boolean) {
  if(!value||typeof value!=="object")throw new GoogleCalendarAuthError("Resposta de autorização inválida");
  const token=value as TokenReply;
  if(typeof token.access_token!=="string"||!token.access_token
      ||(requireRefresh&&(typeof token.refresh_token!=="string"||!token.refresh_token))
      ||typeof token.expires_in!=="number"||!Number.isFinite(token.expires_in)
      ||token.expires_in<60
      ||(typeof token.scope==="string"&&!token.scope.split(" ").includes(GOOGLE_CALENDAR_SCOPE))
      ||(token.token_type!==undefined&&String(token.token_type).toLowerCase()!=="bearer")){
    throw new GoogleCalendarAuthError("O Google não concedeu acesso somente leitura com validade adequada.");
  }
  return {access:token.access_token,refresh:typeof token.refresh_token==="string"?token.refresh_token:null,
    expiry:new Date(Date.now()+Math.floor(token.expires_in)*1000).toISOString()};
}
export type GoogleEvent={id:string;title:string;start:string;end:string|null;allDay:boolean};
export type GoogleEventsSnapshot={
  period:AgendaPeriod;from:string;until:string;timeZone:"America/Sao_Paulo";
  events:GoogleEvent[];truncated:boolean;source:"google-calendar";readOnly:true;
};
export class GoogleCalendarReadOnly {
  private readonly key:Buffer;
  private readonly settings:Settings;
  constructor(private readonly pool:Pool,settings:Settings,
    private readonly fetcher:typeof fetch=fetch) {
    this.settings=validateGoogleCalendarSettings(settings);
    this.key=Buffer.from(this.settings.encryptionKey,"hex");
  }
  async initialize():Promise<void> {
    await this.pool.query([
      "CREATE TABLE IF NOT EXISTS cortex_google_calendar_oauth_states (",
      "state_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,",
      "verifier_ciphertext TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL)"
    ].join(" "));
    await this.pool.query([
      "CREATE TABLE IF NOT EXISTS cortex_google_calendar_credentials (",
      "user_id TEXT PRIMARY KEY,access_ciphertext TEXT NOT NULL,",
      "refresh_ciphertext TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL,",
      "connected_at TIMESTAMPTZ NOT NULL)"
    ].join(" "));
    await this.pool.query([
      "CREATE INDEX IF NOT EXISTS cortex_google_calendar_states_expiry",
      "ON cortex_google_calendar_oauth_states (expires_at)"
    ].join(" "));
  }
  async status(user:string):Promise<{configured:true;connected:boolean;readOnly:true}> {
    const result=await this.pool.query(
      "SELECT 1 FROM cortex_google_calendar_credentials WHERE user_id=$1 LIMIT 1",[user]);
    return {configured:true,connected:result.rowCount===1,readOnly:true};
  }
  async begin(user:string):Promise<{authorizationUrl:string;expiresInSeconds:number}> {
    const state=crypto.randomBytes(32).toString("base64url");
    const verifier=crypto.randomBytes(48).toString("base64url");
    // A fresh attempt invalidates any pending previous state for this user.
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      await client.query("DELETE FROM cortex_google_calendar_oauth_states WHERE user_id=$1 OR expires_at<NOW()",[user]);
      await client.query([
        "INSERT INTO cortex_google_calendar_oauth_states",
        "(state_hash,user_id,verifier_ciphertext,expires_at)",
        "VALUES ($1,$2,$3,NOW()+INTERVAL '10 minutes')"
      ].join(" "),[digest(state),user,sealed(this.key,user,"verifier",verifier)]);
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error;}
    finally{client.release();}
    const uri=new URL(GOOGLE_AUTHORIZE);
    uri.searchParams.set("client_id",this.settings.clientId);
    uri.searchParams.set("redirect_uri",this.settings.redirectUri);
    uri.searchParams.set("response_type","code");
    uri.searchParams.set("scope",GOOGLE_CALENDAR_SCOPE);
    uri.searchParams.set("state",state);
    uri.searchParams.set("access_type","offline");
    uri.searchParams.set("prompt","consent");
    uri.searchParams.set("code_challenge",pkceChallenge(verifier));
    uri.searchParams.set("code_challenge_method","S256");
    return {authorizationUrl:uri.toString(),expiresInSeconds:OAUTH_TTL_MS/1000};
  }
  async finish(state:string,code:string):Promise<void> {
    if(!/^[A-Za-z0-9_-]{43}$/.test(state)||code.length<1||code.length>2048)
      throw new GoogleCalendarAuthError("Autorização inválida ou expirada");
    // DELETE RETURNING enforces one-time state consumption even across replicas.
    const result=await this.pool.query<StateRow>([
      "DELETE FROM cortex_google_calendar_oauth_states WHERE state_hash=$1",
      "RETURNING user_id,verifier_ciphertext,expires_at"
    ].join(" "),[digest(state)]);
    const row=result.rows[0];
    if(!row||new Date(row.expires_at).getTime()<Date.now())
      throw new GoogleCalendarAuthError("Autorização inválida ou expirada");
    const verifier=unseal(this.key,row.user_id,"verifier",row.verifier_ciphertext);
    const response=await googleJson(this.fetcher,GOOGLE_TOKEN,{
      method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body:tokenForm({client_id:this.settings.clientId,
        client_secret:this.settings.clientSecret,grant_type:"authorization_code",
        code,code_verifier:verifier,redirect_uri:this.settings.redirectUri})
    });
    const token=parsedToken(response,true);
    await this.pool.query([
      "INSERT INTO cortex_google_calendar_credentials",
      "(user_id,access_ciphertext,refresh_ciphertext,expires_at,connected_at)",
      "VALUES ($1,$2,$3,$4::timestamptz,NOW())",
      "ON CONFLICT (user_id) DO UPDATE SET",
      "access_ciphertext=EXCLUDED.access_ciphertext,",
      "refresh_ciphertext=EXCLUDED.refresh_ciphertext,",
      "expires_at=EXCLUDED.expires_at,connected_at=NOW()"
    ].join(" "),[row.user_id,sealed(this.key,row.user_id,"access",token.access),
      sealed(this.key,row.user_id,"refresh",token.refresh!),token.expiry]);
  }
  async disconnect(user:string):Promise<boolean> {
    const result=await this.pool.query(
      "DELETE FROM cortex_google_calendar_credentials WHERE user_id=$1",[user]);
    await this.pool.query("DELETE FROM cortex_google_calendar_oauth_states WHERE user_id=$1",[user]);
    return (result.rowCount??0)>0;
  }
  private async accessToken(user:string):Promise<string> {
    const stored=await this.pool.query<TokenRow>([
      "SELECT access_ciphertext,refresh_ciphertext,expires_at",
      "FROM cortex_google_calendar_credentials WHERE user_id=$1"
    ].join(" "),[user]);
    const row=stored.rows[0];
    if(!row)throw new GoogleCalendarAuthError("Conecte sua conta Google Agenda primeiro.");
    if(new Date(row.expires_at).getTime()>Date.now()+90_000)
      return unseal(this.key,user,"access",row.access_ciphertext);
    const refresh=unseal(this.key,user,"refresh",row.refresh_ciphertext);
    const answer=await googleJson(this.fetcher,GOOGLE_TOKEN,{
      method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body:tokenForm({client_id:this.settings.clientId,
        client_secret:this.settings.clientSecret,grant_type:"refresh_token",
        refresh_token:refresh})
    });
    const token=parsedToken(answer,false);
    await this.pool.query([
      "UPDATE cortex_google_calendar_credentials SET",
      "access_ciphertext=$2,expires_at=$3::timestamptz WHERE user_id=$1"
    ].join(" "),[user,sealed(this.key,user,"access",token.access),token.expiry]);
    return token.access;
  }
  async listEvents(user:string,period:AgendaPeriod,now=new Date()):Promise<GoogleEventsSnapshot>{
    const {from,until}=agendaWindow(period,now);
    const access=await this.accessToken(user);
    const uri=new URL(GOOGLE_EVENTS);
    uri.searchParams.set("timeMin",from);
    uri.searchParams.set("timeMax",until);
    uri.searchParams.set("singleEvents","true");
    uri.searchParams.set("orderBy","startTime");
    uri.searchParams.set("maxResults","50");
    uri.searchParams.set("fields","items(id,summary,start,end),nextPageToken");
    const raw=await googleJson(this.fetcher,uri.toString(),{
      headers:{Authorization:"Bearer "+access,Accept:"application/json"},method:"GET"
    }) as {items?:unknown;nextPageToken?:unknown};
    if(!raw||!Array.isArray(raw.items))throw new GoogleCalendarRemoteError("Lista de eventos inválida");
    const events:GoogleEvent[]=[];
    for(const item of raw.items.slice(0,50)){
      if(!item||typeof item!=="object")continue;
      const event=item as Record<string,unknown>;
      const start=event.start as {dateTime?:unknown;date?:unknown}|undefined;
      const end=event.end as {dateTime?:unknown;date?:unknown}|undefined;
      const when=start?.dateTime??start?.date;
      if(typeof event.id!=="string"||typeof when!=="string"||!when)continue;
      events.push({id:event.id,title:typeof event.summary==="string"?
        event.summary.slice(0,200):"(Sem título)",
        start:when,end:typeof(end?.dateTime??end?.date)==="string"?
          (end?.dateTime??end?.date) as string:null,
        allDay:typeof start?.date==="string"});
    }
    return {period,from,until,timeZone:"America/Sao_Paulo",
      events,truncated:typeof raw.nextPageToken==="string",source:"google-calendar",readOnly:true};
  }
}
