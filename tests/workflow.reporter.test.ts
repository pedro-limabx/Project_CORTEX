import { describe, expect, it, vi } from "vitest";
import type { LLMProvider } from "../src/domain/types.js";
import { InMemoryStore } from "../src/memory/store.js";
import { NeuronCore } from "../src/neuron/core.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { InMemoryPermissionStore } from "../src/permissions/in-memory-store.js";
import { ApprovalEngine } from "../src/approval/engine.js";
import { InMemoryApprovalStore } from "../src/approval/store.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { WorkflowReporter, matchesWorkflowStatusQuestion } from "../src/workflows/reporter.js";
import { InMemoryWorkflowStore } from "../src/workflows/store.js";
import type { WorkflowRun, WorkflowStepStatus } from "../src/workflows/types.js";

const NOW = Date.parse("2026-10-08T11:00:00.000Z");
const ids = {
  active: "11111111-1111-4111-8111-111111111111",
  approval: "22222222-2222-4222-8222-222222222222",
  running: "33333333-3333-4333-8333-333333333333",
  failed: "44444444-4444-4444-8444-444444444444",
  completed: "55555555-5555-4555-8555-555555555555"
};

function workflow(id: string, status: WorkflowStepStatus, userId = "user-a"): WorkflowRun {
  const start = new Date(NOW - 45_000).toISOString();
  return {
    id,
    userId,
    objective: "Processo controlado " + id.slice(0, 8),
    version: 1,
    createdAt: start,
    updatedAt: start,
    steps: [{
      id: "step-1",
      tool: "calculator.evaluate",
      input: { expression: "2+2" },
      dependsOn: [],
      status,
      ...(status === "RUNNING" ? { startedAt: start } : {}),
      ...(status === "WAITING_APPROVAL" ? { approvalId: "approval-1" } : {})
    }]
  };
}

describe("CORTEX read-only workflow reporting", () => {
  it("reports progress, status and next manual action without modifying records", async () => {
    const store = new InMemoryWorkflowStore();
    await store.create(workflow(ids.active, "PENDING"));
    await store.create(workflow(ids.approval, "WAITING_APPROVAL"));
    await store.create(workflow(ids.running, "RUNNING"));
    await store.create(workflow(ids.failed, "FAILED"));
    await store.create(workflow(ids.completed, "COMPLETED"));

    const reporter = new WorkflowReporter(store, () => NOW);
    const summary = await reporter.summarize("user-a");
    expect(summary.readOnly).toBe(true);
    expect(summary.mode).toBe("recent");
    expect(summary.count).toBe(5);
    expect(summary.text).toContain("1 ativos");
    expect(summary.text).toContain("1 aguardando aprovação");
    expect(summary.text).toContain("1 com falha");
    expect(summary.text).toContain("1 concluídos");

    const active = summary.workflows.find(item => item.id === ids.active)!;
    expect(active.percent).toBe(0);
    expect(active.nextStepIds).toEqual(["step-1"]);
    expect(active.attention).toContain("comando explícito");
    const approval = summary.workflows.find(item => item.id === ids.approval)!;
    expect(approval.attention).toContain("aprovação explícita");
    const running = summary.workflows.find(item => item.id === ids.running)!;
    expect(running.attention).toContain("Verifique externamente");
    const failed = summary.workflows.find(item => item.id === ids.failed)!;
    expect(failed.attention).toContain("exige análise");
    const completed = summary.workflows.find(item => item.id === ids.completed)!;
    expect(completed.percent).toBe(100);
    expect(completed.status).toBe("COMPLETED");

    const stored = await store.get("user-a", ids.active);
    expect(stored?.version).toBe(1);
    expect(stored?.steps[0]?.status).toBe("PENDING");
  });

  it("never reveals another user's workflows and handles unknown IDs", async () => {
    const store = new InMemoryWorkflowStore();
    await store.create(workflow(ids.active, "PENDING", "user-a"));
    await store.create(workflow(ids.approval, "FAILED", "user-b"));
    const reporter = new WorkflowReporter(store, () => NOW);
    const own = await reporter.summarize("user-a");
    expect(own.count).toBe(1);
    expect(own.text).not.toContain(ids.approval);

    const denied = await reporter.summarize("user-a", { id: ids.approval });
    expect(denied.count).toBe(0);
    expect(denied.text).toContain("Não encontrei");
    const missing = await reporter.summarize("user-c");
    expect(missing.count).toBe(0);
    expect(missing.text).toContain("Não encontrei workflows");
    await expect(reporter.summarize("user-a", { limit: 100 })).rejects.toThrow("limit");
    await expect(reporter.summarize("user-a", { id: "not-a-uuid" }))
      .rejects.toThrow("Invalid workflow id");
  });

  it("distinguishes a running step from a stale interrupted step", async () => {
    const store = new InMemoryWorkflowStore();
    const recent = workflow(ids.running, "RUNNING");
    recent.steps[0]!.startedAt = new Date(NOW - 10_000).toISOString();
    await store.create(recent);
    const reporter = new WorkflowReporter(store, () => NOW);
    const status = await reporter.summarize("user-a", { id: ids.running });
    expect(status.workflows[0]?.attention).toContain("está em execução");
    expect(status.workflows[0]?.attention).not.toContain("Verifique externamente");
  });

  it("recognizes only explicit read-only workflow questions", () => {
    const accepted = [
      "Como estão meus workflows?",
      "NEURON, mostre o progresso dos fluxos",
      "Qual o status do workflow " + ids.active + "?",
      "Resumo dos workflows por favor",
      "Acompanhe meus workflows"
    ];
    for (const message of accepted) expect(matchesWorkflowStatusQuestion(message)).toBe(true);

    const declined = [
      "Calcule 25*18",
      "Crie um workflow e mostre o status",
      "Execute o próximo workflow",
      "Aprove os workflows",
      "Preciso de ajuda para criar um workflow",
      "Meu workflow precisa rodar agora"
    ];
    for (const message of declined) expect(matchesWorkflowStatusQuestion(message)).toBe(false);
  });

  it("answers status requests through NEURON without consulting the model or executing tools", async () => {
    const store = new InMemoryWorkflowStore();
    await store.create(workflow(ids.active, "PENDING"));
    await store.create(workflow(ids.approval, "FAILED", "user-b"));
    const reporter = new WorkflowReporter(store, () => NOW);
    const chat = vi.fn(async () => ({ provider: "mock", text: "Resposta genérica" }));
    const provider: LLMProvider = { chat };
    const registry = new ToolRegistry();
    const memory = new InMemoryStore();
    const neuron = new NeuronCore(
      provider,
      memory,
      registry,
      new ToolExecutor(registry),
      new PermissionEngine(new InMemoryPermissionStore()),
      new ApprovalEngine(new InMemoryApprovalStore()),
      undefined,
      reporter
    );

    const result = await neuron.respond("user-a", "Qual o status do workflow " + ids.active + "?");
    expect(result.workflowReport).toMatchObject({
      mode: "single", count: 1, readOnly: true
    });
    expect(result.text).toContain(ids.active);
    expect(result.text).not.toContain(ids.approval);
    expect(result.plan.status).toBe("COMPLETED");
    expect(result.plan.steps).toEqual([]);
    expect(result.toolResults).toEqual([]);
    expect(result.steps).toBe(0);
    expect(chat).not.toHaveBeenCalled();
    expect(await memory.listTasks("user-a", 10)).toEqual([]);

    const general = await neuron.respond("user-a", "Como estão meus workflows?");
    expect(general.workflowReport?.count).toBe(1);

    const notIntercepted = await neuron.respond("user-a", "Calcule 25*18");
    expect(notIntercepted.text).toBe("Resposta genérica");
    expect(notIntercepted.workflowReport).toBeUndefined();
    expect(chat).toHaveBeenCalledOnce();
  });
});
