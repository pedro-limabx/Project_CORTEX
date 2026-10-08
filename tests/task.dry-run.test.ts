import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LLMProvider } from "../src/domain/types.js";
import { InMemoryStore } from "../src/memory/store.js";
import { NeuronCore } from "../src/neuron/core.js";
import { ApprovalEngine } from "../src/approval/engine.js";
import { InMemoryApprovalStore } from "../src/approval/store.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { InMemoryPermissionStore } from "../src/permissions/in-memory-store.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";

describe("Task dry-run persistence", () => {
  it("never saves simulated tool execution as a completed task", async () => {
    const store = new InMemoryStore();
    const registry = new ToolRegistry();
    let executions = 0;
    registry.register({
      name: "test.simulated",
      version: "1.0.0",
      description: "Simulated operation",
      risk: "LOW",
      permissions: [],
      inputSchema: z.object({}),
      async execute() { executions++; return true; }
    });
    let calls = 0;
    const provider: LLMProvider = {
      async chat() {
        calls++;
        return calls === 1
          ? { provider: "test", text: "", toolCalls: [{ id: "c1", name: "test.simulated", arguments: "{}" }] }
          : { provider: "test", text: "Simulation complete" };
      }
    };
    const core = new NeuronCore(
      provider, store, registry, new ToolExecutor(registry),
      new PermissionEngine(new InMemoryPermissionStore()),
      new ApprovalEngine(new InMemoryApprovalStore())
    );
    const response = await core.respond("test-user", "Simule", { dryRun: true });
    expect(response.plan.status).toBe("COMPLETED");
    expect(response.taskId).toBeUndefined();
    expect(executions).toBe(0);
    expect(await store.listTasks("test-user", 10)).toHaveLength(0);
    await expect(core.respond("test-user", "Continue", {
      dryRun: true, resumeTaskId: "task:unknown"
    })).rejects.toThrow("Cannot resume persisted tasks in dry-run mode");
  });
});
