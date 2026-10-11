// V25: private, owner-scoped, bounded activity timeline. This is a read-only
// projection of events already durably recorded by CORTEX, not a new execution
// engine. No Google OAuth access or tool execution occurs in this module.
import type {Pool} from "pg";

export type ActivityCategory="all"|"reminders"|"agenda"|"notifications"|"tools";
export const activityCategories:readonly ActivityCategory[]=[
  "all","reminders","agenda","notifications","tools"
];
export type ActivityEntry={
  id:string;category:Exclude<ActivityCategory,"all">;
  status:string;description:string;source:"cortex";
  occurredAt:string;referenceId:string;
};
export type ActivitySnapshot={
  entries:ActivityEntry[];category:ActivityCategory;limit:number;
  truncated:boolean;readOnly:true;source:"cortex-postgresql";timeZone:"America/Sao_Paulo";
  disclaimer:string;
};
type ActivityRow={
  category:Exclude<ActivityCategory,"all">;status:string;description:string;
  reference_id:string;occurred_at:Date|string; event_key:string;
};
export function validActivityRequest(category:unknown,limit:unknown):
  {category:ActivityCategory;limit:number}|null{
  if(typeof category!=="string"||!activityCategories.includes(category as ActivityCategory))
    return null;
  if(typeof limit!=="number"||!Number.isInteger(limit)||limit<1||limit>100)
    return null;
  return {category:category as ActivityCategory,limit};
}
// Every branch is scoped to $1 (server-side user id). Never take user id,
// a table name or a SQL fragment from the request. Filtering is in SQL before
// LIMIT so one high-volume source cannot hide all other categories.
// EVENT KEYS distinguish lifecycle phases on the same underlying record.
const ACTIVITY_SQL=[
  "SELECT category,status,description,reference_id,occurred_at,event_key FROM (",
  "SELECT 'reminders'::text AS category,'CREATED'::text AS status,",
  "'Lembrete criado: '||title AS description,id::text AS reference_id,",
  "created_at AS occurred_at,id::text||':created' AS event_key",
  "FROM cortex_reminders WHERE user_id=$1 AND $2 IN ('all','reminders')",
  "UNION ALL",
  "SELECT 'reminders','DUE','Lembrete vencido: '||title,id::text,triggered_at,",
  "id::text||':due' FROM cortex_reminders",
  "WHERE user_id=$1 AND triggered_at IS NOT NULL AND $2 IN ('all','reminders')",
  "UNION ALL",
  "SELECT 'reminders','DONE','Lembrete concluído: '||title,id::text,completed_at,",
  "id::text||':done' FROM cortex_reminders",
  "WHERE user_id=$1 AND completed_at IS NOT NULL AND $2 IN ('all','reminders')",
  "UNION ALL",
  "SELECT 'reminders','CANCELLED','Lembrete cancelado: '||title,id::text,cancelled_at,",
  "id::text||':cancelled' FROM cortex_reminders",
  "WHERE user_id=$1 AND cancelled_at IS NOT NULL AND $2 IN ('all','reminders')",
  "UNION ALL",
  "SELECT 'agenda','PENDING_REVIEW','Proposta criada: '||coalesce(state->>'title','(sem título)'),",
  "id::text,created_at,id::text||':created' FROM cortex_agenda_proposals",
  "WHERE user_id=$1 AND $2 IN ('all','agenda')",
  "UNION ALL",
  "SELECT 'agenda',CASE WHEN state->>'status'='REJECTED' THEN 'REJECTED' ELSE 'APPROVED' END,",
  "CASE WHEN state->>'status'='REJECTED' THEN 'Proposta rejeitada: ' ELSE 'Proposta aprovada: ' END",
  "||coalesce(state->>'title','(sem título)'),id::text,",
  "(state->>'reviewedAt')::timestamptz,id::text||':reviewed'",
  "FROM cortex_agenda_proposals WHERE user_id=$1",
  "AND state->>'reviewedAt' IS NOT NULL AND $2 IN ('all','agenda')",
  "UNION ALL",
  "SELECT 'agenda','APPLIED','Horário de lembrete alterado: '||coalesce(state->>'title','(sem título)'),",
  "id::text,(state->>'appliedAt')::timestamptz,id::text||':applied'",
  "FROM cortex_agenda_proposals WHERE user_id=$1",
  "AND state->>'appliedAt' IS NOT NULL AND $2 IN ('all','agenda')",
  "UNION ALL",
  "SELECT 'agenda','REVERTED','Horário de lembrete restaurado: '||coalesce(state->>'title','(sem título)'),",
  "id::text,(state->>'revertedAt')::timestamptz,id::text||':reverted'",
  "FROM cortex_agenda_proposals WHERE user_id=$1",
  "AND state->>'revertedAt' IS NOT NULL AND $2 IN ('all','agenda')",
  "UNION ALL",
  "SELECT 'notifications','CREATED','Alerta de workflow: '||workflow_status,",
  "id::text,created_at,id::text||':created' FROM cortex_persistent_notifications",
  "WHERE user_id=$1 AND $2 IN ('all','notifications')",
  "UNION ALL",
  "SELECT 'notifications','READ','Alerta visualizado: '||workflow_status,",
  "id::text,read_at,id::text||':read' FROM cortex_persistent_notifications",
  "WHERE user_id=$1 AND read_at IS NOT NULL AND $2 IN ('all','notifications')",
  "UNION ALL",
  "SELECT 'tools',CASE WHEN ok THEN 'SUCCESS' ELSE 'FAILED' END,",
  "'Ferramenta executada: '||tool,id::text,created_at,id::text||':executed'",
  "FROM neuron_audit_events WHERE user_id=$1 AND $2 IN ('all','tools')",
  ") events",
  "WHERE occurred_at IS NOT NULL",
  "ORDER BY occurred_at DESC,category ASC,status ASC,event_key ASC",
  "LIMIT ($3::integer + 1)"
].join(" ");

export class PostgresActivityFeed {
  constructor(private readonly pool:Pick<Pool,"query">){}
  async list(user:string,category:ActivityCategory,limit:number):Promise<ActivitySnapshot>{
    const valid=validActivityRequest(category,limit);
    if(!valid)throw new Error("Parâmetros da central de atividades inválidos.");
    const result=await this.pool.query<ActivityRow>(ACTIVITY_SQL,[user,category,limit]);
    const entries=result.rows.slice(0,limit).map(row=>({
      id:row.event_key,category:row.category,status:row.status,
      description:row.description,source:"cortex" as const,
      occurredAt:new Date(row.occurred_at).toISOString(),referenceId:row.reference_id
    }));
    return {entries,category,limit,truncated:result.rows.length>limit,readOnly:true,
      source:"cortex-postgresql",timeZone:"America/Sao_Paulo",
      disclaimer:"Histórico limitado a lembretes, propostas, notificações persistidas e auditoria de ferramentas. Não inclui eventos externos do Google nem todas as atividades do sistema."};
  }
}
