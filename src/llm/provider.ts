import type { LLMMessage, LLMProvider, LLMResponse, LLMToolCall } from "../domain/types.js";

export class LocalTestProvider implements LLMProvider {
  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    const last = messages[messages.length - 1];

    if (last?.role === "tool") {
      let payload: any;
      try {
        payload = JSON.parse(last.content ?? "{}");
      } catch {
        payload = {};
      }

      if (payload?.ok && payload?.output?.result !== undefined) {
        return {
          provider: "local-test",
          model: "cortex-deterministic-test",
          text: `O resultado é ${payload.output.result}.`
        };
      }

      if (payload?.ok && payload?.output?.iso) {
        return {
          provider: "local-test",
          model: "cortex-deterministic-test",
          text: `O horário atual do servidor é ${payload.output.iso}.`
        };
      }

      return {
        provider: "local-test",
        model: "cortex-deterministic-test",
        text: payload?.error
          ? `Não consegui executar a ferramenta: ${payload.error}`
          : "A ferramenta foi processada."
      };
    }

    const userMessage = messages.find(m => m.role === "user")?.content ?? "";
    const normalized = userMessage.toLowerCase();

    if (/(hora|horário|horas)/i.test(normalized)) {
      return {
        provider: "local-test",
        model: "cortex-deterministic-test",
        text: "",
        toolCalls: [{
          id: cryptoRandomId(),
          name: "system.time",
          arguments: "{}"
        }]
      };
    }

    const expression = extractArithmeticExpression(normalized);
    if (expression) {
      return {
        provider: "local-test",
        model: "cortex-deterministic-test",
        text: "",
        toolCalls: [{
          id: cryptoRandomId(),
          name: "calculator.evaluate",
          arguments: JSON.stringify({ expression })
        }]
      };
    }

    return {
      provider: "local-test",
      model: "cortex-deterministic-test",
      text: "Estou em modo de teste local. Posso demonstrar o ciclo de ferramentas com cálculo e horário."
    };
  }
}

function cryptoRandomId(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function extractArithmeticExpression(text: string): string | undefined {
  const multiplication = text.match(/(-?\\d+(?:[.,]\\d+)?)\\s*(?:vezes|x|multiplicado por)\\s*(-?\\d+(?:[.,]\\d+)?)/i);
  if (multiplication) {
    return `${multiplication[1].replace(",", ".")}*${multiplication[2].replace(",", ".")}`;
  }

  const arithmetic = text.match(/(-?\\d+(?:[.,]\\d+)?)\\s*([+\\-*/%])\\s*(-?\\d+(?:[.,]\\d+)?)/);
  if (arithmetic) {
    return `${arithmetic[1].replace(",", ".")}${arithmetic[2]}${arithmetic[3].replace(",", ".")}`;
  }

  return undefined;
}

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
        text: "NEURON está sem um provedor de LLM configurado."
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
