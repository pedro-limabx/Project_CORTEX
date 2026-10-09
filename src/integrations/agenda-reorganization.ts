// V22: bounded, auditable manual plans. No Google/Reminder mutation here.
import {createHash} from "node:crypto";
import {nextRecurrenceAfter} from "../reminders/recurrence.js";
import type {AgendaPeriod} from "../reminders/agenda.js";
import type {AgendaConflict,ConflictReport} from "./agenda-conflicts.js";
import type {UnifiedAgenda,UnifiedItem} from "./unified-agenda.js";

export type PlanStatus="PENDING_REVIEW"|"APPROVED"|"REJECTED";
export type AgendaPlan={
  id:string;period:AgendaPeriod;conflictKey:string;targetId:string;
  title:string;source:"google"|"cortex";originalStart:string;originalEnd:string|null;
  proposedStart:string;proposedEnd:string|null;
  status:PlanStatus;createdAt:string;updatedAt:string;expiresAt:string;
  reviewedAt:string|null;externalChangeApplied:false;
};
export type PlanDraft=Omit<AgendaPlan,
  "id"|"status"|"createdAt"|"updatedAt"|"expiresAt"|"reviewedAt"|"externalChangeApplied">;
export class PlanInputError extends Error {}
export class PlanConflictError extends Error {}

const SLOT_MS=30*60_000;
const DAY_MS=86_400_000;
const ZONE="America/Sao_Paulo";
export function agendaConflictKey(value:AgendaConflict):string {
  return createHash("sha256")
    .update(JSON.stringify([value.kind,value.first.id,value.second.id,value.at,value.until]))
    .digest("hex").slice(0,32);
}
function civilDay(input:number):string {
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{
    timeZone:ZONE,year:"numeric",month:"2-digit",day:"2-digit"
  }).formatToParts(new Date(input)).filter(x=>x.type!=="literal")
    .map(x=>[x.type,x.value]));
  return [parts.year,parts.month,parts.day].join("-");
}
function validUtc(iso:string|null|undefined):number|null {
  if(!iso)return null;
  const n=Date.parse(iso);
  return Number.isFinite(n)?n:null;
}
function overlap(a:number,b:number,c:number,d:number):boolean {
  return a<d&&c<b;
}
function localSlotOnDay(day:string,time:string,reference:number):number|null {
  let current=new Date(reference-2*DAY_MS);
  for(let attempt=0;attempt<5;attempt++){
    current=nextRecurrenceAfter(current,"DAILY",time,null);
    const at=current.getTime();
    const actual=civilDay(at);
    if(actual===day)return at;
    if(actual>day)return null;
  }
  return null;
}

export function draftAgendaPlan(
  agenda:UnifiedAgenda,report:ConflictReport,conflictKey:string,targetId:string,
  now=new Date()
):PlanDraft {
  if(agenda.period!==report.period||report.truncated||agenda.truncated
      ||report.google!=="connected"||agenda.google!=="connected")
    throw new PlanConflictError("A análise está incompleta ou o Google não está conectado. Não é seguro propor uma alteração.");
  const conflict=report.conflicts.find(x=>agendaConflictKey(x)===conflictKey);
  if(!conflict||![conflict.first.id,conflict.second.id].includes(targetId))
    throw new PlanInputError("Conflito ou compromisso não encontrado na consulta atual. Atualize a análise.");
  const target=agenda.items.find(x=>x.id===targetId);
  if(!target)throw new PlanInputError("Compromisso não encontrado");
  const source=target.sources.includes("google")?"google":"cortex";
  if(target.sources.length!==1)
    throw new PlanConflictError("Esse registro pertence às duas agendas. Reorganize-o manualmente para não desalinhar as fontes.");
  if(source==="cortex"&&target.cortexKind!=="saved")
    throw new PlanConflictError("Uma recorrência prevista não pode ser tratada como um lembrete já existente.");
  const original=validUtc(target.start);
  const end=source==="google"?validUtc(target.end):null;
  if(original===null||original<=now.getTime())
    throw new PlanConflictError("O horário original já passou ou é inválido.");
  if(source==="google"&&(end===null||end<=original))
    throw new PlanConflictError("O evento não possui duração confiável.");
  const duration=source==="google"?end!-original:SLOT_MS;
  if(duration>9*60*60_000)
    throw new PlanConflictError("O compromisso não cabe na janela de sugestões de 9h às 18h.");
  const day=civilDay(original);
  const dayBlocked=agenda.items.some(x=>x.allDay&&x.sources.includes("google")
    &&x.start<=day&&day<(x.end??"9999-12-31"));
  if(dayBlocked)throw new PlanConflictError(
    "Há um evento de dia inteiro nesta data; verifique a disponibilidade manualmente.");
  // Don't assume that a missing/invalid end is safe.
  if(agenda.items.some(x=>x.id!==targetId&&x.sources.includes("google")&&!x.allDay
    &&civilDay(Date.parse(x.start))===day
    &&(validUtc(x.end)===null||validUtc(x.end)!<=Date.parse(x.start))))
    throw new PlanConflictError("Eventos sem duração confiável impedem uma sugestão segura.");
  const from=Date.parse(agenda.from),until=Date.parse(agenda.until);
  for(let minutes=9*60;minutes<18*60;minutes+=30){
    const time=String(Math.floor(minutes/60)).padStart(2,"0")+":"+
      String(minutes%60).padStart(2,"0");
    const start=localSlotOnDay(day,time,original);
    if(start===null||start<now.getTime()+60_000||start===original)continue;
    const finish=start+duration;
    if(start<from||finish>until||civilDay(finish-1)!==day)continue;
    if(minutes*60_000+duration>18*60*60_000)continue;
    const collision=agenda.items.some(other=>{
      if(other.id===targetId||other.allDay)return false;
      const otherStart=validUtc(other.start);
      if(otherStart===null)return false;
      if(other.sources.includes("google")){
        const otherEnd=validUtc(other.end);
        if(otherEnd!==null&&otherEnd>otherStart
            &&overlap(start,finish,otherStart,otherEnd))return true;
      }
      // Point reminders are instants, not artificial busy intervals.
      if(other.sources.includes("cortex")&&otherStart>=start&&otherStart<finish)return true;
      return false;
    });
    if(collision)continue;
    return {period:agenda.period,conflictKey,targetId,title:target.title,
      source,originalStart:target.start,originalEnd:source==="google"?target.end??null:null,
      proposedStart:new Date(start).toISOString(),
      proposedEnd:source==="google"?new Date(finish).toISOString():null};
  }
  throw new PlanConflictError("Não encontrei um intervalo tentativo adequado no mesmo dia. Avalie outra data manualmente.");
}
