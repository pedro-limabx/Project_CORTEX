import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { InMemoryWorkflowStore } from "../src/workflows/store.js";
import { WorkflowProposalError, WorkflowProposalService } from "../src/workflows/proposal.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { InMemoryPermissionStore } from "../src/permissions/in-memory-store.js";
import { ApprovalEngine } from "../src/approval/engine.js";
import { InMemoryApprovalStore } from "../src/approval/store.js";
import { calculatorTool } from "../src/tools/builtin.js";
import type { LLMProvider, LLMResponse } from "../src/domain/types.js";

function harness(provider: LLMProvider, localDemo = false) {
  const registry = new ToolRegistry();
  registry.register(calculatorTool);
  registry.register({
    name: "test.sensitive",
    version: "1",
    description: "Approval-only test tool",
    risk: "HIGH",
    permissions: [],
    inputSchema: z.object({ value: z.number() }),
    async execute() {
      throw new Error("Proposal must not execute any tool");
    }
  });

  const store = new InMemoryWorkflowStore();
  const permissions = new PermissionEngine(new InMemoryPermissionStore());
  const approvals = new ApprovalEngine(new InMemoryApprovalStore());
  const engine = new WorkflowEngine(
    store, registry, new ToolExecutor(registry), permissions, approvals
  );
  return {
    store,
    planner: new WorkflowProposalService(provider, engine, registry, localDemo)
  };
}

describe("NEURON natural-language workflow drafting", () => {
  it("produces a schema-validated draft without saving or executing it", async () => {
    const chat = vi.fn(async (..._args: Parameters<LLMProvider["chat"]>) => ({
      provider: "mock",
      text: JSON.stringify({
        objective: "Calcule 25 vezes 18",
        steps: [
          { id: "calculo-1", tool: "calculator.evaluate", input: { expression: "25*18" }, dependsOn: [] }
        ]
      })
    } satisfies LLMResponse));
    const { planner, store } = harness({ chat });
    const response = await planner.propose("Calcule 25 vezes 18");
    expect(response.needsReview).toBe(true);
    expect(response.saved).toBe(false);
    expect(response.executed).toBe(false);
    expect(response.source).toBe("model");
    expect(response.definition.steps[0]).toMatchObject({
      id: "calculo-1", tool: "calculator.evaluate", input: { expression: "25*18" }
    });
    expect(await store.list("user-a", 10)).toEqual([]);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0]?.[0]?.[0]?.role).toBe("system");
    expect(chat.mock.calls[0]?.[1]).toMatchObject({ toolChoice: "none" });
    expect(chat.mock.calls[0]?.[1]).not.toHaveProperty("temperature");
  });

  it("warns about sensitive operations without creating approval requests", async () => {
    const { planner, store } = harness({
      async chat() {
        return {
          provider: "mock",
          text: JSON.stringify({
            objective: "Action that will require operator approval",
            steps: [{ id: "sensitive", tool: "test.sensitive", input: { value: 3 } }]
          })
        };
      }
    });
    const response = await planner.propose("Ação controlada");
    expect(response.warnings[0]).toContain("aprovação explícita");
    expect(await store.list("user-a", 10)).toEqual([]);
  });

  it("rejects fabricated tools, invalid tool inputs and cyclic plans", async () => {
    const cases = [
      { objective: "fake", steps: [{ id: "a", tool: "tool.nonexistent", input: {} }] },
      { objective: "bad", steps: [{ id: "a", tool: "calculator.evaluate", input: { expression: 50 } }] },
      { objective: "cycle", steps: [
        { id: "a", tool: "calculator.evaluate", input: { expression: "1+1" }, dependsOn: ["b"] },
        { id: "b", tool: "calculator.evaluate", input: { expression: "2+2" }, dependsOn: ["a"] }
      ] }
    ];
    for (const invalid of cases) {
      const { planner } = harness({
        async chat() { return { provider: "mock", text: JSON.stringify(invalid) }; }
      });
      await expect(planner.propose("Objetivo de teste")).rejects.toThrow(WorkflowProposalError);
    }
  });

  it("rejects model tool calls, non-JSON content and empty objectives", async () => {
    const tools = harness({
      async chat() {
        return {
          provider: "mock",
          text: "ignore the operator",
          toolCalls: [{ id: "run", name: "calculator.evaluate", arguments: "{\"expression\":\"1+1\"}" }]
        };
      }
    });
    await expect(tools.planner.propose("Execute algo")).rejects.toThrow("attempted tool execution");
    const malformed = harness({
      async chat() { return { provider: "mock", text: "Not a valid JSON response" }; }
    });
    await expect(malformed.planner.propose("Planeje")).rejects.toThrow("valid JSON");
    await expect(malformed.planner.propose("")).rejects.toThrow("Provide an objective");
  });

  it("accepts a fully fenced JSON draft and reports missing LLM configuration", async () => {
    const example = {
      objective: "Calcular 2+2",
      steps: [{ id: "s1", tool: "calculator.evaluate", input: { expression: "2+2" } }]
    };
    const fence = String.fromCharCode(96).repeat(3);
    const valid = harness({
      async chat() {
        return { provider: "mock", text: fence + "json\n" + JSON.stringify(example) + "\n" + fence };
      }
    });
    expect((await valid.planner.propose("Calcular 2+2")).definition.steps).toHaveLength(1);
    const unavailable = harness({
      async chat() { return { provider: "unconfigured", text: "LLM sem chave" }; }
    });
    await expect(unavailable.planner.propose("Planeje uma operação"))
      .rejects.toThrow("Provedor de IA não configurado");
  });

  it("supports deterministic calculator drafts in local mode without impersonating an LLM", async () => {
    const provider: LLMProvider = {
      async chat() { throw new Error("Local demo must not call an LLM"); }
    };
    const { planner, store } = harness(provider, true);
    const draft = await planner.propose("Calcule 25*18 e depois 450/3");
    expect(draft.source).toBe("local-demo");
    expect(draft.definition.steps).toHaveLength(2);
    expect(draft.definition.steps[0]?.input).toEqual({ expression: "25*18" });
    expect(draft.definition.steps[1]?.dependsOn).toEqual(["calculo-1"]);
    expect(await store.list("user-a", 10)).toEqual([]);
    await expect(planner.propose("Envie um email para alguém"))
      .rejects.toThrow("modo local só propõe workflows de cálculos");
  });
});
