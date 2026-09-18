import type { LLMMessage, LLMProvider, LLMResponse, LLMToolCall } from "../domain/types.js";

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
    private readonly model?: string
  ) {}

  async chat(
    messages: LLMMessage[],
    options: { temperature?: number; tools?: unknown[]; toolChoice?: "auto" | "none" } = {}
  ): Promise<LLMResponse> {
    if (!this.apiKey || !this.model) {
      return {
        provider: "unconfigured",
        text: "NEURON está em modo local de desenvolvimento. Configure LLM_API_KEY e LLM_MODEL para habilitar um modelo externo."
      };
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: options.temperature ?? 0.2
    };
    if (options.tools?.length) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice ?? "auto";
    }

    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`LLM provider error: ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
    }

    const bodyJson = await response.json() as any;
    const message = bodyJson.choices?.[0]?.message;
    const text = typeof message?.content === "string" ? message.content : "";
    const toolCalls: LLMToolCall[] = Array.isArray(message?.tool_calls)
      ? message.tool_calls
          .filter((c: any) => c?.id && c?.function?.name)
          .map((c: any) => ({
            id: String(c.id),
            name: String(c.function.name),
            arguments: typeof c.function.arguments === "string" ? c.function.arguments : JSON.stringify(c.function.arguments ?? {})
          }))
      : [];

    return {
      provider: "openai-compatible",
      model: bodyJson.model,
      text,
      toolCalls,
      usage: {
        inputTokens: bodyJson.usage?.prompt_tokens,
        outputTokens: bodyJson.usage?.completion_tokens
      }
    };
  }
}
