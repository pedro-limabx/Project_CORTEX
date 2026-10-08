import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
export type AlertStatus = "FAILED" | "NEEDS_RECONCILIATION" | "AWAITING_APPROVAL" | "RECOVERY_REQUIRED" | "RECOVERING";
export type Severity = "critical" | "attention";
export type Candidate = { workflowId: string; version: number; status: AlertStatus; severity: Severity };
export type Notice = Candidate & { id: string; createdAt: string; readAt: string | null };
export type Settings = { enabled: boolean; intervalSeconds: number; cooldownSeconds: number; nextCheckAt: string; lastCheckedAt: string | null; lastCheckOk: boolean | null };
export type Event = { id: string; kind: "SETTINGS_UPDATED" | "CHECK_COMPLETED" | "CHECK_FAILED"; sampled: number; created: number; createdAt: string };
export interface MonitorRepository {
  getSettings(user: string): Promise<Settings>;
  configure(user: string, enabled: boolean, intervalSeconds: number, cooldownSeconds: number): Promise<Settings>;
  withLock<T>(user: string, action: () => Promise<T>): Promise<T | undefined>;
  insert(user: string, notice: Candidate, cooldown: number, at: string): Promise<boolean>;
  complete(user: string, at: string, ok: boolean, sampled: number, created: number): Promise<void>;
  list(user: string, view: "all" | "unread", limit: number): Promise<{ notifications: Notice[]; unread: number }>;
  read(user: string, id: string, at: string): Promise<boolean>;
  events(user: string, limit: number): Promise<Event[]>;
}
type SettingRow = {enabled: boolean; interval_seconds: number; cooldown_seconds: number; next_check_at: Date | string; last_checked_at: Date | string | null; last_check_ok: boolean | null};
const iso = (date: Date | string): string => new Date(date).toISOString();
function setting(row: SettingRow): Settings {
  return { enabled: row.enabled, intervalSeconds: row.interval_seconds, cooldownSeconds: row.cooldown_seconds,
    nextCheckAt: iso(row.next_check_at), lastCheckedAt: row.last_checked_at ? iso(row.last_checked_at) : null,
    lastCheckOk: row.last_check_ok };
}
export class PostgresMonitorRepository implements MonitorRepository {
  constructor(private readonly pool: Pool) {}
  async initialize(): Promise<void> {
    await this.pool.query([
      "CREATE TABLE IF NOT EXISTS cortex_monitor_settings (",
      "user_id TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT FALSE,",
      "interval_seconds INTEGER NOT NULL DEFAULT 60 CHECK(interval_seconds BETWEEN 60 AND 3600),",
      "cooldown_seconds INTEGER NOT NULL DEFAULT 600 CHECK(cooldown_seconds BETWEEN 60 AND 86400),",
      "last_checked_at TIMESTAMPTZ, next_check_at TIMESTAMPTZ NOT NULL DEFAULT now(),",
      "last_check_ok BOOLEAN)"
    ].join(" "));
    await this.pool.query([
      "CREATE TABLE IF NOT EXISTS cortex_persistent_notifications (",
      "id UUID PRIMARY KEY, user_id TEXT NOT NULL, workflow_id UUID NOT NULL,",
      "workflow_version INTEGER NOT NULL, workflow_status TEXT NOT NULL,",
      "severity TEXT NOT NULL CHECK(severity IN ('critical','attention')),",
      "created_at TIMESTAMPTZ NOT NULL, read_at TIMESTAMPTZ,",
      "UNIQUE(user_id, workflow_id, workflow_version, workflow_status))"
    ].join(" "));
    await this.pool.query("CREATE INDEX IF NOT EXISTS cortex_notify_recent ON cortex_persistent_notifications (user_id, created_at DESC)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS cortex_notify_cooldown ON cortex_persistent_notifications (user_id, workflow_id, workflow_status, created_at DESC)");
    await this.pool.query([
      "CREATE TABLE IF NOT EXISTS cortex_monitor_events (",
      "id UUID PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,",
      "sampled INTEGER NOT NULL, created INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL)"
    ].join(" "));
    await this.pool.query("CREATE INDEX IF NOT EXISTS cortex_monitor_events_recent ON cortex_monitor_events (user_id, created_at DESC)");
  }
  private async ensure(user: string) {
    await this.pool.query("INSERT INTO cortex_monitor_settings(user_id) VALUES($1) ON CONFLICT DO NOTHING", [user]);
  }
  async getSettings(user: string): Promise<Settings> {
    await this.ensure(user);
    const result = await this.pool.query<SettingRow>(
      "SELECT enabled, interval_seconds, cooldown_seconds, next_check_at, last_checked_at, last_check_ok FROM cortex_monitor_settings WHERE user_id=$1", [user]);
    if (!result.rows[0]) throw new Error("Monitor settings not found");
    return setting(result.rows[0]);
  }
  private async event(user: string, kind: Event["kind"], sampled: number, created: number, at: string) {
    await this.pool.query(
      "INSERT INTO cortex_monitor_events(id,user_id,kind,sampled,created,created_at) VALUES($1,$2,$3,$4,$5,$6)",
      [randomUUID(), user, kind, sampled, created, at]);
  }
  async configure(user: string, enabled: boolean, intervalSeconds: number, cooldownSeconds: number): Promise<Settings> {
    await this.ensure(user);
    const updated = await this.pool.query<SettingRow>([
      "UPDATE cortex_monitor_settings SET enabled=$2, interval_seconds=$3, cooldown_seconds=$4,",
      "next_check_at=CASE WHEN $2 AND NOT enabled THEN now() ELSE next_check_at END",
      "WHERE user_id=$1 RETURNING enabled,interval_seconds,cooldown_seconds,next_check_at,last_checked_at,last_check_ok"
    ].join(" "), [user, enabled, intervalSeconds, cooldownSeconds]);
    await this.event(user, "SETTINGS_UPDATED", 0, 0, new Date().toISOString());
    if (!updated.rows[0]) throw new Error("Monitor settings not found");
    return setting(updated.rows[0]);
  }
  async withLock<T>(user: string, action: () => Promise<T>): Promise<T | undefined> {
    // Shared PostgreSQL session advisory lock across all backend replicas.
    const client = await this.pool.connect();
    let locked = false;
    try {
      const result = await client.query<{locked: boolean}>(
        "SELECT pg_try_advisory_lock(hashtext('cortex-v10'), hashtext($1::text)) AS locked", [user]);
      locked = result.rows[0]?.locked === true;
      if (!locked) return undefined;
      return await action();
    } finally {
      try {
        if (locked) await client.query(
          "SELECT pg_advisory_unlock(hashtext('cortex-v10'), hashtext($1::text))", [user]);
      } finally { client.release(); }
    }
  }
  async insert(user: string, n: Candidate, cooldown: number, at: string): Promise<boolean> {
    const inserted = await this.pool.query([
      "INSERT INTO cortex_persistent_notifications",
      "(id,user_id,workflow_id,workflow_version,workflow_status,severity,created_at)",
      "SELECT $1::uuid,$2,$3::uuid,$4,$5,$6,$7::timestamptz",
      "WHERE NOT EXISTS (SELECT 1 FROM cortex_persistent_notifications",
      "WHERE user_id=$2 AND workflow_id=$3::uuid AND workflow_status=$5",
      "AND created_at > $7::timestamptz - ($8::integer * interval '1 second'))",
      "ON CONFLICT (user_id,workflow_id,workflow_version,workflow_status) DO NOTHING",
      "RETURNING id"
    ].join(" "), [randomUUID(), user, n.workflowId, n.version, n.status, n.severity, at, cooldown]);
    return inserted.rows.length > 0;
  }
  async complete(user: string, at: string, ok: boolean, sampled: number, created: number): Promise<void> {
    await this.pool.query([
      "UPDATE cortex_monitor_settings SET last_checked_at=$2::timestamptz, last_check_ok=$3,",
      "next_check_at=$2::timestamptz + (interval_seconds * interval '1 second')",
      "WHERE user_id=$1"
    ].join(" "), [user, at, ok]);
    await this.event(user, ok ? "CHECK_COMPLETED" : "CHECK_FAILED", sampled, created, at);
  }
  async list(user: string, view: "all" | "unread", limit: number) {
    const [rows, count] = await Promise.all([
      this.pool.query<{id: string;workflow_id: string;workflow_version: number;workflow_status: AlertStatus;
        severity: Severity;created_at: Date | string;read_at: Date | string | null}>([
        "SELECT id,workflow_id,workflow_version,workflow_status,severity,created_at,read_at",
        "FROM cortex_persistent_notifications WHERE user_id=$1",
        "AND ($2::text='all' OR read_at IS NULL) ORDER BY created_at DESC,id DESC LIMIT $3"
      ].join(" "), [user, view, limit]),
      this.pool.query<{unread: string}>(
        "SELECT count(*)::text AS unread FROM cortex_persistent_notifications WHERE user_id=$1 AND read_at IS NULL", [user])
    ]);
    return { notifications: rows.rows.map(n => ({id:n.id,workflowId:n.workflow_id,version:n.workflow_version,
      status:n.workflow_status,severity:n.severity,createdAt:iso(n.created_at),readAt:n.read_at?iso(n.read_at):null})),
      unread:Number(count.rows[0]?.unread ?? 0) };
  }
  async read(user: string, id: string, at: string): Promise<boolean> {
    const result = await this.pool.query([
      "UPDATE cortex_persistent_notifications SET read_at=COALESCE(read_at,$3::timestamptz)",
      "WHERE user_id=$1 AND id=$2::uuid RETURNING id"
    ].join(" "), [user,id,at]);
    return result.rows.length===1;
  }
  async events(user: string, limit: number): Promise<Event[]> {
    const result = await this.pool.query<{id:string;kind:Event["kind"];sampled:number;created:number;created_at:Date|string}>([
      "SELECT id,kind,sampled,created,created_at FROM cortex_monitor_events",
      "WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2"
    ].join(" "), [user,limit]);
    return result.rows.map(row=>({id:row.id,kind:row.kind,sampled:row.sampled,
      created:row.created,createdAt:iso(row.created_at)}));
  }
}
