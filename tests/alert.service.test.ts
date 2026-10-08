import { describe, expect, it, vi } from "vitest";
import {
  OperationalAlertService, AlertConflictError, AlertInputError, AlertNotFoundError
} from "../src/alerts/service.js";
import { InMemoryAlertAcknowledgementStore } from "../src/alerts/store.js";
import { InMemoryWorkflowStore } from "../src/workflows/store.js";
import type { WorkflowRun, WorkflowStep } from "../src/workflows/types.js";

const T = "2026-10-08T19:00:00.000Z";
const id = (n: number) => n.toString(16).padStart(8, "0") +
  "-2222-4222-8222-222222222222";

const SECRET = "do-not-expose-private-tool-result";

function step(id: string, status: WorkflowStep["status"]): WorkflowStep {
  return {
    id, tool: "calculator.evaluate", input: { expression: "private input" },
    output: { secret: SECRET }, error: "private error",
    dependsOn: [], status
  };
}

function makeRun(n: number, type:
  "failed" | "uncertain" | "approval" | "recoveryRequired" |
  "recovering" | "active" | "completed", owner = "user-a"
): WorkflowRun {
  const run: WorkflowRun = {
    id: id(n),
    userId: owner,
    objective: "Operational test " + type,
    version: 1,
    createdAt: T,
    updatedAt: new Date(Date.parse(T) + n * 1000).toISOString(),
    steps: [step("primary", type === "failed" || type === "recoveryRequired"
      || type === "recovering" ? "FAILED"
      : type === "uncertain" ? "RUNNING"
        : type === "approval" ? "WAITING_APPROVAL"
          : type === "completed" ? "COMPLETED" : "PENDING")]
  };
  if (type === "recoveryRequired" || type === "recovering") {
    run.steps.push({
      ...step("fallback", "PENDING"),
      dependsOn: ["primary"],
      onFailureOf: "primary"
    });
  }
  if (type === "recovering") {
    run.recoveries = [{
      stepId: "primary",
      note: "private operator investigation note",
      authorizedAt: T
    }];
  }
  return run;
}

async function fixture() {
  const store = new InMemoryWorkflowStore();
  const kinds = [
    "failed", "uncertain", "approval", "recoveryRequired",
    "recovering", "active", "completed"
  ] as const;
  for (let n = 0; n < kinds.length; n++) {
    await store.create(makeRun(n + 1, kinds[n]!));
  }
  await store.create(makeRun(99, "failed", "someone-else"));
  const acknowledgements = new InMemoryAlertAcknowledgementStore();
  const alerts = new OperationalAlertService(
    store, acknowledgements, () => new Date(T)
  );
  return { store, acknowledgements, alerts };
}

describe("CORTEX v8 supervised alert inbox", () => {
  it("reports only current actionable statuses and prioritizes critical alerts", async () => {
    const { alerts } = await fixture();
    const snapshot = await alerts.inbox("user-a", { limit: 50, view: "all" });
    expect(snapshot).toMatchObject({
      readOnly: true,
      delivery: "manual_in_app_only",
      generatedAt: T,
      scope: { kind: "latest_workflows", limit: 50, sampled: 7, isAllTime: false },
      counts: { all: 5, unread: 5, acknowledged: 0, critical: 2, attention: 3 }
    });
    expect(snapshot.alerts.map(a => a.status)).toEqual([
      "NEEDS_RECONCILIATION",
      "FAILED",
      "RECOVERY_REQUIRED",
      "AWAITING_APPROVAL",
      "RECOVERING"
    ]);
    expect(snapshot.alerts.every(a => a.version === 1)).toBe(true);
    expect(snapshot.alerts.every(a => !a.acknowledged)).toBe(true);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("private input");
    expect(serialized).not.toContain("private operator investigation note");
    expect(serialized).not.toContain("private error");
    expect(serialized).not.toContain(id(99));

    const empty = await alerts.inbox("unknown-user");
    expect(empty.scope.sampled).toBe(0);
    expect(empty.counts.all).toBe(0);
    expect(empty.alerts).toEqual([]);
  });

  it("records human acknowledgement without modifying workflow state or granting permissions", async () => {
    const { alerts, store, acknowledgements } = await fixture();
    const saveSpy = vi.spyOn(store, "update");
    const ownBefore = await store.get("user-a", id(1));
    const confirmation = {
      workflowId: id(1), version: 1, status: "FAILED", confirmed: true
    };
    const received = await alerts.acknowledge("user-a", confirmation);
    expect(received).toMatchObject({
      acknowledged: true, actionExecuted: false,
      readOnlyWorkflow: true, workflowUnchanged: true,
      workflowId: id(1), version: 1, status: "FAILED", acknowledgedAt: T
    });
    expect(saveSpy).not.toHaveBeenCalled();
    expect(await store.get("user-a", id(1))).toEqual(ownBefore);

    const repeated = await alerts.acknowledge("user-a", confirmation);
    expect(repeated).toEqual(received);
    const current = await acknowledgements.listCurrent("user-a", [{
      workflowId: id(1), version: 1, status: "FAILED"
    }]);
    expect(current).toHaveLength(1);

    const all = await alerts.inbox("user-a");
    expect(all.counts).toMatchObject({ all: 5, unread: 4, acknowledged: 1 });
    expect(all.alerts.find(alert => alert.workflowId === id(1))).toMatchObject({
      acknowledged: true, acknowledgedAt: T
    });
    const unseen = await alerts.inbox("user-a", { view: "unread" });
    expect(unseen.alerts).toHaveLength(4);
    expect(unseen.counts.all).toBe(5);
    expect(unseen.counts.unread).toBe(4);
  });

  it("refuses stale acknowledgement after a workflow changes and renews the alert", async () => {
    const { store, alerts } = await fixture();
    const previous = (await store.get("user-a", id(1)))!;
    await alerts.acknowledge("user-a", {
      workflowId: id(1), version: 1, status: "FAILED", confirmed: true
    });
    const changed = structuredClone(previous);
    changed.version = 2;
    changed.updatedAt = "2026-10-08T19:02:00.000Z";
    expect(await store.update("user-a", 1, changed)).toBe(true);

    const renewed = await alerts.inbox("user-a");
    expect(renewed.alerts.find(a => a.workflowId === id(1))).toMatchObject({
      version: 2, acknowledged: false
    });
    await expect(alerts.acknowledge("user-a", {
      workflowId: id(1), version: 1, status: "FAILED", confirmed: true
    })).rejects.toThrow(AlertConflictError);
    expect((await alerts.inbox("user-a")).counts.unread).toBe(5);

    const completed = structuredClone(changed);
    completed.version = 3;
    completed.steps[0]!.status = "COMPLETED";
    expect(await store.update("user-a", 2, completed)).toBe(true);
    const nowResolved = await alerts.inbox("user-a");
    expect(nowResolved.counts.all).toBe(4);
    expect(nowResolved.alerts.some(a => a.workflowId === id(1))).toBe(false);
  });

  it("isolates users and rejects malformed or non-actionable acknowledgements", async () => {
    const { alerts, acknowledgements } = await fixture();
    await expect(alerts.acknowledge("someone-else", {
      workflowId: id(1), version: 1, status: "FAILED", confirmed: true
    })).rejects.toThrow(AlertNotFoundError);

    const invalid = [
      null, {}, { workflowId: "not-a-uuid", version: 1, status: "FAILED", confirmed: true },
      { workflowId: id(1), version: 1, status: "FAILED", confirmed: "true" },
      { workflowId: id(1), version: 0, status: "FAILED", confirmed: true },
      { workflowId: id(1), version: 1.5, status: "FAILED", confirmed: true },
      { workflowId: id(1), version: 1, status: "COMPLETED", confirmed: true }
    ];
    for (const input of invalid) {
      await expect(alerts.acknowledge("user-a", input)).rejects.toThrow(AlertInputError);
    }
    await expect(alerts.acknowledge("user-a", {
      workflowId: id(1), version: 1, status: "RECOVERY_REQUIRED", confirmed: true
    })).rejects.toThrow(AlertConflictError);
    const list = await acknowledgements.listCurrent("user-a", [{
      workflowId: id(1), version: 1, status: "FAILED"
    }]);
    expect(list).toEqual([]);
  });

  it("rejects invalid sample windows and ignores other owners' acknowledgements", async () => {
    const { alerts, acknowledgements } = await fixture();
    await acknowledgements.acknowledge("someone-else", {
      workflowId: id(1), version: 1, status: "FAILED"
    }, T);
    const own = await alerts.inbox("user-a", { limit: 2 });
    expect(own.scope.sampled).toBe(2);
    expect(own.counts.all).toBe(0);
    expect(own.alerts).toEqual([]);

    const all = await alerts.inbox("user-a");
    expect(all.alerts.find(a => a.workflowId === id(1))?.acknowledged).toBe(false);
    for (const limit of [0, 101, -1, NaN, 2.5, Infinity]) {
      await expect(alerts.inbox("user-a", { limit })).rejects.toThrow(AlertInputError);
    }
    await expect(alerts.inbox("user-a", { view: "invalid" as "all" }))
      .rejects.toThrow(AlertInputError);
  });

  it("acknowledges concurrent clicks idempotently for the same alert version", async () => {
    const { alerts, acknowledgements } = await fixture();
    const payload = { workflowId: id(1), version: 1, status: "FAILED", confirmed: true };
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      alerts.acknowledge("user-a", payload)));
    expect(results.every(result => result.acknowledged && !result.actionExecuted)).toBe(true);
    expect(new Set(results.map(result => result.acknowledgedAt)).size).toBe(1);
    expect(await acknowledgements.listCurrent("user-a",
      [{ workflowId: id(1), version: 1, status: "FAILED" }])).toHaveLength(1);
  });
});
