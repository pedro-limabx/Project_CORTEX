import type { Pool } from "pg";
import type { ApprovalRequest, ApprovalStore } from "./store.js";

export class PostgresApprovalStore implements ApprovalStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS neuron_approval_requests (
        id UUID PRIMARY KEY,
        user_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        arguments_hash TEXT NOT NULL,
        risk TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        approved_at TIMESTAMPTZ,
        consumed_at TIMESTAMPTZ,
        rejected_at TIMESTAMPTZ
      )
    `);
  }

  async create(request: ApprovalRequest): Promise<void> {
    await this.pool.query(
      `INSERT INTO neuron_approval_requests
        (id, user_id, tool, arguments_hash, risk, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [request.id, request.userId, request.tool, request.argumentsHash, request.risk, request.createdAt, request.expiresAt]
    );
  }

  async get(id: string): Promise<ApprovalRequest | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM neuron_approval_requests WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    return row ? this.map(row) : undefined;
  }

  async approve(id: string, userId: string): Promise<ApprovalRequest | undefined> {
    const result = await this.pool.query(
      `UPDATE neuron_approval_requests
       SET approved_at = NOW()
       WHERE id = $1 AND user_id = $2 AND approved_at IS NULL
         AND rejected_at IS NULL AND consumed_at IS NULL AND expires_at > NOW()
       RETURNING *`,
      [id, userId]
    );
    return result.rows[0] ? this.map(result.rows[0]) : undefined;
  }

  async reject(id: string, userId: string): Promise<ApprovalRequest | undefined> {
    const result = await this.pool.query(
      `UPDATE neuron_approval_requests
       SET rejected_at = NOW()
       WHERE id = $1 AND user_id = $2 AND approved_at IS NULL
         AND rejected_at IS NULL AND consumed_at IS NULL
       RETURNING *`,
      [id, userId]
    );
    return result.rows[0] ? this.map(result.rows[0]) : undefined;
  }

  async consume(id: string, userId: string): Promise<ApprovalRequest | undefined> {
    const result = await this.pool.query(
      `UPDATE neuron_approval_requests
       SET consumed_at = NOW()
       WHERE id = $1 AND user_id = $2 AND approved_at IS NOT NULL
         AND rejected_at IS NULL AND consumed_at IS NULL AND expires_at > NOW()
       RETURNING *`,
      [id, userId]
    );
    return result.rows[0] ? this.map(result.rows[0]) : undefined;
  }

  private map(row: Record<string, unknown>): ApprovalRequest {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      tool: String(row.tool),
      argumentsHash: String(row.arguments_hash),
      risk: row.risk as ApprovalRequest["risk"],
      createdAt: new Date(String(row.created_at)).toISOString(),
      expiresAt: new Date(String(row.expires_at)).toISOString(),
      ...(row.approved_at ? { approvedAt: new Date(String(row.approved_at)).toISOString() } : {}),
      ...(row.consumed_at ? { consumedAt: new Date(String(row.consumed_at)).toISOString() } : {}),
      ...(row.rejected_at ? { rejectedAt: new Date(String(row.rejected_at)).toISOString() } : {})
    };
  }
}
