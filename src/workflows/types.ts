import { z } from "zod";

const stepSchema = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  tool: z.string().min(1).max(128),
  input: z.unknown().default({}),
  dependsOn: z.array(z.string()).max(32).default([])
}).strict();

const workflowSchema = z.object({
  objective: z.string().trim().min(1).max(1000),
  steps: z.array(stepSchema).min(1).max(32)
}).strict();

export type WorkflowDefinition = z.infer<typeof workflowSchema>;
export type WorkflowStepStatus = "PENDING" | "RUNNING" | "WAITING_APPROVAL" | "COMPLETED" | "FAILED";
export type WorkflowStatus = "ACTIVE" | "AWAITING_APPROVAL" | "NEEDS_RECONCILIATION" | "COMPLETED" | "FAILED";

export interface WorkflowStep {
  id: string;
  tool: string;
  input: unknown;
  dependsOn: string[];
  status: WorkflowStepStatus;
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
  if (run.steps.every(s => s.status === "COMPLETED")) return "COMPLETED";
  return "ACTIVE";
}

export function readyWorkflowSteps(run: WorkflowRun): WorkflowStep[] {
  const complete = new Set(run.steps.filter(s => s.status === "COMPLETED").map(s => s.id));
  return run.steps.filter(s => s.status === "PENDING" && s.dependsOn.every(id => complete.has(id)));
}

export function workflowResponse(run: WorkflowRun) {
  const completed = run.steps.filter(s => s.status === "COMPLETED").length;
  return {
    ...run,
    status: workflowStatus(run),
    progress: {
      completed,
      total: run.steps.length,
      percent: Math.round(100 * completed / run.steps.length),
      ready: readyWorkflowSteps(run).map(s => s.id)
    }
  };
}
