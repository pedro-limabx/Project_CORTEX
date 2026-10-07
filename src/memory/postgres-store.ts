import { Pool } from "pg";
import type { MemoryRecord } from "../domain/types.js";
import type { MemoryStore } from "./store.js";

export class PostgresMemoryStore implements MemoryStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS neuron_memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('SESSION', 'PREFERENCE', 'FACT', 'TASK', 'ACTION')),
        content TEXT NOT NULL,
        importance DOUBLE PRECISION NOT NULL DEFAULT 0.3,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS neuron_memories_user_updated_idx
      ON neuron_memories (user_id, updated_at DESC)
    `);
  }

  async save(record: MemoryRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO neuron_memories
        (id, user_id, kind, content, importance, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         kind = EXCLUDED.kind,
         content = EXCLUDED.content,
         importance = EXCLUDED.importance,
         updated_at = EXCLUDED.updated_at`,
      [
        record.id,
        record.userId,
        record.kind,
        record.content,
        record.importance,
        record.createdAt,
        record.updatedAt
      ]
    );
  }

  async getTask(userId: string, taskId: string): Promise<MemoryRecord | undefined> {
    const result = await this.pool.query(
      `SELECT id, user_id, kind, content, importance, created_at, updated_at
       FROM neuron_memories
       WHERE user_id = $1 AND kind = 'TASK' AND id = $2
       LIMIT 1`,
      [userId, taskId]
    );

    const row = result.rows[0];
    if (!row) return undefined;

    return {
      id: String(row.id),
      userId: String(row.user_id),
      kind: row.kind,
      content: String(row.content),
      importance: Number(row.importance),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }

  async listTasks(userId: string, limit: number): Promise<MemoryRecord[]> {
    if (!Number.isInteger(limit) || limit <= 0) return [];

    const result = await this.pool.query(
      `SELECT id, user_id, kind, content, importance, created_at, updated_at
       FROM neuron_memories
       WHERE user_id = $1 AND kind = 'TASK'
       ORDER BY updated_at DESC
       LIMIT $2`,
      [userId, limit]
    );

    return result.rows.map(row => ({
      id: String(row.id),
      userId: String(row.user_id),
      kind: row.kind,
      content: String(row.content),
      importance: Number(row.importance),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    }));
  }

  async search(userId: string, query: string, limit: number): Promise<MemoryRecord[]> {
    if (!Number.isInteger(limit) || limit <= 0) return [];

    const result = await this.pool.query(
      `SELECT id, user_id, kind, content, importance, created_at, updated_at
       FROM neuron_memories
       WHERE user_id = $1 AND content ILIKE $2
       ORDER BY importance DESC, updated_at DESC
       LIMIT $3`,
      [userId, `%${escapeLike(query)}%`, limit]
    );

    return result.rows.map(row => ({
      id: String(row.id),
      userId: String(row.user_id),
      kind: row.kind,
      content: String(row.content),
      importance: Number(row.importance),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    }));
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
