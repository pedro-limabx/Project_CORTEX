import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApprovalEngine } from "../src/approval/engine.js";
import { InMemoryApprovalStore } from "../src/approval/store.js";
import { InMemoryPermissionStore } from "../src/permissions/in-memory-store.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { InMemoryWorkflowStore } from "../src/workflows/store.js";
import {
  parseWorkflowDefinition,
  workflowStatus,
  WorkflowConflictError,
  WorkflowInputError
} from "../src/workflows/types.js";

function makeHarness() {
  const registry = new ToolRegistry();
  const store = new InMemoryWorkflowStore();
  const approvalEngine = new ApprovalEngine(new InMemoryApprovalStore());
  const permissions = new PermissionEngine(new InMemoryPermissionStore());
  const counts: string[] = [];

  registry.register({
    name: "test.record",
    version: "1.0.0",
    description: "Record a deterministic test step",
    risk: "LOW",
    permissions: [],
    inputSchema: z.object({ value: z.number() }),
    async execute(input) {
      const data = input as { value: number };
      counts.push("record:" + data.value);
      return { value: data.value * 2 };
    }
  });

  registry.register({
    name: "test.sensitive",
    version: "1.0.0",
    description: "High-risk action requiring explicit approval",
    risk: "HIGH",
    permissions: [],
    inputSchema: z.object({ value: z.number() }),
    async execute(input) {
      const data = input as { value: number };
      counts.push("sensitive:" + data.value);
      return { value: data.value };
    }
  });

  registry.register({
    name: "test.fail",
    version: "1.0.0",
    description: "Fail safely",
    risk: "LOW",
    permissions: [],
    inputSchema: z.object({}),
    async execute() {
      counts.push("fail");
      throw new Error("simulated execution failure");
    }
  });

  const engine = new WorkflowEngine(
    store,
    registry,
    new ToolExecutor(registry),
    permissions,
    approvalEngine
  );
  return { engine, store, registry, counts, approvalEngine };
}

describe("Workflow dependency validation", () => {
  it("rejects duplicates, missing parents, cycles and self-references", () => {
    const s = (id: string, dependsOn: string[] = []) =>
      ({ id, tool: "test.record", input: { value: 1 }, dependsOn });
    const cases = [
      [s("a"), s("a")],
      [s("a", ["missing"])],
      [s("a", ["b"]), s("b", ["a"])],
      [s("a", ["a"])],
      [s("a", ["b", "b"]), s("b")]
    ];
    for (const steps of cases) {
      expect(() => parseWorkflowDefinition({ objective: "Check invalid workflow", steps }))
        .toThrow(WorkflowInputError);
    }
  });

  it("rejects invalid inputs or unavailable tools during creation", async () => {
    const { engine } = makeHarness();
    await expect(engine.create("user-a", {
      objective: "bad tool", steps: [{ id: "a", tool: "missing", input: {} }]
    })).rejects.toThrow("Unknown tool");
    await expect(engine.create("user-a", {
      objective: "invalid schema", steps: [{ id: "a", tool: "test.record", input: { value: "wrong" } }]
    })).rejects.toThrow("Invalid input");
  });
});

describe("Workflow orchestration", () => {
  it("executes a DAG in dependency order, one persisted step per advance", async () => {
    const { engine, counts, store } = makeHarness();
    const created = await engine.create("user-a", {
      objective: "Build an ordered workflow",
      steps: [
        { id: "third", tool: "test.record", input: { value: 3 }, dependsOn: ["second"] },
        { id: "second", tool: "test.record", input: { value: 2 }, dependsOn: ["first"] },
        { id: "first", tool: "test.record", input: { value: 1 } }
      ]
    });
    expect(created.progress).toEqual({ completed: 0, total: 3, percent: 0, ready: ["first"] });
    expect(created.status).toBe("ACTIVE");

    const first = await engine.advance("user-a", created.id);
    expect(first.progress.ready).toEqual(["second"]);
    expect(first.progress.completed).toBe(1);
    expect(first.steps.find(s => s.id === "first")?.output).toEqual({ value: 2 });
    expect((await store.get("user-a", created.id))?.version).toBe(3);

    const second = await engine.advance("user-a", created.id);
    expect(second.progress.ready).toEqual(["third"]);
    expect(second.progress.percent).toBe(67);

    const finished = await engine.advance("user-a", created.id);
    expect(finished.status).toBe("COMPLETED");
    expect(finished.progress.percent).toBe(100);
    expect(counts).toEqual(["record:1", "record:2", "record:3"]);
    await engine.advance("user-a", created.id);
    expect(counts).toHaveLength(3);
    expect(await engine.list("user-b", 20)).toEqual([]);
    await expect(engine.get("user-b", created.id)).rejects.toThrow("Workflow not found");
    await expect(engine.get("user-a", "not-a-uuid")).rejects.toThrow("Workflow not found");
  });

  it("enforces approval before executing a sensitive dependency", async () => {
    const { engine, approvalEngine, counts } = makeHarness();
    const created = await engine.create("user-a", {
      objective: "Do sensitive work before reporting",
      steps: [
        { id: "sensitive", tool: "test.sensitive", input: { value: 9 } },
        { id: "final", tool: "test.record", input: { value: 5 }, dependsOn: ["sensitive"] }
      ]
    });
    const awaiting = await engine.advance("user-a", created.id);
    expect(awaiting.status).toBe("AWAITING_APPROVAL");
    expect(counts).toEqual([]);
    expect(awaiting.progress.ready).toEqual([]);
    const approvalId = awaiting.steps[0]?.approvalId;
    expect(approvalId).toBeTruthy();
    expect((await engine.advance("user-a", created.id)).status).toBe("AWAITING_APPROVAL");
    await expect(engine.advance("user-a", created.id, "incorrect"))
      .rejects.toThrow("Approval id does not match");
    expect(await approvalEngine.approve(approvalId!, "user-a")).toBeDefined();

    const completedStep = await engine.advance("user-a", created.id, approvalId);
    expect(completedStep.status).toBe("ACTIVE");
    expect(completedStep.steps[0]?.status).toBe("COMPLETED");
    expect(counts).toEqual(["sensitive:9"]);
    expect((await engine.advance("user-a", created.id)).status).toBe("COMPLETED");
    expect(counts).toEqual(["sensitive:9", "record:5"]);
    await expect(engine.advance("user-a", created.id, approvalId)).resolves.toMatchObject({
      status: "COMPLETED"
    });
    expect(counts).toHaveLength(2);
  });

  it("stops the workflow after an execution failure instead of retrying", async () => {
    const { engine, counts } = makeHarness();
    const created = await engine.create("user-a", {
      objective: "Handle a failing task",
      steps: [
        { id: "fail", tool: "test.fail", input: {} },
        { id: "blocked", tool: "test.record", input: { value: 1 }, dependsOn: ["fail"] }
      ]
    });
    const failed = await engine.advance("user-a", created.id);
    expect(failed.status).toBe("FAILED");
    expect(failed.steps[0]?.error).toContain("simulated execution failure");
    expect(failed.steps[1]?.status).toBe("PENDING");
    await expect(engine.advance("user-a", created.id)).rejects.toThrow(WorkflowConflictError);
    expect(counts).toEqual(["fail"]);
  });

  it("prevents advancing interrupted RUNNING steps without manual reconciliation", async () => {
    const { engine, store, counts } = makeHarness();
    const created = await engine.create("user-a", {
      objective: "Never replay ambiguous work",
      steps: [
        { id: "first", tool: "test.record", input: { value: 1 } },
        { id: "second", tool: "test.record", input: { value: 2 }, dependsOn: ["first"] }
      ]
    });
    const saved = (await store.get("user-a", created.id))!;
    const interrupted = structuredClone(saved);
    interrupted.steps[0]!.status = "RUNNING";
    interrupted.steps[0]!.startedAt = new Date(Date.now() - 35_000).toISOString();
    interrupted.version++;
    expect(await store.update("user-a", saved.version, interrupted)).toBe(true);
    expect(workflowStatus(interrupted)).toBe("NEEDS_RECONCILIATION");
    await expect(engine.advance("user-a", created.id)).rejects.toThrow("reconciliation");
    const verified = await engine.reconcile("user-a", created.id, "first", "completed");
    expect(verified.progress.ready).toEqual(["second"]);
    expect(verified.steps[0]?.status).toBe("COMPLETED");
    expect(counts).toEqual([]);
    const final = await engine.advance("user-a", created.id);
    expect(final.status).toBe("COMPLETED");
    expect(counts).toEqual(["record:2"]);
  });

  it("enforces optimistic compare-and-swap and reconciliation grace period", async () => {
    const { engine, store } = makeHarness();
    const created = await engine.create("user-a", {
      objective: "Concurrent update protection",
      steps: [{ id: "first", tool: "test.record", input: { value: 1 } }]
    });
    const prior = (await store.get("user-a", created.id))!;
    const version2 = { ...prior, version: 2 };
    expect(await store.update("user-a", 1, version2)).toBe(true);
    expect(await store.update("user-a", 1, version2)).toBe(false);
    const running = structuredClone(version2);
    running.version = 3;
    running.steps[0]!.status = "RUNNING";
    running.steps[0]!.startedAt = new Date().toISOString();
    expect(await store.update("user-a", 2, running)).toBe(true);
    await expect(engine.reconcile("user-a", created.id, "first", "completed"))
      .rejects.toThrow("Wait for the in-flight execution timeout");
  });
});
