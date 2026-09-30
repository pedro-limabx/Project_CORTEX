import { Pool } from "pg";
import type { AuditRecord } from "../domain/types.js";
import type { AuditStore } from "./store.js";

export class PostgresAuditStore implements AuditStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
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
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS neuron_audit_user_created_idx
      ON neuron_audit_events (user_id, created_at DESC)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS neuron_audit_request_idx
      ON neuron_audit_events (request_id)
    `);
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
