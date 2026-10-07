import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMMessage } from "../src/domain/types.js";
import { OpenAICompatibleProvider } from "../src/llm/provider.js";

describe("OpenAICompatibleProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a safe unconfigured response when credentials are missing", async () => {
    const provider = new OpenAICompatibleProvider("https://api.example.com/v1");

    await expect(provider.chat([
      { role: "user", content: "Olá" }
    ])).resolves.toMatchObject({
      provider: "unconfigured",
      text: "NEURON está sem um provedor de LLM configurado."
    });
  });

  it("uses the Responses API and maps function calls and tool output", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "gpt-6-luna",
      output: [{ type: "function_call", call_id: "call-1", name: "calculator.evaluate", arguments: JSON.stringify({ expression: "25*18" }) }],
      output_text: "",
      usage: { input_tokens: 21, output_tokens: 8 }
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));

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

    const provider = new OpenAICompatibleProvider(
      "https://api.example.com/v1",
      "secret-test-key",
      "test-model"
    );

    const result = await provider.chat(messages, {
      temperature: 0.2,
      tools,
      toolChoice: "auto"
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret-test-key");

    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("test-model");
    expect(body.messages).toEqual(messages);
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toBe("auto");
    expect(body.temperature).toBe(0.2);

    expect(result).toMatchObject({
      provider: "openai-compatible",
      model: "test-model",
      text: "Vou calcular.",
      toolCalls: [{
        id: "call-1",
        name: "calculator.evaluate",
        arguments: '{"expression":"25*18"}'
      }],
      usage: {
        inputTokens: 21,
        outputTokens: 8
      }
    });
  });

  it("surfaces provider HTTP errors without exposing the API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("invalid request", {
      status: 400,
      headers: { "Content-Type": "text/plain" }
    }));

    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleProvider(
      "https://api.example.com/v1",
      "secret-test-key",
      "test-model"
    );

    await expect(provider.chat([
      { role: "user", content: "teste" }
    ])).rejects.toThrow("LLM provider error: 400: invalid request");
  });
});
