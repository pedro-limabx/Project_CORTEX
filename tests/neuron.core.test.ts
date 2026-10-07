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
