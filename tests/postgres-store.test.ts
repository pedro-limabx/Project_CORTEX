import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { MemoryRecord } from "../src/domain/types.js";
import { PostgresMemoryStore } from "../src/memory/postgres-store.js";

function makeStore(rows: unknown[] = []) {
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValue({ rows });
  const pool = { query } as unknown as Pool;
  return { store: new PostgresMemoryStore(pool), query };
}

const record: MemoryRecord = {
  id: "memory-1",
  userId: "user-1",
  kind: "FACT",
  content: "Pedro prefere respostas em português.",
  importance: 0.8,
  createdAt: "2026-09-29T12:00:00.000Z",
  updatedAt: "2026-09-29T12:00:00.000Z"
};

describe("PostgresMemoryStore", () => {
  it("creates its table and lookup index", async () => {
    const { store, query } = makeStore();
    await store.initialize();

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("CREATE TABLE IF NOT EXISTS neuron_memories");
    expect(query.mock.calls[1]?.[0]).toContain("CREATE INDEX IF NOT EXISTS neuron_memories_user_updated_idx");
  });

  it("saves memories using parameterized SQL", async () => {
    const { store, query } = makeStore();
    await store.save(record);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT (id) DO UPDATE");
    expect(query.mock.calls[0]?.[1]).toEqual([
      record.id,
      record.userId,
      record.kind,
      record.content,
      record.importance,
      record.createdAt,
      record.updatedAt
    ]);
  });

  it("searches only the requested user and maps database rows", async () => {
    const { store, query } = makeStore([{
      id: "memory-2",
      user_id: "user-1",
      kind: "PREFERENCE",
      content: "Gosta de respostas objetivas",
      importance: "0.7",
      created_at: "2026-09-28T10:00:00.000Z",
      updated_at: "2026-09-29T10:00:00.000Z"
    }]);

    const result = await store.search("user-1", "respostas", 5);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual(["user-1", "%respostas%", 5]);
    expect(result).toEqual([{
      id: "memory-2",
      userId: "user-1",
      kind: "PREFERENCE",
      content: "Gosta de respostas objetivas",
      importance: 0.7,
      createdAt: "2026-09-28T10:00:00.000Z",
      updatedAt: "2026-09-29T10:00:00.000Z"
    }]);
  });

  it("does not query the database for invalid limits", async () => {
    const { store, query } = makeStore();
    await expect(store.search("user-1", "anything", 0)).resolves.toEqual([]);
    await expect(store.search("user-1", "anything", -1)).resolves.toEqual([]);
    await expect(store.search("user-1", "anything", 1.5)).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
