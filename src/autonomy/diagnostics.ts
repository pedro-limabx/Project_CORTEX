import type { Settings } from "./store.js";

export type MonitorHealthStatus = "disabled" | "starting" | "healthy" | "degraded" | "overdue";

export function diagnoseMonitorHealth(settings: Settings, now: Date = new Date()) {
  const overdueSeconds = settings.enabled
    ? Math.max(0, Math.floor((now.getTime() - Date.parse(settings.nextCheckAt)) / 1000))
    : 0;
  let status: MonitorHealthStatus;
  if (!settings.enabled) status = "disabled";
  else if (settings.lastCheckOk === false) status = "degraded";
  else if (overdueSeconds > 30) status = "overdue";
  else if (settings.lastCheckedAt === null) status = "starting";
  else status = "healthy";
  return { status, enabled: settings.enabled, lastCheckedAt: settings.lastCheckedAt,
    nextCheckAt: settings.nextCheckAt, lastCheckOk: settings.lastCheckOk,
    overdueSeconds, readOnlyChecks: true as const };
}
