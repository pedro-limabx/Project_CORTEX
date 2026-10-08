export type PlanStepStatus = "PLANNED" | "COMPLETED" | "FAILED" | "AWAITING_APPROVAL";

export type PlanStatus = "ACTIVE" | "REPLANNING" | "COMPLETED" | "FAILED";

export interface PlanStep {
  index: number;
  tool: string;
  input: unknown;
  status: PlanStepStatus;
  error?: string;
  approvalId?: string;
}

export interface ExecutionPlan {
  objective: string;
  status: PlanStatus;
  currentStep?: number;
  revision: number;
  steps: PlanStep[];
}

export class ExecutionPlanner {
  private readonly steps: PlanStep[] = [];
  private status: PlanStatus = "ACTIVE";
  private currentStep: number | undefined;
  private revision = 1;

  constructor(private readonly objective: string) {}

  begin(tool: string, input: unknown): PlanStep {
    if (this.status === "COMPLETED" || this.status === "FAILED") {
      this.status = "ACTIVE";
      this.revision++;
    }

    const step: PlanStep = {
      index: this.steps.length + 1,
      tool,
      input,
      status: "PLANNED"
    };

    this.steps.push(step);
    this.currentStep = step.index;
    this.status = "ACTIVE";
    return step;
  }

  complete(step: PlanStep, ok: boolean, error?: string, awaitingApproval = false): void {
    step.status = awaitingApproval
      ? "AWAITING_APPROVAL"
      : ok
        ? "COMPLETED"
        : "FAILED";

    if (error) step.error = error.slice(0, 500);

    if (step.status === "FAILED") {
      this.status = "REPLANNING";
      this.currentStep = step.index;
    } else if (step.status === "AWAITING_APPROVAL") {
      this.status = "ACTIVE";
      this.currentStep = step.index;
    } else {
      this.currentStep = undefined;
    }
  }

  shouldReplan(step: PlanStep): boolean {
    if (step.status !== "FAILED") return false;
    this.status = "REPLANNING";
    return true;
  }

  markCompleted(): void {
    if (this.steps.length === 0) {
      this.status = "COMPLETED";
      this.currentStep = undefined;
      return;
    }

    const lastStep = this.steps[this.steps.length - 1];
    const hasPendingStep = this.steps.some(
      step => step.status === "PLANNED" || step.status === "AWAITING_APPROVAL"
    );

    if (hasPendingStep || !lastStep || lastStep.status !== "COMPLETED") return;

    const allFailuresRecovered = this.steps.every((step, index) => {
      if (step.status !== "FAILED") return true;
      return this.steps.slice(index + 1).some(laterStep => laterStep.status === "COMPLETED");
    });

    if (allFailuresRecovered) {
      this.status = "COMPLETED";
      this.currentStep = undefined;
    }
  }

  markFailed(): void {
    this.status = "FAILED";
    this.currentStep = undefined;
  }

  restore(plan: ExecutionPlan): void {
    if (plan.objective !== this.objective) throw new Error("Planner objective mismatch");
    this.steps.length = 0;
    this.steps.push(...plan.steps.map(step => ({ ...step })));
    this.status = plan.status;
    this.currentStep = plan.currentStep;
    this.revision = plan.revision;
  }

  getStep(index: number): PlanStep | undefined {
    return this.steps.find(step => step.index === index);
  }

  getObjective(): string {
    return this.objective;
  }

  getStatus(): PlanStatus {
    return this.status;
  }

  snapshot(): ExecutionPlan {
    return {
      objective: this.objective,
      status: this.status,
      ...(this.currentStep !== undefined ? { currentStep: this.currentStep } : {}),
      revision: this.revision,
      steps: this.steps.map(step => ({ ...step }))
    };
  }
}
