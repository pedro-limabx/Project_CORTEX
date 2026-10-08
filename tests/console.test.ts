import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import { Script, runInNewContext } from "node:vm";
import { resolve } from "node:path";
import { registerConsole } from "../src/console.js";

describe("CORTEX web console", () => {
  it("serves the dashboard and its same-origin assets", async () => {
    const app = Fastify();
    registerConsole(app);

    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(302);
    expect(root.headers.location).toBe("/console");

    const index = await app.inject({ method: "GET", url: "/console" });
    expect(index.statusCode).toBe(200);
    expect(index.headers["content-type"]).toContain("text/html");
    expect(index.body).toContain("CORTEX");
    expect(index.body).toContain('src="/console/app.js"');
    expect(index.body).toContain('id="workflow-objective"');
    expect(index.body).toContain('id="propose-workflow"');
    expect(index.body).toContain('href="/console/styles.css"');
    expect(index.body).not.toContain("127.0.0.1:3000/api/chat");

    const script = await app.inject({ method: "GET", url: "/console/app.js" });
    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toContain("javascript");
    expect(script.body).toContain('api("/api/chat"');
    expect(script.body).toContain('api("/api/workflows/propose"');

    const stylesheet = await app.inject({ method: "GET", url: "/console/styles.css" });
    expect(stylesheet.statusCode).toBe(200);
    expect(stylesheet.headers["content-type"]).toContain("text/css");

    for (const response of [index, script, stylesheet]) {
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["content-security-policy"]).toContain("connect-src 'self'");
      expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    }

    await app.close();
  });

  function setupChatHandlers(
    source: string,
    overrides: { api?: (path: string, options: unknown) => Promise<unknown> } = {}
  ) {
    const start = source.indexOf("let chatSending = false;");
    const finish = source.indexOf("function renderChatInspection(result)", start);
    expect(start).toBeGreaterThan(-1);
    expect(finish).toBeGreaterThan(start);

    type KeyEvent = {
      key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean;
      metaKey: boolean; isComposing: boolean; keyCode: number;
      preventDefault: () => void;
    };
    const input = { value: "Calcule 25*18" };
    const button = { disabled: false };
    const checkbox = { checked: false };
    const key = vi.fn();
    const submit = vi.fn();
    const form = {
      addEventListener: (_name: string, callback: (event: { preventDefault: () => void }) => void) => {
        submit.mockImplementation(callback);
      }
    };
    const textarea = {
      ...input,
      addEventListener: (_name: string, callback: (event: KeyEvent) => void) => {
        key.mockImplementation(callback);
      }
    };
    const api = vi.fn(overrides.api ?? (async () => ({
      requestId: "req-1", text: "O resultado é 450.",
      plan: { objective: input.value, status: "COMPLETED", steps: [] }
    })));
    const messages = vi.fn();
    const notice = vi.fn();
    const inspect = vi.fn();
    const state = { busy: true, lastChat: null as unknown }; // background refresh must not block chat
    runInNewContext(source.slice(start, finish), {
      $: (selector: string) => {
        if (selector === "#message") return textarea;
        if (selector === "#dry-run") return checkbox;
        if (selector === "#chat-form button[type=submit]") return button;
        if (selector === "#chat-form") return form;
        throw new Error("Unexpected selector: " + selector);
      },
      api, addMessage: messages, renderChatInspection: inspect,
      showNotice: notice, hideNotice: vi.fn(), loadTasks: vi.fn(), state
    });
    const keydown = (changes: Partial<KeyEvent> = {}) => {
      const preventDefault = vi.fn();
      key({
        key: "Enter", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
        isComposing: false, keyCode: 13, preventDefault, ...changes
      });
      return preventDefault;
    };
    return { textarea, input, button, api, messages, notice, inspect, state, keydown, submit };
  }

  it("actually sends through the API on Enter and through the button submit handler", async () => {
    const source = await readFile(resolve(process.cwd(), "web/app.js"), "utf8");
    const chat = setupChatHandlers(source);

    expect(chat.keydown()).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(chat.messages).toHaveBeenCalledTimes(2));
    expect(chat.api).toHaveBeenCalledWith("/api/chat", {
      method: "POST", body: { message: "Calcule 25*18", dryRun: false }
    });
    expect(chat.notice).toHaveBeenCalledWith(
      "Mensagem enviada ao servidor. Aguardando resposta do NEURON..."
    );
    expect(chat.messages).toHaveBeenNthCalledWith(1, "VOCÊ", "Calcule 25*18", true);
    expect(chat.messages).toHaveBeenNthCalledWith(2, "NEURON", "O resultado é 450.");
    expect(chat.button.disabled).toBe(false);
    expect(chat.textarea.value).toBe("");
    expect(chat.state.lastChat).toMatchObject({ requestId: "req-1" });

    chat.textarea.value = "Outro teste";
    const preventDefault = vi.fn();
    chat.submit({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(chat.api).toHaveBeenCalledTimes(2));
    expect(chat.api).toHaveBeenNthCalledWith(2, "/api/chat", {
      method: "POST", body: { message: "Outro teste", dryRun: false }
    });
  });

  it("keeps Shift+Enter for newlines and preserves draft on API failures", async () => {
    const source = await readFile(resolve(process.cwd(), "web/app.js"), "utf8");
    const failingApi = vi.fn(async () => { throw new Error("Network unreachable"); });
    const chat = setupChatHandlers(source, { api: failingApi });
    for (const changes of [
      { shiftKey: true }, { isComposing: true }, { keyCode: 229 },
      { key: "A" }, { ctrlKey: true }, { altKey: true }, { metaKey: true }
    ]) {
      expect(chat.keydown(changes)).not.toHaveBeenCalled();
    }
    expect(chat.api).not.toHaveBeenCalled();

    chat.keydown();
    await vi.waitFor(() => expect(chat.notice).toHaveBeenCalledWith(
      "Falha ao enviar ao NEURON: Network unreachable", "error"
    ));
    expect(chat.textarea.value).toBe("Calcule 25*18");
    expect(chat.messages).not.toHaveBeenCalled();
    expect(chat.button.disabled).toBe(false);
  });

  it("ships parseable JavaScript without embedding server secrets or local URL assumptions", async () => {
    const script = await readFile(resolve(process.cwd(), "web/app.js"), "utf8");
    expect(() => new Script(script, { filename: "web/app.js" })).not.toThrow();
    expect(script).toContain('credentials: "same-origin"');
    expect(script).not.toContain("localStorage");
    expect(script).not.toContain("sessionStorage");
    expect(script).not.toContain("http://127.0.0.1:3000");
  });
});
