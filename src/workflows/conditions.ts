import { readStepOutput } from "./bindings.js";
import {
  readyWorkflowSteps,
  WorkflowInputError,
  type WorkflowCondition,
  type WorkflowRun,
  type WorkflowStep
} from "./types.js";

const FINISHED = new Set(["COMPLETED", "SKIPPED"]);

function compareCondition(run: WorkflowRun, condition: WorkflowCondition): boolean {
  const actual = readStepOutput(run, condition.step, condition.path, true);
  const expected = condition.value;
  if (actual !== null && typeof actual !== "string" &&
      typeof actual !== "number" && typeof actual !== "boolean") {
    throw new WorkflowInputError("Condition result must be a scalar value");
  }
  switch (condition.operator) {
    case "eq": return actual === expected;
    case "neq": return actual !== expected;
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      if (typeof actual !== "number" || typeof expected !== "number" ||
          !Number.isFinite(actual) || !Number.isFinite(expected)) {
        throw new WorkflowInputError("Numeric comparison received a non-numeric value");
      }
      if (condition.operator === "gt") return actual > expected;
      if (condition.operator === "gte") return actual >= expected;
      if (condition.operator === "lt") return actual < expected;
      return actual <= expected;
  }
}

/**
 * Pure, side-effect-free evaluation of known predicates and unreachable paths.
 * When a step's dependencies settle, a false predicate becomes SKIPPED; no
 * tool or approval is invoked. Missing/malformed outputs fail closed.
 *
 * Cascading skipped branches are resolved in memory before one atomic store
 * compare-and-swap. Executable steps stay PENDING for the next manual advance.
 */
export function evaluateWorkflowBranches(
  current: WorkflowRun,
  timestamp: string = new Date().toISOString()
): WorkflowRun | undefined {
  // An unresolved or failed external action takes precedence over all branch
  // decisions. Reconciliation or an operator review must happen first.
  if (current.steps.some(step => step.status === "FAILED" || step.status === "RUNNING")) {
    return undefined;
  }
  const next = structuredClone(current);
  let changed = false;
  let again = true;

  const skip = (step: WorkflowStep, reason: string) => {
    step.status = "SKIPPED";
    step.skipReason = reason;
    step.finishedAt = timestamp;
    changed = true;
    again = true;
  };
  const fail = (step: WorkflowStep, reason: string) => {
    step.status = "FAILED";
    step.error = reason.slice(0, 500);
    step.finishedAt = timestamp;
    changed = true;
    again = false;
  };

  while (again) {
    again = false;
    for (const step of next.steps) {
      if (step.status !== "PENDING") continue;
      const parents = step.dependsOn.map(id => next.steps.find(other => other.id === id));
      if (parents.some(parent => !parent)) {
        fail(step, "Workflow contains an unknown dependency");
        break;
      }
      const mode = step.dependsMode ?? "all";
      if (mode === "all" && parents.some(parent => parent?.status === "SKIPPED")) {
        skip(step, "A required dependency was skipped");
        continue;
      }
      if (mode === "settled" && parents.length &&
          parents.every(parent => parent && FINISHED.has(parent.status)) &&
          parents.every(parent => parent?.status === "SKIPPED")) {
        skip(step, "All alternate paths were skipped");
        continue;
      }
      // Only evaluate predicates after dependencies reach the permitted
      // terminal states. 'settled' joins wait for all branches to finish.
      if (!readyWorkflowSteps(next).some(candidate => candidate.id === step.id)) continue;
      if (!step.when) continue;

      const source = next.steps.find(parent => parent.id === step.when?.step);
      if (source?.status === "SKIPPED") {
        skip(step, "Conditional source was skipped");
        continue;
      }
      if (!source || source.status !== "COMPLETED") {
        fail(step, "Condition source was not completed");
        break;
      }
      try {
        if (!compareCondition(next, step.when)) {
          skip(step, "Condition evaluated to false");
        }
      } catch (error) {
        const reason = error instanceof WorkflowInputError
          ? error.message
          : "Condition evaluation failed";
        fail(step, reason);
        break;
      }
    }
    if (next.steps.some(step => step.status === "FAILED")) break;
  }
  return changed ? next : undefined;
}
