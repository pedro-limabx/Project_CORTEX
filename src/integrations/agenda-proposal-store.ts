import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import type {AgendaPlan,PlanDraft,PlanStatus} from "./agenda-reorganization.js";

export type StoredPlan=AgendaPlan&{expired:boolean};
export class ProposalQuotaError extends Error {}
export class PostgresAgendaProposalStore {
  constructor(private readonly pool:Pool){}
  async initialize():Promise<void>{
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(8142,1518)");
      await client.query([
        "CREATE TABLE IF NOT EXISTS cortex_agenda_proposals (",
        "id UUID PRIMARY KEY,user_id TEXT NOT NULL,",
        "status TEXT NOT NULL CHECK (status IN ('PENDING_REVIEW','APPROVED','REJECTED','APPLIED','REVERTED')),",
        "state JSONB NOT NULL,expires_at TIMESTAMPTZ NOT NULL,",
        "created_at TIMESTAMPTZ NOT NULL,reviewed_at TIMESTAMPTZ)"
      ].join(" "));
      // Upgrade existing V22 databases, retaining all prior proposal records.
      await client.query("ALTER TABLE cortex_agenda_proposals DROP CONSTRAINT IF EXISTS cortex_agenda_proposals_status_check");
      await client.query([
        "ALTER TABLE cortex_agenda_proposals",
        "ADD CONSTRAINT cortex_agenda_proposals_status_check",
        "CHECK (status IN ('PENDING_REVIEW','APPROVED','REJECTED','APPLIED','REVERTED'))"
      ].join(" "));
      await client.query([
        "CREATE INDEX IF NOT EXISTS cortex_agenda_proposals_owner_recent",
        "ON cortex_agenda_proposals (user_id,created_at DESC,id)"
      ].join(" "));
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error;}
    finally{client.release();}
  }
  private hydrate(row:{state:AgendaPlan;expires_at:Date|string}):StoredPlan{
    const data=row.state;
    return {...data,externalChangeApplied:false,
      expired:data.status==="PENDING_REVIEW"
        &&new Date(row.expires_at).getTime()<=Date.now()};
  }
  async create(user:string,draft:PlanDraft,now=new Date()):Promise<StoredPlan>{
    const id=randomUUID(),createdAt=now.toISOString();
    const expiresAt=new Date(now.getTime()+15*60_000).toISOString();
    const data:AgendaPlan={...draft,id,status:"PENDING_REVIEW",createdAt,
      updatedAt:createdAt,expiresAt,reviewedAt:null,externalChangeApplied:false};
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      // Prevent a runaway number of pending decisions for the same owner.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), 22022)",[user]);
      const count=await client.query<{count:string}>([
        "SELECT count(*)::text AS count FROM cortex_agenda_proposals",
        "WHERE user_id=$1 AND status='PENDING_REVIEW' AND expires_at>NOW()"
      ].join(" "),[user]);
      if(Number(count.rows[0]?.count??0)>=50)throw new ProposalQuotaError(
        "Limite de 50 propostas pendentes. Aprove/rejeite algumas antes de criar outras.");
      const inserted=await client.query<{state:AgendaPlan;expires_at:Date|string}>([
        "INSERT INTO cortex_agenda_proposals",
        "(id,user_id,status,state,expires_at,created_at)",
        "VALUES ($1::uuid,$2,'PENDING_REVIEW',$3::jsonb,$4::timestamptz,$5::timestamptz)",
        "RETURNING state,expires_at"
      ].join(" "),[id,user,JSON.stringify(data),expiresAt,createdAt]);
      await client.query("COMMIT");
      return this.hydrate(inserted.rows[0]!);
    }catch(error){await client.query("ROLLBACK");throw error;}
    finally{client.release();}
  }
  async list(user:string,limit:number):Promise<StoredPlan[]>{
    const result=await this.pool.query<{state:AgendaPlan;expires_at:Date|string}>([
      "SELECT state,expires_at FROM cortex_agenda_proposals",
      "WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2"
    ].join(" "),[user,limit]);
    return result.rows.map(x=>this.hydrate(x));
  }
  // V24: history derived from V23 applied plans, including later reversions.
  // Older V23 records are retained without a data-copying migration.
  async listChangeHistory(user:string,limit:number):Promise<StoredPlan[]>{
    const result=await this.pool.query<{state:AgendaPlan;expires_at:Date|string}>([
      "SELECT state,expires_at FROM cortex_agenda_proposals",
      "WHERE user_id=$1 AND status IN ('APPLIED','REVERTED')",
      "AND state->>'source'='cortex'",
      "ORDER BY created_at DESC,id DESC LIMIT $2"
    ].join(" "),[user,limit]);
    return result.rows.map(x=>this.hydrate(x));
  }
  async get(user:string,id:string):Promise<StoredPlan|null>{
    const result=await this.pool.query<{state:AgendaPlan;expires_at:Date|string}>([
      "SELECT state,expires_at FROM cortex_agenda_proposals",
      "WHERE user_id=$1 AND id=$2::uuid"
    ].join(" "),[user,id]);
    return result.rows[0]?this.hydrate(result.rows[0]):null;
  }
  // V23 applies only already approved internal reminder plans in one PostgreSQL
  // transaction. Approval alone remains a non-mutating decision.
  async applyInternalReminder(user:string,id:string,expected:StoredPlan,
    now=new Date()):Promise<{
      proposal:StoredPlan;reminder:{id:string;title:string;previousDueAt:string;dueAt:string}
    }|null>{
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1),23023)",[user]);
      const current=await client.query<{state:AgendaPlan;expires_at:Date|string;status:string}>([
        "SELECT state,expires_at,status FROM cortex_agenda_proposals",
        "WHERE id=$1::uuid AND user_id=$2 FOR UPDATE"
      ].join(" "),[id,user]);
      const row=current.rows[0],plan=row?.state;
      if(!row||!plan||row.status!=="APPROVED"||plan.status!=="APPROVED"
          ||plan.appliedAt||plan.source!=="cortex"
          ||new Date(row.expires_at).getTime()<=now.getTime()
          ||!/^cortex:[0-9a-f-]{36}$/i.test(plan.targetId)
          ||plan.targetId!==expected.targetId
          ||plan.originalStart!==expected.originalStart
          ||plan.proposedStart!==expected.proposedStart
          ||plan.conflictKey!==expected.conflictKey
          ||plan.title!==expected.title
          ||plan.proposedEnd!==null||plan.originalEnd!==null){
        await client.query("ROLLBACK");
        return null;
      }
      const reminderId=plan.targetId.slice("cortex:".length);
      const locked=await client.query<{
        id:string;title:string;status:string;due_at:Date|string
      }>([
        "SELECT id,title,status,due_at FROM cortex_reminders",
        "WHERE id=$1::uuid AND user_id=$2 FOR UPDATE"
      ].join(" "),[reminderId,user]);
      const reminder=locked.rows[0];
      if(!reminder||reminder.title!==plan.title||reminder.status!=="PENDING"
          ||new Date(reminder.due_at).toISOString()!==plan.originalStart
          ||Date.parse(plan.proposedStart)<now.getTime()+60_000){
        await client.query("ROLLBACK");
        return null;
      }
      // Guard against newly persisted reminder instants since the snapshot.
      // External Google changes must be checked separately before this txn.
      const occupied=await client.query([
        "SELECT id FROM cortex_reminders",
        "WHERE user_id=$1 AND id<>$2::uuid AND status IN ('PENDING','DUE')",
        "AND due_at >= $3::timestamptz",
        "AND due_at < ($3::timestamptz + interval '30 minutes') LIMIT 1"
      ].join(" "),[user,reminderId,plan.proposedStart]);
      if(occupied.rows.length){
        await client.query("ROLLBACK");
        return null;
      }
      const move=await client.query([
        "UPDATE cortex_reminders SET due_at=$3::timestamptz",
        "WHERE id=$1::uuid AND user_id=$2 AND title=$4",
        "AND status='PENDING' AND due_at=$5::timestamptz",
        "AND $3::timestamptz>NOW()+interval '1 minute'",
        "RETURNING id"
      ].join(" "),[reminderId,user,plan.proposedStart,plan.title,plan.originalStart]);
      if(move.rows.length!==1){
        await client.query("ROLLBACK");
        return null;
      }
      const at=now.toISOString();
      const updated=await client.query<{state:AgendaPlan;expires_at:Date|string}>([
        "UPDATE cortex_agenda_proposals SET status='APPLIED',",
        "state=state||jsonb_build_object('status','APPLIED','appliedAt',$3::text,'updatedAt',$3::text)",
        "WHERE id=$1::uuid AND user_id=$2 AND status='APPROVED'",
        "AND expires_at>NOW() RETURNING state,expires_at"
      ].join(" "),[id,user,at]);
      if(updated.rows.length!==1){
        await client.query("ROLLBACK");
        return null;
      }
      await client.query("COMMIT");
      return {proposal:this.hydrate(updated.rows[0]!),
        reminder:{id:reminderId,title:plan.title,
          previousDueAt:plan.originalStart,dueAt:plan.proposedStart}};
    }catch(error){await client.query("ROLLBACK");throw error;}
    finally{client.release();}
  }

  // V24: history and reminder change commit in a single atomic transaction.
  // A replay or a concurrent second decision cannot apply the same undo.
  async undoInternalReminder(user:string,id:string,expected:StoredPlan,
    now=new Date()):Promise<{
      proposal:StoredPlan;reminder:{id:string;title:string;previousDueAt:string;dueAt:string}
    }|null>{
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1),23023)",[user]);
      const found=await client.query<{state:AgendaPlan;status:string}>([
        "SELECT state,status FROM cortex_agenda_proposals",
        "WHERE id=$1::uuid AND user_id=$2 FOR UPDATE"
      ].join(" "),[id,user]);
      const row=found.rows[0],plan=row?.state;
      const applied=plan?.appliedAt?Date.parse(plan.appliedAt):NaN;
      if(!row||!plan||row.status!=="APPLIED"||plan.status!=="APPLIED"
        ||plan.source!=="cortex"||plan.revertedAt
        ||!Number.isFinite(applied)||applied>now.getTime()
        ||now.getTime()>=applied+30*60_000
        ||!/^cortex:[0-9a-f-]{36}$/i.test(plan.targetId)
        ||plan.targetId!==expected.targetId
        ||plan.originalStart!==expected.originalStart
        ||plan.proposedStart!==expected.proposedStart
        ||plan.title!==expected.title||plan.appliedAt!==expected.appliedAt
        ||plan.originalEnd!==null||plan.proposedEnd!==null
        ||Date.parse(plan.originalStart)<=now.getTime()+60_000){
        await client.query("ROLLBACK");
        return null;
      }
      const reminderId=plan.targetId.slice("cortex:".length);
      const locked=await client.query<{title:string;status:string;due_at:Date|string}>([
        "SELECT title,status,due_at FROM cortex_reminders",
        "WHERE id=$1::uuid AND user_id=$2 FOR UPDATE"
      ].join(" "),[reminderId,user]);
      const reminder=locked.rows[0];
      if(!reminder||reminder.status!=="PENDING"||reminder.title!==plan.title
        ||new Date(reminder.due_at).toISOString()!==plan.proposedStart){
        await client.query("ROLLBACK");
        return null;
      }
      const occupied=await client.query([
        "SELECT id FROM cortex_reminders WHERE user_id=$1 AND id<>$2::uuid",
        "AND status IN ('PENDING','DUE') AND due_at >= $3::timestamptz",
        "AND due_at < ($3::timestamptz + interval '30 minutes') LIMIT 1"
      ].join(" "),[user,reminderId,plan.originalStart]);
      if(occupied.rows.length){
        await client.query("ROLLBACK");
        return null;
      }
      const moved=await client.query([
        "UPDATE cortex_reminders SET due_at=$3::timestamptz",
        "WHERE id=$1::uuid AND user_id=$2 AND title=$4",
        "AND status='PENDING' AND due_at=$5::timestamptz",
        "AND $3::timestamptz>NOW()+interval '1 minute'",
        "RETURNING id"
      ].join(" "),[reminderId,user,plan.originalStart,plan.title,plan.proposedStart]);
      if(moved.rows.length!==1){
        await client.query("ROLLBACK");
        return null;
      }
      const at=now.toISOString();
      const updated=await client.query<{state:AgendaPlan;expires_at:Date|string}>([
        "UPDATE cortex_agenda_proposals SET status='REVERTED',",
        "state=state||jsonb_build_object('status','REVERTED','revertedAt',$3::text,'updatedAt',$3::text)",
        "WHERE id=$1::uuid AND user_id=$2 AND status='APPLIED'",
        "AND (state->>'appliedAt')::timestamptz<=NOW()",
        "AND (state->>'appliedAt')::timestamptz>NOW()-INTERVAL '30 minutes'",
        "RETURNING state,expires_at"
      ].join(" "),[id,user,at]);
      if(updated.rows.length!==1){
        await client.query("ROLLBACK");
        return null;
      }
      await client.query("COMMIT");
      return {proposal:this.hydrate(updated.rows[0]!),
        reminder:{id:reminderId,title:plan.title,
          previousDueAt:plan.proposedStart,dueAt:plan.originalStart}};
    }catch(error){await client.query("ROLLBACK");throw error;}
    finally{client.release();}
  }

  async review(user:string,id:string,decision:"approve"|"reject"):Promise<StoredPlan|null>{
    const status:PlanStatus=decision==="approve"?"APPROVED":"REJECTED";
    const updated=await this.pool.query<{state:AgendaPlan;expires_at:Date|string}>([
      "UPDATE cortex_agenda_proposals SET status=$3,reviewed_at=NOW(),",
      "state=jsonb_set(jsonb_set(jsonb_set(state,'{status}',to_jsonb($3::text)),",
      "'{reviewedAt}',to_jsonb(NOW()::text)),'{updatedAt}',to_jsonb(NOW()::text))",
      "WHERE user_id=$1 AND id=$2::uuid AND status='PENDING_REVIEW'",
      "AND expires_at>NOW() RETURNING state,expires_at"
    ].join(" "),[user,id,status]);
    return updated.rows[0]?this.hydrate(updated.rows[0]):null;
  }
}
