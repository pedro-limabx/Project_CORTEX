import {describe,expect,it,afterAll,vi} from "vitest";
import {Pool} from "pg";
import {randomUUID} from "node:crypto";
import {
  GoogleCalendarReadOnly,GoogleCalendarAuthError,GOOGLE_CALENDAR_SCOPE
} from "../src/integrations/google-calendar.js";

const available=Boolean(process.env.DATABASE_URL);
const suite=available?describe:describe.skip;
const pool=available?new Pool({connectionString:process.env.DATABASE_URL}):undefined;
afterAll(async()=>{await pool?.end();});
const options={
  clientId:"client-id.apps.googleusercontent.com",
  clientSecret:"client-secret-not-public",
  redirectUri:"https://cortex.example.org/api/integrations/google-calendar/callback",
  encryptionKey:"b".repeat(64)
};
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{
  status,headers:{"Content-Type":"application/json"}
});

suite("V18 OAuth lifecycle with PostgreSQL and mocked Google",()=>{
  it("uses one-time PKCE state, seals tokens, scopes by owner and never mutates events",async()=>{
    if(!pool)throw new Error("PostgreSQL is required");
    const user=randomUUID(),other=randomUUID();
    const requests:{url:string;headers:Headers;body:string;method:string}[]=[];
    const fake=vi.fn(async (input:string|URL,init:RequestInit={})=>{
      const url=String(input),headers=new Headers(init.headers),body=String(init.body??"");
      requests.push({url,headers,body,method:String(init.method)});
      if(url==="https://oauth2.googleapis.com/token"){
        const grant=new URLSearchParams(body).get("grant_type");
        if(grant==="authorization_code"){
          expect(new URLSearchParams(body).get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{40,128}$/);
          return response({access_token:"private-access-key",refresh_token:"private-refresh-key",
            expires_in:3600,scope:GOOGLE_CALENDAR_SCOPE,token_type:"Bearer"});
        }
        if(grant==="refresh_token"){
          expect(new URLSearchParams(body).get("refresh_token")).toBe("private-refresh-key");
          return response({access_token:"refreshed-token",expires_in:3600,
            scope:GOOGLE_CALENDAR_SCOPE,token_type:"Bearer"});
        }
      }
      if(url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events?")){
        expect(headers.get("authorization")).toMatch(/^Bearer (private-access-key|refreshed-token)$/);
        const uri=new URL(url);
        expect(uri.searchParams.get("singleEvents")).toBe("true");
        expect(uri.searchParams.get("timeMin")).toBe("2026-10-09T03:00:00.000Z");
        expect(uri.searchParams.get("timeMax")).toBe("2026-10-10T03:00:00.000Z");
        return response({items:[
          {id:"a",summary:"Consulta médica",start:{dateTime:"2026-10-09T15:00:00-03:00"},
            end:{dateTime:"2026-10-09T16:00:00-03:00"}},
          {id:"b",summary:"Feriado",start:{date:"2026-10-09"},end:{date:"2026-10-10"}}
        ],nextPageToken:"another-page"});
      }
      throw new Error("Unexpected remote request: "+url);
    }) as unknown as typeof fetch;
    const service=new GoogleCalendarReadOnly(pool,options,fake);
    await service.initialize();
    expect(await service.status(user)).toEqual({configured:true,connected:false,readOnly:true});
    const begin=await service.begin(user),uri=new URL(begin.authorizationUrl);
    expect(uri.host).toBe("accounts.google.com");
    expect(uri.searchParams.get("scope")).toBe(GOOGLE_CALENDAR_SCOPE);
    expect(uri.searchParams.get("response_type")).toBe("code");
    expect(uri.searchParams.get("code_challenge_method")).toBe("S256");
    expect(uri.searchParams.get("access_type")).toBe("offline");
    expect(uri.searchParams.get("redirect_uri")).toBe(options.redirectUri);
    const state=uri.searchParams.get("state")!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const found=await pool.query("SELECT * FROM cortex_google_calendar_oauth_states WHERE user_id=$1",[user]);
    expect(found.rows).toHaveLength(1);
    expect(JSON.stringify(found.rows)).not.toContain(state);
    expect(JSON.stringify(found.rows)).not.toContain("client-secret");
    await service.finish(state,"test-auth-code");
    expect(requests[0]?.url).toBe("https://oauth2.googleapis.com/token");
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.body).toContain("client_secret=client-secret-not-public");
    const stored=await pool.query(
      "SELECT * FROM cortex_google_calendar_credentials WHERE user_id=$1",[user]);
    expect(stored.rows).toHaveLength(1);
    expect(JSON.stringify(stored.rows)).not.toContain("private-access-key");
    expect(JSON.stringify(stored.rows)).not.toContain("private-refresh-key");
    expect(await service.status(user)).toMatchObject({connected:true});
    expect(await service.status(other)).toMatchObject({connected:false});
    await expect(service.finish(state,"replayed-auth-code")).rejects.toBeInstanceOf(GoogleCalendarAuthError);
    await expect(service.listEvents(other,"today")).rejects.toBeInstanceOf(GoogleCalendarAuthError);
    const now=new Date("2026-10-09T16:00:00.000Z");
    const snapshot=await service.listEvents(user,"today",now);
    expect(snapshot).toMatchObject({readOnly:true,source:"google-calendar",
      truncated:true,events:[{id:"a",title:"Consulta médica",allDay:false},
        {id:"b",title:"Feriado",allDay:true}]});
    const eventsReq=requests.find(x=>x.url.includes("/calendar/v3/"));
    expect(eventsReq?.method).toBe("GET");
    expect(eventsReq?.body).toBe("");
    await pool.query(
      "UPDATE cortex_google_calendar_credentials SET expires_at=NOW()-INTERVAL '1 minute' WHERE user_id=$1",
      [user]);
    const again=await service.listEvents(user,"today",now);
    expect(again.events).toHaveLength(2);
    expect(requests.filter(x=>x.url==="https://oauth2.googleapis.com/token")).toHaveLength(2);
    expect(await service.disconnect(user)).toBe(true);
    expect(await service.status(user)).toMatchObject({connected:false});
    await expect(service.listEvents(user,"today",now)).rejects.toBeInstanceOf(GoogleCalendarAuthError);
    expect(await service.disconnect(user)).toBe(false);
  });
  it("prevents invalid OAuth scope and state replay even if token endpoint responds",async()=>{
    if(!pool)throw new Error("PostgreSQL is required");
    const user=randomUUID();
    const fake=vi.fn(async()=>response({
      access_token:"malicious-access",refresh_token:"malicious-refresh",
      expires_in:3600,scope:"https://www.googleapis.com/auth/calendar"
    })) as unknown as typeof fetch;
    const service=new GoogleCalendarReadOnly(pool,options,fake);
    await service.initialize();
    const state=new URL((await service.begin(user)).authorizationUrl).searchParams.get("state")!;
    await expect(service.finish(state,"code")).rejects.toBeInstanceOf(GoogleCalendarAuthError);
    expect((await service.status(user)).connected).toBe(false);
    await expect(service.finish(state,"code")).rejects.toBeInstanceOf(GoogleCalendarAuthError);
  });
});
