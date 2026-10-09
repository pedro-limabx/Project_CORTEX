import {describe,expect,it,afterAll} from "vitest";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {PostgresReminderRepository} from "../src/reminders/store.js";
import {PostgresRecurrenceRepository} from "../src/reminders/recurrence-store.js";
import {validateNewSchedule} from "../src/reminders/recurrence.js";
import {ReminderScheduler} from "../src/reminders/service.js";
const available=Boolean(process.env.DATABASE_URL);
const suite=available?describe:describe.skip;
const pool=available?new Pool({connectionString:process.env.DATABASE_URL}):undefined;
afterAll(async()=>{await pool?.end();});
suite("V15 transactional recurrence PostgreSQL",()=>{
  it("creates no duplicates across replicas, survives restart and skips missed flood",async()=>{
    if(!pool)throw new Error("PostgreSQL not configured");
    const reminders=new PostgresReminderRepository(pool),repo=new PostgresRecurrenceRepository(pool);
    await reminders.initialize();
    await repo.initialize();
    const user=randomUUID(),now=new Date("2026-10-09T16:00:00Z");
    const rule=await repo.create(user,validateNewSchedule({
      title:"Daily task",frequency:"DAILY",time:"07:00"
    },now),now.toISOString());
    expect((await repo.get(user,rule.id))?.status).toBe("ACTIVE");
    expect(await repo.list("other-user",10)).toEqual([]);
    const future="2026-10-14T16:00:00Z";
    const replica=new PostgresRecurrenceRepository(pool);
    const counts=await Promise.all([
      repo.generateDue(user,future,100),replica.generateDue(user,future,100)
    ]);
    expect(counts.reduce((a,b)=>a+b,0)).toBe(1);
    expect(await repo.generateDue(user,future,100)).toBe(0);
    const rows=await reminders.list(user,"all",100);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Daily task");
    const next=await repo.get(user,rule.id);
    expect(next?.nextDueAt).toBe("2026-10-15T10:00:00.000Z");
    const scheduler=new ReminderScheduler(reminders,user,()=>new Date(future),undefined,repo);
    await scheduler.checkDue();
    expect((await reminders.list(user,"due",100))).toHaveLength(1);
    expect(await reminders.dueCount(user)).toBe(1);
    await scheduler.stop();
  });
  it("pause, resume, cancel are owner-scoped and preserve previous occurrences",async()=>{
    if(!pool)throw new Error("PostgreSQL not configured");
    const repo=new PostgresRecurrenceRepository(pool),reminders=new PostgresReminderRepository(pool);
    await reminders.initialize();
    await repo.initialize();
    const user=randomUUID(),now="2026-10-09T16:00:00Z",future="2026-10-11T16:00:00Z";
    const schedule=await repo.create(user,validateNewSchedule({
      title:"Weekly Monday",frequency:"WEEKLY",time:"07:00",weekday:1
    },new Date(now)),now);
    expect(await repo.transition("other-user",schedule.id,"pause",now)).toBe(false);
    expect(await repo.transition(user,schedule.id,"pause",now)).toBe(true);
    expect(await repo.transition(user,schedule.id,"pause",now)).toBe(false);
    expect(await repo.generateDue(user,"2026-10-26T16:00:00Z",100)).toBe(0);
    expect(await repo.transition(user,schedule.id,"resume",future)).toBe(true);
    expect((await repo.get(user,schedule.id))?.nextDueAt).toBe("2026-10-12T10:00:00.000Z");
    expect(await repo.generateDue(user,"2026-10-12T10:01:00Z",100)).toBe(1);
    expect((await reminders.list(user,"all",100))).toHaveLength(1);
    expect(await repo.transition(user,schedule.id,"cancel","2026-10-13T00:00:00Z")).toBe(true);
    expect(await repo.transition(user,schedule.id,"resume","2026-10-13T00:00:00Z")).toBe(false);
    expect(await repo.generateDue(user,"2026-11-20T16:00:00Z",100)).toBe(0);
    expect((await reminders.list(user,"all",100))).toHaveLength(1);
  });
});
