import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LLMProvider, LLMResponse, MemoryRecord } from "../src/domain/types.js";
import { InMemoryStore } from "../src/memory/store.js";
import { NeuronCore } from "../src/neuron/core.js";
import { ApprovalEngine } from "../src/approval/engine.js";
import { InMemoryApprovalStore } from "../src/approval/store.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { InMemoryPermissionStore } from "../src/permissions/in-memory-store.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { parseTaskPlan, reconcileInterruptedPlan, taskToResponse } from "../src/neuron/task.js";

function makeCore(provider: LLMProvider, memory: InMemoryStore, registry: ToolRegistry, approvals: ApprovalEngine) {
  return new NeuronCore(
    provider,
    memory,
    registry,
    new ToolExecutor(registry),
    new PermissionEngine(new InMemoryPermissionStore()),
    approvals
  );
}

function toolCall(name: string, id = "tool-1"): LLMResponse {
  return {
    provider: "test",
    text: "",
    toolCalls: [{ id, name, arguments: "{}" }]
  };
}

describe("Persisted task lifecycle", () => {
  it("persists PLANNED before executing and COMPLETED after execution", async () => {
    const memory = new InMemoryStore();
    const registry = new ToolRegistry();
    let observedStatus = "";
    registry.register({
      name: "test.write",
      version: "1.0.0",
      description: "Test persisted execution ordering",
      risk: "LOW",
      permissions: [],
      inputSchema: z.object({}),
      async execute() {
        const tasks = await memory.listTasks("user-1", 10);
        observedStatus = parseTaskPlan(tasks[0]?.content ?? "").steps[0]?.status ?? "";
        return { done: true };
      }
    });
    let calls = 0;
    const provider: LLMProvider = {
      async chat() {
        return ++calls === 1 ? toolCall("test.write") : { provider: "test", text: "Concluído." };
      }
    };
    const result = await makeCore(provider, memory, registry, new ApprovalEngine(new InMemoryApprovalStore()))
      .respond("user-1", "Grave um resultado.");
    expect(observedStatus).toBe("PLANNED");
    expect(result.plan.status).toBe("COMPLETED");
    const record = await memory.getTask("user-1", "task:" + result.requestId + ":1");
    expect(parseTaskPlan(record?.content ?? "").steps[0]?.status).toBe("COMPLETED");
  });

  it("pauses HIGH risk tools and resumes with the same approved arguments exactly once", async () => {
    const memory = new InMemoryStore();
    const approvalEngine = new ApprovalEngine(new InMemoryApprovalStore());
    const registry = new ToolRegistry();
    let executed = 0;
    registry.register({
      name: "test.sensitive",
      version: "1.0.0",
      description: "Test approval flow",
      risk: "HIGH",
      permissions: [],
      inputSchema: z.object({}),
      async execute() {
        executed++;
        return { ok: true };
      }
    });

    let calls = 0;
    const provider: LLMProvider = {
      async chat() {
        return ++calls === 1
          ? toolCall("test.sensitive")
          : { provider: "test", text: "Operação aprovada e finalizada." };
      }
    };
    const first = await makeCore(provider, memory, registry, approvalEngine)
      .respond("user-1", "Execute a ação sensível.");
    expect(first.plan.steps[0]?.status).toBe("AWAITING_APPROVAL");
    expect(first.plan.status).not.toBe("COMPLETED");
    expect(executed).toBe(0);
    const approvalId = first.plan.steps[0]?.approvalId;
    expect(approvalId).toBeTruthy();
    const taskId = "task:" + first.requestId + ":1";
    const pending = await makeCore(provider, memory, registry, approvalEngine)
      .respond("user-1", "continue", { resumeTaskId: taskId });
    expect(pending.plan.steps[0]?.status).toBe("AWAITING_APPROVAL");
    expect(executed).toBe(0);
    await expect(makeCore(provider, memory, registry, approvalEngine).respond(
      "user-1", "continue", { resumeTaskId: taskId, approvalId: "wrong" }
    )).rejects.toThrow("Approval id does not match");
    expect(executed).toBe(0);
    expect(await approvalEngine.approve(approvalId!, "user-1")).toBeDefined();

    const resumed = await makeCore(provider, memory, registry, approvalEngine)
      .respond("user-1", "continue", { resumeTaskId: taskId, approvalId: approvalId! });
    expect(resumed.plan.status).toBe("COMPLETED");
    expect(resumed.plan.steps[0]?.status).toBe("COMPLETED");
    expect(resumed.plan.steps).toHaveLength(1);
    expect(executed).toBe(1);
    await expect(makeCore(provider, memory, registry, approvalEngine)
      .respond("user-1", "continue", { resumeTaskId: taskId, approvalId: approvalId! }))
      .rejects.toThrow("Task is already finalized");
    expect(executed).toBe(1);
  });

  it("never automatically replays an interrupted tool and never resumes completed plans", async () => {
    const memory = new InMemoryStore();
    const registry = new ToolRegistry();
    const provider: LLMProvider = {
      async chat() {
        throw new Error("The model must not be called");
      }
    };
    const now = new Date().toISOString();
    const save = async (id: string, status: "ACTIVE" | "COMPLETED", step: "PLANNED" | "COMPLETED") => {
      const record: MemoryRecord = {
        id, userId: "user-1", kind: "TASK", importance: 0.7,
        createdAt: now, updatedAt: now,
        content: JSON.stringify({
          objective: "critical task",
          status, revision: 1, currentStep: 1,
          steps: [{ index: 1, tool: "test.write", input: {}, status: step }]
        })
      };
      await memory.save(record);
    };
    await save("task:interrupted", "ACTIVE", "PLANNED");
    await save("task:completed", "COMPLETED", "COMPLETED");
    const core = makeCore(provider, memory, registry, new ApprovalEngine(new InMemoryApprovalStore()));
    await expect(core.respond("user-1", "continue", { resumeTaskId: "task:interrupted" }))
      .rejects.toThrow("manual reconciliation is required");
    await expect(core.respond("user-1", "continue", { resumeTaskId: "task:completed" }))
      .rejects.toThrow("Task is already finalized");
    await expect(core.respond("user-2", "continue", { resumeTaskId: "task:interrupted" }))
      .rejects.toThrow("Task not found");
  });


  it("does not execute an already successful tool again after a model interruption", async () => {
    const memory = new InMemoryStore();
    const registry = new ToolRegistry();
    const approvals = new ApprovalEngine(new InMemoryApprovalStore());
    let executed = 0;
    registry.register({
      name: "test.once",
      version: "1.0.0",
      description: "An operation that must not run twice",
      risk: "LOW",
      permissions: [],
      inputSchema: z.object({}),
      async execute() {
        executed++;
        return { success: true };
      }
    });
    let firstCalls = 0;
    const crashingProvider: LLMProvider = {
      async chat() {
        if (++firstCalls === 1) return toolCall("test.once");
        throw new Error("simulated model interruption");
      }
    };
    await expect(makeCore(crashingProvider, memory, registry, approvals)
      .respond("user-1", "Execute uma vez.")).rejects.toThrow("simulated model interruption");
    expect(executed).toBe(1);
    const task = (await memory.listTasks("user-1", 10))[0];
    expect(parseTaskPlan(task?.content ?? "").steps[0]?.status).toBe("COMPLETED");

    let resumedCalls = 0;
    const resumeProvider: LLMProvider = {
      async chat() {
        return ++resumedCalls === 1
          ? toolCall("test.once", "repeat-1")
          : { provider: "test", text: "Recuperação finalizada." };
      }
    };
    const result = await makeCore(resumeProvider, memory, registry, approvals)
      .respond("user-1", "continue", { resumeTaskId: task!.id });
    expect(result.plan.status).toBe("COMPLETED");
    expect(result.plan.steps).toHaveLength(1);
    expect(result.toolResults[0]).toMatchObject({
      tool: "test.once",
      output: { skipped: true }
    });
    expect(executed).toBe(1);
  });


  it("reconciles an uncertain interrupted step only with an explicitly verified outcome", () => {
    const interrupted = parseTaskPlan(JSON.stringify({
      objective: "write once",
      status: "ACTIVE",
      currentStep: 1,
      revision: 1,
      steps: [{ index: 1, tool: "test.write", input: {}, status: "PLANNED" }]
    }));
    const completed = reconcileInterruptedPlan(interrupted, "completed");
    expect(completed.status).toBe("ACTIVE");
    expect(completed.currentStep).toBeUndefined();
    expect(completed.steps[0]?.status).toBe("COMPLETED");
    const failed = reconcileInterruptedPlan(interrupted, "failed");
    expect(failed.status).toBe("REPLANNING");
    expect(failed.currentStep).toBe(1);
    expect(failed.steps[0]?.status).toBe("FAILED");
    expect(() => reconcileInterruptedPlan(completed, "completed"))
      .toThrow("Task has no single interrupted final step");
  });

  it("rejects damaged task records rather than leaking them into the API", () => {
    expect(() => parseTaskPlan('{"status":"ACTIVE"}')).toThrow("Persisted task is invalid");
    expect(() => parseTaskPlan('{"objective":"x","status":"ACTIVE","revision":1,"steps":[{"index":7,"tool":"bad","status":"PLANNED"}]}'))
      .toThrow("Persisted task is invalid");
    expect(() => taskToResponse({
      id: "corrupt", userId: "user-1", kind: "TASK", content: "{",
      importance: 0.7, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z"
    })).toThrow("Persisted task is invalid");
  });
});
