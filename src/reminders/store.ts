import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type ReminderStatus = "PENDING" | "DUE" | "DONE" | "CANCELLED";
export type Reminder = {
  id: string; title: string; dueAt: string; createdAt: string;
  status: ReminderStatus; triggeredAt: string | null;
  completedAt: string | null; cancelledAt: string | null;
};
export type ReminderView = "all" | "pending" | "due" | "done" | "cancelled";

export interface ReminderRepository {
  create(user: string, title: string, dueAt: string, createdAt: string): Promise<Reminder>;
  list(user: string, view: ReminderView, limit: number): Promise<Reminder[]>;
  get(user: string, id: string): Promise<Reminder | null>;
  transition(user: string, id: string, target: "DONE" | "CANCELLED", at: string): Promise<boolean>;
  markDue(user: string, at: string, limit: number): Promise<number>;
  dueCount(user: string): Promise<number>;
  listWindow(user:string,from:string,until:string,limit:number):Promise<Reminder[]>;
}

type Row = {
  id: string; title: string; status: ReminderStatus;
  due_at: Date | string; created_at: Date | string;
  triggered_at: Date | string | null; completed_at: Date | string | null;
  cancelled_at: Date | string | null;
};
const iso = (at: Date | string): string => new Date(at).toISOString();
const map = (row: Row): Reminder => ({
  id: row.id, title: row.title, status: row.status,
  dueAt: iso(row.due_at), createdAt: iso(row.created_at),
  triggeredAt: row.triggered_at ? iso(row.triggered_at) : null,
  completedAt: row.completed_at ? iso(row.completed_at) : null,
  cancelledAt: row.cancelled_at ? iso(row.cancelled_at) : null
});
const FIELDS = "id,title,status,due_at,created_at,triggered_at,completed_at,cancelled_at";

export class PostgresReminderRepository implements ReminderRepository {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query([
      "CREATE TABLE IF NOT EXISTS cortex_reminders (",
      "id UUID PRIMARY KEY, user_id TEXT NOT NULL,",
      "title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),",
      "status TEXT NOT NULL DEFAULT 'PENDING'",
      "CHECK (status IN ('PENDING','DUE','DONE','CANCELLED')),",
      "due_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL,",
      "triggered_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ)"
    ].join(" "));
    await this.pool.query([
      "CREATE INDEX IF NOT EXISTS cortex_reminders_due",
      "ON cortex_reminders (user_id, due_at, id) WHERE status='PENDING'"
    ].join(" "));
    await this.pool.query([
      "CREATE INDEX IF NOT EXISTS cortex_reminders_inbox",
      "ON cortex_reminders (user_id, due_at DESC, id)"
    ].join(" "));
  }

  async create(user: string, title: string, dueAt: string, createdAt: string): Promise<Reminder> {
    const result = await this.pool.query<Row>([
      "INSERT INTO cortex_reminders (id,user_id,title,due_at,created_at)",
      "VALUES ($1::uuid,$2,$3,$4::timestamptz,$5::timestamptz)",
      "RETURNING", FIELDS
    ].join(" "), [randomUUID(), user, title, dueAt, createdAt]);
    if (!result.rows[0]) throw new Error("Unable to save reminder");
    return map(result.rows[0]);
  }

  async list(user: string, view: ReminderView, limit: number): Promise<Reminder[]> {
    const result = await this.pool.query<Row>([
      "SELECT", FIELDS, "FROM cortex_reminders WHERE user_id=$1",
      "AND ($2::text='all' OR lower(status)=$2::text)",
      "ORDER BY CASE WHEN status='DUE' THEN 0 WHEN status='PENDING' THEN 1 ELSE 2 END,",
      "due_at ASC, id ASC LIMIT $3"
    ].join(" "), [user, view, limit]);
    return result.rows.map(map);
  }

  async listWindow(user:string,from:string,until:string,limit:number):Promise<Reminder[]> {
    const result=await this.pool.query<Row>([
      "SELECT",FIELDS,"FROM cortex_reminders",
      "WHERE user_id=$1 AND status IN ('PENDING','DUE')",
      "AND due_at >= $2::timestamptz AND due_at < $3::timestamptz",
      "ORDER BY due_at ASC,id ASC LIMIT $4"
    ].join(" "),[user,from,until,limit]);
    return result.rows.map(map);
  }

  async get(user: string, id: string): Promise<Reminder | null> {
    const result = await this.pool.query<Row>(
      "SELECT " + FIELDS + " FROM cortex_reminders WHERE user_id=$1 AND id=$2::uuid",
      [user, id]);
    return result.rows[0] ? map(result.rows[0]) : null;
  }

  async transition(user: string, id: string, target: "DONE" | "CANCELLED", at: string): Promise<boolean> {
    const result = await this.pool.query([
      "UPDATE cortex_reminders SET status=$3,",
      "completed_at=CASE WHEN $3='DONE' THEN $4::timestamptz ELSE completed_at END,",
      "cancelled_at=CASE WHEN $3='CANCELLED' THEN $4::timestamptz ELSE cancelled_at END",
      "WHERE user_id=$1 AND id=$2::uuid AND status IN ('PENDING','DUE')",
      "RETURNING id"
    ].join(" "), [user, id, target, at]);
    return result.rows.length === 1;
  }

  async markDue(user: string, at: string, limit: number): Promise<number> {
    // SKIP LOCKED allows parallel replicas without duplicate transitions.
    // A crashed process simply leaves uncommitted rows PENDING for the next pass.
    const result = await this.pool.query([
      "WITH candidate AS (",
      "SELECT id FROM cortex_reminders",
      "WHERE user_id=$1 AND status='PENDING' AND due_at <= $2::timestamptz",
      "ORDER BY due_at ASC, id ASC LIMIT $3 FOR UPDATE SKIP LOCKED)",
      "UPDATE cortex_reminders AS r SET status='DUE', triggered_at=$2::timestamptz",
      "FROM candidate WHERE r.id=candidate.id AND r.user_id=$1 AND r.status='PENDING'",
      "RETURNING r.id"
    ].join(" "), [user, at, limit]);
    return result.rows.length;
  }

  async dueCount(user: string): Promise<number> {
    const result = await this.pool.query<{count: string}>(
      "SELECT count(*)::text AS count FROM cortex_reminders WHERE user_id=$1 AND status='DUE'",
      [user]);
    return Number(result.rows[0]?.count ?? 0);
  }
}
