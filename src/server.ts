import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { InMemoryStore } from "./memory/store.js";
import { OpenAICompatibleProvider } from "./llm/provider.js";
import { NeuronCore } from "./neuron/core.js";
import { ToolExecutor } from "./tools/executor.js";
import { calculatorTool, timeTool } from "./tools/builtin.js";
import { ToolRegistry } from "./tools/registry.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: config.CORS_ORIGIN });

const memory = new InMemoryStore();
const registry = new ToolRegistry();
registry.register(calculatorTool);
registry.register(timeTool);

const executor = new ToolExecutor(registry);
const llm = new OpenAICompatibleProvider(config.LLM_BASE_URL, config.LLM_API_KEY, config.LLM_MODEL);
const neuron = new NeuronCore(llm, memory, registry, executor);

app.get("/health", async () => ({
  ok: true,
  service: "cortex",
  intelligence: "neuron",
  version: "0.2.0",
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
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
