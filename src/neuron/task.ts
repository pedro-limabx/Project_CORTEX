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
