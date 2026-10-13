// V26: explainable, read-only priorities from owner-scoped live CORTEX state.
// Ranking is deterministic; no LLM, background execution or auto-approval.
import type {ReminderRepository} from "../reminders/store.js";
import type {PostgresAgendaProposalStore} from "../integrations/agenda-proposal-store.js";
import type {OperationalAlertService} from "../alerts/service.js";

export type PriorityFilter="all"|"urgent"|"reminders"|"workflows"|"decisions";
export type PrioritySeverity="critical"|"high"|"medium";
export type PriorityItem={
  id:string;kind:"reminder"|"workflow"|"decision";severity:PrioritySeverity;
  title:string;reason:string;nextStep:string;
  sourceTab:"reminders"|"alerts"|"agenda-proposals";
  occurredAt:string;deadlineAt:string|null;referenceId:string;
  readOnly:true;
};
export type PrioritySnapshot={
  generatedAt:string;filter:PriorityFilter;limit:number;items:PriorityItem[];
  counts:{critical:number;high:number;medium:number;inSample:number};
  partial:boolean;warnings:string[];
  readOnly:true;timeZone:"America/Sao_Paulo";
  scope:"sampled_current_state";actionExecuted:false;
};
export function validatePriorityRequest(filter:unknown,limit:unknown):
  {filter:PriorityFilter;limit:number}|null{
  if(filter!=="all"&&filter!=="urgent"&&filter!=="reminders"
    &&filter!=="workflows"&&filter!=="decisions")return null;
  if(typeof limit!=="number"||!Number.isSafeInteger(limit)||limit<1||limit>100)
    return null;
  return {filter,limit};
}
export type PriorityDependencies={
  reminders:Pick<ReminderRepository,"list">;
  proposals:Pick<PostgresAgendaProposalStore,"list">;
  alerts:Pick<OperationalAlertService,"inbox">;
};
const cap=100;
const score:Record<PrioritySeverity,number>={critical:0,high:1,medium:2};
function validTime(value:string):number{
  const date=Date.parse(value);
  return Number.isFinite(date)?date:0;
}
export async function computePriorities(
  deps:PriorityDependencies,user:string,filter:PriorityFilter,limit:number,
  now=new Date()
):Promise<PrioritySnapshot>{
  if(!validatePriorityRequest(filter,limit))throw new Error("Filtro de prioridades inválido.");
  const at=now.getTime();
  const includeReminders=filter==="all"||filter==="urgent"||filter==="reminders";
  const includeDecisions=filter==="all"||filter==="urgent"||filter==="decisions";
  const includeWorkflows=filter==="all"||filter==="urgent"||filter==="workflows";
  const [reminders,proposals,inbox]=await Promise.all([
    includeReminders?deps.reminders.list(user,"due",cap+1):Promise.resolve([]),
    includeDecisions?deps.proposals.list(user,cap+1):Promise.resolve([]),
    includeWorkflows?deps.alerts.inbox(user,{view:"unread",limit:cap}):Promise.resolve(null)
  ]);
  const collected:PriorityItem[]=[];
  // DUE is persisted by the reminder scheduler; never guess that a PENDING
  // reminder is overdue from dueAt alone, or silently mutate its state.
  for(const reminder of reminders.slice(0,cap)){
    collected.push({
      id:"reminder:"+reminder.id,kind:"reminder",severity:"high",
      title:reminder.title,reason:"Lembrete marcado como vencido e ainda não concluído.",
      nextStep:"Abra Lembretes para concluir ou cancelar, após conferir o contexto.",
      sourceTab:"reminders",occurredAt:reminder.triggeredAt??reminder.dueAt,
      deadlineAt:reminder.dueAt,referenceId:reminder.id,readOnly:true
    });
  }
  for(const plan of proposals.slice(0,cap)){
    if(plan.expired||Date.parse(plan.expiresAt)<=at)continue;
    if(plan.status==="PENDING_REVIEW"){
      const minutes=(Date.parse(plan.expiresAt)-at)/60_000;
      collected.push({
        id:"decision:"+plan.id,kind:"decision",
        severity:minutes<=5?"high":"medium",
        title:plan.title,
        reason:minutes<=5
          ?"Proposta aguardando decisão e com menos de 5 minutos de validade."
          :"Proposta de agenda aguardando sua aprovação ou rejeição.",
        nextStep:"Abra Propostas de agenda para revisar os dois horários.",
        sourceTab:"agenda-proposals",occurredAt:plan.createdAt,
        deadlineAt:plan.expiresAt,referenceId:plan.id,readOnly:true
      });
    }else if(plan.status==="APPROVED"){
      collected.push({
        id:"decision:"+plan.id,kind:"decision",severity:"medium",
        title:plan.title,
        reason:plan.source==="cortex"
          ?"Plano aprovado, mas a aplicação ao lembrete requer outra confirmação."
          :"Plano aprovado para um evento Google; só é possível alterá-lo manualmente.",
        nextStep:plan.source==="cortex"
          ?"Abra Propostas de agenda e verifique se ainda é seguro aplicar."
          :"Revise a proposta e, se quiser, altere manualmente no Google Agenda.",
        sourceTab:"agenda-proposals",occurredAt:plan.reviewedAt??plan.createdAt,
        deadlineAt:plan.expiresAt,referenceId:plan.id,readOnly:true
      });
    }
  }
  for(const alert of inbox?.alerts??[]){
    collected.push({
      id:"workflow:"+alert.workflowId+":"+alert.version+":"+alert.status,
      kind:"workflow",severity:alert.severity==="critical"?"critical":"high",
      title:"Workflow requer atenção: "+alert.status,
      reason:alert.severity==="critical"
        ?"O estado atual do workflow indica falha ou resultado que exige reconciliação."
        :"O workflow está em um estado que requer avaliação humana.",
      nextStep:"Abra Alertas para avaliar o diagnóstico e as ações supervisionadas.",
      sourceTab:"alerts",occurredAt:alert.updatedAt,
      deadlineAt:null,referenceId:alert.workflowId,readOnly:true
    });
  }
  const eligible=filter==="urgent"
    ?collected.filter(item=>item.severity!=="medium"):collected;
  eligible.sort((a,b)=>score[a.severity]-score[b.severity]
    ||(a.kind==="decision"&&b.kind==="decision"
      ?validTime(a.deadlineAt??"")-validTime(b.deadlineAt??""):0)
    ||validTime(a.occurredAt)-validTime(b.occurredAt)
    ||a.id.localeCompare(b.id));
  const warnings:string[]=[];
  if(reminders.length>cap)warnings.push(
    "Mais de 100 lembretes vencidos: a amostra não inclui todos.");
  if(proposals.length>cap)warnings.push(
    "Mais de 100 propostas recentes: podem existir decisões anteriores fora da amostra.");
  if(inbox&&inbox.scope.sampled>=cap)warnings.push(
    "Os alertas cobrem somente os 100 workflows mais recentes, não o histórico completo.");
  const partial=warnings.length>0||eligible.length>limit;
  if(eligible.length>limit)warnings.push(
    "Exibindo apenas os "+limit+" primeiros itens classificados nesta consulta.");
  return {
    generatedAt:now.toISOString(),filter,limit,items:eligible.slice(0,limit),
    counts:{critical:eligible.filter(x=>x.severity==="critical").length,
      high:eligible.filter(x=>x.severity==="high").length,
      medium:eligible.filter(x=>x.severity==="medium").length,
      inSample:eligible.length},
    partial,warnings,readOnly:true,timeZone:"America/Sao_Paulo",
    scope:"sampled_current_state",actionExecuted:false
  };
}
