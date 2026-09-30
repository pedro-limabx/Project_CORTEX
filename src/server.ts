import Fastify from "fastify";
import crypto from "node:crypto";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { InMemoryAuditStore, type AuditStore } from "./audit/store.js";
import { PostgresAuditStore } from "./audit/postgres-store.js";
import { Pool } from "pg";
import { InMemoryStore, type MemoryStore } from "./memory/store.js";
import { PostgresMemoryStore } from "./memory/postgres-store.js";
import { LocalTestProvider, OpenAICompatibleProvider } from "./llm/provider.js";
import { NeuronCore } from "./neuron/core.js";
import { ToolExecutor } from "./tools/executor.js";
import { calculatorTool, timeTool } from "./tools/builtin.js";
import { ToolRegistry } from "./tools/registry.js";

const app = Fastify({ logger: true });

if (config.NODE_ENV === "production" && !config.CORTEX_API_TOKEN) {
  throw new Error("CORTEX_API_TOKEN is required in production");
}

function authenticate(request: { headers: Record<string, string | string[] | undefined> }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): unknown {
  if (!config.CORTEX_API_TOKEN) return;
  const authorization = request.headers.authorization;
  const supplied = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  const expectedBuffer = Buffer.from(config.CORTEX_API_TOKEN);
  const suppliedBuffer = Buffer.from(supplied);
  const valid = suppliedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
  if (!valid) return reply.code(401).send({ error: "Unauthorized" });
}
await app.register(cors, { origin: config.CORS_ORIGIN });

const pool = config.DATABASE_URL ? new Pool({ connectionString: config.DATABASE_URL }) : undefined;
let memory: MemoryStore;
let audit: AuditStore = new InMemoryAuditStore();
if (pool) {
  const postgresMemory = new PostgresMemoryStore(pool);
  await postgresMemory.initialize();
  const postgresAudit = new PostgresAuditStore(pool);
  await postgresAudit.initialize();
  audit = postgresAudit;
  memory = postgresMemory;
  app.log.info("Persistent PostgreSQL memory enabled");
} else {
  memory = new InMemoryStore();
  app.log.warn("DATABASE_URL is not set; using in-memory memory store");
}
const registry = new ToolRegistry();
registry.register(calculatorTool);
registry.register(timeTool);

const executor = new ToolExecutor(registry);
const llm = config.LOCAL_TEST_MODE
  ? new LocalTestProvider()
  : new OpenAICompatibleProvider(config.LLM_BASE_URL, config.LLM_API_KEY, config.LLM_MODEL);
const neuron = new NeuronCore(llm, memory, registry, executor, audit);

app.get("/health", async () => ({
  ok: true,
  service: "cortex",
  intelligence: "neuron",
  version: "0.3.0",
  timestamp: new Date().toISOString()
}));

app.get("/api/tools", { preHandler: authenticate }, async () => registry.list().map(t => ({
  name: t.name,
  version: t.version,
  description: t.description,
  risk: t.risk,
  permissions: t.permissions
})));

app.post("/api/chat", { preHandler: authenticate }, async (request, reply) => {
  const body = request.body as {
    message?: unknown;
    userId?: unknown;
    grantedPermissions?: unknown;
    approvedToolCalls?: unknown;
    dryRun?: unknown;
  };

  if (typeof body.message !== "string" || body.message.trim().length === 0) {
    return reply.code(400).send({ error: "message is required" });
  }

  // Identity is server-controlled; clients cannot grant permissions or approve tools.
  return neuron.respond(config.CORTEX_USER_ID, body.message.trim(), {
    grantedPermissions: [],
    approvedToolCalls: [],
    dryRun: body.dryRun === true
  });
