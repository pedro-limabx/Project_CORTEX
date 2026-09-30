import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { Pool } from "pg";
import { InMemoryStore, type MemoryStore } from "./memory/store.js";
import { PostgresMemoryStore } from "./memory/postgres-store.js";
import { LocalTestProvider, OpenAICompatibleProvider } from "./llm/provider.js";
import { NeuronCore } from "./neuron/core.js";
import { ToolExecutor } from "./tools/executor.js";
import { calculatorTool, timeTool } from "./tools/builtin.js";
import { ToolRegistry } from "./tools/registry.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: config.CORS_ORIGIN });

const pool = config.DATABASE_URL ? new Pool({ connectionString: config.DATABASE_URL }) : undefined;
let memory: MemoryStore;
if (pool) {
  const postgresMemory = new PostgresMemoryStore(pool);
  await postgresMemory.initialize();
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
const neuron = new NeuronCore(llm, memory, registry, executor);

app.get("/health", async () => ({
  ok: true,
  service: "cortex",
  intelligence: "neuron",
  version: "0.3.0",
  timestamp: new Date().toISOString()
}));

app.get("/api/tools", async () => registry.list().map(t => ({
  name: t.name,
  version: t.version,
  description: t.description,
  risk: t.risk,
  permissions: t.permissions
})));

app.post("/api/chat", async (request, reply) => {
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

  const permissions = Array.isArray(body.grantedPermissions)
    ? body.grantedPermissions.filter((p): p is string => typeof p === "string")
    : [];
  const approvals = Array.isArray(body.approvedToolCalls)
    ? body.approvedToolCalls.filter((p): p is string => typeof p === "string")
    : [];

  const userId = typeof body.userId === "string" && body.userId.trim() ? body.userId : "local-user";
  return neuron.respond(userId, body.message.trim(), {
    grantedPermissions: permissions as any,
    approvedToolCalls: approvals,
    dryRun: body.dryRun === true
  });
});

const shutdown = async () => {
  await app.close();
  await pool?.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
