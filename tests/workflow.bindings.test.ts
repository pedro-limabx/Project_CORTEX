import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApprovalEngine } from "../src/approval/engine.js";
import { InMemoryApprovalStore } from "../src/approval/store.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { InMemoryPermissionStore } from "../src/permissions/in-memory-store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { calculatorTool } from "../src/tools/builtin.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { InMemoryWorkflowStore } from "../src/workflows/store.js";
import { inspectStepInput } from "../src/workflows/bindings.js";
import { WorkflowInputError } from "../src/workflows/types.js";

function harness() {
  const registry = new ToolRegistry();
  const store = new InMemoryWorkflowStore();
  const approvals = new ApprovalEngine(new InMemoryApprovalStore());
  const history: number[] = [];
  registry.register(calculatorTool);
  registry.register({
    name: "test.record",
    version: "1",
    description: "Records typed values",
    risk: "LOW",
    permissions: [],
    inputSchema: z.object({ value: z.number() }),
    async execute(input) {
      const value = (input as { value: number }).value;
      history.push(value);
      return { value: value * 2 };
    }
  });
  registry.register({
    name: "test.sensitive",
    version: "1",
    description: "A controlled high-risk test action",
    risk: "HIGH",
    permissions: [],
    inputSchema: z.object({ value: z.number() }),
    async execute(input) {
      const value = (input as { value: number }).value;
      history.push(value);
      return { value };
    }
  });
  return {
    store,
    history,
    approvals,
    engine: new WorkflowEngine(
      store, registry, new ToolExecutor(registry),
      new PermissionEngine(new InMemoryPermissionStore()), approvals
    )
  };
}

const direct = (source: string, path: string) => ({ $fromStep: source, path });

describe("CORTEX v3 output bindings", () => {
  it("passes typed numeric output to a downstream tool, preserving raw input", async () => {
    const { engine, store, history } = harness();
    const run = await engine.create("user-a", {
      objective: "Multiply first output by two again",
      steps: [
        { id: "first", tool: "test.record", input: { value: 7 } },
        {
          id: "second", tool: "test.record",
          input: { value: direct("first", "value") },
          dependsOn: ["first"]
        }
      ]
    });

    expect(run.steps[1]?.input).toEqual({ value: direct("first", "value") });
    expect(run.steps[1]?.resolvedInput).toBeUndefined();
    const first = await engine.advance("user-a", run.id);
    expect(first.progress.ready).toEqual(["second"]);
    expect(first.steps[0]?.output).toEqual({ value: 14 });
    const done = await engine.advance("user-a", run.id);
    expect(done.status).toBe("COMPLETED");
    expect(done.steps[1]?.resolvedInput).toEqual({ value: 14 });
    expect(done.steps[1]?.input).toEqual({ value: direct("first", "value") });
    expect(done.steps[1]?.output).toEqual({ value: 28 });
    expect(history).toEqual([7, 14]);
    expect((await store.get("user-a", run.id))?.steps[1]?.resolvedInput).toEqual({ value: 14 });
  });

  it("interpolates arithmetic results into string input for calculator", async () => {
    const { engine } = harness();
    const run = await engine.create("user-a", {
      objective: "Calculate and divide the previous result",
      steps: [
        { id: "first", tool: "calculator.evaluate", input: { expression: "25*18" } },
        {
          id: "second", tool: "calculator.evaluate",
          input: { expression: "{{steps.first.result}}/3" },
          dependsOn: ["first"]
        }
      ]
    });
    await engine.advance("user-a", run.id);
    const result = await engine.advance("user-a", run.id);
    expect(result.status).toBe("COMPLETED");
    expect(result.steps[1]?.resolvedInput).toEqual({ expression: "450/3" });
    expect(result.steps[1]?.output).toEqual({ result: 150 });
  });

  it("rejects undeclared references, malformed paths and unsafe properties during validation", async () => {
    const { engine } = harness();
    const cases: unknown[] = [
      { value: direct("outside", "value") },
      { value: direct("first", "constructor") },
      { value: direct("first", "value.__proto__") },
      { value: { $fromStep: "first", path: "value", extra: 1 } },
      { value: "{{steps.first.result" },
      { value: "{{steps.first.constructor}}" },
      { value: "{{steps.second.value}}" }
    ];
    for (const input of cases) {
      await expect(engine.create("user-a", {
        objective: "Invalid binding",
        steps: [
          { id: "first", tool: "test.record", input: { value: 3 } },
          { id: "second", tool: "test.record", input, dependsOn: ["first"] }
        ]
      })).rejects.toThrow(WorkflowInputError);
    }
    expect(() => inspectStepInput(JSON.parse('{"__proto__":{"admin":true}}'), "second", ["first"]))
      .toThrow("Unsafe workflow input property");
  });

  it("fails closed if the resolved path is absent, without executing the consumer", async () => {
    const { engine, history } = harness();
    const run = await engine.create("user-a", {
      objective: "Missing parent output field",
      steps: [
        { id: "first", tool: "test.record", input: { value: 2 } },
        {
          id: "second", tool: "test.record",
          input: { value: direct("first", "missing") },
          dependsOn: ["first"]
        }
      ]
    });
    await engine.advance("user-a", run.id);
    const failed = await engine.advance("user-a", run.id);
    expect(failed.status).toBe("FAILED");
    expect(failed.steps[1]?.error).toContain("Referenced output path is missing");
    expect(failed.steps[1]?.resolvedInput).toBeUndefined();
    expect(history).toEqual([2]);
  });

  it("rejects a mismatched resolved type before any downstream side effect", async () => {
    const { engine, history } = harness();
    const run = await engine.create("user-a", {
      objective: "Mismatched input type",
      steps: [
        { id: "first", tool: "test.record", input: { value: 2 } },
        {
          id: "second", tool: "test.record",
          input: { value: "{{steps.first.value}}" },
          dependsOn: ["first"]
        }
      ]
    });
    await engine.advance("user-a", run.id);
    const failed = await engine.advance("user-a", run.id);
    expect(failed.status).toBe("FAILED");
    expect(failed.steps[1]?.error).toContain("does not match tool schema");
    expect(history).toEqual([2]);
  });

  it("binds approvals and execution to identical persisted values", async () => {
    const { engine, store, approvals, history } = harness();
    const run = await engine.create("user-a", {
      objective: "Sensitive typed consumption",
      steps: [
        { id: "first", tool: "test.record", input: { value: 5 } },
        {
          id: "second", tool: "test.sensitive",
          input: { value: direct("first", "value") },
          dependsOn: ["first"]
        }
      ]
    });
    await engine.advance("user-a", run.id);
    const waiting = await engine.advance("user-a", run.id);
    expect(waiting.status).toBe("AWAITING_APPROVAL");
    expect(waiting.steps[1]?.resolvedInput).toEqual({ value: 10 });
    expect(history).toEqual([5]);
    const approvalId = waiting.steps[1]?.approvalId;
    expect(approvalId).toBeTruthy();
    await expect(engine.advance("user-a", run.id, approvalId)).rejects.toThrow("Approval has not been granted");
    expect((await store.get("user-a", run.id))?.steps[1]?.resolvedInput).toEqual({ value: 10 });

    await approvals.approve(approvalId!, "user-a");
    const done = await engine.advance("user-a", run.id, approvalId);
    expect(done.status).toBe("COMPLETED");
    expect(done.steps[1]?.resolvedInput).toEqual({ value: 10 });
    expect(history).toEqual([5, 10]);
  });

  it("does not invent outputs after manual reconciliation of an interrupted step", async () => {
    const { engine, store } = harness();
    const run = await engine.create("user-a", {
      objective: "Require a genuinely stored upstream output",
      steps: [
        { id: "first", tool: "test.record", input: { value: 3 } },
        {
          id: "second", tool: "test.record",
          input: { value: direct("first", "value") }, dependsOn: ["first"]
        }
      ]
    });
    const saved = (await store.get("user-a", run.id))!;
    const interrupted = structuredClone(saved);
    interrupted.steps[0]!.status = "RUNNING";
    interrupted.steps[0]!.startedAt = new Date(Date.now() - 35_000).toISOString();
    interrupted.version++;
    expect(await store.update("user-a", saved.version, interrupted)).toBe(true);

    await engine.reconcile("user-a", run.id, "first", "completed");
    const result = await engine.advance("user-a", run.id);
    expect(result.status).toBe("FAILED");
    expect(result.steps[1]?.error).toContain("Referenced output is unavailable");
  });
});
