import type { LLMMessage, LLMProvider, LLMResponse } from "../domain/types.js";

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
    private readonly model?: string
  ) {}

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    if (!this.apiKey || !this.model) {
      return {
        provider: "unconfigured",
        text: "NEURON está em modo local de desenvolvimento. Configure LLM_API_KEY e LLM_MODEL para habilitar um modelo externo."
      };
    }

    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({ model: this.model, messages, temperature: 0.2 })
    });

    if (!response.ok) throw new Error(`LLM provider error: ${response.status}`);
    const body = await response.json() as any;
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("LLM provider returned an invalid response");

    return {
      provider: "openai-compatible",
      model: body.model,
      text,
      usage: {
        inputTokens: body.usage?.prompt_tokens,
        outputTokens: body.usage?.completion_tokens
      }
    };
  }
}
