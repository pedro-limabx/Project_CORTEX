import { describe, expect, it } from "vitest";
import { ExecutionPlanner } from "../src/neuron/planner.js";

describe("ExecutionPlanner recovery state", () => {
  it("keeps a failed-only plan in replanning", () => {
    const planner = new ExecutionPlanner("recover task");
    const failed = planner.begin("test.fail", {});
    planner.complete(failed, false, "simulated failure");

    planner.markCompleted();

    expect(planner.snapshot().status).toBe("REPLANNING");
  });

  it("completes a plan after a failed step is recovered by a later successful step", () => {
    const planner = new ExecutionPlanner("recover task");
    const failed = planner.begin("test.fail", {});
    planner.complete(failed, false, "simulated failure");

    const recovery = planner.begin("calculator.evaluate", { expression: "10 + 5" });
    planner.complete(recovery, true);

    planner.markCompleted();

    const plan = planner.snapshot();
    expect(plan.status).toBe("COMPLETED");
    expect(plan.currentStep).toBeUndefined();
    expect(plan.steps[0]?.status).toBe("FAILED");
    expect(plan.steps[1]?.status).toBe("COMPLETED");
  });

  it("does not complete when the latest step is not successful", () => {
    const planner = new ExecutionPlanner("pending task");
    const step = planner.begin("test.pending", {});
    planner.complete(step, false, "awaiting recovery");

    planner.begin("test.next", {});

    planner.markCompleted();

    expect(planner.snapshot().status).toBe("ACTIVE");
  });
});
