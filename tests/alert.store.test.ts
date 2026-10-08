import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PostgresAlertAcknowledgementStore } from "../src/alerts/store.js";

const key = {
  workflowId: "11111111-2222-4111-8111-111111111111",
  version: 5,
  status: "FAILED" as const
};
const at = "2026-10-08T19:10:00.000Z";

function setup() {
  const query = vi.fn(async (..._args: unknown[]) => ({
    rows: [] as Record<string, unknown>[]
  }));
  const store = new PostgresAlertAcknowledgementStore(
    { query } as unknown as Pool
  );
  return { store, query };
}

const row = {
  workflow_id: key.workflowId,
  workflow_version: key.version,
  workflow_status: key.status,
  acknowledged_at: at
};

describe("CORTEX PostgreSQL alert acknowledgements", () => {
  it("creates a scoped, unique and indexed acknowledgement table", async () => {
    const { store, query } = setup();
    await store.initialize();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("CREATE TABLE IF NOT EXISTS cortex_alert_acknowledgements");
    expect(query.mock.calls[0]?.[0]).toContain(
      "PRIMARY KEY (user_id, workflow_id, workflow_version, workflow_status)"
    );
    expect(query.mock.calls[1]?.[0]).toContain("cortex_alert_ack_user_time_idx");
  });

  it("retrieves only exact current version/status with an owner-scoped parameterized join", async () => {
    const { store, query } = setup();
    query.mockResolvedValueOnce({ rows: [row] });
    const result = await store.listCurrent("owner-a", [key]);
    expect(result).toEqual([{ ...key, acknowledgedAt: at }]);
    const [sql, args] = query.mock.calls[0]!;
    expect(sql).toContain("jsonb_to_recordset($2::jsonb)");
    expect(sql).toContain("a.user_id = $1");
    expect(args).toEqual(["owner-a", JSON.stringify([{
      workflow_id: key.workflowId,
      workflow_version: key.version,
      workflow_status: key.status
    }])]);

    await expect(store.listCurrent("owner-a", [])).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("inserts acknowledgement only once using conflict-free, parameterized SQL", async () => {
    const { store, query } = setup();
    query.mockResolvedValueOnce({ rows: [row] });
    const acknowledged = await store.acknowledge("owner-a", key, at);
    expect(acknowledged).toEqual({ ...key, acknowledgedAt: at });
    const [sql, args] = query.mock.calls[0]!;
    expect(sql).toContain("ON CONFLICT (user_id, workflow_id, workflow_version, workflow_status) DO NOTHING");
    expect(sql).toContain("RETURNING workflow_id");
    expect(args).toEqual(["owner-a", key.workflowId, 5, "FAILED", at]);
  });

  it("returns the original timestamp when concurrent inserts already acknowledged", async () => {
    const { store, query } = setup();
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [row] });
    const result = await store.acknowledge(
      "owner-a", key, "2026-10-09T00:00:00.000Z"
    );
    expect(result.acknowledgedAt).toBe(at);
    expect(query).toHaveBeenCalledTimes(2);
    const [sql, args] = query.mock.calls[1]!;
    expect(sql).toContain("WHERE user_id = $1 AND workflow_id = $2::uuid");
    expect(args).toEqual(["owner-a", key.workflowId, key.version, key.status]);
  });

  it("rejects unexpected missing data after a concurrent insert conflict", async () => {
    const { store } = setup();
    await expect(store.acknowledge("owner-a", key, at))
      .rejects.toThrow("Acknowledgement not found");
  });
});
