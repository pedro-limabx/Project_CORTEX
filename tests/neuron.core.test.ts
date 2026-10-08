import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/memory/store.js";
import type { LLMMessage, LLMProvider, LLMResponse } from "../src/domain/types.js";
import { LocalTestProvider } from "../src/llm/provider.js";
import { NeuronCore } from "../src/neuron/core.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { InMemoryPermissionStore } from "../src/permissions/in-memory-store.js";
import { ApprovalEngine } from "../src/approval/engine.js";
import { InMemoryApprovalStore } from "../src/approval/store.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { calculatorTool, timeTool } from "../src/tools/builtin.js";

describe("NEURON chained tool flow", () => {
  it("executes calculator.evaluate then system.time and completes in 3 steps", async () => {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);
    registry.register(timeTool);

    const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    let calls = 0;

    const provider: LLMProvider = {
      async chat(messages: LLMMessage[]): Promise<LLMResponse> {
        calls++;

        if (calls === 1) {
          return {
            provider: "test",
            model: "deterministic-chain",
            text: "",
            toolCalls: [{
              id: "call-calculator",
              name: "calculator.evaluate",
              arguments: JSON.stringify({ expression: "25*18" })
            }]
          };
        }

        const lastTool = messages[messages.length - 1];
        expect(lastTool?.role).toBe("tool");

        if (calls === 2) {
          const payload = JSON.parse(lastTool?.content ?? "{}");
          expect(payload).toMatchObject({
            tool: "calculator.evaluate",
            ok: true,
            output: { result: 450 }
          });

          return {
            provider: "test",
            model: "deterministic-chain",
            text: "",
            toolCalls: [{
              id: "call-time",
              name: "system.time",
              arguments: "{}"
            }]
          };
        }

        const payload = JSON.parse(lastTool?.content ?? "{}");
        expect(payload.tool).toBe("system.time");
        expect(payload.ok).toBe(true);
        expect(payload.output?.iso).toMatch(isoPattern);

        return {
          provider: "test",
          model: "deterministic-chain",
          text: "25 vezes 18 = 450. Horário: " + payload.output.iso
        };
      }
    };

    const core = new NeuronCore(
      provider,
      new InMemoryStore(),
      registry,
      new ToolExecutor(registry),
      new PermissionEngine(new InMemoryPermissionStore()),
      new ApprovalEngine(new InMemoryApprovalStore())
    );

    const result = await core.respond(
      "test-user",
      "NEURON, calcule 25 vezes 18 e depois me diga que horas são."
    );

    expect(result.steps).toBe(3);
    expect(result.toolResults).toHaveLength(2);

    expect(result.toolResults[0]).toMatchObject({
      tool: "calculator.evaluate",
      ok: true,
      output: { result: 450 }
    });

    expect(result.toolResults[1]).toMatchObject({
      tool: "system.time",
      ok: true
    });
    const timeResult = result.toolResults[1] as { output?: { iso?: string } };
    expect(timeResult.output?.iso).toMatch(isoPattern);

    expect(result.text).toContain("450");
    expect(result.text).toContain(timeResult.output?.iso ?? "");
    expect(calls).toBe(3);
  });
});


describe("NEURON local replanning", () => {
  it("replans after calculator output and then executes system.time", async () => {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);
    registry.register(timeTool);

    const core = new NeuronCore(
      new LocalTestProvider(),
      new InMemoryStore(),
      registry,
      new ToolExecutor(registry),
      new PermissionEngine(new InMemoryPermissionStore()),
      new ApprovalEngine(new InMemoryApprovalStore())
    );

    const result = await core.respond(
      "test-user",
      "NEURON, calcule 25 vezes 18 e depois me diga que horas são."
    );

    expect(result.steps).toBe(3);
    expect(result.toolResults).toHaveLength(2);
    expect(result.toolResults[0]).toMatchObject({
      tool: "calculator.evaluate",
      ok: true,
      output: { result: 450 }
    });
    expect(result.toolResults[1]).toMatchObject({
      tool: "system.time",
      ok: true
    });

    const timeResult = result.toolResults[1] as { output?: { iso?: string } };
    expect(timeResult.output?.iso).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
    expect(result.text).toContain("450");
    expect(result.text).toContain(timeResult.output?.iso ?? "");
  });
});


describe("NEURON OpenAI tool naming", () => {
  it("exposes OpenAI-safe tool names and maps them back to canonical names", async () => {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);
    registry.register(timeTool);

    let firstTools: unknown[] = [];
    let calls = 0;
    const provider: LLMProvider = {
      async chat(messages: LLMMessage[], options): Promise<LLMResponse> {
        calls++;
        if (calls === 1) {
          firstTools = options?.tools ?? [];
          return {
            provider: "test",
            model: "openai-compatible",
            text: "",
            toolCalls: [{
              id: "call-calculator",
              name: "calculator_evaluate",
              arguments: JSON.stringify({ expression: "25*18" })
            }]
          };
        }

        const lastTool = messages[messages.length - 1];
        expect(lastTool?.role).toBe("tool");
        expect(JSON.parse(lastTool?.content ?? "{}")).toMatchObject({
          tool: "calculator.evaluate",
          ok: true,
          output: { result: 450 }
        });

        return {
          provider: "test",
          model: "openai-compatible",
          text: "O resultado é 450."
        };
      }
    };

    const core = new NeuronCore(
      provider,
      new InMemoryStore(),
      registry,
      new ToolExecutor(registry),
      new PermissionEngine(new InMemoryPermissionStore()),
      new ApprovalEngine(new InMemoryApprovalStore())
    );

    const result = await core.respond("test-user", "Calcule 25 vezes 18.");

    expect(firstTools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({ name: "calculator_evaluate" })
      }),
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({ name: "system_time" })
      })
    ]));
    expect(result.text).toBe("O resultado é 450.");
    expect(result.toolResults[0]).toMatchObject({
      tool: "calculator.evaluate",
      ok: true,
      output: { result: 450 }
    });
  });
});


describe("NEURON adaptive planner", () => {
  it("signals a replan after a failed tool execution", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "test.fail",
      version: "1.0.0",
      description: "Always fails for planner tests.",
      risk: "LOW",
      permissions: [],
      inputSchema: { parse: (value: unknown) => value },
      async execute() {
        throw new Error("simulated failure");
      }
    });
    registry.register(calculatorTool);

    let calls = 0;
    const provider: LLMProvider = {
      async chat(messages: LLMMessage[]): Promise<LLMResponse> {
        calls++;
        if (calls === 1) {
          return {
            provider: "test",
            text: "",
            toolCalls: [{ id: "fail-1", name: "test.fail", arguments: "{}" }]
          };
        }

        expect(messages.some(message =>
          message.role === "user" && message.content?.includes("Planner signal")
        )).toBe(true);

        return {
          provider: "test",
          text: "Replanejado após a falha."
        };
      }
    };

    const core = new NeuronCore(
      provider,
      new InMemoryStore(),
      registry,
      new ToolExecutor(registry),
      new PermissionEngine(new InMemoryPermissionStore()),
      new ApprovalEngine(new InMemoryApprovalStore())
    );

    const result = await core.respond("test-user", "Execute a tarefa com segurança.");

    expect(result.plan).toMatchObject({
      objective: "Execute a tarefa com segurança.",
      status: "REPLANNING",
      revision: 1,
      currentStep: 1,
      steps: [
        { index: 1, tool: "test.fail", status: "FAILED", error: "simulated failure" }
      ]
    });
    expect(result.steps).toBe(2);
    expect(result.text).toBe("Replanejado após a falha.");
  });
});


describe("NEURON persisted task resume", () => {
  it("resumes an incomplete persisted task using the saved objective and task id", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "test.fail",
      version: "1.0.0",
      description: "Fails once so the task can be persisted for resume.",
      risk: "LOW",
      permissions: [],
      inputSchema: { parse: (value: unknown) => value },
      async execute() {
        throw new Error("simulated failure");
      }
    });
    registry.register(calculatorTool);

    let calls = 0;
    const provider: LLMProvider = {
      async chat(messages: LLMMessage[]): Promise<LLMResponse> {
        calls++;

        if (calls === 1) {
          return {
            provider: "test",
            text: "",
            toolCalls: [{
              id: "fail-1",
              name: "test.fail",
              arguments: "{}"
            }]
          };
        }

        if (calls === 2) {
          expect(messages.some(message =>
            message.role === "user" && message.content?.includes("Planner signal")
          )).toBe(true);

          return {
            provider: "test",
            text: "A tarefa precisa ser retomada."
          };
        }

        expect(messages.some(message =>
          message.role === "user" && message.content?.includes("Calcule 10 + 5.")
        )).toBe(true);

        return {
          provider: "test",
          text: "",
          toolCalls: [{
            id: "calc-1",
            name: "calculator.evaluate",
            arguments: JSON.stringify({ expression: "10+5" })
          }]
        };
      }
    };

    const memory = new InMemoryStore();
    const core = new NeuronCore(
      provider,
      memory,
      registry,
      new ToolExecutor(registry),
      new PermissionEngine(new InMemoryPermissionStore()),
      new ApprovalEngine(new InMemoryApprovalStore())
    );

    const first = await core.respond("test-user", "Calcule 10 + 5.");
    expect(first.plan.status).toBe("REPLANNING");

    const savedTask = await memory.getTask("test-user", "task:" + first.requestId + ":1");
    expect(savedTask).toBeDefined();

    const resumed = await core.respond("test-user", "continue", {
      resumeTaskId: savedTask?.id
    });

    expect(resumed.plan.objective).toBe("Calcule 10 + 5.");
    expect(resumed.plan.status).toBe("ACTIVE");
    expect(resumed.plan.steps).toHaveLength(2);
    expect(resumed.plan.steps[0]).toMatchObject({
      index: 1,
      tool: "test.fail",
      status: "FAILED"
    });
    expect(resumed.plan.steps[1]).toMatchObject({
      index: 2,
      tool: "calculator.evaluate",
      status: "COMPLETED"
    });
  });

  it("rejects an unknown task id", async () => {
    const core = new NeuronCore(
      new LocalTestProvider(),
      new InMemoryStore(),
      new ToolRegistry(),
      new ToolExecutor(new ToolRegistry()),
      new PermissionEngine(new InMemoryPermissionStore()),
      new ApprovalEngine(new InMemoryApprovalStore())
    );

    await expect(
      core.respond("test-user", "continue", { resumeTaskId: "missing-task" })
    ).rejects.toThrow("Task not found");
  });
});
