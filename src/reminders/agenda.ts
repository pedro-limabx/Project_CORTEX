// V16: deterministic personal agenda lookup, without writes or LLM inference.
import {RECURRENCE_ZONE, nextRecurrenceAfter} from "./recurrence.js";
import type {ReminderRepository} from "./store.js";
import type {PostgresRecurrenceRepository} from "./recurrence-store.js";

export type AgendaPeriod="today"|"tomorrow"|"week";
export type AgendaItem={
  id:string;title:string;dueAt:string;
  source:"saved"|"recurrence-preview";status:"PENDING"|"DUE"|"PROJECTED";
};
export type AgendaSnapshot={
  period:AgendaPeriod;from:string;until:string;timeZone:typeof RECURRENCE_ZONE;
  generatedAt:string;readOnly:true;items:AgendaItem[];
  counts:{saved:number;projected:number};truncated:boolean;
};

const formatter=new Intl.DateTimeFormat("en-GB",{
  timeZone:RECURRENCE_ZONE,year:"numeric",month:"2-digit",day:"2-digit",
  hour:"2-digit",minute:"2-digit",hourCycle:"h23"
});
function civilParts(at:Date) {
  const values=Object.fromEntries(formatter.formatToParts(at)
    .filter(p=>p.type!=="literal").map(p=>[p.type,Number(p.value)]));
  return {year:values.year!,month:values.month!,day:values.day!,
    hour:values.hour!,minute:values.minute!};
}
function localMidnight(day:Date):Date {
  const civil=day.getUTCFullYear(),month=day.getUTCMonth()+1,date=day.getUTCDate();
  const wall=Date.UTC(civil,month-1,date);
  let utc=wall;
  for(let i=0;i<4;i++){
    const local=civilParts(new Date(utc));
    const seen=Date.UTC(local.year,local.month-1,local.day,local.hour,local.minute);
    if(seen===wall)break;
    utc+=wall-seen;
  }
  const candidate=new Date(utc),check=civilParts(candidate);
  if(check.year!==civil||check.month!==month||check.day!==date
      ||check.hour!==0||check.minute!==0) {
    throw new Error("Não foi possível determinar o início do dia em São Paulo");
  }
  return candidate;
}
export function agendaWindow(period:AgendaPeriod,now=new Date()) {
  if(!["today","tomorrow","week"].includes(period)||!Number.isFinite(now.getTime()))
    throw new Error("Período inválido");
  const local=civilParts(now);
  const day=Date.UTC(local.year,local.month-1,local.day);
  const offset=period==="tomorrow"?1:0;
  const duration=period==="week"?7:1;
  return {
    from:localMidnight(new Date(day+offset*86_400_000)).toISOString(),
    until:localMidnight(new Date(day+(offset+duration)*86_400_000)).toISOString()
  };
}

export function interpretAgendaQuestion(message:string):AgendaPeriod|null {
  const text=message.normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .trim().toLowerCase().replace(/[?.!]+$/g,"").trim();
  const prefix=/^(?:quais(?: sao)?(?: os)? meus (?:lembretes|compromissos)|quais(?: sao)? os meus (?:lembretes|compromissos)|o que (?:tenho(?: agendado)?|esta agendado)|(?:me mostre|mostre|mostrar|consulte|consultar|ver) (?:a )?(?:minha agenda|meus lembretes|meus compromissos)|(?:qual (?:e )?)?minha agenda)\b/u;
  const hit=prefix.exec(text);
  if(!hit)return null;
  const tail=text.slice(hit[0].length).trim();
  if(!tail)return "today";
  if(/^(?:de|para|da|do|na|no|nos|nesta|esta|desta)?\s*amanha$/u.test(tail))return "tomorrow";
  if(/^(?:de|para|da|do|na|no|nos|nesta|esta|desta)?\s*hoje$/u.test(tail))return "today";
  if(/^(?:(?:de|para|da|do|na|no|nos|nesta|esta|desta)\s+)?(?:semana|esta semana|proxima semana|(?:os )?proximos 7 dias)$/u.test(tail))return "week";
  return null;
}

type AgendaDeps={
  reminders:Pick<ReminderRepository,"listWindow">;
  recurrences:Pick<PostgresRecurrenceRepository,"listActive">;
};
const SCAN_LIMIT=100,DISPLAY_LIMIT=30;
export async function readAgenda(deps:AgendaDeps,user:string,period:AgendaPeriod,
    now=new Date()):Promise<AgendaSnapshot>{
  const {from,until}=agendaWindow(period,now);
  const [saved,active]=await Promise.all([
    deps.reminders.listWindow(user,from,until,SCAN_LIMIT+1),
    deps.recurrences.listActive(user,SCAN_LIMIT+1)
  ]);
  const combined:AgendaItem[]=saved.slice(0,SCAN_LIMIT).map(item=>({
    id:item.id,title:item.title,dueAt:item.dueAt,source:"saved",
    status:item.status==="DUE"?"DUE":"PENDING"
  }));
  const fromMs=Date.parse(from),untilMs=Date.parse(until);
  for(const schedule of active.slice(0,SCAN_LIMIT)){
    let candidate=new Date(schedule.nextDueAt);
    if(candidate.getTime()<fromMs){
      candidate=nextRecurrenceAfter(new Date(fromMs-1),schedule.frequency,
        schedule.localTime,schedule.weekday);
    }
    // A daily schedule contributes up to 7 *projected* slots in this window.
    for(let slot=0;slot<8 && candidate.getTime()<untilMs;slot++){
      if(candidate.getTime()>=fromMs){
        combined.push({id:schedule.id+":"+candidate.toISOString(),title:schedule.title,
          dueAt:candidate.toISOString(),source:"recurrence-preview",status:"PROJECTED"});
      }
      candidate=nextRecurrenceAfter(candidate,schedule.frequency,
        schedule.localTime,schedule.weekday);
    }
  }
  combined.sort((a,b)=>a.dueAt.localeCompare(b.dueAt)||a.id.localeCompare(b.id));
  const items=combined.slice(0,DISPLAY_LIMIT);
  return {period,from,until,timeZone:RECURRENCE_ZONE,
    generatedAt:now.toISOString(),readOnly:true,items,
    counts:{saved:items.filter(x=>x.source==="saved").length,
      projected:items.filter(x=>x.source==="recurrence-preview").length},
    truncated:saved.length>SCAN_LIMIT||active.length>SCAN_LIMIT||combined.length>DISPLAY_LIMIT};
}
export function agendaAnswer(snapshot:AgendaSnapshot):string {
  const name={today:"hoje",tomorrow:"amanhã",week:"os próximos 7 dias"}[snapshot.period];
  if(!snapshot.items.length){
    return "Não encontrei lembretes pendentes ou recorrências previstas para "+
      name+" no calendário do CORTEX (horário de São Paulo).";
  }
  const fmt=new Intl.DateTimeFormat("pt-BR",{
    timeZone:RECURRENCE_ZONE,day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"
  });
  const lines=snapshot.items.slice(0,10).map(item=>
    "• "+fmt.format(new Date(item.dueAt))+" — "+item.title+
      (item.source==="recurrence-preview"?" (recorrência prevista)":
        item.status==="DUE"?" (vencido)":" (agendado)"));
  return "Sua agenda para "+name+" (São Paulo): "+snapshot.counts.saved+
    " registro(s) e "+snapshot.counts.projected+" previsão(ões) de recorrência nesta amostra.\n"+
    lines.join("\n")+(snapshot.items.length>10||snapshot.truncated
      ?"\nA lista foi limitada. Confira o painel para os detalhes.":"");
}
