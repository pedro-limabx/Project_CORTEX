import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

// The dashboard and APIs share the same origin. Never put CORTEX_API_TOKEN
// or LLM_API_KEY in browser responses: the user can supply their own API token
// for the current tab and the server keeps provider keys private.
const filePaths = {
  html: resolve(process.cwd(), "web/index.html"),
  css: resolve(process.cwd(), "web/styles.css"),
  javascript: resolve(process.cwd(), "web/app.js")
};

const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

function browserHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header("Cache-Control", "no-store")
    .header("X-Content-Type-Options", "nosniff")
    .header("Referrer-Policy", "no-referrer")
    .header("Content-Security-Policy", csp);
}

export function registerConsole(app: FastifyInstance): void {
  app.get("/", async (_request, reply) => reply.redirect("/console"));

  app.get("/console", async (_request, reply) => {
    const html = await readFile(filePaths.html, "utf8");
    return browserHeaders(reply).type("text/html; charset=utf-8").send(html);
  });

  app.get("/console/styles.css", async (_request, reply) => {
    const css = await readFile(filePaths.css, "utf8");
    return browserHeaders(reply).type("text/css; charset=utf-8").send(css);
  });

  app.get("/console/app.js", async (_request, reply) => {
    const javascript = await readFile(filePaths.javascript, "utf8");
    return browserHeaders(reply).type("application/javascript; charset=utf-8").send(javascript);
  });
}
