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
  when: conditionSchema.optional()
}).strict();

const workflowSchema = z.object({
  objective: z.string().trim().min(1).max(1000),
  steps: z.array(stepSchema).min(1).max(32)
}).strict();

export type WorkflowDefinition = z.infer<typeof workflowSchema>;
export type WorkflowStepStatus = "PENDING" | "RUNNING" | "WAITING_APPROVAL" | "COMPLETED" | "SKIPPED" | "FAILED";
export type WorkflowStatus = "ACTIVE" | "AWAITING_APPROVAL" | "NEEDS_RECONCILIATION" | "COMPLETED" | "FAILED";

export interface WorkflowStep {
  id: string;
  tool: string;
  input: unknown;
  /** Exact schema-validated input used for approval and execution. */
  resolvedInput?: unknown;
  dependsOn: string[];
  dependsMode?: WorkflowDependencyMode;
  when?: WorkflowCondition;
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
  for (const step of definition.steps) {
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

export function workflowStatus(run: WorkflowRun): WorkflowStatus {
  if (run.steps.some(s => s.status === "FAILED")) return "FAILED";
  if (run.steps.some(s => s.status === "RUNNING")) return "NEEDS_RECONCILIATION";
  if (run.steps.some(s => s.status === "WAITING_APPROVAL")) return "AWAITING_APPROVAL";
  if (run.steps.every(s => s.status === "COMPLETED" || s.status === "SKIPPED")) return "COMPLETED";
  return "ACTIVE";
}

export function readyWorkflowSteps(run: WorkflowRun): WorkflowStep[] {
  const complete = new Set(run.steps.filter(s => s.status === "COMPLETED").map(s => s.id));
  const settled = new Set(run.steps.filter(s =>
    s.status === "COMPLETED" || s.status === "SKIPPED").map(s => s.id));
  return run.steps.filter(step => step.status === "PENDING" && (
    (step.dependsMode ?? "all") === "settled"
      ? step.dependsOn.every(id => settled.has(id)) && step.dependsOn.some(id => complete.has(id))
      : step.dependsOn.every(id => complete.has(id))
  ));
}

export function workflowResponse(run: WorkflowRun) {
  const completed = run.steps.filter(s => s.status === "COMPLETED").length;
  const skipped = run.steps.filter(s => s.status === "SKIPPED").length;
  return {
    ...run,
    status: workflowStatus(run),
    progress: {
      completed,
      skipped,
      total: run.steps.length,
      percent: Math.round(100 * (completed + skipped) / run.steps.length),
      ready: readyWorkflowSteps(run).map(s => s.id)
    }
  };
}
