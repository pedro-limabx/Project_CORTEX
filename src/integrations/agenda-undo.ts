// V24: fail-closed preview for a manual undo of a V23 CORTEX reminder move.
// Neither this module nor its callers mutate Google Calendar events.
import type {AgendaPlan} from "./agenda-reorganization.js";
import type {UnifiedAgenda} from "./unified-agenda.js";

export const UNDO_WINDOW_MINUTES=30;
const UNDO_WINDOW_MS=UNDO_WINDOW_MINUTES*60_000;
const BUFFER_MS=30*60_000;
export type UndoPreview={
  eligible:boolean;reason:string;proposalId:string;
  reminderId:string|null;title:string;
  currentDueAt:string;restoreDueAt:string;
  expiresAt:string|null;timeZone:"America/Sao_Paulo";
  externalChangeApplied:false;internalChangeApplied:false;
};
function civilDay(input:string):string {
  const date=new Date(input);
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{
    timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"
  }).formatToParts(date).filter(p=>p.type!=="literal").map(p=>[p.type,p.value]));
  return parts.year+"-"+parts.month+"-"+parts.day;
}
function overlap(start:number,end:number,otherStart:number,otherEnd:number):boolean {
  return start<otherEnd && otherStart<end;
}
function safeTime(value:string|undefined|null):number|null {
  if(!value)return null;
  const t=Date.parse(value);
  return Number.isFinite(t)?t:null;
}
function state(reason:string,plan:AgendaPlan,deadline:string|null):UndoPreview{
  const validId=/^cortex:([0-9a-f-]{36})$/i.exec(plan.targetId);
  return {eligible:false,reason,proposalId:plan.id,
    reminderId:validId?.[1]??null,title:plan.title,
    currentDueAt:plan.proposedStart,restoreDueAt:plan.originalStart,
    expiresAt:deadline,timeZone:"America/Sao_Paulo",
    externalChangeApplied:false,internalChangeApplied:false};
}
export function previewReminderUndo(plan:AgendaPlan,agenda:UnifiedAgenda,
  now=new Date()):UndoPreview {
  const applied=safeTime(plan.appliedAt);
  const deadline=applied===null?null:new Date(applied+UNDO_WINDOW_MS).toISOString();
  const fail=(reason:string)=>state(reason,plan,deadline);
  const current=now.getTime();
  if(plan.status!=="APPLIED"||plan.source!=="cortex"||!/^cortex:[0-9a-f-]{36}$/i.test(plan.targetId)
      ||plan.originalEnd!==null||plan.proposedEnd!==null)
    return fail("Somente alterações aplicadas a lembretes internos podem ser revertidas.");
  if(applied===null||current<applied||current>=applied+UNDO_WINDOW_MS)
    return fail("O período de 30 minutos para reversão já terminou.");
  const original=safeTime(plan.originalStart),proposed=safeTime(plan.proposedStart);
  if(original===null||proposed===null||original<=current+60_000
      ||original===proposed)
    return fail("O horário anterior já passou, está próximo demais ou é inválido.");
  if(agenda.google!=="connected"||agenda.truncated)
    return fail("A consulta Google está desconectada ou incompleta. Não é seguro reverter.");
  const from=Date.parse(agenda.from),until=Date.parse(agenda.until);
  if(![from,until].every(Number.isFinite)||original<from||original>=until
      ||proposed<from||proposed>=until)
    return fail("Os horários não estão cobertos pela consulta atual.");
  const target=agenda.items.find(x=>x.id===plan.targetId);
  if(!target||target.title!==plan.title||target.start!==plan.proposedStart
      ||target.cortexKind!=="saved"||target.cortexStatus!=="PENDING"
      ||target.sources.length!==1||target.sources[0]!=="cortex")
    return fail("O lembrete foi modificado, não está pendente ou aparece em mais de uma agenda.");
  const wantedDay=civilDay(plan.originalStart);
  for(const item of agenda.items){
    if(item.id===target.id)continue;
    if(item.allDay&&item.sources.includes("google")){
      const fromDay=item.start,toDay=/^\d{4}-\d{2}-\d{2}$/.test(item.end??"")
        ?item.end!:"9999-12-31";
      if(fromDay<=wantedDay&&wantedDay<toDay)
        return fail("Existe um evento de dia inteiro nessa data. Verifique manualmente.");
      continue;
    }
    const start=safeTime(item.start);
    if(start===null)continue;
    if(item.sources.includes("google")){
      const end=safeTime(item.end);
      if(end===null||end<=start){
        if(civilDay(item.start)===wantedDay)
          return fail("Há um evento Google sem duração confiável nessa data.");
      }else if(overlap(original,original+BUFFER_MS,start,end)){
        return fail("O horário anterior está ocupado por um evento Google.");
      }
    }
    if(item.sources.includes("cortex")&&start>=original&&start<original+BUFFER_MS)
      return fail("Outro lembrete do CORTEX coincide com o horário anterior.");
  }
  const ok=state("O horário anterior não apresenta sobreposições na amostra atual. "+
    "A reversão ainda será revalidada no PostgreSQL.",plan,deadline);
  return {...ok,eligible:true};
}
