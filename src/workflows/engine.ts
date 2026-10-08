import crypto from "node:crypto";
import type { AuditRecord, ToolContext } from "../domain/types.js";
import type { AuditStore } from "../audit/store.js";
import { PermissionEngine } from "../permissions/engine.js";
import { ApprovalEngine } from "../approval/engine.js";
import { evaluatePolicy } from "../security/policy.js";
import { ToolExecutor } from "../tools/executor.js";
import { ToolRegistry } from "../tools/registry.js";
import type { WorkflowStore } from "./store.js";
import { inspectStepInput, resolveStepInput, referencesStepOutput } from "./bindings.js";
import { evaluateWorkflowBranches } from "./conditions.js";
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
      // References may resolve to numbers, strings or objects at runtime;
      // validate syntax and dependencies now, then validate the resolved
      // input through the tool schema before requesting approval/executing.
      const inspected = inspectStepInput(step.input, step.id, step.dependsOn);
      if (step.onFailureOf && referencesStepOutput(inspected.input, step.onFailureOf)) {
        throw new WorkflowInputError(
          "Recovery handler " + step.id + " cannot reference outputs of the failed step"
        );
      }
      let prepared = inspected.input;
      if (!inspected.hasBindings) {
        try {
          prepared = schema.parse(inspected.input);
        } catch {
          throw new WorkflowInputError("Invalid input for tool: " + step.tool);
        }
      }
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(prepared);
      } catch {
        throw new WorkflowInputError("Tool input is not JSON serializable");
      }
      if (serialized === undefined) throw new WorkflowInputError("Tool input is not JSON serializable");
      return {
        id: step.id,
        tool: step.tool,
        input: JSON.parse(serialized) as unknown,
        dependsOn: step.dependsOn,
        ...(step.dependsMode ? { dependsMode: step.dependsMode } : {}),
        ...(step.when ? { when: step.when } : {}),
        ...(step.onFailureOf ? { onFailureOf: step.onFailureOf } : {}),
        status: "PENDING" as const
      };
    });

    return {
      objective: definition.objective,
      steps: steps.map(step => ({
        id: step.id,
        tool: step.tool,
        input: step.input,
        dependsOn: step.dependsOn,
        ...(step.dependsMode ? { dependsMode: step.dependsMode } : {}),
        ...(step.when ? { when: step.when } : {}),
        ...(step.onFailureOf ? { onFailureOf: step.onFailureOf } : {})
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

  /**
   * Apply automatic SKIPPED decisions (never tools) with one atomic CAS.
   * A prior process crash leaves the pending decisions reproducible.
   */
  private async settle(run: WorkflowRun): Promise<WorkflowRun> {
    const decided = evaluateWorkflowBranches(run);
    if (!decided) return run;
    decided.version = run.version + 1;
    decided.updatedAt = new Date().toISOString();
    if (!await this.store.update(run.userId, run.version, decided)) {
      throw new WorkflowConflictError("Workflow was modified by another request");
    }
    return decided;
  }

  async advance(userId: string, id: string, approvalId?: string) {
    let run = await this.load(userId, id);
    // In-flight effects must be reconciled first; do not even mutate skipped
    // branch state while an external tool might still be running.
    const beforeSettling = workflowStatus(run);
    if (beforeSettling !== "FAILED" && beforeSettling !== "NEEDS_RECONCILIATION") {
      run = await this.settle(run);
    }
    const status = workflowStatus(run);
    if (status === "COMPLETED" || status === "COMPLETED_WITH_FAILURES") {
      return workflowResponse(run);
    }
    if (status === "FAILED" || status === "NEEDS_RECONCILIATION" ||
        status === "RECOVERY_REQUIRED") {
      throw new WorkflowConflictError(
        status === "FAILED"
          ? "Workflow failed; it cannot be retried automatically"
          : status === "RECOVERY_REQUIRED"
            ? "A failed step requires explicit operator recovery authorization"
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

    // Resolve only outputs from declared COMPLETED dependencies. Fail closed
    // before any approval request, RUNNING transition or tool side effect.
    let resolvedInput: unknown;
    try {
      const unparsed = pendingApproval && Object.prototype.hasOwnProperty.call(step, "resolvedInput")
        ? step.resolvedInput
        : resolveStepInput(run, step.id);
      const schema = tool.inputSchema as { parse?: (input: unknown) => unknown };
      if (typeof schema?.parse !== "function") {
        throw new WorkflowInputError("Tool has no valid input schema");
      }
      resolvedInput = schema.parse(unparsed);
      // The same JSON payload is subsequently approved, persisted and executed.
      const serialized = JSON.stringify(resolvedInput);
      if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 65_536) {
        throw new WorkflowInputError("Resolved tool input exceeds the allowed size");
      }
      resolvedInput = JSON.parse(serialized) as unknown;
    } catch (error) {
      const detail = error instanceof WorkflowInputError ? error.message : "Resolved input does not match tool schema";
      run = await this.transition(run, step.id, {
        status: "FAILED",
        error: detail.slice(0, 500),
        finishedAt: new Date().toISOString()
      });
      return workflowResponse(run);
    }

    const granted = await this.permissions.getPermissions(userId);
    const policy = evaluatePolicy(tool, granted, false);

    if (!pendingApproval && !policy.allowed && policy.requiresApproval) {
      const request = await this.approvals.request(userId, step.tool, resolvedInput, tool.risk);
      run = await this.transition(run, step.id, {
        status: "WAITING_APPROVAL",
        resolvedInput,
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
      resolvedInput,
      startedAt: new Date().toISOString()
    });

    let approved = false;
    if (pendingApproval) {
      approved = await this.approvals.consume(approvalId!, userId, step.tool, resolvedInput);
      if (!approved) {
        // No tool has been called: it is safe to put the step back into
        // WAITING_APPROVAL and let the operator resolve the approval.
        await this.transition(run, step.id, { status: "WAITING_APPROVAL" });
        throw new WorkflowConflictError("Approval has not been granted or has expired");
      }
    }

    const requestId = crypto.randomUUID();
    const result = await this.executor.execute(step.tool, resolvedInput, {
      userId,
      requestId,
      dryRun: false,
      grantedPermissions: granted
    } satisfies ToolContext, approved);

    // A timeout is an ambiguous result: the remote side effect may still be
    // running. Preserve RUNNING until an operator verifies the external outcome.
    const timedOut = !result.ok && result.error === "Tool timeout";
    run = await this.transition(run, step.id, {
      status: timedOut ? "RUNNING" : result.ok ? "COMPLETED" : "FAILED",
      ...(result.ok && result.output !== undefined ? { output: result.output } : {}),
      ...(!result.ok ? { error: result.error ?? "Unknown tool failure" } : {}),
      ...(!timedOut ? { finishedAt: new Date().toISOString() } : {})
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

    run = await this.settle(run);
    return workflowResponse(run);
  }

  /**
   * A human certifies that the failed action has been investigated. This
   * authorizes ONE explicitly declared alternate handler; it never replays
   * the failed tool nor executes the alternate handler in this request.
   */
  async authorizeRecovery(userId: string, id: string, stepId: string, note: string) {
    const run = await this.load(userId, id);
    if (workflowStatus(run) === "NEEDS_RECONCILIATION") {
      throw new WorkflowConflictError("Reconcile uncertain external actions before recovery");
    }
    const failed = run.steps.find(step => step.id === stepId && step.status === "FAILED");
    if (!failed) throw new WorkflowConflictError("Selected step has no confirmed failed result");
    const handler = run.steps.find(step => step.onFailureOf === stepId);
    if (!handler || handler.status !== "PENDING") {
      throw new WorkflowConflictError("No pending declared recovery handler for this step");
    }
    if (run.recoveries?.some(entry => entry.stepId === stepId)) {
      return workflowResponse(run);
    }
    if (typeof note !== "string" || note.trim().length < 10 || note.length > 500) {
      throw new WorkflowInputError("Recovery confirmation note must contain 10 to 500 characters");
    }

    const next = structuredClone(run);
    next.recoveries = [
      ...(next.recoveries ?? []),
      { stepId, authorizedAt: new Date().toISOString(), note: note.trim() }
    ];
    next.version = run.version + 1;
    next.updatedAt = new Date().toISOString();
    const saved = await this.store.update(userId, run.version, next);
    if (!saved) throw new WorkflowConflictError("Workflow was modified by another request");
    // Atomic CAS owns authorization. Settling is deterministic, and if the
    // process exits here, advance() will redo only the SKIPPED decisions.
    return workflowResponse(await this.settle(next));
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
    return workflowResponse(await this.settle(updated));
  }
}
