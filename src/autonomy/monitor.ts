import type { OperationalAlertService } from "../alerts/service.js";
import type { Candidate, MonitorRepository } from "./store.js";
export interface NotificationChannel {
  readonly name: string;
  publish(user: string, candidate: Candidate, cooldown: number, at: string): Promise<boolean>;
}
export class InAppNotificationChannel implements NotificationChannel {
  readonly name = "in-app";
  constructor(private readonly repository: MonitorRepository) {}
  publish(user: string, candidate: Candidate, cooldown: number, at: string) {
    return this.repository.insert(user, candidate, cooldown, at);
  }
}
const WATCHED = new Set(["AWAITING_APPROVAL", "NEEDS_RECONCILIATION", "RECOVERY_REQUIRED", "RECOVERING", "FAILED"]);
export type MonitorCheckResult =
  | { ran: false; reason: "disabled" | "not_due" | "rate_limited" | "locked" }
  | { ran: true; checkedAt: string; sampled: number; created: number };
export class AutonomousMonitoringService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<MonitorCheckResult> | undefined;
  constructor(
    private readonly repo: MonitorRepository,
    private readonly alerts: Pick<OperationalAlertService, "inbox">,
    private readonly user: string,
    private readonly channel: NotificationChannel,
    private readonly now: () => Date = () => new Date(),
    private readonly onError: (error: unknown) => void = () => {}
  ) {}
  async checkDue(force = false): Promise<MonitorCheckResult> {
    if (this.inFlight) return this.inFlight;
    const promise = this.checkLocked(force);
    this.inFlight = promise;
    try { return await promise; }
    finally { if (this.inFlight === promise) this.inFlight = undefined; }
  }
  private async checkLocked(force: boolean): Promise<MonitorCheckResult> {
    const result = await this.repo.withLock(this.user, async (): Promise<MonitorCheckResult> => {
      const settings = await this.repo.getSettings(this.user);
      const start = this.now();
      if (!settings.enabled) return {ran: false, reason: "disabled"};
      // Manual checks respect persisted opt-in and a 30s rate limit across replicas.
      if (force && settings.lastCheckedAt
        && start.getTime() - Date.parse(settings.lastCheckedAt) < 30_000) {
        return {ran: false, reason: "rate_limited"};
      }
      if (!force && Date.parse(settings.nextCheckAt) > start.getTime()) {
        return {ran: false, reason: "not_due"};
      }
      let sampled = 0, created = 0;
      try {
        // Metadata-only reads. Tools, approvals and LLMs are never invoked.
        const snapshot = await this.alerts.inbox(this.user, {limit: 100, view: "all"});
        sampled = snapshot.scope.sampled;
        for (const alert of snapshot.alerts) {
          if (!WATCHED.has(alert.status)) continue;
          const candidate: Candidate = { workflowId: alert.workflowId, version: alert.version,
            status: alert.status as Candidate["status"], severity: alert.severity };
          if (await this.channel.publish(this.user, candidate, settings.cooldownSeconds, start.toISOString())) created++;
        }
        const checkedAt = this.now().toISOString();
        await this.repo.complete(this.user, checkedAt, true, sampled, created);
        return {ran: true, checkedAt, sampled, created};
      } catch (error) {
        // Error messages may contain sensitive tool payloads: persist no exception text.
        await this.repo.complete(this.user, this.now().toISOString(), false, sampled, created);
        throw error;
      }
    });
    return result ?? {ran: false, reason: "locked"};
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.checkDue().catch(this.onError); }, 15_000);
    this.timer.unref?.();
    void this.checkDue().catch(this.onError);
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }
}
export function validateMonitorSettings(input: unknown): {
  enabled: boolean; intervalSeconds: number; cooldownSeconds: number
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid settings");
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key=>!["enabled","intervalSeconds","cooldownSeconds"].includes(key))
    || typeof body.enabled !== "boolean"
    || typeof body.intervalSeconds !== "number" || !Number.isInteger(body.intervalSeconds)
    || body.intervalSeconds < 60 || body.intervalSeconds > 3600
    || typeof body.cooldownSeconds !== "number" || !Number.isInteger(body.cooldownSeconds)
    || body.cooldownSeconds < 60 || body.cooldownSeconds > 86400) {
    throw new Error("enabled (boolean), intervalSeconds (60..3600) and cooldownSeconds (60..86400) required");
  }
  return { enabled:body.enabled, intervalSeconds:body.intervalSeconds, cooldownSeconds:body.cooldownSeconds };
}
