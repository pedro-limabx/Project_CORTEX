import { describe, expect, it, vi } from "vitest";
import type { OperationalAlertService } from "../src/alerts/service.js";
import {
  AutonomousMonitoringService, InAppNotificationChannel, validateMonitorSettings
} from "../src/autonomy/monitor.js";
import type {
  Candidate, Event, MonitorRepository, Notice, Settings
} from "../src/autonomy/store.js";

class MemoryMonitorRepository implements MonitorRepository {
  readonly notices: Notice[] = [];
  readonly history: Event[] = [];
  readonly settings = new Map<string, Settings>();
  readonly active = new Set<string>();
  readonly checks: Array<{ user: string; ok: boolean; created: number }> = [];
  readonly now = () => "2026-10-08T12:00:00.000Z";
  async getSettings(user: string): Promise<Settings> {
    return this.settings.get(user) ?? {
      enabled: false, intervalSeconds: 60, cooldownSeconds: 600,
      nextCheckAt: this.now(), lastCheckedAt: null, lastCheckOk: null
    };
  }
  async configure(user: string, enabled: boolean, intervalSeconds: number, cooldownSeconds: number): Promise<Settings> {
    const settings = { ...(await this.getSettings(user)), enabled, intervalSeconds, cooldownSeconds };
    this.settings.set(user, settings);
    return settings;
  }
  async withLock<T>(user: string, job: () => Promise<T>): Promise<T | undefined> {
    if (this.active.has(user)) return undefined;
    this.active.add(user);
    try { return await job(); }
    finally { this.active.delete(user); }
  }
  async insert(user: string, notice: Candidate, cooldown: number, at: string): Promise<boolean> {
    if (this.notices.some(existing => (existing as Notice & { user?: string }).user === user
      && existing.workflowId === notice.workflowId
      && existing.status === notice.status
      && (existing.version === notice.version ||
        Date.parse(at) - Date.parse(existing.createdAt) < cooldown * 1000))) return false;
    this.notices.push({ ...notice, id: user + "-" + notice.version, createdAt: at, readAt: null,
      user } as Notice);
    return true;
  }
  async complete(user: string, at: string, ok: boolean, _sampled: number, created: number): Promise<void> {
    const previous = await this.getSettings(user);
    this.settings.set(user, { ...previous, lastCheckedAt: at, lastCheckOk: ok,
      nextCheckAt: new Date(Date.parse(at) + previous.intervalSeconds * 1000).toISOString() });
    this.checks.push({ user, ok, created });
  }
  async list(user: string, view: "all" | "unread", limit: number) {
    const mine = this.notices.filter(n => (n as Notice & {user:string}).user === user);
    return { unread: mine.filter(n=>!n.readAt).length,
      notifications: mine.filter(n=>view === "all" || !n.readAt).slice(0,limit) };
  }
  async read(user: string, id: string, at: string): Promise<boolean> {
    const item = this.notices.find(n => (n as Notice & {user:string}).user === user && n.id === id);
    if (!item) return false;
    item.readAt ??= at;
    return true;
  }
  async events(user: string, limit: number): Promise<Event[]> {
    return this.history.filter(e => e.id.startsWith(user)).slice(0, limit);
  }
}
const workflowId = "99999999-9999-4999-8999-999999999999";
const makeAlert = (version: number, status: Candidate["status"] = "FAILED") => ({
  workflowId, version, status, severity: status === "FAILED" ? "critical" : "attention"
});
function provider(alerts: ReturnType<typeof makeAlert>[]) {
  return {
    inbox: vi.fn(async () => ({
      scope: { sampled: 1 },
      alerts
    }))
  } as unknown as Pick<OperationalAlertService,"inbox">;
}
describe("CORTEX V10/V11 autonomous monitoring", () => {
  it("rejects unsafe configurations and unknown parameters", () => {
    expect(validateMonitorSettings({enabled:true,intervalSeconds:60,cooldownSeconds:600}))
      .toEqual({enabled:true,intervalSeconds:60,cooldownSeconds:600});
    for (const input of [
      {}, {enabled:"true",intervalSeconds:60,cooldownSeconds:600},
      {enabled:true,intervalSeconds:1,cooldownSeconds:600},
      {enabled:true,intervalSeconds:60.5,cooldownSeconds:600},
      {enabled:true,intervalSeconds:60,cooldownSeconds:0},
      {enabled:true,intervalSeconds:60,cooldownSeconds:600,runTools:true}
    ]) expect(() => validateMonitorSettings(input)).toThrow();
  });
  it("is disabled by default and obeys the persisted interval", async () => {
    const store = new MemoryMonitorRepository();
    const source = provider([makeAlert(1)]);
    const monitor = new AutonomousMonitoringService(
      store, source, "owner", new InAppNotificationChannel(store), () => new Date(store.now()));
    await monitor.checkDue();
    expect(source.inbox).not.toHaveBeenCalled();
    await store.configure("owner",true,60,600);
    await monitor.checkDue();
    await monitor.checkDue();
    expect(source.inbox).toHaveBeenCalledTimes(1);
    expect(store.notices).toHaveLength(1);
    expect(store.checks).toEqual([{user:"owner",ok:true,created:1}]);
  });
  it("serializes two replicas, deduplicates alerts, and isolates owners", async () => {
    const store = new MemoryMonitorRepository();
    const source = provider([makeAlert(1,"AWAITING_APPROVAL"),makeAlert(1)]);
    await store.configure("owner",true,60,600);
    const first = new AutonomousMonitoringService(store,source,"owner",
      new InAppNotificationChannel(store),()=>new Date(store.now()));
    const second = new AutonomousMonitoringService(store,source,"owner",
      new InAppNotificationChannel(store),()=>new Date(store.now()));
    await Promise.all([first.checkDue(), second.checkDue()]);
    expect(source.inbox).toHaveBeenCalledTimes(1);
    expect(store.notices).toHaveLength(2);
    await store.configure("other",true,60,600);
    const other = new AutonomousMonitoringService(store,source,"other",
      new InAppNotificationChannel(store),()=>new Date(store.now()));
    await other.checkDue();
    expect((await store.list("owner","all",100)).notifications).toHaveLength(2);
    expect((await store.list("other","all",100)).notifications).toHaveLength(2);
    expect(await store.read("other","owner-1",store.now())).toBe(false);
  });
  it("manual checks require opt-in and respect persisted rate limits", async () => {
    const store = new MemoryMonitorRepository();
    let time = Date.parse(store.now());
    const source = provider([makeAlert(1)]);
    const monitor = new AutonomousMonitoringService(store,source,"owner",
      new InAppNotificationChannel(store),()=>new Date(time));
    expect(await monitor.checkDue(true)).toEqual({ran:false,reason:"disabled"});
    await store.configure("owner",true,3600,600);
    expect((await monitor.checkDue()).ran).toBe(true);
    expect(await monitor.checkDue(true)).toEqual({ran:false,reason:"rate_limited"});
    time += 31_000;
    expect(await monitor.checkDue()).toEqual({ran:false,reason:"not_due"});
    expect((await monitor.checkDue(true)).ran).toBe(true);
    expect(source.inbox).toHaveBeenCalledTimes(2);
    expect(store.notices).toHaveLength(1);
  });
  it("records failed scans without persisting exception payloads", async () => {
    const store = new MemoryMonitorRepository();
    await store.configure("owner",true,60,600);
    const source: Pick<OperationalAlertService, "inbox"> = {
      inbox: vi.fn(async () => { throw new Error("SECRET-PAYLOAD"); })
    };
    const monitor = new AutonomousMonitoringService(store,source,"owner",
      new InAppNotificationChannel(store),()=>new Date(store.now()));
    await expect(monitor.checkDue()).rejects.toThrow("SECRET-PAYLOAD");
    expect(store.checks).toEqual([{user:"owner",ok:false,created:0}]);
    expect(JSON.stringify(store.checks)).not.toContain("SECRET-PAYLOAD");
  });
});
