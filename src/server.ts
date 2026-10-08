import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import crypto from "node:crypto";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { InMemoryAuditStore, type AuditStore } from "./audit/store.js";
import { PostgresAuditStore } from "./audit/postgres-store.js";
import { Pool } from "pg";
import { InMemoryStore, type MemoryStore } from "./memory/store.js";
import { PostgresMemoryStore } from "./memory/postgres-store.js";
import { PermissionEngine } from "./permissions/engine.js";
import { InMemoryPermissionStore } from "./permissions/in-memory-store.js";
import { PostgresPermissionStore } from "./permissions/postgres-store.js";
import { ApprovalEngine } from "./approval/engine.js";
import { InMemoryApprovalStore } from "./approval/store.js";
import { PostgresApprovalStore } from "./approval/postgres-store.js";
import { LocalTestProvider, OpenAICompatibleProvider } from "./llm/provider.js";
import { NeuronCore } from "./neuron/core.js";
import { ToolExecutor } from "./tools/executor.js";
import { calculatorTool, timeTool } from "./tools/builtin.js";
import { createWebSearchTool } from "./tools/web-search.js";
import { ToolRegistry } from "./tools/registry.js";

const app = Fastify({ logger: true });

if (config.NODE_ENV === "production" && !config.CORTEX_API_TOKEN) {
  throw new Error("CORTEX_API_TOKEN is required in production");
}

async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!config.CORTEX_API_TOKEN) return;
  const authorization = request.headers.authorization;
  const supplied = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  const expectedBuffer = Buffer.from(config.CORTEX_API_TOKEN);
  const suppliedBuffer = Buffer.from(supplied);
  const valid = suppliedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
  if (!valid) reply.code(401).send({ error: "Unauthorized" });
}

await app.register(cors, { origin: config.CORS_ORIGIN });

const pool = config.DATABASE_URL ? new Pool({ connectionString: config.DATABASE_URL }) : undefined;
let memory: MemoryStore;
let permissions: PermissionEngine;
let approvals: ApprovalEngine;
let audit: AuditStore = new InMemoryAuditStore();
if (pool) {
  const postgresMemory = new PostgresMemoryStore(pool);
  await postgresMemory.initialize();
  const postgresPermissions = new PostgresPermissionStore(pool);
  await postgresPermissions.initialize();
  permissions = new PermissionEngine(postgresPermissions);
  const postgresApprovals = new PostgresApprovalStore(pool);
  await postgresApprovals.initialize();
  approvals = new ApprovalEngine(postgresApprovals);
  const postgresAudit = new PostgresAuditStore(pool);
  await postgresAudit.initialize();
  audit = postgresAudit;
  memory = postgresMemory;
  app.log.info("Persistent PostgreSQL memory and audit enabled");
} else {
  memory = new InMemoryStore();
  permissions = new PermissionEngine(new InMemoryPermissionStore());
  approvals = new ApprovalEngine(new InMemoryApprovalStore());
  app.log.warn("DATABASE_URL is not set; using in-memory memory, permissions and audit stores");
}

const registry = new ToolRegistry();
registry.register(calculatorTool);
registry.register(timeTool);
if (!config.LOCAL_TEST_MODE) {
  registry.register(createWebSearchTool(config.LLM_BASE_URL, config.LLM_API_KEY, config.LLM_MODEL));
}

const executor = new ToolExecutor(registry);
const llm = config.LOCAL_TEST_MODE
  ? new LocalTestProvider()
  : new OpenAICompatibleProvider(config.LLM_BASE_URL, config.LLM_API_KEY, config.LLM_MODEL);
const neuron = new NeuronCore(llm, memory, registry, executor, permissions, approvals, audit);

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

app.post("/api/approvals/:id/approve", { preHandler: authenticate }, async (request, reply) => {
  const params = request.params as { id?: string };
  if (!params.id) return reply.code(400).send({ error: "approval id is required" });
  const approval = await approvals.approve(params.id, config.CORTEX_USER_ID);
  if (!approval) return reply.code(404).send({ error: "approval not found, expired, or already finalized" });
  return { ok: true, approvalId: approval.id, approvedAt: approval.approvedAt, expiresAt: approval.expiresAt };
});

app.post("/api/approvals/:id/reject", { preHandler: authenticate }, async (request, reply) => {
  const params = request.params as { id?: string };
  if (!params.id) return reply.code(400).send({ error: "approval id is required" });
  const approval = await approvals.reject(params.id, config.CORTEX_USER_ID);
  if (!approval) return reply.code(404).send({ error: "approval not found or already finalized" });
  return { ok: true, approvalId: approval.id, rejectedAt: approval.rejectedAt };
});

// Task endpoints expose only records owned by the server-controlled identity.
app.get("/api/tasks", { preHandler: authenticate }, async (request, reply) => {
  const query = request.query as { limit?: string };
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return reply.code(400).send({ error: "limit must be an integer between 1 and 100" });
  }
  const records = await memory.listTasks(config.CORTEX_USER_ID, limit);
  return { tasks: records.map(record => ({
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    plan: JSON.parse(record.content)
  })) };
});

app.get("/api/tasks/:id", { preHandler: authenticate }, async (request, reply) => {
  const { id } = request.params as { id: string };
  const record = await memory.getTask(config.CORTEX_USER_ID, id);
  if (!record) return reply.code(404).send({ error: "task not found" });
  return {
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    plan: JSON.parse(record.content)
  };
});

app.post("/api/chat", { preHandler: authenticate }, async (request, reply) => {
  const body = request.body && typeof request.body === "object"
    ? request.body as { message?: unknown; dryRun?: unknown; approvalId?: unknown; resumeTaskId?: unknown }
    : {};

  if (typeof body.message !== "string" || body.message.trim().length === 0) {
    return reply.code(400).send({ error: "message is required" });
  }

  // Identity is server-controlled; clients cannot grant permissions or approve tools.
  const options = body.dryRun === true
    ? {
        dryRun: true as const,
        ...(typeof body.approvalId === "string" ? { approvalId: body.approvalId } : {}),
        ...(typeof body.resumeTaskId === "string" ? { resumeTaskId: body.resumeTaskId } : {})
      }
    : {
        ...(typeof body.approvalId === "string" ? { approvalId: body.approvalId } : {}),
        ...(typeof body.resumeTaskId === "string" ? { resumeTaskId: body.resumeTaskId } : {})
      };

  return neuron.respond(config.CORTEX_USER_ID, body.message.trim(), options);
});

const shutdown = async () => {
  await app.close();
  await pool?.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
