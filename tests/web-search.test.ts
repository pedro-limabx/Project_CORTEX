import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSearchTool } from "../src/tools/web-search.js";

describe("web.search", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fails safely when the external provider is not configured", async () => {
    const tool = createWebSearchTool("https://api.example.com/v1");
    await expect(tool.execute({ query: "latest news" }, {
      userId: "test",
      requestId: "req",
      dryRun: false,
      grantedPermissions: new Set()
    })).rejects.toThrow("Web search is unavailable");
  });

  it("uses the Responses API web search tool and extracts sources", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "gpt-6-luna",
      output_text: "A resposta atual é baseada em fontes da web.",
      output: [{
        type: "message",
        role: "assistant",
        content: [{
          type: "output_text",
          text: "A resposta atual é baseada em fontes da web.",
          annotations: [
            {
              type: "url_citation",
              title: "Example Source",
              url: "https://example.com/source"
            }
          ]
        }]
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    vi.stubGlobal("fetch", fetchMock);

    const tool = createWebSearchTool(
      "https://api.example.com/v1",
      "secret-test-key",
      "gpt-6-luna"
    );

    const result = await tool.execute({ query: "quem é o homem mais rico do mundo hoje?" }, {
      userId: "test",
      requestId: "req",
      dryRun: false,
      grantedPermissions: new Set()
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/responses");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret-test-key");

    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("gpt-6-luna");
    expect(body.input).toBe("quem é o homem mais rico do mundo hoje?");
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(body.tool_choice).toBe("auto");

    expect(result).toEqual({
      text: "A resposta atual é baseada em fontes da web.",
      sources: [{
        title: "Example Source",
        url: "https://example.com/source"
      }]
    });
  });
});
