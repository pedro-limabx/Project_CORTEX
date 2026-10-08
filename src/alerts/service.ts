import type { WorkflowStore } from "../workflows/store.js";
import { diagnoseWorkflow } from "../workflows/timeline.js";
import { workflowStatus, type WorkflowRun, type WorkflowStatus } from "../workflows/types.js";
import {
  type AlertAcknowledgementStore,
  type AlertKey
} from "./store.js";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export const MAX_ALERT_WORKFLOWS = 100;
export const DEFAULT_ALERT_WORKFLOWS = 50;

const WATCHED_STATUSES: readonly WorkflowStatus[] = [
  "NEEDS_RECONCILIATION", "FAILED", "RECOVERY_REQUIRED",
  "AWAITING_APPROVAL", "RECOVERING"
];
export type AlertSeverity = "critical" | "attention";
export type AlertView = "all" | "unread";

export class AlertInputError extends Error {}
export class AlertConflictError extends Error {}
export class AlertNotFoundError extends Error {}

export interface OperationalAlert extends AlertKey {
  objective: string;
  severity: AlertSeverity;
  updatedAt: string;
  message: string;
  nextAction: string;
  acknowledged: boolean;
  acknowledgedAt?: string;
}

export interface AlertInbox {
  scope: {
    kind: "latest_workflows";
    limit: number;
    sampled: number;
    isAllTime: false;
    view: AlertView;
  };
  generatedAt: string;
  readOnly: true;
  delivery: "manual_in_app_only";
  counts: {
    all: number;
    unread: number;
    acknowledged: number;
    critical: number;
    attention: number;
  };
  alerts: OperationalAlert[];
}

function statusPriority(status: WorkflowStatus): number {
  const index = WATCHED_STATUSES.indexOf(status);
  return index === -1 ? WATCHED_STATUSES.length : index;
}

function severity(status: WorkflowStatus): AlertSeverity {
  return status === "NEEDS_RECONCILIATION" || status === "FAILED"
    ? "critical" : "attention";
}

function isTracked(status: WorkflowStatus): boolean {
  return WATCHED_STATUSES.includes(status);
}

function keyOf(run: WorkflowRun): AlertKey {
  return { workflowId: run.id, version: run.version, status: workflowStatus(run) };
}

function keyString(key: AlertKey): string {
  return JSON.stringify([key.workflowId, key.version, key.status]);
}

/** Deterministic current-state alert, no historic synthetic notifications. */
function buildAlert(run: WorkflowRun): OperationalAlert {
  const status = workflowStatus(run);
  const diagnosis = diagnoseWorkflow(run);
  return {
    ...keyOf(run),
    objective: run.objective,
    severity: severity(status),
    updatedAt: run.updatedAt,
    message: diagnosis.message,
    nextAction: diagnosis.nextAction,
    acknowledged: false
  };
}

function sortAlerts(a: OperationalAlert, b: OperationalAlert): number {
  return statusPriority(a.status) - statusPriority(b.status)
    || b.updatedAt.localeCompare(a.updatedAt)
    || a.workflowId.localeCompare(b.workflowId);
}

/**
 * Acknowledging means "operator has seen the current state", not "fixed".
 * It does not approve tools, reconcile effects, or mark a workflow complete.
 */
export class OperationalAlertService {
  constructor(
    private readonly workflows: WorkflowStore,
    private readonly acknowledgements: AlertAcknowledgementStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  async inbox(
    userId: string,
    options: { limit?: number; view?: AlertView } = {}
  ): Promise<AlertInbox> {
    const limit = options.limit ?? DEFAULT_ALERT_WORKFLOWS;
    const view = options.view ?? "all";
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ALERT_WORKFLOWS) {
      throw new AlertInputError("limit must be an integer from 1 to 100");
    }
    if (view !== "all" && view !== "unread") {
      throw new AlertInputError("view must be all or unread");
    }

    const runs = await this.workflows.list(userId, limit);
    const candidates = runs.filter(run => isTracked(workflowStatus(run)));
    const alerts = candidates.map(buildAlert);
    const recorded = await this.acknowledgements.listCurrent(
      userId, alerts.map(({ workflowId, version, status }) =>
        ({ workflowId, version, status }))
    );
    const acknowledged = new Map(recorded.map(item =>
      [keyString(item), item.acknowledgedAt]
    ));
    for (const alert of alerts) {
      const at = acknowledged.get(keyString(alert));
      if (at) {
        alert.acknowledged = true;
        alert.acknowledgedAt = at;
      }
    }
    alerts.sort(sortAlerts);

    const seen = alerts.filter(alert => alert.acknowledged).length;
    return {
      scope: {
        kind: "latest_workflows",
        limit,
        sampled: runs.length,
        isAllTime: false,
        view
      },
      generatedAt: this.now().toISOString(),
      readOnly: true,
      delivery: "manual_in_app_only",
      counts: {
        all: alerts.length,
        unread: alerts.length - seen,
        acknowledged: seen,
        critical: alerts.filter(alert => alert.severity === "critical").length,
        attention: alerts.filter(alert => alert.severity === "attention").length
      },
      alerts: view === "unread" ? alerts.filter(alert => !alert.acknowledged) : alerts
    };
  }

  async acknowledge(userId: string, input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new AlertInputError("Invalid acknowledgement request");
    }
    const params = input as Record<string, unknown>;
    if (params.confirmed !== true || typeof params.workflowId !== "string"
      || !UUID.test(params.workflowId)
      || typeof params.version !== "number"
      || !Number.isSafeInteger(params.version) || params.version < 1
      || typeof params.status !== "string"
      || !WATCHED_STATUSES.includes(params.status as WorkflowStatus)) {
      throw new AlertInputError(
        "workflowId, version, actionable status and confirmed=true are required"
      );
    }

    const run = await this.workflows.get(userId, params.workflowId);
    if (!run) throw new AlertNotFoundError("Workflow not found");
    const current = workflowStatus(run);
    if (current !== params.status || run.version !== params.version) {
      throw new AlertConflictError(
        "Workflow state changed. Refresh alerts before acknowledging this version."
      );
    }
    const key: AlertKey = {
      workflowId: run.id,
      version: run.version,
      status: current
    };
    const record = await this.acknowledgements.acknowledge(
      userId, key, this.now().toISOString()
    );
    return {
      acknowledged: true as const,
      workflowId: record.workflowId,
      version: record.version,
      status: record.status,
      acknowledgedAt: record.acknowledgedAt,
      workflowUnchanged: true as const,
      actionExecuted: false as const,
      readOnlyWorkflow: true as const
    };
  }
}
