import type { Pool } from "pg";
import type { WorkflowRun } from "./types.js";

export interface WorkflowStore {
  create(run: WorkflowRun): Promise<void>;
  get(userId: string, id: string): Promise<WorkflowRun | undefined>;
  list(userId: string, limit: number): Promise<WorkflowRun[]>;
  /** Atomic compare-and-swap. False means another request advanced this run. */
  update(userId: string, expectedVersion: number, run: WorkflowRun): Promise<boolean>;
}

function copy(run: WorkflowRun): WorkflowRun {
  return structuredClone(run);
}

export class InMemoryWorkflowStore implements WorkflowStore {
  private readonly runs = new Map<string, WorkflowRun>();

  async create(run: WorkflowRun): Promise<void> {
    if (this.runs.has(run.id)) throw new Error("Workflow id collision");
    this.runs.set(run.id, copy(run));
  }

  async get(userId: string, id: string): Promise<WorkflowRun | undefined> {
    const run = this.runs.get(id);
    return run?.userId === userId ? copy(run) : undefined;
  }

  async list(userId: string, limit: number): Promise<WorkflowRun[]> {
    return [...this.runs.values()]
      .filter(run => run.userId === userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map(copy);
  }

  async update(userId: string, expectedVersion: number, run: WorkflowRun): Promise<boolean> {
    const previous = this.runs.get(run.id);
    if (!previous || previous.userId !== userId || run.userId !== userId
      || previous.version !== expectedVersion || run.version !== expectedVersion + 1) {
      return false;
    }
    this.runs.set(run.id, copy(run));
    return true;
  }
}

export class PostgresWorkflowStore implements WorkflowStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS cortex_workflows (
        id UUID PRIMARY KEY,
        user_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        state JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS cortex_workflows_user_updated_idx
      ON cortex_workflows (user_id, updated_at DESC)
    `);
  }

  async create(run: WorkflowRun): Promise<void> {
    await this.pool.query(
      `INSERT INTO cortex_workflows (id, user_id, version, state, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [run.id, run.userId, run.version, JSON.stringify(run), run.createdAt, run.updatedAt]
    );
  }

  async get(userId: string, id: string): Promise<WorkflowRun | undefined> {
    const result = await this.pool.query(
      "SELECT state FROM cortex_workflows WHERE id = $1 AND user_id = $2",
      [id, userId]
    );
    const value: unknown = result.rows[0]?.state;
    return value ? value as WorkflowRun : undefined;
  }

  async list(userId: string, limit: number): Promise<WorkflowRun[]> {
    const result = await this.pool.query(
      `SELECT state FROM cortex_workflows
       WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`,
      [userId, limit]
    );
    return result.rows.map(row => row.state as WorkflowRun);
  }

  async update(userId: string, expectedVersion: number, run: WorkflowRun): Promise<boolean> {
    if (run.userId !== userId || run.version !== expectedVersion + 1) return false;
    const result = await this.pool.query(
      `UPDATE cortex_workflows
       SET version = $4, state = $5::jsonb, updated_at = $6
       WHERE id = $1 AND user_id = $2 AND version = $3
       RETURNING id`,
      [run.id, userId, expectedVersion, run.version, JSON.stringify(run), run.updatedAt]
    );
    return result.rows.length === 1;
  }
}
