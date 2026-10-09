import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import crypto from "node:crypto";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { registerConsole } from "./console.js";
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
import { parseTaskPlan, reconcileInterruptedPlan, taskToResponse } from "./neuron/task.js";
import { ToolExecutor } from "./tools/executor.js";
import { calculatorTool, timeTool } from "./tools/builtin.js";
import { createWebSearchTool } from "./tools/web-search.js";
import { ToolRegistry } from "./tools/registry.js";
import { WorkflowEngine } from "./workflows/engine.js";
import { WorkflowProposalService, WorkflowProposalError } from "./workflows/proposal.js";
import { WorkflowReporter } from "./workflows/reporter.js";
import { MonitoringService } from "./workflows/monitoring.js";
import { PostgresMonitorRepository } from "./autonomy/store.js";
import { AutonomousMonitoringService, InAppNotificationChannel, validateMonitorSettings } from "./autonomy/monitor.js";
import { diagnoseMonitorHealth } from "./autonomy/diagnostics.js";
import { PostgresReminderRepository } from "./reminders/store.js";
import { ReminderScheduler, ReminderInputError, validateNewReminder } from "./reminders/service.js";
import {
  InMemoryAlertAcknowledgementStore,
  PostgresAlertAcknowledgementStore,
  type AlertAcknowledgementStore
} from "./alerts/store.js";
import {
  OperationalAlertService, AlertInputError, AlertConflictError, AlertNotFoundError
} from "./alerts/service.js";
import { InMemoryWorkflowStore, PostgresWorkflowStore, type WorkflowStore } from "./workflows/store.js";
import { WorkflowConflictError, WorkflowInputError, WorkflowNotFoundError } from "./workflows/types.js";

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
registerConsole(app);

const pool = config.DATABASE_URL ? new Pool({ connectionString: config.DATABASE_URL }) : undefined;
let memory: MemoryStore;
let permissions: PermissionEngine;
let approvals: ApprovalEngine;
let audit: AuditStore = new InMemoryAuditStore();
let workflowStore: WorkflowStore;
let alertAcknowledgements: AlertAcknowledgementStore;
let autonomousStore: PostgresMonitorRepository | undefined;
let reminderStore: PostgresReminderRepository | undefined;
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
  const postgresWorkflows = new PostgresWorkflowStore(pool);
  await postgresWorkflows.initialize();
  workflowStore = postgresWorkflows;
  const postgresAlerts = new PostgresAlertAcknowledgementStore(pool);
  await postgresAlerts.initialize();
  alertAcknowledgements = postgresAlerts;
  autonomousStore = new PostgresMonitorRepository(pool);
  await autonomousStore.initialize();
  reminderStore = new PostgresReminderRepository(pool);
  await reminderStore.initialize();
  app.log.info("Persistent PostgreSQL memory and audit enabled");
} else {
  memory = new InMemoryStore();
  workflowStore = new InMemoryWorkflowStore();
  alertAcknowledgements = new InMemoryAlertAcknowledgementStore();
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
const workflowReporter = new WorkflowReporter(workflowStore);
const monitoring = new MonitoringService(workflowStore);
const operationalAlerts = new OperationalAlertService(workflowStore, alertAcknowledgements);
const backendMonitor = autonomousStore
  ? new AutonomousMonitoringService(autonomousStore, operationalAlerts, config.CORTEX_USER_ID,
    new InAppNotificationChannel(autonomousStore), () => new Date(),
    () => app.log.error('Autonomous monitoring check failed (details redacted)'))
  : undefined;
const reminderScheduler = reminderStore
  ? new ReminderScheduler(reminderStore, config.CORTEX_USER_ID, () => new Date(),
      () => app.log.error("Reminder scheduler failed (details redacted)"))
  : undefined;
const neuron = new NeuronCore(llm, memory, registry, executor, permissions, approvals, audit, workflowReporter);
const workflows = new WorkflowEngine(workflowStore, registry, executor, permissions, approvals, audit);
const workflowProposals = new WorkflowProposalService(llm, workflows, registry, config.LOCAL_TEST_MODE);

app.get("/health", async () => ({
  ok: true,
  service: "cortex",
  intelligence: "neuron",
  version: "0.3.0",
  capabilities: { brandingMediaRoutes: true },
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
  return { tasks: records.map(record => {
    try {
      return taskToResponse(record);
    } catch {
      return { id: record.id, error: "Persisted task is invalid" };
    }
  }) };
});

app.get("/api/tasks/:id", { preHandler: authenticate }, async (request, reply) => {
  const { id } = request.params as { id: string };
  const record = await memory.getTask(config.CORTEX_USER_ID, id);
  if (!record) return reply.code(404).send({ error: "task not found" });
  try {
    return taskToResponse(record);
  } catch {
    return reply.code(422).send({ error: "Persisted task is invalid" });
  }
});

// This is an operator acknowledgement, never an automatic retry of a potentially executed tool.
app.post("/api/tasks/:id/reconcile", { preHandler: authenticate }, async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body && typeof request.body === "object"
    ? request.body as { outcome?: unknown; confirmed?: unknown }
    : {};
  if (body.confirmed !== true || (body.outcome !== "completed" && body.outcome !== "failed")) {
    return reply.code(400).send({
      error: "confirmed=true and an independently verified outcome (completed or failed) are required"
    });
  }
  const record = await memory.getTask(config.CORTEX_USER_ID, id);
  if (!record) return reply.code(404).send({ error: "task not found" });
  try {
    const plan = reconcileInterruptedPlan(parseTaskPlan(record.content), body.outcome);
    const saved = {
      ...record,
      content: JSON.stringify(plan),
      updatedAt: new Date().toISOString()
    };
    await memory.save(saved);
    return taskToResponse(saved);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Invalid task state";
    return reply.code(reason === "Persisted task is invalid" ? 422 : 409).send({ error: reason });
  }
});

app.post("/api/tasks/:id/resume", { preHandler: authenticate }, async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body && typeof request.body === "object"
    ? request.body as { message?: unknown; approvalId?: unknown; dryRun?: unknown }
    : {};
  if (body.message !== undefined && (typeof body.message !== "string" || !body.message.trim())) {
    return reply.code(400).send({ error: "message must be a nonempty string" });
  }
  if (body.approvalId !== undefined && typeof body.approvalId !== "string") {
    return reply.code(400).send({ error: "approvalId must be a string" });
  }
  try {
    return await neuron.respond(
      config.CORTEX_USER_ID,
      typeof body.message === "string" ? body.message.trim() : "Continue a tarefa preservando o objetivo original.",
      {
        resumeTaskId: id,
        ...(body.dryRun === true ? { dryRun: true } : {}),
        ...(typeof body.approvalId === "string" ? { approvalId: body.approvalId } : {})
      }
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    if (reason === "Task not found") return reply.code(404).send({ error: reason });
    if (reason === "Persisted task is invalid") return reply.code(422).send({ error: reason });
    if (reason === "Task is already finalized" || reason.includes("interrupted tool step")) {
      return reply.code(409).send({ error: reason });
    }
    if (reason.includes("Approval") || reason.includes("permissions") || reason.includes("dry-run")) {
      return reply.code(400).send({ error: reason });
    }
    throw error;
  }
});

function workflowError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof WorkflowInputError) return reply.code(400).send({ error: error.message });
  if (error instanceof WorkflowNotFoundError) return reply.code(404).send({ error: error.message });
  if (error instanceof WorkflowConflictError) return reply.code(409).send({ error: error.message });
  throw error;
}

// Draft only. The model cannot persist, approve or execute a proposed workflow.
app.post("/api/workflows/propose", { preHandler: authenticate }, async (request, reply) => {
  const body = request.body && typeof request.body === "object"
    ? request.body as { objective?: unknown }
    : {};
  try {
    return await workflowProposals.propose(body.objective);
  } catch (error) {
    if (error instanceof WorkflowProposalError) {
      return reply.code(422).send({ error: error.message });
    }
    if (error instanceof WorkflowInputError) {
      return reply.code(400).send({ error: error.message });
    }
    throw error;
  }
});

app.post("/api/workflows", { preHandler: authenticate }, async (request, reply) => {
  try {
    const workflow = await workflows.create(config.CORTEX_USER_ID, request.body);
    return reply.code(201).send(workflow);
  } catch (error) {
    return workflowError(reply, error);
  }
});

app.get("/api/workflows", { preHandler: authenticate }, async (request, reply) => {
  const query = request.query as { limit?: string };
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return reply.code(400).send({ error: "limit must be an integer from 1 to 100" });
  }
  return { workflows: await workflows.list(config.CORTEX_USER_ID, limit) };
});

// v8 inbox: calculated on demand, no autonomous polling or external delivery.
app.get("/api/alerts", { preHandler: authenticate }, async (request, reply) => {
  const query = request.query as { limit?: unknown; view?: unknown };
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const view = query.view === undefined ? "all" : query.view;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
      (view !== "all" && view !== "unread")) {
    return reply.code(400).send({
      error: "limit must be 1..100 and view must be all or unread"
    });
  }
  return operationalAlerts.inbox(config.CORTEX_USER_ID, { limit, view });
});

// Operator confirms reading an EXACT workflow version/status. This does not
// grant a tool permission, reconcile external effects or change the workflow.
app.post("/api/alerts/acknowledge", { preHandler: authenticate }, async (request, reply) => {
  try {
    return await operationalAlerts.acknowledge(config.CORTEX_USER_ID, request.body);
  } catch (error) {
    if (error instanceof AlertInputError) {
      return reply.code(400).send({ error: error.message });
    }
    if (error instanceof AlertNotFoundError) {
      return reply.code(404).send({ error: error.message });
    }
    if (error instanceof AlertConflictError) {
      return reply.code(409).send({ error: error.message });
    }
    throw error;
  }
});

// V10: server-side, persistent and human-supervised monitoring configuration.
// No endpoint in this section invokes LLMs, tools, approvals or reconciliations.
app.get("/api/monitoring/backend", { preHandler: authenticate }, async () => {
  if (!autonomousStore) return {
    available: false, reason: "DATABASE_URL required for persistent backend monitoring"
  };
  return {
    available: true,
    settings: await autonomousStore.getSettings(config.CORTEX_USER_ID),
    delivery: ["in-app"],
    readOnlyChecks: true
  };
});

app.put("/api/monitoring/backend", { preHandler: authenticate }, async (request, reply) => {
  if (!autonomousStore) return reply.code(503).send({ error: "PostgreSQL is required" });
  let input: ReturnType<typeof validateMonitorSettings>;
  try { input = validateMonitorSettings(request.body); }
  catch { return reply.code(400).send({ error: "Invalid monitoring configuration" }); }
  const settings = await autonomousStore.configure(
    config.CORTEX_USER_ID, input.enabled, input.intervalSeconds, input.cooldownSeconds
  );
  // Scheduling is owned by the backend. Wake it immediately after explicit enable.
  if (input.enabled) void backendMonitor?.checkDue().catch(
    () => app.log.error("Autonomous monitoring check failed (details redacted)")
  );
  return { available: true, settings, delivery: ["in-app"] };
});

// V11: health information and user-confirmed checks; neither executes actions.
app.get("/api/monitoring/backend/health", { preHandler: authenticate }, async (request, reply) => {
  if (!autonomousStore) return reply.code(503).send({error:"PostgreSQL is required"});
  const settings = await autonomousStore.getSettings(config.CORTEX_USER_ID);
  const inbox = await autonomousStore.list(config.CORTEX_USER_ID, "unread", 1);
  return {...diagnoseMonitorHealth(settings), unreadNotifications: inbox.unread};
});
app.post("/api/monitoring/backend/check", { preHandler: authenticate }, async (request, reply) => {
  if (!backendMonitor) return reply.code(503).send({error:"PostgreSQL is required"});
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).length !== 1 || (body as {confirmed?: unknown}).confirmed !== true) {
    return reply.code(400).send({error:"Explicit confirmed=true is required"});
  }
  const result = await backendMonitor.checkDue(true);
  return {...result, actionExecuted:false, approvalGranted:false, readOnly:true};
});

app.get("/api/monitoring/backend/events", { preHandler: authenticate }, async (request, reply) => {
  if (!autonomousStore) return reply.code(503).send({ error: "PostgreSQL is required" });
  const query = request.query as { limit?: unknown };
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return reply.code(400).send({ error: "limit must be 1..100" });
  }
  return { events: await autonomousStore.events(config.CORTEX_USER_ID, limit) };
});

app.get("/api/notifications", { preHandler: authenticate }, async (request, reply) => {
  if (!autonomousStore) return reply.code(503).send({ error: "PostgreSQL is required" });
  const query = request.query as { view?: unknown; limit?: unknown };
  const view = query.view === undefined ? "unread" : query.view;
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if ((view !== "all" && view !== "unread")
    || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return reply.code(400).send({ error: "view must be all or unread; limit must be 1..100" });
  }
  // UUID, status, severity, timestamps only; no objectives, errors, inputs or outputs.
  return autonomousStore.list(config.CORTEX_USER_ID, view, limit);
});

app.post("/api/notifications/:id/read", { preHandler: authenticate }, async (request, reply) => {
  if (!autonomousStore) return reply.code(503).send({ error: "PostgreSQL is required" });
  const { id } = request.params as { id: string };
  const body = request.body && typeof request.body === "object" ? request.body as { confirmed?: unknown } : {};
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id) || body.confirmed !== true) {
    return reply.code(400).send({ error: "Valid id and confirmed=true required" });
  }
  const found = await autonomousStore.read(config.CORTEX_USER_ID, id, new Date().toISOString());
  if (!found) return reply.code(404).send({ error: "Notification not found" });
  return { read: true, actionExecuted: false, approvalGranted: false };
});

// V12: single-shot reminders. User-created text is private and owner-scoped.
// No external message delivery or autonomous tool execution occurs.
const reminderUuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

app.get("/api/reminders", { preHandler: authenticate }, async (request, reply) => {
  if (!reminderStore) return reply.code(503).send({error:"PostgreSQL is required for reminders"});
  const query = request.query as { view?: unknown; limit?: unknown };
  const view = query.view === undefined ? "all" : query.view;
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if ((view !== "all" && view !== "pending" && view !== "due"
      && view !== "done" && view !== "cancelled")
      || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return reply.code(400).send({error:"Invalid reminder view or limit (1..100)"});
  }
  // Catch newly-due reminders on demand, including after a Codespaces pause.
  await reminderScheduler?.checkDue();
  const [reminders, due] = await Promise.all([
    reminderStore.list(config.CORTEX_USER_ID, view, limit),
    reminderStore.dueCount(config.CORTEX_USER_ID)
  ]);
  return {reminders, due, delivery:"in-app-only", readOnlyChecks:true};
});

app.post("/api/reminders", { preHandler: authenticate }, async (request, reply) => {
  if (!reminderStore) return reply.code(503).send({error:"PostgreSQL is required for reminders"});
  let input: ReturnType<typeof validateNewReminder>;
  try { input = validateNewReminder(request.body); }
  catch (error) {
    if (error instanceof ReminderInputError) return reply.code(400).send({error:error.message});
    throw error;
  }
  const reminder = await reminderStore.create(config.CORTEX_USER_ID,input.title,input.dueAt,new Date().toISOString());
  return reply.code(201).send({reminder,delivery:"in-app-only",actionExecuted:false});
});

app.post("/api/reminders/:id/:action", { preHandler: authenticate }, async (request, reply) => {
  if (!reminderStore) return reply.code(503).send({error:"PostgreSQL is required for reminders"});
  const { id, action } = request.params as {id:string;action:string};
  const body = request.body;
  if (!reminderUuid.test(id) || (action !== "complete" && action !== "cancel")
      || !body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== 1 || (body as {confirmed?:unknown}).confirmed !== true) {
    return reply.code(400).send({error:"Valid reminder id, action and confirmed=true required"});
  }
  const updated = await reminderStore.transition(config.CORTEX_USER_ID,id,
    action === "complete" ? "DONE" : "CANCELLED",new Date().toISOString());
  if (!updated) {
    const existing = await reminderStore.get(config.CORTEX_USER_ID,id);
    if (!existing) return reply.code(404).send({error:"Reminder not found"});
    return reply.code(409).send({error:"Reminder is already finalized"});
  }
  return {reminder:await reminderStore.get(config.CORTEX_USER_ID,id),
    actionExecuted:false,approvalGranted:false};
});

// Reporting is read-only and scoped to the server-controlled identity.
// Owner-scoped, read-only status and performance indicators from a bounded
// snapshot of recent workflows. No raw inputs, outputs or secrets are exposed.
app.get("/api/monitoring/overview", { preHandler: authenticate }, async (request, reply) => {
  const query = request.query as { limit?: unknown };
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return reply.code(400).send({ error: "limit must be an integer from 1 to 100" });
  }
  return monitoring.overview(config.CORTEX_USER_ID, limit);
});

app.get("/api/workflows/summary", { preHandler: authenticate }, async (request, reply) => {
  const query = request.query as { id?: unknown; limit?: unknown };
  const limit = query.limit === undefined ? 10 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    return reply.code(400).send({ error: "limit must be an integer from 1 to 20" });
  }
  if (query.id !== undefined && (typeof query.id !== "string"
    || !/^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/.test(query.id))) {
    return reply.code(400).send({ error: "Invalid workflow id" });
  }
  return workflowReporter.summarize(
    config.CORTEX_USER_ID,
    typeof query.id === "string" ? { id: query.id, limit } : { limit }
  );
});

app.get("/api/workflows/:id", { preHandler: authenticate }, async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    return await workflows.get(config.CORTEX_USER_ID, id);
  } catch (error) {
    return workflowError(reply, error);
  }
});

// Owner-scoped metadata-only timeline. Never invokes the executor, LLM or approvals.
app.get("/api/workflows/:id/timeline", { preHandler: authenticate }, async (request, reply) => {
  const { id } = request.params as { id: string };
  const query = request.query as { limit?: unknown };
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return reply.code(400).send({ error: "limit must be an integer from 1 to 100" });
  }
  try {
    return await workflows.timeline(config.CORTEX_USER_ID, id, limit);
  } catch (error) {
    return workflowError(reply, error);
  }
});

app.post("/api/workflows/:id/advance", { preHandler: authenticate }, async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body && typeof request.body === "object"
    ? request.body as { approvalId?: unknown }
    : {};
  if (body.approvalId !== undefined && typeof body.approvalId !== "string") {
    return reply.code(400).send({ error: "approvalId must be a string" });
  }
  try {
    return await workflows.advance(
      config.CORTEX_USER_ID,
      id,
      typeof body.approvalId === "string" ? body.approvalId : undefined
    );
  } catch (error) {
    return workflowError(reply, error);
  }
});

// Operator attests a confirmed failed action before a declared alternate
// handler may be advanced. This request NEVER invokes the failed or new tool.
app.post("/api/workflows/:id/recovery", { preHandler: authenticate }, async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body && typeof request.body === "object"
    ? request.body as { stepId?: unknown; confirmed?: unknown; note?: unknown }
    : {};
  if (body.confirmed !== true || typeof body.stepId !== "string"
      || typeof body.note !== "string" || body.note.trim().length < 10
      || body.note.length > 500) {
    return reply.code(400).send({
      error: "stepId, confirmed=true and a verification note of 10 to 500 characters are required"
    });
  }
  try {
    return await workflows.authorizeRecovery(
      config.CORTEX_USER_ID, id, body.stepId, body.note
    );
  } catch (error) {
    return workflowError(reply, error);
  }
});

app.post("/api/workflows/:id/reconcile", { preHandler: authenticate }, async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body && typeof request.body === "object"
    ? request.body as { stepId?: unknown; outcome?: unknown; confirmed?: unknown }
    : {};
  if (body.confirmed !== true || typeof body.stepId !== "string"
      || (body.outcome !== "completed" && body.outcome !== "failed")) {
    return reply.code(400).send({ error: "stepId, confirmed=true and verified outcome (completed/failed) are required" });
  }
  try {
    return await workflows.reconcile(config.CORTEX_USER_ID, id, body.stepId, body.outcome);
  } catch (error) {
    return workflowError(reply, error);
  }
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
  await backendMonitor?.stop();
  await reminderScheduler?.stop();
  await app.close();
  await pool?.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
backendMonitor?.start();
reminderScheduler?.start();
