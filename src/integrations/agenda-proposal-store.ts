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
        "status TEXT NOT NULL CHECK (status IN ('PENDING_REVIEW','APPROVED','REJECTED')),",
        "state JSONB NOT NULL,expires_at TIMESTAMPTZ NOT NULL,",
        "created_at TIMESTAMPTZ NOT NULL,reviewed_at TIMESTAMPTZ)"
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
  async get(user:string,id:string):Promise<StoredPlan|null>{
    const result=await this.pool.query<{state:AgendaPlan;expires_at:Date|string}>([
      "SELECT state,expires_at FROM cortex_agenda_proposals",
      "WHERE user_id=$1 AND id=$2::uuid"
    ].join(" "),[user,id]);
    return result.rows[0]?this.hydrate(result.rows[0]):null;
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
