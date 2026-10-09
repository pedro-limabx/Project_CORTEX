// V21: deterministic, bounded, read-only schedule conflict analysis.
// Google events carry actual start/end; CORTEX reminders are instants, not
// invented meetings. All-day events are advisory, not timed busy blocks.
import {nextRecurrenceAfter} from "../reminders/recurrence.js";
import type {AgendaPeriod} from "../reminders/agenda.js";
import type {UnifiedAgenda,UnifiedItem} from "./unified-agenda.js";

export type ConflictKind="event-overlap"|"reminder-during-event";
export type AgendaConflict={
  kind:ConflictKind;severity:"confirmed"|"potential";
  first:{id:string;title:string;source:string};
  second:{id:string;title:string;source:string};
  at:string;until:string|null;
  explanation:string;
};
export type FreeSuggestion={start:string;end:string;timeZone:"America/Sao_Paulo"};
export type ConflictReport={
  period:AgendaPeriod;readOnly:true;timeZone:"America/Sao_Paulo";
  google:UnifiedAgenda["google"];truncated:boolean;
  examined:{items:number;timedEvents:number;instantReminders:number;allDay:number;unknownDuration:number};
  conflicts:AgendaConflict[];suggestions:FreeSuggestion[];warnings:string[];
};

const MAX_CONFLICTS=20;
const MAX_SUGGESTIONS=4;
const SLOT_MS=30*60_000;
type Busy={item:UnifiedItem;start:number;end:number};
type Moment={item:UnifiedItem;time:number};
function ref(item:UnifiedItem) {
  return {id:item.id,title:item.title,source:item.sources.join("+")};
}
function validTime(input:string|undefined|null):number|null {
  if(!input)return null;
  const value=Date.parse(input);
  return Number.isFinite(value)?value:null;
}
function clip(x:number,low:number,high:number):number {
  return Math.max(low,Math.min(x,high));
}
function inside(value:number,start:number,end:number):boolean {
  return value>=start&&value<end;
}
function overlap(start:number,end:number,otherStart:number,otherEnd:number):boolean {
  return start<otherEnd&&otherStart<end;
}
function sameDayInSaoPaulo(timestamp:number):string {
  const fields=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{
    timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"
  }).formatToParts(new Date(timestamp)).filter(p=>p.type!=="literal")
    .map(p=>[p.type,p.value]));
  return fields.year+"-"+fields.month+"-"+fields.day;
}

export function analyzeAgendaConflicts(agenda:UnifiedAgenda,now=new Date()):ConflictReport {
  const from=Date.parse(agenda.from),until=Date.parse(agenda.until);
  if(!Number.isFinite(from)||!Number.isFinite(until)||until<=from)
    throw new Error("Janela de agenda inválida");
  const busy:Busy[]=[],moments:Moment[]=[];
  const allDayDates=new Set<string>();
  let allDay=0,unknownDuration=0;
  for(const item of agenda.items){
    if(item.allDay){
      // All-day can represent birthdays, holidays or time-off. Do not assume
      // an all-day event fully blocks the user's availability.
      if(item.sources.includes("google")){
        allDay++;
        if(/^\d{4}-\d{2}-\d{2}$/u.test(item.start)){
          const exclusiveEnd=/^\d{4}-\d{2}-\d{2}$/u.test(item.end??"")
            ?item.end!:null;
          const startDay=Date.parse(item.start+"T12:00:00Z");
          const endDay=exclusiveEnd?Date.parse(exclusiveEnd+"T12:00:00Z"):startDay+86_400_000;
          for(let day=startDay;day<endDay&&day<startDay+8*86_400_000;day+=86_400_000){
            if(Number.isFinite(day))allDayDates.add(new Date(day).toISOString().slice(0,10));
          }
        }
      }
      continue;
    }
    const start=validTime(item.start);
    if(start===null)continue;
    if(item.sources.includes("google")){
      const end=validTime(item.end);
      if(end===null||end<=start)unknownDuration++;
      else if(overlap(start,end,from,until)){
        busy.push({item,start:clip(start,from,until),end:clip(end,from,until)});
      }
    }
    if(item.sources.includes("cortex")&&inside(start,from,until)){
      // CORTEX has due-at only: never pretend it occupies 30/60 minutes.
      moments.push({item,time:start});
    }
  }
  const conflicts:AgendaConflict[]=[];
  let excess=false;
  function add(conflict:AgendaConflict) {
    if(conflicts.length<MAX_CONFLICTS)conflicts.push(conflict);
    else excess=true;
  }
  for(let i=0;i<busy.length;i++){
    for(let j=i+1;j<busy.length;j++){
      const a=busy[i]!,b=busy[j]!;
      if(a.item.id===b.item.id)continue;
      if(!overlap(a.start,a.end,b.start,b.end))continue;
      const start=Math.max(a.start,b.start),end=Math.min(a.end,b.end);
      add({kind:"event-overlap",severity:"confirmed",first:ref(a.item),
        second:ref(b.item),at:new Date(start).toISOString(),
        until:new Date(end).toISOString(),
        explanation:"Dois eventos com duração informada pelo Google ocupam o mesmo intervalo."});
    }
  }
  for(const point of moments){
    for(const event of busy){
      if(point.item.id===event.item.id)continue; // Same unified event, not a clash.
      if(!inside(point.time,event.start,event.end))continue;
      add({kind:"reminder-during-event",severity:"potential",
        first:ref(point.item),second:ref(event.item),
        at:new Date(point.time).toISOString(),until:null,
        explanation:point.item.cortexKind==="recurrence-preview"
          ?"Uma recorrência prevista coincide com o horário de um evento Google; a duração do lembrete é desconhecida."
          :"Um lembrete pontual coincide com o horário de um evento Google; a duração do lembrete é desconhecida."});
    }
  }
  conflicts.sort((a,b)=>a.at.localeCompare(b.at)||a.kind.localeCompare(b.kind));
  const partial=agenda.truncated||excess;
  const warnings=[...agenda.warnings];
  if(unknownDuration)warnings.push(
    unknownDuration+" evento(s) Google não têm horário de término válido; não é possível verificar sua sobreposição.");
  if(allDay)warnings.push(
    allDay+" evento(s) de dia inteiro não foram tratados como horários ocupados. Confira esses dias manualmente.");
  if(excess)warnings.push("Há mais conflitos que o limite de "+MAX_CONFLICTS+" mostrados.");
  if(agenda.google!=="connected")warnings.push(
    "Sem acesso aos eventos do Google, a ausência de conflito não significa que o período está livre.");
  if(partial)warnings.push("Resultado parcial: outros conflitos podem existir além da amostra carregada.");

  // Availability slots are suggestions only. Never claim an authoritative
  // free/busy result, especially when Google isn't connected or data is paged.
  // A point reminder makes a slot unsuitable if the instant falls inside it.
  const suggestions:FreeSuggestion[]=[];
  const after=Math.max(from,now.getTime());
  if(Number.isFinite(after)&&after<until){
    const candidates:Array<{start:number;end:number}>=[];
    for(let minute=9*60;minute<18*60;minute+=30){
      const time=String(Math.floor(minute/60)).padStart(2,"0")+":"+
        String(minute%60).padStart(2,"0");
      let instant=nextRecurrenceAfter(new Date(from-1),"DAILY",time,null);
      for(let day=0;day<8&&instant.getTime()<until;day++){
        const start=instant.getTime(),end=start+SLOT_MS;
        if(start>=after&&end<=until)candidates.push({start,end});
        instant=nextRecurrenceAfter(instant,"DAILY",time,null);
      }
    }
    candidates.sort((a,b)=>a.start-b.start);
    for(const slot of candidates){
      if(suggestions.length>=MAX_SUGGESTIONS)break;
      if(allDayDates.has(sameDayInSaoPaulo(slot.start)))continue;
      if(busy.some(x=>overlap(slot.start,slot.end,x.start,x.end)))continue;
      if(moments.some(x=>inside(x.time,slot.start,slot.end)))continue;
      suggestions.push({start:new Date(slot.start).toISOString(),
        end:new Date(slot.end).toISOString(),timeZone:"America/Sao_Paulo"});
    }
  }
  return {period:agenda.period,readOnly:true,timeZone:"America/Sao_Paulo",
    google:agenda.google,truncated:partial,
    examined:{items:agenda.items.length,timedEvents:busy.length,
      instantReminders:moments.length,allDay,unknownDuration},
    conflicts,suggestions,warnings};
}

export type ConflictQuestion=AgendaPeriod|"unsupported"|null;
const lead=/^(?:(?:neuron)[,!]?\s*)?(?:tenho (?:algum |alguns )?conflitos? (?:na |em minha )?agenda|(?:me mostre|mostre|analise|verifique|encontre|identifique) (?:os )?(?:conflitos|horarios sobrepostos|sobreposicoes) (?:na |da |em minha )?agenda|(?:onde|quando) (?:minha )?agenda (?:esta )?sobreposta|(?:ha|existem) (?:conflitos|horarios sobrepostos) (?:na |em minha )?agenda)\b/u;
export function interpretConflictQuestion(value:string):ConflictQuestion {
  const text=value.normalize("NFD").replace(/[\u0300-\u036f]/gu,"")
    .trim().toLowerCase().replace(/[?.!]+$/u,"").trim();
  const match=lead.exec(text);
  if(!match)return null;
  const tail=text.slice(match[0].length).trim()
    .replace(/^(?:(?:de|da|do|para|na|no|nos|nesta|desta)\s+)/u,"");
  if(!tail||tail==="hoje")return "today";
  if(tail==="amanha")return "tomorrow";
  if(["semana","esta semana","proximos 7 dias","os proximos 7 dias"].includes(tail))
    return "week";
  return "unsupported";
}
function when(iso:string):string {
  return new Intl.DateTimeFormat("pt-BR",{
    timeZone:"America/Sao_Paulo",day:"2-digit",month:"2-digit",
    hour:"2-digit",minute:"2-digit"
  }).format(new Date(iso));
}
export function conflictAnswer(report:ConflictReport):string {
  const label={today:"hoje",tomorrow:"amanhã",week:"os próximos 7 dias"}[report.period];
  let text="Análise de possíveis conflitos da agenda para "+label+
    " (São Paulo). "+report.conflicts.length+" ocorrência(s) encontrada(s) na amostra.";
  const lines=report.conflicts.slice(0,6).map(item=>
    "• "+when(item.at)+" — "+item.first.title.replace(/[\r\n\t]/gu," ").slice(0,90)+
    " × "+item.second.title.replace(/[\r\n\t]/gu," ").slice(0,90)+
    (item.severity==="potential"?" (possível conflito com lembrete pontual)":" (sobreposição de eventos)"));
  if(lines.length)text+="\n"+lines.join("\n");
  if(!lines.length)text+="\nNenhuma sobreposição foi detectada nos horários com duração conhecida da amostra.";
  if(report.suggestions.length)text+="\nSugestões tentativas de 30 minutos: "+
    report.suggestions.slice(0,3).map(x=>when(x.start)).join(", ")+
    ". Confira a disponibilidade antes de reagendar.";
  if(report.warnings.length)text+="\n"+report.warnings.join(" ");
  text+="\nNenhum compromisso foi alterado.";
  return text;
}
