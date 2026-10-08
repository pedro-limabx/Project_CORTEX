import { z } from "zod";
import type { MemoryRecord } from "../domain/types.js";

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

export type StoredExecutionPlan = z.infer<typeof planSchema>;

export function parseTaskPlan(content: string): StoredExecutionPlan {
  try {
    const value: unknown = JSON.parse(content);
    return planSchema.parse(value);
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
