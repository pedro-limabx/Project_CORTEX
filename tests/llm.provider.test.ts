import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMMessage } from "../src/domain/types.js";
import { OpenAICompatibleProvider } from "../src/llm/provider.js";

describe("OpenAICompatibleProvider", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns a safe unconfigured response when credentials are missing", async () => {
    const provider = new OpenAICompatibleProvider("https://api.example.com/v1");

    await expect(provider.chat([{ role: "user", content: "Olá" }])).resolves.toMatchObject({
      provider: "unconfigured",
      text: "NEURON está sem um provedor de LLM configurado."
    });
  });

  it("uses the Responses API and maps function calls and tool output", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: "gpt-6-luna",
        output: [{
          type: "function_call",
          call_id: "call-1",
          name: "calculator.evaluate",
          arguments: JSON.stringify({ expression: "25*18" })
        }],
        output_text: "",
        usage: { input_tokens: 21, output_tokens: 8 }
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: "gpt-6-luna",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "O resultado é 450." }] }],
        output_text: "O resultado é 450.",
        usage: { input_tokens: 30, output_tokens: 5 }
      }), { status: 200, headers: { "Content-Type": "application/json" } }));

    vi.stubGlobal("fetch", fetchMock);

    const messages: LLMMessage[] = [
      { role: "system", content: "Você é o NEURON." },
      { role: "user", content: "Calcule 25 vezes 18." }
    ];
    const tools = [{
      type: "function",
      function: {
        name: "calculator.evaluate",
        description: "Evaluate arithmetic.",
        parameters: {
          type: "object",
          properties: { expression: { type: "string" } },
          required: ["expression"]
        }
      }
    }];

    const provider = new OpenAICompatibleProvider("https://api.example.com/v1", "secret-test-key", "gpt-6-luna");
    const first = await provider.chat(messages, { temperature: 0.2, tools, toolChoice: "auto" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/responses");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret-test-key");

    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("gpt-6-luna");
    expect(body.instructions).toBe("Você é o NEURON.");
    expect(body.input).toEqual([{ role: "user", content: "Calcule 25 vezes 18." }]);
    expect(body.tools).toEqual([{
      type: "function",
      name: "calculator.evaluate",
      description: "Evaluate arithmetic.",
      parameters: tools[0].function.parameters,
      strict: false
    }]);
    expect(body.tool_choice).toBe("auto");
    expect(body.temperature).toBe(0.2);
    expect(first).toMatchObject({
      provider: "openai-responses",
      model: "gpt-6-luna",
      text: "",
      toolCalls: [{ id: "call-1", name: "calculator.evaluate", arguments: '{"expression":"25*18"}' }],
      usage: { inputTokens: 21, outputTokens: 8 }
    });

    const followupMessages: LLMMessage[] = [
      ...messages,
      { role: "assistant", content: null, tool_calls: first.toolCalls },
      {
        role: "tool",
        tool_call_id: "call-1",
        name: "calculator.evaluate",
        content: JSON.stringify({ tool: "calculator.evaluate", ok: true, output: { result: 450 } })
      }
    ];
    const second = await provider.chat(followupMessages, { temperature: 0.2, tools, toolChoice: "auto" });
    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const secondBody = JSON.parse(String(secondInit.body));

    expect(secondBody.input).toEqual([
      { role: "user", content: "Calcule 25 vezes 18." },
      { type: "function_call", call_id: "call-1", name: "calculator.evaluate", arguments: '{"expression":"25*18"}' },
      { type: "function_call_output", call_id: "call-1", output: JSON.stringify({ tool: "calculator.evaluate", ok: true, output: { result: 450 } }) }
    ]);
    expect(second).toMatchObject({
      provider: "openai-responses",
      model: "gpt-6-luna",
      text: "O resultado é 450.",
      toolCalls: []
    });
  });

  it("surfaces provider HTTP errors without exposing the API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("invalid request", {
      status: 400,
      headers: { "Content-Type": "text/plain" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleProvider("https://api.example.com/v1", "secret-test-key", "gpt-6-luna");
    await expect(provider.chat([{ role: "user", content: "teste" }]))
      .rejects.toThrow("LLM provider error: 400: invalid request");
  });
});
