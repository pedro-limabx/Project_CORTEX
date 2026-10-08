import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApprovalEngine } from "../src/approval/engine.js";
import { InMemoryApprovalStore } from "../src/approval/store.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { InMemoryPermissionStore } from "../src/permissions/in-memory-store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { InMemoryWorkflowStore } from "../src/workflows/store.js";
import { WorkflowInputError, workflowStatus } from "../src/workflows/types.js";

const NOTE = "Verifiquei no sistema externo que a operação falhou sem efeito.";

function harness() {
  const store = new InMemoryWorkflowStore();
  const registry = new ToolRegistry();
  const approvals = new ApprovalEngine(new InMemoryApprovalStore());
  const calls: string[] = [];
  registry.register({
    name: "test.fail", version: "1", description: "Controlled failure",
    risk: "LOW", permissions: [],
    inputSchema: z.object({}),
    async execute() {
      calls.push("fail");
      throw new Error("controlled execution failure");
    }
  });
  registry.register({
    name: "test.value", version: "1", description: "Record a value",
    risk: "LOW", permissions: [],
    inputSchema: z.object({ value: z.number() }),
    async execute(input) {
      const value = (input as { value: number }).value;
      calls.push("value:" + value);
      return { value };
    }
  });
  registry.register({
    name: "test.secure", version: "1", description: "Requires approval",
    risk: "HIGH", permissions: [],
    inputSchema: z.object({ value: z.number() }),
    async execute(input) {
      const value = (input as { value: number }).value;
      calls.push("secure:" + value);
      return { value };
    }
  });
  const executor = new ToolExecutor(registry);
  const engine = new WorkflowEngine(
    store, registry, executor,
    new PermissionEngine(new InMemoryPermissionStore()), approvals
  );
  return { store, approvals, calls, executor, engine };
}

function recoveryDefinition(tool = "test.value", failTool = "test.fail") {
  return {
    objective: "Investigate and continue through alternate path",
    steps: [
      { id: "primary", tool: failTool,
        input: failTool === "test.fail" ? {} : { value: 7 } },
      { id: "normal", tool: "test.value",
        input: { value: 99 }, dependsOn: ["primary"] },
      { id: "fallback", tool, input: { value: 15 },
        dependsOn: ["primary"], onFailureOf: "primary" },
      { id: "final", tool: "test.value", input: { value: 22 },
        dependsOn: ["fallback"] }
    ]
  };
}

describe("CORTEX v5 supervised failure recovery", () => {
  it("cannot run a recovery until operator confirmation, never replays the failure", async () => {
    const { engine, store, calls } = harness();
    const run = await engine.create("owner", recoveryDefinition());
    expect(run.status).toBe("ACTIVE");

    const failed = await engine.advance("owner", run.id);
    expect(failed.status).toBe("RECOVERY_REQUIRED");
    expect(failed.progress).toMatchObject({ failed: 1, completed: 0 });
    expect(failed.steps[0]?.status).toBe("FAILED");
    expect(failed.steps[2]?.status).toBe("PENDING");
    expect(calls).toEqual(["fail"]);
    await expect(engine.advance("owner", run.id)).rejects.toThrow("operator recovery authorization");
    expect(calls).toEqual(["fail"]);

    await expect(engine.authorizeRecovery("owner", run.id, "primary", "short"))
      .rejects.toThrow(WorkflowInputError);
    await expect(engine.authorizeRecovery("another", run.id, "primary", NOTE))
      .rejects.toThrow("Workflow not found");
    const authorized = await engine.authorizeRecovery("owner", run.id, "primary", NOTE);
    expect(authorized.status).toBe("RECOVERING");
    expect(authorized.recoveries).toMatchObject([{
      stepId: "primary", note: NOTE
    }]);
    expect(authorized.steps[1]?.status).toBe("SKIPPED");
    expect(authorized.steps[2]?.status).toBe("PENDING");
    expect(authorized.progress.ready).toEqual(["fallback"]);
    expect(calls).toEqual(["fail"]);

    const persisted = await store.get("owner", run.id);
    expect(persisted?.recoveries?.[0]?.stepId).toBe("primary");
    const intermediate = await engine.advance("owner", run.id);
    expect(intermediate.status).toBe("RECOVERING");
    expect(intermediate.progress.ready).toEqual(["final"]);
    expect(calls).toEqual(["fail", "value:15"]);

    const finished = await engine.advance("owner", run.id);
    expect(finished.status).toBe("COMPLETED_WITH_FAILURES");
    expect(finished.progress).toMatchObject({
      completed: 2, skipped: 1, failed: 1, percent: 100, ready: []
    });
    expect(calls).toEqual(["fail", "value:15", "value:22"]);
    expect(workflowStatus((await store.get("owner", run.id))!))
      .toBe("COMPLETED_WITH_FAILURES");
    await engine.advance("owner", run.id);
    expect(calls).toHaveLength(3);
  });

  it("skips the unused recovery handler if the original action succeeds", async () => {
    const { engine, calls } = harness();
    const created = await engine.create("owner", recoveryDefinition("test.value", "test.value"));
    const afterPrimary = await engine.advance("owner", created.id);
    expect(afterPrimary.status).toBe("ACTIVE");
    expect(afterPrimary.steps[2]?.status).toBe("SKIPPED");
    expect(afterPrimary.steps[3]?.status).toBe("SKIPPED");
    expect(afterPrimary.progress.ready).toEqual(["normal"]);
    expect(afterPrimary.progress).toMatchObject({ completed: 1, skipped: 2 });
    expect(calls).toEqual(["value:7"]);

    const done = await engine.advance("owner", created.id);
    expect(done.status).toBe("COMPLETED");
    expect(done.progress.percent).toBe(100);
    expect(calls).toEqual(["value:7", "value:99"]);
  });

  it("preserves sensitive-tool approvals for authorized recovery handlers", async () => {
    const { engine, approvals, calls } = harness();
    const run = await engine.create("owner", recoveryDefinition("test.secure"));
    await engine.advance("owner", run.id);
    await engine.authorizeRecovery("owner", run.id, "primary", NOTE);
    expect(calls).toEqual(["fail"]);

    const pending = await engine.advance("owner", run.id);
    expect(pending.status).toBe("AWAITING_APPROVAL");
    const approvalId = pending.steps[2]?.approvalId;
    expect(approvalId).toBeTruthy();
    expect(calls).toEqual(["fail"]);
    await expect(engine.advance("owner", run.id, approvalId))
      .rejects.toThrow("Approval has not been granted");
    await approvals.approve(approvalId!, "owner");
    const completed = await engine.advance("owner", run.id, approvalId);
    expect(completed.status).toBe("RECOVERING");
    expect(completed.steps[2]?.resolvedInput).toEqual({ value: 15 });
    expect(calls).toEqual(["fail", "secure:15"]);
  });

  it("requires verified reconciliation after an ambiguous tool timeout", async () => {
    const { engine, store, executor, calls } = harness();
    const run = await engine.create("owner", recoveryDefinition());
    const originalExecute = executor.execute.bind(executor);
    const mocked = vi.spyOn(executor, "execute").mockImplementationOnce(async () => ({
      tool: "test.fail", ok: false, error: "Tool timeout"
    }));
    const ambiguous = await engine.advance("owner", run.id);
    expect(mocked).toHaveBeenCalledOnce();
    expect(ambiguous.status).toBe("NEEDS_RECONCILIATION");
    expect(ambiguous.steps[0]?.status).toBe("RUNNING");
    expect(ambiguous.steps[0]?.error).toBe("Tool timeout");
    await expect(engine.authorizeRecovery("owner", run.id, "primary", NOTE))
      .rejects.toThrow("Reconcile uncertain");
    await expect(engine.advance("owner", run.id)).rejects.toThrow("reconciliation");
    expect(calls).toEqual([]);

    // Fast-forward only the persisted start time to simulate a timed-out external operation.
    const previous = (await store.get("owner", run.id))!;
    const aged = structuredClone(previous);
    aged.steps[0]!.startedAt = new Date(Date.now() - 35_000).toISOString();
    aged.version++;
    expect(await store.update("owner", previous.version, aged)).toBe(true);
    const verified = await engine.reconcile("owner", run.id, "primary", "failed");
    expect(verified.status).toBe("RECOVERY_REQUIRED");
    const authorized = await engine.authorizeRecovery("owner", run.id, "primary", NOTE);
    expect(authorized.status).toBe("RECOVERING");
    mocked.mockRestore();
    expect(originalExecute).toBeDefined();
  });

  it("rejects undeclared, ambiguous or cyclic recovery definitions", async () => {
    const { engine } = harness();
    const valid = recoveryDefinition();
    const invalid = [
      { ...valid, steps: valid.steps.map(step => step.id === "fallback"
        ? { ...step, dependsOn: [] } : step) },
      { ...valid, steps: [
        ...valid.steps,
        { id: "other-handler", tool: "test.value", input: { value: 1 },
          dependsOn: ["primary"], onFailureOf: "primary" }
      ] },
      { ...valid, steps: valid.steps.map(step => step.id === "fallback"
        ? { ...step, when: { step: "primary", path: "result", operator: "eq", value: 1 } }
        : step) },
      { ...valid, steps: valid.steps.map(step => step.id === "fallback"
        ? { ...step, dependsMode: "settled" } : step) },
      { ...valid, steps: valid.steps.map(step => step.id === "fallback"
        ? { ...step, input: { value: { $fromStep: "primary", path: "value" } } } : step) },
      { ...valid, steps: valid.steps.map(step => step.id === "fallback"
        ? { ...step, onFailureOf: "not-present", dependsOn: ["primary", "not-present"] } : step) }
    ];
    for (const definition of invalid) {
      await expect(engine.create("owner", definition)).rejects.toThrow(WorkflowInputError);
    }
  });

  it("does not duplicate operator records under concurrent authorization requests", async () => {
    const { engine, store, calls } = harness();
    const run = await engine.create("owner", recoveryDefinition());
    await engine.advance("owner", run.id);
    const results = await Promise.allSettled([
      engine.authorizeRecovery("owner", run.id, "primary", NOTE),
      engine.authorizeRecovery("owner", run.id, "primary", NOTE)
    ]);
    expect(results.some(result => result.status === "fulfilled")).toBe(true);
    // Depending on read timing the second call either returns the existing
    // authorization idempotently or loses the optimistic version race.
    const persisted = await store.get("owner", run.id);
    expect(persisted?.recoveries).toHaveLength(1);
    expect(calls).toEqual(["fail"]);
  });
});
