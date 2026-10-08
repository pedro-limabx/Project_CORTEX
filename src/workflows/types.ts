import { z } from "zod";

const conditionSchema = z.object({
  step: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  path: z.string().min(1).max(200),
  operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte"]),
  value: z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()])
}).strict();

export type WorkflowCondition = z.infer<typeof conditionSchema>;
export type WorkflowDependencyMode = "all" | "settled";

const stepSchema = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  tool: z.string().min(1).max(128),
  input: z.unknown().default({}),
  dependsOn: z.array(z.string()).max(32).default([]),
  dependsMode: z.enum(["all", "settled"]).optional(),
  when: conditionSchema.optional(),
  onFailureOf: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/).optional()
}).strict();

const workflowSchema = z.object({
  objective: z.string().trim().min(1).max(1000),
  steps: z.array(stepSchema).min(1).max(32)
}).strict();

export type WorkflowDefinition = z.infer<typeof workflowSchema>;
export type WorkflowStepStatus = "PENDING" | "RUNNING" | "WAITING_APPROVAL" | "COMPLETED" | "SKIPPED" | "FAILED";
export type WorkflowStatus =
  | "ACTIVE" | "AWAITING_APPROVAL" | "NEEDS_RECONCILIATION"
  | "RECOVERY_REQUIRED" | "RECOVERING" | "COMPLETED_WITH_FAILURES"
  | "COMPLETED" | "FAILED";

export interface WorkflowRecoveryAuthorization {
  stepId: string;
  authorizedAt: string;
  note: string;
}

export interface WorkflowStep {
  id: string;
  tool: string;
  input: unknown;
  /** Exact schema-validated input used for approval and execution. */
  resolvedInput?: unknown;
  dependsOn: string[];
  dependsMode?: WorkflowDependencyMode;
  when?: WorkflowCondition;
  /** Explicit failure-handler step, authorized separately by a human. */
  onFailureOf?: string;
  status: WorkflowStepStatus;
  skipReason?: string;
  approvalId?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  output?: unknown;
}

export interface WorkflowRun {
  id: string;
  userId: string;
  objective: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  steps: WorkflowStep[];
  recoveries?: WorkflowRecoveryAuthorization[];
}

export class WorkflowInputError extends Error {}
export class WorkflowConflictError extends Error {}
export class WorkflowNotFoundError extends Error {}

export function parseWorkflowDefinition(raw: unknown): WorkflowDefinition {
  const parsed = workflowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WorkflowInputError(parsed.error.issues.map(i => i.message).join("; "));
  }

  const definition = parsed.data;
  const ids = new Set(definition.steps.map(step => step.id));
  if (ids.size !== definition.steps.length) {
    throw new WorkflowInputError("Workflow step ids must be unique");
  }

  const dependencies = new Map(definition.steps.map(step => [step.id, step.dependsOn]));
  const handlers = new Set<string>();
  for (const step of definition.steps) {
    if (step.onFailureOf) {
      if (!ids.has(step.onFailureOf) || !step.dependsOn.includes(step.onFailureOf)) {
        throw new WorkflowInputError(
          "Recovery handler " + step.id + " must directly depend on its existing failed source"
        );
      }
      if (handlers.has(step.onFailureOf)) {
        throw new WorkflowInputError("Only one recovery handler is allowed per failed step");
      }
      handlers.add(step.onFailureOf);
      if (step.when || step.dependsMode === "settled") {
        throw new WorkflowInputError("Recovery handlers cannot have conditions or settled dependencies");
      }
    }

    if (new Set(step.dependsOn).size !== step.dependsOn.length) {
      throw new WorkflowInputError("Duplicate dependencies in step " + step.id);
    }
    if (step.dependsMode === "settled" && step.dependsOn.length === 0) {
      throw new WorkflowInputError("settled dependency mode requires at least one dependency");
    }
    if (step.when) {
      if (!step.dependsOn.includes(step.when.step)) {
        throw new WorkflowInputError(
          "Step " + step.id + " must declare conditional source " + step.when.step + " in dependsOn"
        );
      }
      const segments = step.when.path.split(".");
      if (segments.length > 8 || segments.some(segment =>
        !/^[a-zA-Z0-9_-]+$/.test(segment) ||
        ["__proto__", "prototype", "constructor"].includes(segment))) {
        throw new WorkflowInputError("Invalid condition output path");
      }
      if (["gt", "gte", "lt", "lte"].includes(step.when.operator) &&
          typeof step.when.value !== "number") {
        throw new WorkflowInputError("Numeric comparison requires a numeric value");
      }
    }
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) {
        throw new WorkflowInputError("Unknown dependency " + dependency + " in step " + step.id);
      }
      if (dependency === step.id) {
        throw new WorkflowInputError("A step cannot depend on itself");
      }
    }
  }

  // A failed recovery action is terminal. Nested recovery chains would make
  // external side-effect attestations ambiguous and are deliberately excluded.
  for (const step of definition.steps) {
    if (step.onFailureOf && handlers.has(step.id)) {
      throw new WorkflowInputError("Recovery handlers cannot themselves have recovery handlers");
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new WorkflowInputError("Workflow contains a dependency cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const parent of dependencies.get(id) ?? []) visit(parent);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  return definition;
}

export function failedStepHandler(run: WorkflowRun, stepId: string): WorkflowStep | undefined {
  return run.steps.find(step => step.onFailureOf === stepId);
}

export function recoveryAuthorized(run: WorkflowRun, stepId: string): boolean {
  return Boolean(run.recoveries?.some(item => item.stepId === stepId));
}

export function workflowStatus(run: WorkflowRun): WorkflowStatus {
  // An ambiguous in-flight effect always takes precedence over historical failures.
  if (run.steps.some(step => step.status === "RUNNING")) return "NEEDS_RECONCILIATION";

  const failed = run.steps.filter(step => step.status === "FAILED");
  if (failed.length) {
    for (const source of failed) {
      const handler = failedStepHandler(run, source.id);
      if (!handler || handler.status === "FAILED" || handler.status === "SKIPPED") return "FAILED";
    }
    if (failed.some(source => !recoveryAuthorized(run, source.id))) {
      return "RECOVERY_REQUIRED";
    }
    if (run.steps.some(step => step.status === "WAITING_APPROVAL")) {
      return "AWAITING_APPROVAL";
    }
    if (run.steps.every(step =>
      step.status === "COMPLETED" || step.status === "SKIPPED" || step.status === "FAILED")) {
      return failed.every(source => failedStepHandler(run, source.id)?.status === "COMPLETED")
        ? "COMPLETED_WITH_FAILURES"
        : "FAILED";
    }
    return "RECOVERING";
  }
  if (run.steps.some(step => step.status === "WAITING_APPROVAL")) {
    return "AWAITING_APPROVAL";
  }
  if (run.steps.every(step => step.status === "COMPLETED" || step.status === "SKIPPED")) {
    return "COMPLETED";
  }
  return "ACTIVE";
}

export function readyWorkflowSteps(run: WorkflowRun): WorkflowStep[] {
  const complete = new Set(run.steps.filter(step => step.status === "COMPLETED").map(step => step.id));
  const settled = new Set(run.steps.filter(step =>
    step.status === "COMPLETED" || step.status === "SKIPPED").map(step => step.id));
  return run.steps.filter(step => {
    if (step.status !== "PENDING") return false;
    if (step.onFailureOf) {
      const source = run.steps.find(parent => parent.id === step.onFailureOf);
      return source?.status === "FAILED"
        && recoveryAuthorized(run, source.id)
        && step.dependsOn.every(id => id === source.id || complete.has(id));
    }
    return (step.dependsMode ?? "all") === "settled"
      ? step.dependsOn.every(id => settled.has(id)) &&
        step.dependsOn.some(id => complete.has(id))
      : step.dependsOn.every(id => complete.has(id));
  }).sort((a, b) => Number(Boolean(b.onFailureOf)) - Number(Boolean(a.onFailureOf)));
}

export function workflowResponse(run: WorkflowRun) {
  const completed = run.steps.filter(step => step.status === "COMPLETED").length;
  const skipped = run.steps.filter(step => step.status === "SKIPPED").length;
  const failed = run.steps.filter(step => step.status === "FAILED").length;
  const status = workflowStatus(run);
  const runnable = status === "ACTIVE" || status === "RECOVERING";
  return {
    ...run,
    status,
    progress: {
      completed,
      skipped,
      failed,
      total: run.steps.length,
      percent: Math.round(100 * (completed + skipped + failed) / run.steps.length),
      ready: runnable ? readyWorkflowSteps(run).map(step => step.id) : []
    }
  };
}
