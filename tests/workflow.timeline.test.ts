import { describe, expect, it } from "vitest";
import { ApprovalEngine } from "../src/approval/engine.js";
import { InMemoryApprovalStore } from "../src/approval/store.js";
import { InMemoryPermissionStore } from "../src/permissions/in-memory-store.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { calculatorTool } from "../src/tools/builtin.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { appendWorkflowEvents, workflowTimeline } from "../src/workflows/timeline.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { InMemoryWorkflowStore } from "../src/workflows/store.js";
import type { WorkflowRun } from "../src/workflows/types.js";

function harness() {
  const store = new InMemoryWorkflowStore();
  const registry = new ToolRegistry();
  registry.register(calculatorTool);
  const engine = new WorkflowEngine(
    store, registry, new ToolExecutor(registry),
    new PermissionEngine(new InMemoryPermissionStore()),
    new ApprovalEngine(new InMemoryApprovalStore())
  );
  return { engine, store };
}

describe("CORTEX v6 persisted workflow timeline", () => {
  it("records creation and step changes in order, without serializing tool payloads", async () => {
    const { engine, store } = harness();
    const created = await engine.create("owner", {
      objective: "Private objective: do not copy to diagnostic logs",
      steps: [
        { id: "one", tool: "calculator.evaluate", input: { expression: "25*18" } },
        { id: "two", tool: "calculator.evaluate", input: { expression: "{{steps.one.result}}/3" },
          dependsOn: ["one"] }
      ]
    });
    expect(created.events).toMatchObject([{ seq: 1, kind: "WORKFLOW_CREATED" }]);

    const first = await engine.advance("owner", created.id);
    expect(first.steps[0]?.status).toBe("COMPLETED");
    const second = await engine.advance("owner", created.id);
    expect(second.status).toBe("COMPLETED");

    const report = await engine.timeline("owner", created.id);
    expect(report.readOnly).toBe(true);
    expect(report.historyComplete).toBe(true);
    expect(report.progress.completed).toBe(2);
    expect(report.diagnostic.level).toBe("info");
    expect(report.events).toHaveLength(5);
    expect(report.events.map(e => e.seq)).toEqual([5, 4, 3, 2, 1]);
    expect(report.events.filter(e => e.to === "COMPLETED")).toHaveLength(2);
    expect(report.events[0]).toMatchObject({
      stepId: "two", from: "RUNNING", to: "COMPLETED", source: "engine"
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("25*18");
    expect(serialized).not.toContain("Private objective");
    expect(serialized).not.toContain("450/3");
    expect(await store.get("owner", created.id)).toMatchObject({ version: 5 });
    await expect(engine.timeline("stranger", created.id))
      .rejects.toThrow("Workflow not found");
    const unchanged = await store.get("owner", created.id);
    expect(unchanged?.events).toHaveLength(5);
  });

  it("records skipped conditional paths separately from tool executions", async () => {
    const { engine } = harness();
    const run = await engine.create("owner", {
      objective: "Guarded calculation",
      steps: [
        { id: "measure", tool: "calculator.evaluate", input: { expression: "10+2" } },
        { id: "unused", tool: "calculator.evaluate", input: { expression: "10+5" },
          dependsOn: ["measure"],
          when: { step: "measure", path: "result", operator: "gt", value: 50 } },
        { id: "used", tool: "calculator.evaluate", input: { expression: "7*8" },
          dependsOn: ["measure"],
          when: { step: "measure", path: "result", operator: "lte", value: 50 } }
      ]
    });
    const measured = await engine.advance("owner", run.id);
    expect(measured.steps.find(s => s.id === "unused")?.status).toBe("SKIPPED");
    const timeline = await engine.timeline("owner", run.id);
    expect(timeline.events).toContainEqual(expect.objectContaining({
      stepId: "unused", from: "PENDING", to: "SKIPPED", source: "routing"
    }));
    const done = await engine.advance("owner", run.id);
    expect(done.status).toBe("COMPLETED");
    expect((await engine.timeline("owner", run.id)).events
      .filter(e => e.stepId === "unused")).toHaveLength(1);
  });

  it("records manual recovery authorization without disclosing the operator note", async () => {
    const { engine } = harness();
    const run = await engine.create("owner", {
      objective: "Fallback only after confirmation",
      steps: [
        { id: "primary", tool: "calculator.evaluate", input: { expression: "10/0" } },
        { id: "fallback", tool: "calculator.evaluate", input: { expression: "7+8" },
          dependsOn: ["primary"], onFailureOf: "primary" }
      ]
    });
    const failed = await engine.advance("owner", run.id);
    expect(failed.status).toBe("RECOVERY_REQUIRED");
    const pending = await engine.timeline("owner", run.id);
    expect(pending.diagnostic.nextAction).toContain("autorize");
    const confidential = "Investigação interna 2026: referência particular 893722.";
    await engine.authorizeRecovery("owner", run.id, "primary", confidential);
    const report = await engine.timeline("owner", run.id);
    expect(report.status).toBe("RECOVERING");
    expect(report.events).toContainEqual(expect.objectContaining({
      kind: "RECOVERY_AUTHORIZED", stepId: "primary", source: "operator"
    }));
    expect(JSON.stringify(report)).not.toContain(confidential);
    expect(JSON.stringify(report)).not.toContain("Division by zero");
    const done = await engine.advance("owner", run.id);
    expect(done.status).toBe("COMPLETED_WITH_FAILURES");
    expect((await engine.timeline("owner", run.id)).diagnostic.message)
      .toContain("caminho alternativo");
  });

  it("does not synthesize an imaginary history for legacy workflows", async () => {
    const { engine, store } = harness();
    const created = await engine.create("owner", {
      objective: "Legacy workflow", steps: [
        { id: "step", tool: "calculator.evaluate", input: { expression: "2+2" } }
      ]
    });
    const stored = (await store.get("owner", created.id))!;
    const legacy = structuredClone(stored);
    delete legacy.events;
    legacy.version++;
    expect(await store.update("owner", stored.version, legacy)).toBe(true);
    const before = await engine.timeline("owner", created.id);
    expect(before.events).toEqual([]);
    expect(before.historyComplete).toBe(false);
    await engine.advance("owner", created.id);
    const after = await engine.timeline("owner", created.id);
    expect(after.historyComplete).toBe(false);
    expect(after.events[0]?.kind).toBe("STEP_STATUS_CHANGED");
  });

  it("enforces limits and preserves monotonically increasing event sequences", () => {
    const base: WorkflowRun = {
      id: "22222222-2222-4222-8222-222222222222",
      userId: "owner", version: 1, objective: "Simple",
      createdAt: "2026-10-08T12:00:00Z", updatedAt: "2026-10-08T12:00:00Z",
      steps: [{ id: "s", tool: "test.tool", input: {},
        dependsOn: [], status: "PENDING" }],
      events: [{ seq: 1, at: "2026-10-08T12:00:00Z",
        kind: "WORKFLOW_CREATED", source: "engine" }]
    };
    let current = base;
    for (let i = 0; i < 270; i++) {
      const next = structuredClone(current);
      next.steps[0]!.status = i % 2 === 0 ? "RUNNING" : "PENDING";
      appendWorkflowEvents(current, next, "engine", "2026-10-08T12:01:00Z");
      current = next;
    }
    expect(current.events).toHaveLength(256);
    expect(current.events?.at(-1)?.seq).toBe(271);
    const report = workflowTimeline(current, 10);
    expect(report.events).toHaveLength(10);
    expect(report.events[0]?.seq).toBe(271);
    expect(report.historyComplete).toBe(false);
    expect(() => workflowTimeline(current, 101)).toThrow("limit");
    expect(() => workflowTimeline(current, 0)).toThrow("limit");
    expect(() => workflowTimeline(current, 1.5)).toThrow("limit");
  });

  it("provides read-only actionable diagnoses for uncertain and waiting states", () => {
    const run: WorkflowRun = {
      id: "22222222-2222-4222-8222-222222222222",
      userId: "owner", version: 3, objective: "Control",
      createdAt: "2026-10-08T12:00:00Z", updatedAt: "2026-10-08T12:02:00Z",
      steps: [{
        id: "s", tool: "test.tool", input: {},
        dependsOn: [], status: "RUNNING"
      }]
    };
    const result = workflowTimeline(run);
    expect(result.status).toBe("NEEDS_RECONCILIATION");
    expect(result.diagnostic.level).toBe("critical");
    expect(result.diagnostic.nextAction).toContain("Verifique");
    expect(result.events).toEqual([]);
    expect(result.historyComplete).toBe(false);
  });
});
