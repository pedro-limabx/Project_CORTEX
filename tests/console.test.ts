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

  it("sends on Enter but keeps Shift+Enter for multiline messages", async () => {
    const source = await readFile(resolve(process.cwd(), "web/app.js"), "utf8");
    const start = source.indexOf('$("#message").addEventListener("keydown"');
    const finish = source.indexOf('$("#chat-form").addEventListener("submit"', start);
    expect(start).toBeGreaterThan(-1);
    expect(finish).toBeGreaterThan(start);

    type KeyEvent = {
      key: string;
      shiftKey: boolean;
      ctrlKey: boolean;
      altKey: boolean;
      metaKey: boolean;
      isComposing: boolean;
      keyCode: number;
      preventDefault: () => void;
    };

    let onKeydown: ((event: KeyEvent) => void) | undefined;
    const form = { requestSubmit: vi.fn() };
    const message = {
      addEventListener: (_name: string, callback: (event: KeyEvent) => void) => {
        onKeydown = callback;
      }
    };
    runInNewContext(source.slice(start, finish), {
      $: (selector: string) => selector === "#message" ? message : form
    });
    expect(onKeydown).toBeDefined();

    const dispatch = (changes: Partial<KeyEvent> = {}) => {
      const preventDefault = vi.fn();
      onKeydown?.({
        key: "Enter",
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        isComposing: false,
        keyCode: 13,
        preventDefault,
        ...changes
      });
      return preventDefault;
    };

    expect(dispatch()).toHaveBeenCalledOnce();
    expect(form.requestSubmit).toHaveBeenCalledOnce();

    for (const changes of [
      { shiftKey: true },
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
      { isComposing: true },
      { keyCode: 229 },
      { key: "A" }
    ]) {
      expect(dispatch(changes)).not.toHaveBeenCalled();
    }
    expect(form.requestSubmit).toHaveBeenCalledOnce();
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
