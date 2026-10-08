import type { WorkflowStore } from "./store.js";
import { diagnoseWorkflow } from "./timeline.js";
import {
  workflowResponse,
  type WorkflowEvent,
  type WorkflowStatus,
  type WorkflowStepStatus,
  type WorkflowRun
} from "./types.js";

export const MAX_MONITORING_WORKFLOWS = 100;
export const DEFAULT_MONITORING_WORKFLOWS = 50;
const MAX_ALERTS = 12;
const MAX_ACTIVITY = 16;
const MAX_RECENT = 12;
const MAX_STEP_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export type MonitoringSeverity = "critical" | "attention";

export interface MonitoringAlert {
  workflowId: string;
  objective: string;
  status: WorkflowStatus;
  severity: MonitoringSeverity;
  updatedAt: string;
  message: string;
  nextAction: string;
}

export interface MonitoringEvent {
  workflowId: string;
  at: string;
  seq: number;
  kind: WorkflowEvent["kind"];
  source: WorkflowEvent["source"];
  stepId?: string;
  tool?: string;
  from?: WorkflowStepStatus;
  to?: WorkflowStepStatus;
}

export interface MonitoringSnapshot {
  scope: {
    kind: "latest_workflows";
    limit: number;
    sampled: number;
    isAllTime: false;
  };
  generatedAt: string;
  readOnly: true;
  statusCounts: Record<WorkflowStatus, number>;
  metrics: {
    total: number;
    completed: number;
    completionPercent: number | null;
    requiringAttention: number;
    critical: number;
    steps: Record<WorkflowStepStatus, number>;
    observedTerminalStepDurations: number;
    averageTerminalStepDurationMs: number | null;
  };
  alerts: MonitoringAlert[];
  activity: MonitoringEvent[];
  recent: Array<{
    id: string;
    objective: string;
    status: WorkflowStatus;
    percent: number;
    updatedAt: string;
    completed: number;
    skipped: number;
    failed: number;
    total: number;
  }>;
}

const ALL_STATUSES: WorkflowStatus[] = [
  "ACTIVE", "AWAITING_APPROVAL", "NEEDS_RECONCILIATION",
  "RECOVERY_REQUIRED", "RECOVERING", "COMPLETED_WITH_FAILURES",
  "COMPLETED", "FAILED"
];
const ALL_STEPS: WorkflowStepStatus[] = [
  "PENDING", "RUNNING", "WAITING_APPROVAL", "COMPLETED", "SKIPPED", "FAILED"
];

function countBy<T extends string>(values: readonly T[]): Record<T, number> {
  return Object.fromEntries(values.map(value => [value, 0])) as Record<T, number>;
}

function timestampMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function severity(status: WorkflowStatus): MonitoringSeverity | undefined {
  if (status === "FAILED" || status === "NEEDS_RECONCILIATION") return "critical";
  if (status === "RECOVERY_REQUIRED" || status === "AWAITING_APPROVAL"
    || status === "RECOVERING") return "attention";
  return undefined;
}

function priority(alert: MonitoringAlert): number {
  if (alert.status === "NEEDS_RECONCILIATION") return 0;
  if (alert.status === "FAILED") return 1;
  if (alert.status === "RECOVERY_REQUIRED") return 2;
  if (alert.status === "AWAITING_APPROVAL") return 3;
  return 4;
}

/**
 * A read-only point-in-time snapshot of recent owner-scoped records.
 * This reports sampled CURRENT states, not lifetime rates or an immutable
 * audit log. No LLM, executor, authorization or store mutation is involved.
 */
export function summarizeMonitoring(
  runs: readonly WorkflowRun[],
  limit: number,
  generatedAt: string
): MonitoringSnapshot {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MONITORING_WORKFLOWS) {
    throw new Error("limit must be an integer from 1 to 100");
  }

  const sampled = runs.slice(0, limit);
  const statusCounts = countBy(ALL_STATUSES);
  const stepCounts = countBy(ALL_STEPS);
  const alerts: MonitoringAlert[] = [];
  const activity: MonitoringEvent[] = [];
  const recent: MonitoringSnapshot["recent"] = [];
  let observedDurations = 0;
  let totalDuration = 0;

  for (const run of sampled) {
    const snapshot = workflowResponse(run);
    statusCounts[snapshot.status]++;

    if (recent.length < MAX_RECENT) {
      recent.push({
        id: run.id,
        objective: run.objective,
        status: snapshot.status,
        percent: snapshot.progress.percent,
        updatedAt: run.updatedAt,
        completed: snapshot.progress.completed,
        skipped: snapshot.progress.skipped,
        failed: snapshot.progress.failed,
        total: snapshot.progress.total
      });
    }

    for (const step of run.steps) {
      stepCounts[step.status]++;
      if (step.status !== "COMPLETED" && step.status !== "FAILED") continue;
      const started = timestampMs(step.startedAt);
      const finished = timestampMs(step.finishedAt);
      if (started === undefined || finished === undefined) continue;
      const duration = finished - started;
      if (duration < 0 || duration > MAX_STEP_DURATION_MS) continue;
      observedDurations++;
      totalDuration += duration;
    }

    const alertSeverity = severity(snapshot.status);
    if (alertSeverity) {
      const diagnostic = diagnoseWorkflow(run);
      alerts.push({
        workflowId: run.id,
        objective: run.objective,
        status: snapshot.status,
        severity: alertSeverity,
        updatedAt: run.updatedAt,
        message: diagnostic.message,
        nextAction: diagnostic.nextAction
      });
    }

    // Explicitly project ONLY metadata fields, never return arbitrary stored
    // event properties or tool arguments/results/approval IDs/operator notes.
    for (const event of run.events ?? []) {
      activity.push({
        workflowId: run.id,
        at: event.at,
        seq: event.seq,
        kind: event.kind,
        source: event.source,
        ...(event.stepId ? { stepId: event.stepId } : {}),
        ...(event.tool ? { tool: event.tool } : {}),
        ...(event.from ? { from: event.from } : {}),
        ...(event.to ? { to: event.to } : {})
      });
    }
  }

  alerts.sort((a, b) => priority(a) - priority(b)
    || (timestampMs(b.updatedAt) ?? 0) - (timestampMs(a.updatedAt) ?? 0)
    || a.workflowId.localeCompare(b.workflowId));

  activity.sort((a, b) => (timestampMs(b.at) ?? 0) - (timestampMs(a.at) ?? 0)
    || b.seq - a.seq || a.workflowId.localeCompare(b.workflowId));

  const completed = statusCounts.COMPLETED + statusCounts.COMPLETED_WITH_FAILURES;
  const critical = alerts.filter(alert => alert.severity === "critical").length;
  return {
    scope: {
      kind: "latest_workflows",
      limit,
      sampled: sampled.length,
      isAllTime: false
    },
    generatedAt,
    readOnly: true,
    statusCounts,
    metrics: {
      total: sampled.length,
      completed,
      completionPercent: sampled.length ? Math.round(100 * completed / sampled.length) : null,
      requiringAttention: alerts.length,
      critical,
      steps: stepCounts,
      observedTerminalStepDurations: observedDurations,
      averageTerminalStepDurationMs: observedDurations
        ? Math.round(totalDuration / observedDurations) : null
    },
    alerts: alerts.slice(0, MAX_ALERTS),
    activity: activity.slice(0, MAX_ACTIVITY),
    recent
  };
}

export class MonitoringService {
  constructor(
    private readonly store: WorkflowStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  async overview(userId: string, limit = DEFAULT_MONITORING_WORKFLOWS): Promise<MonitoringSnapshot> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MONITORING_WORKFLOWS) {
      throw new Error("limit must be an integer from 1 to 100");
    }
    const runs = await this.store.list(userId, limit);
    return summarizeMonitoring(runs, limit, this.now().toISOString());
  }
}
