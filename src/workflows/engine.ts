import crypto from "node:crypto";
import type { AuditRecord, ToolContext } from "../domain/types.js";
import type { AuditStore } from "../audit/store.js";
import { PermissionEngine } from "../permissions/engine.js";
import { ApprovalEngine } from "../approval/engine.js";
import { evaluatePolicy } from "../security/policy.js";
import { ToolExecutor } from "../tools/executor.js";
import { ToolRegistry } from "../tools/registry.js";
import type { WorkflowStore } from "./store.js";
import {
  parseWorkflowDefinition,
  readyWorkflowSteps,
  workflowResponse,
  workflowStatus,
  WorkflowConflictError,
  WorkflowInputError,
  WorkflowNotFoundError,
  type WorkflowRun,
  type WorkflowStep
} from "./types.js";

const RECONCILIATION_GRACE_MS = 30_000;

export class WorkflowEngine {
  constructor(
    private readonly store: WorkflowStore,
    private readonly registry: ToolRegistry,
    private readonly executor: ToolExecutor,
    private readonly permissions: PermissionEngine,
    private readonly approvals: ApprovalEngine,
    private readonly audit?: AuditStore
  ) {}

  /**
   * Validate and normalize an untrusted workflow definition without persisting or
   * executing anything. Used by both manual and LLM-assisted authoring.
   */
  validate(input: unknown) {
    const definition = parseWorkflowDefinition(input);
    const steps: WorkflowStep[] = definition.steps.map(step => {
      const tool = this.registry.get(step.tool);
      if (!tool) throw new WorkflowInputError("Unknown tool: " + step.tool);
      const schema = tool.inputSchema as { parse?: (input: unknown) => unknown };
      if (typeof schema?.parse !== "function") {
        throw new WorkflowInputError("Tool has no valid input schema: " + step.tool);
      }
      let parsed: unknown;
      try {
        parsed = schema.parse(step.input);
      } catch {
        throw new WorkflowInputError("Invalid input for tool: " + step.tool);
      }
      // Preserve the exact serialized input used later for authorization/execution.
      const serialized = JSON.stringify(parsed);
      if (serialized === undefined) throw new WorkflowInputError("Tool input is not JSON serializable");
      return {
        id: step.id,
        tool: step.tool,
        input: JSON.parse(serialized) as unknown,
        dependsOn: step.dependsOn,
        status: "PENDING" as const
      };
    });

    return {
      objective: definition.objective,
      steps: steps.map(step => ({
        id: step.id,
        tool: step.tool,
        input: step.input,
        dependsOn: step.dependsOn
      }))
    };
  }

  async create(userId: string, input: unknown) {
    const definition = this.validate(input);
    const steps: WorkflowStep[] = definition.steps.map(step => ({
      ...step,
      status: "PENDING" as const
    }));
    const now = new Date().toISOString();
    const run: WorkflowRun = {
      id: crypto.randomUUID(),
      userId,
      objective: definition.objective,
      version: 1,
      createdAt: now,
      updatedAt: now,
      steps
    };
    await this.store.create(run);
    return workflowResponse(run);
  }

  async get(userId: string, id: string) {
    const run = await this.load(userId, id);
    return workflowResponse(run);
  }

  async list(userId: string, limit: number) {
    return (await this.store.list(userId, limit)).map(workflowResponse);
  }

  private async load(userId: string, id: string): Promise<WorkflowRun> {
    // Reject invalid identifiers before PostgreSQL's UUID parser can throw a 500.
    if (!/^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/.test(id)) {
      throw new WorkflowNotFoundError("Workflow not found");
    }
    const run = await this.store.get(userId, id);
    if (!run) throw new WorkflowNotFoundError("Workflow not found");
    return run;
  }

  private async transition(
    current: WorkflowRun,
    stepId: string,
    patch: Partial<WorkflowStep>
  ): Promise<WorkflowRun> {
    const next = structuredClone(current);
    const step = next.steps.find(item => item.id === stepId);
    if (!step) throw new WorkflowConflictError("Workflow step not found");
    Object.assign(step, patch);
    next.version++;
    next.updatedAt = new Date().toISOString();
    const updated = await this.store.update(current.userId, current.version, next);
    if (!updated) throw new WorkflowConflictError("Workflow was modified by another request");
    return next;
  }

  async advance(userId: string, id: string, approvalId?: string) {
    let run = await this.load(userId, id);
    const status = workflowStatus(run);
    if (status === "COMPLETED") return workflowResponse(run);
    if (status === "FAILED" || status === "NEEDS_RECONCILIATION") {
      throw new WorkflowConflictError(
        status === "FAILED"
          ? "Workflow failed; it cannot be retried automatically"
          : "An interrupted step requires verified reconciliation before advancing"
      );
    }

    const pendingApproval = run.steps.find(step => step.status === "WAITING_APPROVAL");
    if (pendingApproval && !approvalId) return workflowResponse(run);
    if (!pendingApproval && approvalId) {
      throw new WorkflowConflictError("No step is waiting for this approval");
    }

    const step = pendingApproval ?? readyWorkflowSteps(run)[0];
    if (!step) throw new WorkflowConflictError("No runnable step is available");
    const tool = this.registry.get(step.tool);
    if (!tool) {
      run = await this.transition(run, step.id, {
        status: "FAILED",
        error: "Registered tool is unavailable",
        finishedAt: new Date().toISOString()
      });
      return workflowResponse(run);
    }

    const granted = await this.permissions.getPermissions(userId);
    const policy = evaluatePolicy(tool, granted, false);

    if (!pendingApproval && !policy.allowed && policy.requiresApproval) {
      const request = await this.approvals.request(userId, step.tool, step.input, tool.risk);
      run = await this.transition(run, step.id, {
        status: "WAITING_APPROVAL",
        approvalId: request.id
      });
      return workflowResponse(run);
    }
    if (!policy.allowed && !policy.requiresApproval) {
      run = await this.transition(run, step.id, {
        status: "FAILED",
        error: policy.reason,
        finishedAt: new Date().toISOString()
      });
      return workflowResponse(run);
    }

    if (pendingApproval) {
      if (step.approvalId !== approvalId) {
        throw new WorkflowConflictError("Approval id does not match the pending step");
      }
      if (!evaluatePolicy(tool, granted, true).allowed) {
        throw new WorkflowConflictError("Required permission was revoked");
      }
    }

    // Claim the step before consuming its one-use approval. A competing request
    // cannot consume authorization and then lose the workflow version race.
    run = await this.transition(run, step.id, {
      status: "RUNNING",
      startedAt: new Date().toISOString()
    });

    let approved = false;
    if (pendingApproval) {
      approved = await this.approvals.consume(approvalId!, userId, step.tool, step.input);
      if (!approved) {
        // No tool has been called: it is safe to put the step back into
        // WAITING_APPROVAL and let the operator resolve the approval.
        await this.transition(run, step.id, { status: "WAITING_APPROVAL" });
        throw new WorkflowConflictError("Approval has not been granted or has expired");
      }
    }

    const requestId = crypto.randomUUID();
    const result = await this.executor.execute(step.tool, step.input, {
      userId,
      requestId,
      dryRun: false,
      grantedPermissions: granted
    } satisfies ToolContext, approved);

    run = await this.transition(run, step.id, {
      status: result.ok ? "COMPLETED" : "FAILED",
      ...(result.ok && result.output !== undefined ? { output: result.output } : {}),
      ...(!result.ok ? { error: result.error ?? "Unknown tool failure" } : {}),
      finishedAt: new Date().toISOString()
    });

    if (this.audit) {
      const entry: AuditRecord = {
        id: crypto.randomUUID(),
        userId,
        requestId,
        tool: step.tool,
        ok: result.ok,
        requiresApproval: result.requiresApproval ?? false,
        ...(result.error ? { error: result.error.slice(0, 1000) } : {}),
        createdAt: new Date().toISOString()
      };
      await this.audit.record(entry);
    }

    return workflowResponse(run);
  }

  /** Operator attests the external outcome; this never re-executes a tool. */
  async reconcile(userId: string, id: string, stepId: string, outcome: "completed" | "failed") {
    const run = await this.load(userId, id);
    const running = run.steps.find(step => step.status === "RUNNING");
    if (!running || running.id !== stepId) {
      throw new WorkflowConflictError("Step is not awaiting reconciliation");
    }
    if (!running.startedAt || Date.now() - Date.parse(running.startedAt) < RECONCILIATION_GRACE_MS) {
      throw new WorkflowConflictError("Wait for the in-flight execution timeout before reconciling");
    }
    const updated = await this.transition(run, stepId, {
      status: outcome === "completed" ? "COMPLETED" : "FAILED",
      ...(outcome === "failed" ? { error: "Operator verified the step did not complete" } : {}),
      finishedAt: new Date().toISOString()
    });
    return workflowResponse(updated);
  }
}
