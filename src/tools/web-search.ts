import { z } from "zod";
import type { ToolDefinition } from "../domain/types.js";

interface WebSearchSource {
  title: string;
  url: string;
}

export function createWebSearchTool(
  baseUrl: string,
  apiKey?: string,
  model?: string
): ToolDefinition<{ query: string }, { text: string; sources: WebSearchSource[] }> {
  return {
    name: "web.search",
    version: "1.0.0",
    description: "Search the live web for current, changing, or source-dependent information such as news, rankings, prices, recent people, companies, events, and facts that should be verified. Use it when the answer cannot be reliably provided from existing knowledge.",
    risk: "LOW",
    permissions: [],
    inputSchema: z.object({
      query: z.string().min(2).max(500)
    }),
    async execute(input) {
      if (!apiKey || !model) {
        throw new Error("Web search is unavailable because the external LLM provider is not configured");
      }

      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          input: input.query,
          tools: [{ type: "web_search" }],
          tool_choice: "auto"
        })
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Web search provider error: ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
      }

      const body = await response.json() as any;
      const output = Array.isArray(body.output) ? body.output : [];
      const text = typeof body.output_text === "string"
        ? body.output_text
        : output
          .filter((item: any) => item?.type === "message")
          .flatMap((item: any) => Array.isArray(item.content) ? item.content : [])
          .filter((item: any) => item?.type === "output_text" && typeof item.text === "string")
          .map((item: any) => item.text)
          .join("");

      const sources: WebSearchSource[] = [];
      const seen = new Set<string>();

      for (const item of output) {
        if (item?.type !== "message" || !Array.isArray(item.content)) continue;

        for (const contentItem of item.content) {
          if (!Array.isArray(contentItem?.annotations)) continue;

          for (const annotation of contentItem.annotations) {
            if (annotation?.type !== "url_citation" || typeof annotation.url !== "string") continue;
            if (seen.has(annotation.url)) continue;

            seen.add(annotation.url);
            sources.push({
              title: typeof annotation.title === "string" && annotation.title.trim()
                ? annotation.title
                : annotation.url,
              url: annotation.url
            });
          }
        }
      }

      return { text, sources };
    }
  };
}
