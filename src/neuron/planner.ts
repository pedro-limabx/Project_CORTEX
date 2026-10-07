export type PlanStepStatus = "PLANNED" | "COMPLETED" | "FAILED" | "AWAITING_APPROVAL";

export interface PlanStep {
  index: number;
  tool: string;
  input: unknown;
  status: PlanStepStatus;
  error?: string;
}

export class ExecutionPlanner {
  private readonly steps: PlanStep[] = [];

  constructor(private readonly objective: string) {}

  begin(tool: string, input: unknown): PlanStep {
    const step: PlanStep = {
      index: this.steps.length + 1,
      tool,
      input,
      status: "PLANNED"
    };
    this.steps.push(step);
    return step;
  }

  complete(step: PlanStep, ok: boolean, error?: string, awaitingApproval = false): void {
    step.status = awaitingApproval
      ? "AWAITING_APPROVAL"
      : ok
        ? "COMPLETED"
        : "FAILED";
    if (error) step.error = error.slice(0, 500);
  }

  shouldReplan(step: PlanStep): boolean {
    return step.status === "FAILED";
  }

  getObjective(): string {
    return this.objective;
  }

  snapshot(): PlanStep[] {
    return this.steps.map(step => ({ ...step }));
  }
}
