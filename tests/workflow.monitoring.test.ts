import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkflowStore } from "../src/workflows/store.js";
import {
  MonitoringService, summarizeMonitoring,
  type MonitoringSnapshot
} from "../src/workflows/monitoring.js";
import type {
  WorkflowEvent, WorkflowRun, WorkflowStep, WorkflowStepStatus
} from "../src/workflows/types.js";

const TIME = "2026-10-08T14:00:00.000Z";
const SECRETS = {
  input: "private-credential-keep-out",
  output: "private-result-keep-out",
  error: "private-error-keep-out",
  note: "operator-investigation-keep-out",
  approval: "private-approval-id-keep-out"
};

function step(id: string, status: WorkflowStepStatus): WorkflowStep {
  return {
    id,
    tool: "calculator.evaluate",
    input: { expression: SECRETS.input },
    resolvedInput: { expression: SECRETS.input },
    dependsOn: [],
    status,
    output: { result: SECRETS.output },
    error: SECRETS.error,
    approvalId: SECRETS.approval
  };
}

function run(
  id: string,
  kind: "active" | "completed" | "failed" | "approval" |
    "uncertain" | "pendingRecovery" | "recovering" | "recovered",
  userId = "owner",
  at = TIME
): WorkflowRun {
  const created = "2026-10-08T12:00:00.000Z";
  const record: WorkflowRun = {
    id, userId, objective: "Processo " + kind,
    version: 1, createdAt: created, updatedAt: at,
    steps: []
  };
  if (kind === "active") record.steps = [step("step", "PENDING")];
  if (kind === "completed") record.steps = [{
    ...step("step", "COMPLETED"),
    startedAt: "2026-10-08T12:00:00.000Z",
    finishedAt: "2026-10-08T12:00:01.000Z"
  }];
  if (kind === "failed") record.steps = [{
    ...step("step", "FAILED"),
    startedAt: "2026-10-08T12:00:00.000Z",
    finishedAt: "2026-10-08T12:00:02.000Z"
  }];
  if (kind === "approval") record.steps = [step("step", "WAITING_APPROVAL")];
  if (kind === "uncertain") record.steps = [step("step", "RUNNING")];
  if (kind === "pendingRecovery" || kind === "recovering" || kind === "recovered") {
    record.steps = [
      step("original", "FAILED"),
      {
        ...step("fallback", kind === "recovered" ? "COMPLETED" : "PENDING"),
        onFailureOf: "original", dependsOn: ["original"]
      }
    ];
    if (kind !== "pendingRecovery") {
      record.recoveries = [{
        stepId: "original", note: SECRETS.note, authorizedAt: at
      }];
    }
  }
  const event: WorkflowEvent = {
    seq: 1, at, kind: "STEP_STATUS_CHANGED", source: "engine",
    stepId: record.steps[0]!.id, tool: "calculator.evaluate",
    from: "PENDING", to: record.steps[0]!.status
  };
  // Deliberately store additional fields to verify the API's explicit
  // metadata projection never blindly spreads arbitrary stored JSON.
  record.events = [
    { ...event, privateNote: SECRETS.note } as WorkflowEvent
  ];
  return record;
}

const id = (n: number) => n.toString(16).padStart(8, "0") +
  "-1111-4111-8111-111111111111";

async function fixture() {
  const store = new InMemoryWorkflowStore();
  const kinds = [
    "active", "completed", "failed", "approval",
    "uncertain", "pendingRecovery", "recovering", "recovered"
  ] as const;
  for (let i = 0; i < kinds.length; i++) {
    await store.create(run(id(i + 1), kinds[i]!, "owner",
      new Date(Date.parse(TIME) + i * 1000).toISOString()));
  }
  await store.create(run(id(99), "failed", "someone-else"));
  return store;
}

describe("CORTEX v7 monitoring snapshot", () => {
  it("aggregates real recent workflow states with accurate denominators and durations", async () => {
    const store = await fixture();
    const watcher = new MonitoringService(store, () => new Date(TIME));
    const report = await watcher.overview("owner", 20);

    expect(report).toMatchObject({
      readOnly: true,
      scope: { kind: "latest_workflows", limit: 20, sampled: 8, isAllTime: false },
      generatedAt: TIME
    });
    expect(report.metrics).toMatchObject({
      total: 8,
      completed: 2,
      completionPercent: 25,
      requiringAttention: 5,
      critical: 2,
      observedTerminalStepDurations: 2,
      averageTerminalStepDurationMs: 1500
    });
    expect(report.statusCounts).toEqual({
      ACTIVE: 1, COMPLETED: 1, FAILED: 1,
      AWAITING_APPROVAL: 1, NEEDS_RECONCILIATION: 1,
      RECOVERY_REQUIRED: 1, RECOVERING: 1, COMPLETED_WITH_FAILURES: 1
    });
    expect(report.metrics.steps).toEqual({
      PENDING: 3, RUNNING: 1, WAITING_APPROVAL: 1,
      COMPLETED: 2, SKIPPED: 0, FAILED: 4
    });
    expect(report.alerts).toHaveLength(5);
    expect(report.alerts[0]?.status).toBe("NEEDS_RECONCILIATION");
    expect(report.alerts[0]?.nextAction).toContain("Verifique");
    expect(report.alerts[1]?.status).toBe("FAILED");
    expect(report.recent).toHaveLength(8);
    expect(report.activity).toHaveLength(8);
    expect(report.activity[0]?.workflowId).toBe(id(8));
    expect(report.recent[0]?.id).toBe(id(8));
  });

  it("does not leak secrets, operator notes, inputs, errors or data from other users", async () => {
    const store = await fixture();
    const update = vi.spyOn(store, "update");
    const create = vi.spyOn(store, "create");
    const reporter = new MonitoringService(store, () => new Date(TIME));
    const report = await reporter.overview("owner", 100);
    const serialized = JSON.stringify(report);
    for (const value of Object.values(SECRETS)) {
      expect(serialized).not.toContain(value);
    }
    expect(serialized).not.toContain(id(99));
    expect(report.recent.every(entry => !("userId" in entry))).toBe(true);
    expect(report.activity.every(entry => !("output" in entry))).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();

    const outsider = await reporter.overview("someone-else");
    expect(outsider.metrics.total).toBe(1);
    expect(outsider.recent[0]?.id).toBe(id(99));
    expect(outsider.recent.some(item => item.id === id(1))).toBe(false);
  });

  it("honors sampling limits without claiming historical totals", async () => {
    const store = await fixture();
    const reporter = new MonitoringService(store, () => new Date(TIME));
    const small = await reporter.overview("owner", 2);
    expect(small.metrics.total).toBe(2);
    expect(small.scope).toMatchObject({ sampled: 2, limit: 2, isAllTime: false });
    expect(small.statusCounts.COMPLETED_WITH_FAILURES).toBe(1);
    expect(small.statusCounts.RECOVERING).toBe(1);
    expect(small.metrics.completionPercent).toBe(50);
    expect(small.activity).toHaveLength(2);
    expect(small.alerts).toHaveLength(1);

    for (const invalid of [0, -1, 1.5, 101, NaN, Infinity]) {
      await expect(reporter.overview("owner", invalid)).rejects.toThrow("limit");
      expect(() => summarizeMonitoring([], invalid, TIME)).toThrow("limit");
    }
  });

  it("returns explicit empty sample and null averages rather than invented rates", async () => {
    const store = await fixture();
    const reporter = new MonitoringService(store, () => new Date(TIME));
    const empty = await reporter.overview("new-owner");
    expect(empty.metrics).toMatchObject({
      total: 0, completed: 0, completionPercent: null,
      requiringAttention: 0, critical: 0,
      observedTerminalStepDurations: 0,
      averageTerminalStepDurationMs: null
    });
    expect(empty.recent).toEqual([]);
    expect(empty.activity).toEqual([]);
    expect(empty.alerts).toEqual([]);
    expect(Object.values(empty.statusCounts).every(count => count === 0)).toBe(true);
  });

  it("caps alerts, recent records and events and tolerates absent legacy events", () => {
    const runs = Array.from({ length: 30 }, (_, i) =>
      run(id(i + 1), "failed", "owner",
        new Date(Date.parse(TIME) + i * 1000).toISOString()));
    const first = runs[0]!;
    delete first.events;
    const snapshot: MonitoringSnapshot = summarizeMonitoring(runs, 30, TIME);
    expect(snapshot.metrics.total).toBe(30);
    expect(snapshot.metrics.requiringAttention).toBe(30);
    expect(snapshot.alerts).toHaveLength(12);
    expect(snapshot.recent).toHaveLength(12);
    expect(snapshot.activity).toHaveLength(16);
    expect(snapshot.statusCounts.FAILED).toBe(30);
  });

  it("excludes unreliable durations and does not confuse skipped steps with success", () => {
    const bad = run(id(70), "completed");
    bad.steps.push({
      ...step("skipped", "SKIPPED"),
      startedAt: "2026-10-08T12:00:00.000Z",
      finishedAt: "2026-10-08T12:00:09.000Z"
    });
    bad.steps[0]!.finishedAt = "2026-10-08T11:00:00.000Z";
    const future = run(id(71), "failed");
    future.steps[0]!.finishedAt = "2026-10-20T12:00:00.000Z";
    const snapshot = summarizeMonitoring([bad, future], 20, TIME);
    expect(snapshot.metrics.steps.SKIPPED).toBe(1);
    expect(snapshot.metrics.steps.COMPLETED).toBe(1);
    expect(snapshot.metrics.steps.FAILED).toBe(1);
    expect(snapshot.metrics.observedTerminalStepDurations).toBe(0);
    expect(snapshot.metrics.averageTerminalStepDurationMs).toBeNull();
    expect(snapshot.metrics.completed).toBe(1);
    expect(snapshot.metrics.completionPercent).toBe(50);
  });
});
