import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

// Console assets are served from a fixed allowlist; never accept client paths.
// The logo/video live in web/assets and can be installed independently from code.
const filePaths = {
  html: resolve(process.cwd(), "web/index.html"),
  css: resolve(process.cwd(), "web/styles.css"),
  javascript: resolve(process.cwd(), "web/app.js"),
  logo: resolve(process.cwd(), "web/assets/cortex-logo.png"),
  intro: resolve(process.cwd(), "web/assets/cortex-intro.mp4")
};

const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "media-src 'self'",
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

export type VideoRange = { start: number; end: number };
export function parseVideoRange(header: string | undefined, size: number): VideoRange | null | "invalid" {
  if (!header) return null;
  if (size <= 0) return "invalid";
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match) return "invalid";
  const [, startText = "", endText = ""] = match;
  if (!startText && !endText) return "invalid";
  const parsedStart = startText ? Number(startText) : 0;
  const parsedEnd = endText ? Number(endText) : size - 1;
  if (!Number.isSafeInteger(parsedStart) || !Number.isSafeInteger(parsedEnd)) return "invalid";
  // Suffix ranges: bytes=-500 means the last 500 bytes.
  const start = !startText ? Math.max(0, size - parsedEnd) : parsedStart;
  const end = !startText ? size - 1 : Math.min(parsedEnd, size - 1);
  if (start >= size || start < 0 || end < start || (startText && endText && parsedStart > parsedEnd)) {
    return "invalid";
  }
  return { start, end };
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

  app.get("/console/media/logo.png", async (_request, reply) => {
    try {
      const logo = await readFile(filePaths.logo);
      return browserHeaders(reply).type("image/png").send(logo);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return browserHeaders(reply).code(404).send({ error: "Brand logo asset not installed" });
      }
      throw error;
    }
  });

  app.get("/console/media/intro.mp4", async (request, reply) => {
    let fileSize: number;
    try {
      fileSize = (await stat(filePaths.intro)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return browserHeaders(reply).code(404).send({ error: "Startup video asset not installed" });
      }
      throw error;
    }
    const range = parseVideoRange(request.headers.range, fileSize);
    if (range === "invalid") {
      return browserHeaders(reply).code(416)
        .header("Content-Range", `bytes */${fileSize}`)
        .send({ error: "Invalid video byte range" });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? fileSize - 1;
    const response = browserHeaders(reply)
      .header("Accept-Ranges", "bytes")
      .header("Content-Length", String(end - start + 1))
      .type("video/mp4");
    if (range) {
      response.code(206).header("Content-Range", `bytes ${start}-${end}/${fileSize}`);
    }
    return response.send(createReadStream(filePaths.intro, { start, end }));
  });
}
