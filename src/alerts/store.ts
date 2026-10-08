import type { Pool } from "pg";
import type { WorkflowStatus } from "../workflows/types.js";

export interface AlertKey {
  workflowId: string;
  version: number;
  status: WorkflowStatus;
}

export interface AlertAcknowledgement extends AlertKey {
  acknowledgedAt: string;
}

export interface AlertAcknowledgementStore {
  /** Return acknowledgements for exact current versions; never reveal other users. */
  listCurrent(userId: string, keys: readonly AlertKey[]): Promise<AlertAcknowledgement[]>;
  /** Idempotent, atomic one-time acknowledgement for an exact alert version. */
  acknowledge(userId: string, key: AlertKey, at: string): Promise<AlertAcknowledgement>;
}

function identity(userId: string, key: AlertKey): string {
  return JSON.stringify([userId, key.workflowId, key.version, key.status]);
}

function clone(value: AlertAcknowledgement): AlertAcknowledgement {
  return { ...value };
}

export class InMemoryAlertAcknowledgementStore implements AlertAcknowledgementStore {
  private readonly records = new Map<string, AlertAcknowledgement>();

  async listCurrent(userId: string, keys: readonly AlertKey[]): Promise<AlertAcknowledgement[]> {
    return keys.flatMap(key => {
      const record = this.records.get(identity(userId, key));
      return record ? [clone(record)] : [];
    });
  }

  async acknowledge(
    userId: string, key: AlertKey, at: string
  ): Promise<AlertAcknowledgement> {
    const id = identity(userId, key);
    const existing = this.records.get(id);
    if (existing) return clone(existing);
    const record = { ...key, acknowledgedAt: at };
    this.records.set(id, record);
    return clone(record);
  }
}

function fromRow(row: {
  workflow_id: string;
  workflow_version: number;
  workflow_status: WorkflowStatus;
  acknowledged_at: Date | string;
}): AlertAcknowledgement {
  return {
    workflowId: row.workflow_id,
    version: row.workflow_version,
    status: row.workflow_status,
    acknowledgedAt: new Date(row.acknowledged_at).toISOString()
  };
}

export class PostgresAlertAcknowledgementStore implements AlertAcknowledgementStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query([
      "CREATE TABLE IF NOT EXISTS cortex_alert_acknowledgements (",
      "user_id TEXT NOT NULL,",
      "workflow_id UUID NOT NULL,",
      "workflow_version INTEGER NOT NULL,",
      "workflow_status TEXT NOT NULL,",
      "acknowledged_at TIMESTAMPTZ NOT NULL,",
      "PRIMARY KEY (user_id, workflow_id, workflow_version, workflow_status)",
      ")"
    ].join(" "));
    await this.pool.query([
      "CREATE INDEX IF NOT EXISTS cortex_alert_ack_user_time_idx",
      "ON cortex_alert_acknowledgements (user_id, acknowledged_at DESC)"
    ].join(" "));
  }

  async listCurrent(userId: string, keys: readonly AlertKey[]): Promise<AlertAcknowledgement[]> {
    if (!keys.length) return [];
    // The caller only provides owner-scoped current versions. One parameterized
    // join avoids per-alert queries and never scans unrelated users' records.
    const result = await this.pool.query([
      "SELECT a.workflow_id, a.workflow_version, a.workflow_status, a.acknowledged_at",
      "FROM cortex_alert_acknowledgements AS a",
      "JOIN jsonb_to_recordset($2::jsonb) AS requested(",
      "workflow_id UUID, workflow_version INTEGER, workflow_status TEXT",
      ") ON a.workflow_id = requested.workflow_id",
      "AND a.workflow_version = requested.workflow_version",
      "AND a.workflow_status = requested.workflow_status",
      "WHERE a.user_id = $1"
    ].join(" "), [
      userId,
      JSON.stringify(keys.map(key => ({
        workflow_id: key.workflowId,
        workflow_version: key.version,
        workflow_status: key.status
      })))
    ]);
    return (result.rows as Array<{
      workflow_id: string; workflow_version: number;
      workflow_status: WorkflowStatus; acknowledged_at: Date | string;
    }>).map(fromRow);
  }

  async acknowledge(
    userId: string, key: AlertKey, at: string
  ): Promise<AlertAcknowledgement> {
    const inserted = await this.pool.query([
      "INSERT INTO cortex_alert_acknowledgements",
      "(user_id, workflow_id, workflow_version, workflow_status, acknowledged_at)",
      "VALUES ($1, $2::uuid, $3, $4, $5)",
      "ON CONFLICT (user_id, workflow_id, workflow_version, workflow_status) DO NOTHING",
      "RETURNING workflow_id, workflow_version, workflow_status, acknowledged_at"
    ].join(" "), [userId, key.workflowId, key.version, key.status, at]);
    if (inserted.rows[0]) return fromRow(inserted.rows[0] as {
      workflow_id: string; workflow_version: number;
      workflow_status: WorkflowStatus; acknowledged_at: Date | string;
    });

    const existing = await this.pool.query([
      "SELECT workflow_id, workflow_version, workflow_status, acknowledged_at",
      "FROM cortex_alert_acknowledgements",
      "WHERE user_id = $1 AND workflow_id = $2::uuid",
      "AND workflow_version = $3 AND workflow_status = $4"
    ].join(" "), [userId, key.workflowId, key.version, key.status]);
    if (!existing.rows[0]) {
      throw new Error("Acknowledgement not found after concurrent insert");
    }
    return fromRow(existing.rows[0] as {
      workflow_id: string; workflow_version: number;
      workflow_status: WorkflowStatus; acknowledged_at: Date | string;
    });
  }
}
