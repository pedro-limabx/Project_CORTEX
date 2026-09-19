import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/memory/store.js";
import type { LLMMessage, LLMProvider, LLMResponse } from "../src/domain/types.js";
import { NeuronCore } from "../src/neuron/core.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { calculatorTool, timeTool } from "../src/tools/builtin.js";

describe("NEURON chained tool flow", () => {
  it("executes calculator.evaluate then system.time and completes in 3 steps", async () => {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);
    registry.register(timeTool);

    const iso = "2026-09-19T03:21:15.395Z";
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
        expect(payload).toMatchObject({
          tool: "system.time",
          ok: true,
          output: { iso }
        });

        return {
          provider: "test",
          model: "deterministic-chain",
          text: "25 vezes 18 = 450. Horário: " + iso
        };
      }
    };

    const core = new NeuronCore(
      provider,
      new InMemoryStore(),
      registry,
      new ToolExecutor(registry)
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
      ok: true,
      output: { iso }
    });

    expect(result.text).toContain("450");
    expect(result.text).toContain(iso);
    expect(calls).toBe(3);
  });
});
