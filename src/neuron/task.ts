import { z } from "zod";
import type { MemoryRecord } from "../domain/types.js";
import type { ExecutionPlan } from "./planner.js";

const stepSchema = z.object({
  index: z.number().int().positive(),
  tool: z.string().min(1),
  input: z.unknown(),
  status: z.enum(["PLANNED", "COMPLETED", "FAILED", "AWAITING_APPROVAL"]),
  error: z.string().optional(),
  approvalId: z.string().optional()
});

const planSchema = z.object({
  objective: z.string().min(1),
  status: z.enum(["ACTIVE", "REPLANNING", "COMPLETED", "FAILED"]),
  currentStep: z.number().int().positive().optional(),
  revision: z.number().int().positive(),
  steps: z.array(stepSchema).max(100)
}).superRefine((plan, ctx) => {
  for (const [index, step] of plan.steps.entries()) {
    if (step.index !== index + 1) {
      ctx.addIssue({ code: "custom", message: "Step indexes must be sequential", path: ["steps", index, "index"] });
    }
  }
  if (plan.currentStep !== undefined && plan.currentStep > plan.steps.length) {
    ctx.addIssue({ code: "custom", message: "Invalid current step", path: ["currentStep"] });
  }
});

export function parseTaskPlan(content: string): ExecutionPlan {
  try {
    const value: unknown = JSON.parse(content);
    const plan = planSchema.parse(value);
    return {
      objective: plan.objective,
      status: plan.status,
      revision: plan.revision,
      ...(plan.currentStep !== undefined ? { currentStep: plan.currentStep } : {}),
      steps: plan.steps.map(step => ({
        index: step.index,
        tool: step.tool,
        input: step.input,
        status: step.status,
        ...(step.error !== undefined ? { error: step.error } : {}),
        ...(step.approvalId !== undefined ? { approvalId: step.approvalId } : {})
      }))
    };
  } catch {
    throw new Error("Persisted task is invalid");
  }
}

export function taskToResponse(record: MemoryRecord) {
  return {
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    plan: parseTaskPlan(record.content)
  };
}

/**
 * An interrupted PLANNED tool may have run before the process stopped.
 * Only an authenticated operator who verified the external outcome can
 * resolve this ambiguity. No tool is executed by this function.
 */
export function reconcileInterruptedPlan(
  plan: ExecutionPlan,
  outcome: "completed" | "failed"
): ExecutionPlan {
  if (plan.status === "COMPLETED" || plan.status === "FAILED") {
    throw new Error("Task is already finalized");
  }
  const interrupted = plan.steps.filter(step => step.status === "PLANNED");
  if (interrupted.length !== 1 || interrupted[0]?.index !== plan.steps.length) {
    throw new Error("Task has no single interrupted final step to reconcile");
  }
  const steps = plan.steps.map(step => ({ ...step }));
  const last = steps[steps.length - 1]!;
  last.status = outcome === "completed" ? "COMPLETED" : "FAILED";
  if (outcome === "failed") {
    last.error = "Operator verified this interrupted step did not complete";
  } else {
    delete last.error;
  }
  return {
    ...plan,
    status: outcome === "completed" ? "ACTIVE" : "REPLANNING",
    currentStep: outcome === "completed" ? undefined : last.index,
    steps
  };
}
