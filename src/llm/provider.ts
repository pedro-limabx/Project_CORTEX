import type { LLMMessage, LLMProvider, LLMResponse, LLMToolCall } from "../domain/types.js";

export class LocalTestProvider implements LLMProvider {
  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    const last = messages[messages.length - 1];
    const userMessage = messages.find(m => m.role === "user")?.content ?? "";
    const normalized = userMessage.toLowerCase();

    if (last?.role === "tool") {
      let payload: any;
      try {
        payload = JSON.parse(last.content ?? "{}");
      } catch {
        payload = {};
      }

      if (payload?.tool === "calculator.evaluate") {
        if (!payload.ok) {
          return {
            provider: "local-test",
            model: "cortex-deterministic-test",
            text: `Não consegui executar a ferramenta: ${payload.error ?? "erro desconhecido"}`
          };
        }

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

        return {
          provider: "local-test",
          model: "cortex-deterministic-test",
          text: `O resultado é ${payload.output?.result}.`
        };
      }

      if (payload?.tool === "system.time") {
        if (payload.ok && payload.output?.iso) {
          return {
            provider: "local-test",
            model: "cortex-deterministic-test",
            text: `O resultado é ${this.extractCalculatorResult(messages)}. O horário atual do servidor é ${payload.output.iso}.`
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

    return {
      provider: "local-test",
      model: "cortex-deterministic-test",
      text: "Estou em modo de teste local. Posso demonstrar o ciclo de ferramentas com cálculo e horário."
    };
  }

  private extractCalculatorResult(messages: LLMMessage[]): string {
    for (const message of messages) {
      if (message.role !== "tool" || !message.content) continue;

      try {
        const payload = JSON.parse(message.content);
        if (payload?.tool === "calculator.evaluate" && payload?.ok && payload?.output?.result !== undefined) {
          return String(payload.output.result);
        }
      } catch {
        // Ignore malformed historical tool messages.
      }
    }

    return "o cálculo solicitado";
  }
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
