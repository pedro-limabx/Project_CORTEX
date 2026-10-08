import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PostgresWorkflowStore } from "../src/workflows/store.js";
import type { WorkflowRun } from "../src/workflows/types.js";

const run: WorkflowRun = {
  id: "008d0d90-51eb-44b4-a92e-9fe6e0d527e6",
  userId: "user-a",
  objective: "Persist a workflow",
  version: 1,
  createdAt: "2026-10-07T12:00:00.000Z",
  updatedAt: "2026-10-07T12:00:00.000Z",
  steps: [{
    id: "step-1",
    tool: "test.record",
    input: { value: 1 },
    dependsOn: [],
    status: "PENDING"
  }]
};

describe("PostgreSQL workflow persistence", () => {
  it("creates an isolated workflow table and list index", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const store = new PostgresWorkflowStore({ query } as unknown as Pool);
    await store.initialize();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("CREATE TABLE IF NOT EXISTS cortex_workflows");
    expect(query.mock.calls[1]?.[0]).toContain("CREATE INDEX IF NOT EXISTS cortex_workflows_user_updated_idx");
  });

  it("writes state as parameterized JSON and enforces atomic version updates", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: run.id }] }));
    const store = new PostgresWorkflowStore({ query } as unknown as Pool);
    await store.create(run);
    const createArgs = query.mock.calls[0];
    expect(createArgs?.[0]).toContain("INSERT INTO cortex_workflows");
    expect(createArgs?.[1]).toEqual([
      run.id, run.userId, 1, JSON.stringify(run), run.createdAt, run.updatedAt
    ]);

    const next: WorkflowRun = { ...run, version: 2 };
    expect(await store.update("user-a", 1, next)).toBe(true);
    const updateArgs = query.mock.calls[1];
    expect(updateArgs?.[0]).toContain("version = $3");
    expect(updateArgs?.[0]).toContain("user_id = $2");
    expect(updateArgs?.[1]).toEqual([
      run.id, run.userId, 1, 2, JSON.stringify(next), next.updatedAt
    ]);
    expect(await store.update("user-a", 1, { ...run, version: 3 })).toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("filters reads to the server-controlled user and handles update conflicts", async () => {
    const query = vi.fn(async (statement: string) => {
      if (statement.startsWith("UPDATE")) return { rows: [] };
      return { rows: [{ state: run }] };
    });
    const store = new PostgresWorkflowStore({ query } as unknown as Pool);
    expect(await store.get("user-a", run.id)).toEqual(run);
    expect(query.mock.calls[0]?.[1]).toEqual([run.id, "user-a"]);
    expect((await store.list("user-a", 5))[0]).toEqual(run);
    expect(query.mock.calls[1]?.[1]).toEqual(["user-a", 5]);
    expect(await store.update("user-a", 1, { ...run, version: 2 })).toBe(false);
  });
});
