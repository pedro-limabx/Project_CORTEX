import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { OperationalAlertService } from "../src/alerts/service.js";
import { AutonomousMonitoringService, InAppNotificationChannel } from "../src/autonomy/monitor.js";
import { PostgresMonitorRepository } from "../src/autonomy/store.js";

const available = Boolean(process.env.DATABASE_URL);
const suite = available ? describe : describe.skip;
const pool = available ? new Pool({ connectionString: process.env.DATABASE_URL }) : undefined;
const repo = pool ? new PostgresMonitorRepository(pool) : undefined;
afterAll(async () => { await pool?.end(); });

suite("CORTEX V10 PostgreSQL integration", () => {
  it("migrates tables; persists settings and enforces tenant scoping", async () => {
    if (!repo) throw new Error("PostgreSQL unavailable");
    await repo.initialize();
    const user = "v10-" + randomUUID();
    const other = "v10-" + randomUUID();
    expect((await repo.getSettings(user)).enabled).toBe(false);
    const settings = await repo.configure(user, true, 60, 600);
    expect(settings.enabled).toBe(true);
    const separate = new PostgresMonitorRepository(pool!);
    expect((await separate.getSettings(user)).intervalSeconds).toBe(60);
    expect((await separate.getSettings(other)).enabled).toBe(false);
    // Changing the frequency must reschedule an already-enabled monitor.
    await separate.configure(user,true,3600,600);
    await pool!.query(
      "UPDATE cortex_monitor_settings SET next_check_at = now() + interval '1 hour' WHERE user_id=$1",
      [user]
    );
    const accelerated = await separate.configure(user,true,60,600);
    expect(Date.parse(accelerated.nextCheckAt)).toBeLessThanOrEqual(Date.now()+5000);
    const ev = await separate.events(user,10);
    expect(ev[0]?.kind).toBe("SETTINGS_UPDATED");
    expect(await separate.events(other,10)).toHaveLength(0);
  });
  it("allows only one concurrent scan across independent instances", async () => {
    if (!repo || !pool) throw new Error("PostgreSQL unavailable");
    const user = "v10-" + randomUUID();
    await repo.configure(user,true,60,600);
    let scanned = 0;
    const id = randomUUID();
    const source = { inbox: async () => {
      scanned++;
      await new Promise(resolve=>setTimeout(resolve,75));
      return { scope:{sampled:1}, alerts:[{
        workflowId:id,version:1,status:"AWAITING_APPROVAL",severity:"attention",
        objective:"SECRET-OBJECTIVE",message:"SECRET-ERROR",input:"SECRET-INPUT"
      }] };
    } } as unknown as Pick<OperationalAlertService,"inbox">;
    const otherRepo = new PostgresMonitorRepository(pool);
    const a = new AutonomousMonitoringService(repo, source, user, new InAppNotificationChannel(repo));
    const b = new AutonomousMonitoringService(otherRepo, source, user, new InAppNotificationChannel(otherRepo));
    await Promise.all([a.checkDue(),b.checkDue()]);
    expect(scanned).toBe(1);
    const saved = await otherRepo.list(user,"all",50);
    expect(saved.notifications).toHaveLength(1);
    expect(saved.unread).toBe(1);
    expect(JSON.stringify(saved)).not.toContain("SECRET");
    expect((await otherRepo.list("other","all",50)).notifications).toHaveLength(0);
    const noticeId = saved.notifications[0]?.id;
    if (!noticeId) throw new Error("Expected notification id");
    expect(await otherRepo.read("other",noticeId,new Date().toISOString())).toBe(false);
    expect(await otherRepo.read(user,noticeId,new Date().toISOString())).toBe(true);
    expect(await otherRepo.read(user,noticeId,new Date().toISOString())).toBe(true);
    expect((await otherRepo.list(user,"unread",50)).notifications).toHaveLength(0);
    expect((await otherRepo.events(user,10)).some(e=>e.kind==="CHECK_COMPLETED")).toBe(true);
    const persistedSettings = await otherRepo.getSettings(user);
    expect(persistedSettings.lastCheckOk).toBe(true);
    expect(persistedSettings.lastCheckedAt).not.toBeNull();
  });
  it("prevents duplicate versions and respects cooldown across process restarts", async () => {
    if (!repo || !pool) throw new Error("PostgreSQL unavailable");
    const user = "v10-" + randomUUID();
    const id = randomUUID();
    const at = new Date().toISOString();
    await repo.configure(user,true,60,600);
    const candidate = { workflowId:id, version:1, status:"FAILED" as const, severity:"critical" as const };
    expect(await repo.insert(user,candidate,600,at)).toBe(true);
    expect(await repo.insert(user,candidate,600,at)).toBe(false);
    expect(await new PostgresMonitorRepository(pool).insert(user,{...candidate,version:2},600,at)).toBe(false);
    const oldTime = new Date(Date.parse(at)-3600000).toISOString();
    await pool.query("UPDATE cortex_persistent_notifications SET created_at=$2 WHERE user_id=$1",[user,oldTime]);
    expect(await repo.insert(user,{...candidate,version:2},600,at)).toBe(true);
    expect((await repo.list(user,"all",50)).notifications).toHaveLength(2);
    expect((await repo.events(user,50)).some(e=>e.kind==="SETTINGS_UPDATED")).toBe(true);
  });
});
