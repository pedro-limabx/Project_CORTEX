// V20: read-only, on-demand, conservative merging of CORTEX + Google agenda.
// Nothing is copied to either source; remote event text is data, never commands.
import {readAgenda,type AgendaPeriod,type AgendaSnapshot} from "../reminders/agenda.js";
import type {ReminderRepository} from "../reminders/store.js";
import type {PostgresRecurrenceRepository} from "../reminders/recurrence-store.js";
import type {GoogleCalendarReadOnly,GoogleEventsSnapshot,GoogleEvent} from "./google-calendar.js";

export type UnifiedQuestion=AgendaPeriod|"unsupported"|null;
export type GoogleAvailability="not-configured"|"not-connected"|"connected"|"reconnect"|"unavailable";
export type UnifiedItem={
  id:string; title:string; start:string; allDay:boolean;
  sources:Array<"cortex"|"google">;
  cortexKind?:"saved"|"recurrence-preview";
  cortexStatus?:"PENDING"|"DUE"|"PROJECTED";
};
export type UnifiedAgenda={
  period:AgendaPeriod;from:string;until:string;timeZone:"America/Sao_Paulo";
  readOnly:true;google:GoogleAvailability;items:UnifiedItem[];
  totals:{cortex:number;google:number;matched:number;displayed:number};
  truncated:boolean;warnings:string[];
};

const lead=/^(?:(?:neuron)[,!]?\s*)?(?:minha agenda (?:unificada|completa|integrada)|(?:me mostre|mostre|consulte|consultar|ver) (?:a )?(?:minha )?agenda (?:unificada|completa|integrada)|(?:me mostre|mostre) tudo (?:o )?que tenho (?:agendado|na agenda)|o que tenho na minha agenda (?:unificada|completa|integrada)|(?:junte|reuna|reuna todos|combine) (?:meus )?lembretes (?:com|e) (?:os )?eventos (?:do )?google(?: agenda)?|(?:todos os meus|quais sao todos os meus) compromissos)\b/u;
export function interpretUnifiedAgendaQuestion(value:string):UnifiedQuestion {
  const text=value.normalize("NFD").replace(/[\u0300-\u036f]/gu,"")
    .trim().toLowerCase().replace(/[?.!]+$/u,"").trim();
  const match=lead.exec(text);
  if(!match)return null;
  const tail=text.slice(match[0].length).trim()
    .replace(/^(?:(?:de|da|do|para|na|no|nos|nesta|desta)\s+)/u,"");
  if(!tail)return "today";
  if(tail==="hoje")return "today";
  if(tail==="amanha")return "tomorrow";
  if(["semana","esta semana","proximos 7 dias","os proximos 7 dias"].includes(tail))
    return "week";
  return "unsupported";
}

function key(title:string,start:string):string {
  return title.normalize("NFKC").trim().replace(/\s+/gu," ").toLocaleLowerCase("pt-BR")
    +"\0"+start;
}
function dateOf(event:GoogleEvent):string|null {
  if(event.allDay){
    return /^\d{4}-\d{2}-\d{2}$/u.test(event.start)?event.start:null;
  }
  const time=Date.parse(event.start);
  return Number.isFinite(time)?new Date(time).toISOString():null;
}
function localDate(item:UnifiedItem):string {
  if(item.allDay)return item.start;
  const date=new Date(item.start);
  // Sorting by local civil date first, with all-day entries at the beginning of
  // that day. Time entries are ordered by absolute UTC within the civil day.
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{
    timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"
  }).formatToParts(date).filter(p=>p.type!=="literal").map(p=>[p.type,p.value]));
  return parts.year+"-"+parts.month+"-"+parts.day;
}
function order(a:UnifiedItem,b:UnifiedItem):number {
  const day=localDate(a).localeCompare(localDate(b));
  if(day!==0)return day;
  if(a.allDay!==b.allDay)return a.allDay?-1:1;
  return a.start.localeCompare(b.start)||a.title.localeCompare(b.title)||a.id.localeCompare(b.id);
}
const MAX_DISPLAY=50;

export function mergeUnifiedAgenda(local:AgendaSnapshot,external:GoogleEventsSnapshot|null,
    google:GoogleAvailability):UnifiedAgenda {
  const rows:UnifiedItem[]=local.items.map(item=>({
    id:"cortex:"+item.id,title:item.title,start:item.dueAt,allDay:false,
    sources:["cortex"],cortexKind:item.source,cortexStatus:item.status
  }));
  const matches=new Map<string,UnifiedItem[]>();
  for(const item of rows){
    const id=key(item.title,item.start);
    const group=matches.get(id)??[];
    group.push(item);
    matches.set(id,group);
  }
  let merged=0;
  for(const event of external?.events??[]){
    const date=dateOf(event);
    if(!date)continue;
    // Never collapse all-day events into timestamped reminders. An identical
    // normalized title and exact UTC instant must match, not just proximity.
    const candidate=event.allDay?undefined:matches.get(key(event.title,date))
      ?.find(row=>!row.sources.includes("google"));
    if(candidate){
      candidate.sources.push("google");
      merged++;
    }else{
      rows.push({id:"google:"+event.id,title:event.title,start:date,
        allDay:event.allDay,sources:["google"]});
    }
  }
  rows.sort(order);
  const warnings:string[]=[];
  if(google==="not-configured")warnings.push(
    "Google Agenda não está configurado. Exibindo apenas os dados locais do CORTEX.");
  if(google==="not-connected")warnings.push(
    "Google Agenda ainda não foi autorizado. Exibindo apenas os dados locais.");
  if(google==="reconnect")warnings.push(
    "Autorização do Google expirada ou recusada. Reconecte na aba Google Agenda.");
  if(google==="unavailable")warnings.push(
    "Não foi possível consultar o Google. Os lembretes locais continuam disponíveis.");
  const truncated=local.truncated||Boolean(external?.truncated)||rows.length>MAX_DISPLAY;
  if(truncated)warnings.push(
    "Consulta parcial: algumas entradas podem não aparecer devido aos limites de paginação.");
  return {period:local.period,from:local.from,until:local.until,timeZone:"America/Sao_Paulo",
    readOnly:true,google,items:rows.slice(0,MAX_DISPLAY),
    totals:{cortex:local.items.length,google:external?.events.length??0,
      matched:merged,displayed:Math.min(rows.length,MAX_DISPLAY)},truncated,warnings};
}

type LocalDeps={
  reminders:Pick<ReminderRepository,"listWindow">;
  recurrences:Pick<PostgresRecurrenceRepository,"listActive">;
};
type GoogleDeps=Pick<GoogleCalendarReadOnly,"status"|"listEvents">;
export async function getUnifiedAgenda(
  local:LocalDeps,google:GoogleDeps|undefined,user:string,period:AgendaPeriod,
  now=new Date()
):Promise<UnifiedAgenda>{
  const internal=await readAgenda(local,user,period,now);
  if(!google)return mergeUnifiedAgenda(internal,null,"not-configured");
  try{
    const state=await google.status(user);
    if(!state.connected)return mergeUnifiedAgenda(internal,null,"not-connected");
    const external=await google.listEvents(user,period,now);
    return mergeUnifiedAgenda(internal,external,"connected");
  }catch(error){
    // External failures must never erase successfully loaded local reminders.
    // Avoid returning a Google error containing any OAuth credential or response.
    const authError=error instanceof Error && error.name==="GoogleCalendarAuthError";
    return mergeUnifiedAgenda(internal,null,authError?"reconnect":"unavailable");
  }
}
function humanDate(item:UnifiedItem):string {
  if(item.allDay){
    const match=/^(\d{4})-(\d{2})-(\d{2})$/u.exec(item.start);
    return match?match[3]+"/"+match[2]+" · Dia inteiro":"Dia inteiro";
  }
  const at=new Date(item.start);
  return new Intl.DateTimeFormat("pt-BR",{
    timeZone:"America/Sao_Paulo",day:"2-digit",month:"2-digit",
    hour:"2-digit",minute:"2-digit"
  }).format(at);
}
export function unifiedAgendaAnswer(result:UnifiedAgenda):string {
  const label={today:"hoje",tomorrow:"amanhã",week:"os próximos 7 dias"}[result.period];
  const sourceStatus=result.google==="connected"?"Google consultado":"Google indisponível ou não conectado";
  const header="Agenda unificada para "+label+" (São Paulo). "+
    result.totals.cortex+" entrada(s) do CORTEX, "+result.totals.google+
    " do Google; "+result.totals.matched+" correspondência(s) exata(s). "+sourceStatus+".";
  const items=result.items.slice(0,10).map(item=>
    "• "+humanDate(item)+" — "+item.title.replace(/[\r\n\t]+/gu," ").slice(0,120)+
    " ["+(item.sources.length===2?"CORTEX + Google":
      item.sources[0]==="cortex"
        ?item.cortexKind==="recurrence-preview"?"CORTEX (recorrência prevista)":"CORTEX":
          "Google")+"]");
  return header+(items.length?"\n"+items.join("\n"):"\nNenhum compromisso encontrado nas fontes consultadas.")+
    (result.items.length>10?"\nMostrando os 10 primeiros; veja a inspeção para outros itens.":"")+
    (result.warnings.length?"\n"+result.warnings.join(" "):"");
}
