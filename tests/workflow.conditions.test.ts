import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApprovalEngine } from "../src/approval/engine.js";
import { InMemoryApprovalStore } from "../src/approval/store.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { InMemoryPermissionStore } from "../src/permissions/in-memory-store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { InMemoryWorkflowStore } from "../src/workflows/store.js";
import { parseWorkflowDefinition, WorkflowInputError } from "../src/workflows/types.js";

function harness() {
  const registry = new ToolRegistry();
  const store = new InMemoryWorkflowStore();
  const approvals = new ApprovalEngine(new InMemoryApprovalStore());
  const executions: Array<{ tool: string; value: number }> = [];

  registry.register({
    name: "test.value", version: "1", description: "Return a number",
    risk: "LOW", permissions: [],
    inputSchema: z.object({ value: z.number() }),
    async execute(input) {
      const value = (input as { value: number }).value;
      executions.push({ tool: "test.value", value });
      return { result: value };
    }
  });
  registry.register({
    name: "test.secure", version: "1", description: "Controlled action",
    risk: "HIGH", permissions: [],
    inputSchema: z.object({ value: z.number() }),
    async execute(input) {
      const value = (input as { value: number }).value;
      executions.push({ tool: "test.secure", value });
      return { result: value };
    }
  });
  const engine = new WorkflowEngine(
    store, registry, new ToolExecutor(registry),
    new PermissionEngine(new InMemoryPermissionStore()), approvals
  );
  return { store, approvals, executions, engine };
}

const when = (operator: "gt" | "lte", value: number) =>
  ({ step: "measure", path: "result", operator, value });
const branch = (result: number) => ({
  objective: "Select a path according to measured output",
  steps: [
    { id: "measure", tool: "test.value", input: { value: result } },
    {
      id: "large", tool: "test.value", input: { value: 100 },
      dependsOn: ["measure"], when: when("gt", 50)
    },
    {
      id: "small", tool: "test.value", input: { value: 10 },
      dependsOn: ["measure"], when: when("lte", 50)
    },
    {
      id: "join", tool: "test.value", input: { value: 1 },
      dependsOn: ["large", "small"], dependsMode: "settled"
    }
  ]
});

describe("CORTEX v4 supervised conditional paths", () => {
  it("runs only the true branch and joins after the false branch is skipped", async () => {
    const { engine, executions, store } = harness();
    const created = await engine.create("a", branch(65));
    expect(created.progress.ready).toEqual(["measure"]);
    expect(created.progress).toMatchObject({ completed: 0, skipped: 0, percent: 0 });
    expect(created.steps[1]?.when).toEqual(when("gt", 50));

    const measured = await engine.advance("a", created.id);
    expect(measured.steps[0]?.status).toBe("COMPLETED");
    expect(measured.steps[1]?.status).toBe("PENDING");
    expect(measured.steps[2]?.status).toBe("SKIPPED");
    expect(measured.steps[2]?.skipReason).toContain("Condition evaluated to false");
    expect(measured.progress.ready).toEqual(["large"]);
    expect(measured.progress).toMatchObject({ completed: 1, skipped: 1, percent: 50 });
    expect(executions).toEqual([{ tool: "test.value", value: 65 }]);
    expect((await store.get("a", created.id))?.steps[2]?.status).toBe("SKIPPED");

    const large = await engine.advance("a", created.id);
    expect(large.progress.ready).toEqual(["join"]);
    expect(executions).toHaveLength(2);

    const done = await engine.advance("a", created.id);
    expect(done.status).toBe("COMPLETED");
    expect(done.progress).toMatchObject({ completed: 3, skipped: 1, percent: 100, ready: [] });
    expect(executions.map(entry => entry.value)).toEqual([65, 100, 1]);
    await engine.advance("a", created.id);
    expect(executions).toHaveLength(3);
  });

  it("selects the alternate path for a lower result", async () => {
    const { engine, executions } = harness();
    const run = await engine.create("a", branch(20));
    const first = await engine.advance("a", run.id);
    expect(first.steps[1]?.status).toBe("SKIPPED");
    expect(first.progress.ready).toEqual(["small"]);
    await engine.advance("a", run.id);
    const completed = await engine.advance("a", run.id);
    expect(completed.status).toBe("COMPLETED");
    expect(completed.progress.skipped).toBe(1);
    expect(executions.map(item => item.value)).toEqual([20, 10, 1]);
  });

  it("propagates unreachable dependencies without calling their tools", async () => {
    const { engine, executions } = harness();
    const created = await engine.create("a", {
      objective: "An alternate branch is not selected",
      steps: [
        { id: "measure", tool: "test.value", input: { value: 12 } },
        { id: "skip", tool: "test.value", input: { value: 2 }, dependsOn: ["measure"], when: when("gt", 50) },
        { id: "descendant", tool: "test.value", input: { value: 3 }, dependsOn: ["skip"] },
        {
          id: "alsoSkip", tool: "test.value", input: { value: 4 },
          dependsOn: ["skip", "descendant"], dependsMode: "settled"
        }
      ]
    });
    const done = await engine.advance("a", created.id);
    expect(done.status).toBe("COMPLETED");
    expect(done.progress).toMatchObject({ completed: 1, skipped: 3, percent: 100 });
    expect(done.steps.map(step => step.status)).toEqual([
      "COMPLETED", "SKIPPED", "SKIPPED", "SKIPPED"
    ]);
    expect(executions.map(item => item.value)).toEqual([12]);
  });

  it("validates conditions, direct dependencies and explicit settled joins", async () => {
    const invalid = [
      {
        objective: "Bad source", steps: [
          { id: "measure", tool: "test.value", input: { value: 10 } },
          { id: "branch", tool: "test.value", input: { value: 20 }, when: when("gt", 10) }
        ]
      },
      {
        objective: "Bad path", steps: [
          { id: "measure", tool: "test.value", input: { value: 10 } },
          { id: "branch", tool: "test.value", input: { value: 20 },
            dependsOn: ["measure"], when: { ...when("gt", 10), path: "__proto__.constructor" } }
        ]
      },
      {
        objective: "Bad comparison", steps: [
          { id: "measure", tool: "test.value", input: { value: 10 } },
          { id: "branch", tool: "test.value", input: { value: 20 },
            dependsOn: ["measure"], when: { ...when("gt", 10), value: "ten" } }
        ]
      },
      {
        objective: "No dependencies", steps: [
          { id: "branch", tool: "test.value", input: { value: 10 }, dependsMode: "settled" }
        ]
      }
    ];
    for (const input of invalid) {
      expect(() => parseWorkflowDefinition(input)).toThrow(WorkflowInputError);
    }
  });

  it("rejects absent outputs and numeric type mismatches without executing a branch", async () => {
    const { engine, executions } = harness();
    const missing = await engine.create("a", {
      objective: "Missing condition path",
      steps: [
        { id: "measure", tool: "test.value", input: { value: 4 } },
        { id: "guarded", tool: "test.value", input: { value: 5 },
          dependsOn: ["measure"], when: { ...when("gt", 3), path: "missing" } }
      ]
    });
    const failed = await engine.advance("a", missing.id);
    expect(failed.status).toBe("FAILED");
    expect(failed.steps[1]?.status).toBe("FAILED");
    expect(failed.steps[1]?.error).toContain("Referenced output path is missing");
    expect(executions.map(item => item.value)).toEqual([4]);
  });

  it("does not create approvals or execute a sensitive step when its condition is false", async () => {
    const { engine, approvals, executions } = harness();
    const created = await engine.create("a", {
      objective: "Guard an action by output",
      steps: [
        { id: "measure", tool: "test.value", input: { value: 10 } },
        { id: "secure", tool: "test.secure", input: { value: 55 },
          dependsOn: ["measure"], when: when("gt", 50) }
      ]
    });
    const done = await engine.advance("a", created.id);
    expect(done.status).toBe("COMPLETED");
    expect(done.steps[1]?.status).toBe("SKIPPED");
    expect(done.steps[1]?.approvalId).toBeUndefined();
    expect(executions.map(e => e.value)).toEqual([10]);

    const truePath = await engine.create("a", {
      objective: "Approve selected action",
      steps: [
        { id: "measure", tool: "test.value", input: { value: 60 } },
        { id: "secure", tool: "test.secure", input: { value: 55 },
          dependsOn: ["measure"], when: when("gt", 50) }
      ]
    });
    await engine.advance("a", truePath.id);
    const waiting = await engine.advance("a", truePath.id);
    expect(waiting.status).toBe("AWAITING_APPROVAL");
    expect(waiting.steps[1]?.approvalId).toBeTruthy();
    expect(executions.map(e => e.value)).toEqual([10, 60]);
    const id = waiting.steps[1]!.approvalId!;
    await expect(engine.advance("a", truePath.id, id)).rejects.toThrow("Approval has not been granted");
    expect((await engine.get("a", truePath.id)).status).toBe("AWAITING_APPROVAL");
    await approvals.approve(id, "a");
    const approved = await engine.advance("a", truePath.id, id);
    expect(approved.status).toBe("COMPLETED");
    expect(executions.map(e => e.value)).toEqual([10, 60, 55]);
  });

  it("treats a manually reconciled outputless condition source as unknown, not false", async () => {
    const { engine, store, executions } = harness();
    const created = await engine.create("a", {
      objective: "Never infer values after reconciliation",
      steps: [
        { id: "measure", tool: "test.value", input: { value: 50 } },
        { id: "guarded", tool: "test.value", input: { value: 1 },
          dependsOn: ["measure"], when: when("gt", 40) }
      ]
    });
    const saved = (await store.get("a", created.id))!;
    const running = structuredClone(saved);
    running.steps[0]!.status = "RUNNING";
    running.steps[0]!.startedAt = new Date(Date.now() - 35_000).toISOString();
    running.version++;
    expect(await store.update("a", saved.version, running)).toBe(true);
    const result = await engine.reconcile("a", created.id, "measure", "completed");
    expect(result.status).toBe("FAILED");
    expect(result.steps[1]?.error).toContain("Referenced output is unavailable");
    expect(executions).toEqual([]);
  });
});
