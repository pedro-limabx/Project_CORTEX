import { Pool } from "pg";
import type { AuditRecord } from "../domain/types.js";
import type { AuditStore } from "./store.js";

export class PostgresAuditStore implements AuditStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    // Serialize schema setup across parallel test workers and backend replicas.
    const client=await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(8142,1518)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS neuron_audit_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        ok BOOLEAN NOT NULL,
        requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS neuron_audit_user_created_idx
      ON neuron_audit_events (user_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS neuron_audit_request_idx
      ON neuron_audit_events (request_id)
    `);
      await client.query("COMMIT");
    } catch(error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async record(entry: AuditRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO neuron_audit_events
        (id, user_id, request_id, tool, ok, requires_approval, error, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [entry.id, entry.userId, entry.requestId, entry.tool, entry.ok,
        entry.requiresApproval, entry.error ?? null, entry.createdAt]
    );
  }
}
