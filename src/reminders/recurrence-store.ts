import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {nextRecurrenceAfter,type NewSchedule,type Frequency,type ScheduleStatus} from "./recurrence.js";

export type RecurringSchedule={
  id:string;title:string;frequency:Frequency;weekday:number|null;
  localTime:string;timeZone:string;status:ScheduleStatus;
  nextDueAt:string;createdAt:string;pausedAt:string|null;cancelledAt:string|null;
};
type DbRow={
  id:string;title:string;frequency:Frequency;weekday:number|null;
  local_time:string;time_zone:string;status:ScheduleStatus;
  next_due_at:Date|string;created_at:Date|string;
  paused_at:Date|string|null;cancelled_at:Date|string|null;
};
const fields="id,title,frequency,weekday,local_time,time_zone,status,next_due_at,created_at,paused_at,cancelled_at";
const iso=(value:Date|string)=>new Date(value).toISOString();
function mapped(r:DbRow):RecurringSchedule {
  return {id:r.id,title:r.title,frequency:r.frequency,weekday:r.weekday,
    localTime:r.local_time,timeZone:r.time_zone,status:r.status,
    nextDueAt:iso(r.next_due_at),createdAt:iso(r.created_at),
    pausedAt:r.paused_at?iso(r.paused_at):null,
    cancelledAt:r.cancelled_at?iso(r.cancelled_at):null};
}
export class PostgresRecurrenceRepository {
  constructor(private readonly pool:Pool){}
  async initialize():Promise<void>{
    await this.pool.query([
      "CREATE TABLE IF NOT EXISTS cortex_reminder_schedules (",
      "id UUID PRIMARY KEY,user_id TEXT NOT NULL,title TEXT NOT NULL",
      "CHECK (char_length(title) BETWEEN 1 AND 160),",
      "frequency TEXT NOT NULL CHECK (frequency IN ('DAILY','WEEKLY')),",
      "weekday SMALLINT CHECK (weekday BETWEEN 0 AND 6),",
      "local_time VARCHAR(5) NOT NULL CHECK (local_time ~ '^[0-2][0-9]:[0-5][0-9]$'),",
      "time_zone TEXT NOT NULL CHECK (time_zone = 'America/Sao_Paulo'),",
      "status TEXT NOT NULL CHECK (status IN ('ACTIVE','PAUSED','CANCELLED')),",
      "next_due_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL,",
      "paused_at TIMESTAMPTZ,cancelled_at TIMESTAMPTZ,",
      "CONSTRAINT cortex_reminder_schedule_weekday CHECK (",
      "(frequency='DAILY' AND weekday IS NULL) OR (frequency='WEEKLY' AND weekday IS NOT NULL)))"
    ].join(" "));
    await this.pool.query([
      "ALTER TABLE cortex_reminders ADD COLUMN IF NOT EXISTS",
      "schedule_id UUID REFERENCES cortex_reminder_schedules(id)"
    ].join(" "));
    await this.pool.query([
      "CREATE UNIQUE INDEX IF NOT EXISTS cortex_reminder_schedule_occurrence",
      "ON cortex_reminders (schedule_id,due_at) WHERE schedule_id IS NOT NULL"
    ].join(" "));
    await this.pool.query([
      "CREATE INDEX IF NOT EXISTS cortex_reminder_schedules_due",
      "ON cortex_reminder_schedules (user_id,next_due_at,id) WHERE status='ACTIVE'"
    ].join(" "));
  }
  async create(user:string,input:NewSchedule,at:string):Promise<RecurringSchedule>{
    const result=await this.pool.query<DbRow>([
      "INSERT INTO cortex_reminder_schedules",
      "(id,user_id,title,frequency,weekday,local_time,time_zone,status,next_due_at,created_at)",
      "VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,'ACTIVE',$8::timestamptz,$9::timestamptz)",
      "RETURNING",fields
    ].join(" "),[randomUUID(),user,input.title,input.frequency,input.weekday,
      input.localTime,input.timeZone,input.nextDueAt,at]);
    if(!result.rows[0])throw new Error("Unable to create schedule");
    return mapped(result.rows[0]);
  }
  async list(user:string,limit:number):Promise<RecurringSchedule[]>{
    const result=await this.pool.query<DbRow>([
      "SELECT",fields,"FROM cortex_reminder_schedules WHERE user_id=$1",
      "ORDER BY CASE status WHEN 'ACTIVE' THEN 0 WHEN 'PAUSED' THEN 1 ELSE 2 END,",
      "next_due_at ASC,id ASC LIMIT $2"
    ].join(" "),[user,limit]);
    return result.rows.map(mapped);
  }
  async listActive(user:string,limit:number):Promise<RecurringSchedule[]> {
    const result=await this.pool.query<DbRow>([
      "SELECT",fields,"FROM cortex_reminder_schedules",
      "WHERE user_id=$1 AND status='ACTIVE' ORDER BY next_due_at ASC,id ASC LIMIT $2"
    ].join(" "),[user,limit]);
    return result.rows.map(mapped);
  }
  async get(user:string,id:string):Promise<RecurringSchedule|null>{
    const result=await this.pool.query<DbRow>(
      "SELECT "+fields+" FROM cortex_reminder_schedules WHERE user_id=$1 AND id=$2::uuid",[user,id]);
    return result.rows[0]?mapped(result.rows[0]):null;
  }
  async transition(user:string,id:string,action:"pause"|"resume"|"cancel",at:string):Promise<boolean>{
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      const current=await client.query<DbRow>(
        "SELECT "+fields+" FROM cortex_reminder_schedules WHERE user_id=$1 AND id=$2::uuid FOR UPDATE",
        [user,id]);
      const row=current.rows[0];
      const allowed=row&&(action==="pause"?row.status==="ACTIVE"
        :action==="resume"?row.status==="PAUSED":row.status!=="CANCELLED");
      if(!allowed){await client.query("ROLLBACK");return false;}
      const nextDue=action==="resume"?
        nextRecurrenceAfter(new Date(new Date(at).getTime()+60_000),
          row.frequency,row.local_time,row.weekday).toISOString():iso(row.next_due_at);
      await client.query([
        "UPDATE cortex_reminder_schedules SET status=$3,next_due_at=$4::timestamptz,",
        "paused_at=CASE WHEN $3='PAUSED' THEN $5::timestamptz ELSE NULL END,",
        "cancelled_at=CASE WHEN $3='CANCELLED' THEN $5::timestamptz ELSE cancelled_at END",
        "WHERE user_id=$1 AND id=$2::uuid"
      ].join(" "),[user,id,action==="pause"?"PAUSED":action==="resume"?"ACTIVE":"CANCELLED",nextDue,at]);
      await client.query("COMMIT");
      return true;
    }catch(error){await client.query("ROLLBACK");throw error;}
    finally{client.release();}
  }
  async generateDue(user:string,at:string,limit=100):Promise<number>{
    // A single transaction locks due schedules so replicas cannot create duplicates.
    // On prolonged downtime, create only the oldest missed occurrence per schedule
    // and move next_due_at to the first future slot; do not flood the inbox.
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      const result=await client.query<DbRow>([
        "SELECT",fields,"FROM cortex_reminder_schedules",
        "WHERE user_id=$1 AND status='ACTIVE' AND next_due_at<=$2::timestamptz",
        "ORDER BY next_due_at,id LIMIT $3 FOR UPDATE SKIP LOCKED"
      ].join(" "),[user,at,limit]);
      let inserted=0;
      for(const row of result.rows){
        const due=iso(row.next_due_at);
        const saved=await client.query([
          "INSERT INTO cortex_reminders (id,user_id,title,status,due_at,created_at,schedule_id)",
          "VALUES ($1::uuid,$2,$3,'PENDING',$4::timestamptz,$5::timestamptz,$6::uuid)",
          "ON CONFLICT DO NOTHING RETURNING id"
        ].join(" "),[randomUUID(),user,row.title,due,at,row.id]);
        inserted+=saved.rowCount??0;
        const next=nextRecurrenceAfter(new Date(at),row.frequency,row.local_time,row.weekday);
        await client.query([
          "UPDATE cortex_reminder_schedules SET next_due_at=$3::timestamptz",
          "WHERE user_id=$1 AND id=$2::uuid AND status='ACTIVE'"
        ].join(" "),[user,row.id,next.toISOString()]);
      }
      await client.query("COMMIT");
      return inserted;
    }catch(error){await client.query("ROLLBACK");throw error;}
    finally{client.release();}
  }
}
