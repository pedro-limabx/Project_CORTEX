import {describe,expect,it,afterAll} from "vitest";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {PostgresReminderRepository} from "../src/reminders/store.js";

const available=Boolean(process.env.DATABASE_URL);
const suite=available?describe:describe.skip;
const pool=available?new Pool({connectionString:process.env.DATABASE_URL}):undefined;
afterAll(async()=>{await pool?.end();});

suite("CORTEX V12 PostgreSQL reminders",()=>{
  it("persists creation, verifies owner isolation and protects state transitions",async()=>{
    if(!pool) throw new Error("PostgreSQL unavailable");
    const repo=new PostgresReminderRepository(pool);
    await repo.initialize();
    const owner="rem-"+randomUUID(), outsider="rem-"+randomUUID();
    const now="2026-10-08T16:00:00.000Z",due="2026-10-08T16:05:00.000Z";
    const created=await repo.create(owner,"Personal reminder",due,now);
    expect(created).toMatchObject({title:"Personal reminder",status:"PENDING",triggeredAt:null});
    expect((await new PostgresReminderRepository(pool).get(owner,created.id))?.id).toBe(created.id);
    expect(await repo.get(outsider,created.id)).toBeNull();
    expect(await repo.list(outsider,"all",10)).toEqual([]);
    expect(await repo.transition(outsider,created.id,"DONE",now)).toBe(false);
    expect(await repo.markDue(owner,"2026-10-08T16:04:00.000Z",100)).toBe(0);
    expect(await repo.markDue(owner,due,100)).toBe(1);
    expect((await repo.get(owner,created.id))?.status).toBe("DUE");
    expect(await repo.dueCount(owner)).toBe(1);
    expect(await repo.transition(owner,created.id,"DONE",due)).toBe(true);
    expect(await repo.transition(owner,created.id,"CANCELLED",due)).toBe(false);
    expect(await repo.dueCount(owner)).toBe(0);
    expect((await repo.list(owner,"done",10)).map(x=>x.id)).toContain(created.id);
  });

  it("avoids duplicate notices across concurrent replicas and recovers overdue items",async()=>{
    if(!pool) throw new Error("PostgreSQL unavailable");
    const repo=new PostgresReminderRepository(pool),replica=new PostgresReminderRepository(pool);
    await repo.initialize();
    const user="rem-"+randomUUID(),now="2026-10-08T16:00:00.000Z";
    const a=await repo.create(user,"A","2026-10-08T16:01:00.000Z",now);
    const b=await repo.create(user,"B","2026-10-08T16:02:00.000Z",now);
    const results=await Promise.all([
      repo.markDue(user,"2026-10-08T16:04:00.000Z",100),
      replica.markDue(user,"2026-10-08T16:04:00.000Z",100)
    ]);
    expect(results[0]!+results[1]!).toBe(2);
    expect(await replica.markDue(user,"2026-10-08T16:04:00.000Z",100)).toBe(0);
    expect((await repo.list(user,"due",20)).map(x=>x.id).sort()).toEqual([a.id,b.id].sort());
    expect(await repo.transition(user,a.id,"CANCELLED",now)).toBe(true);
    expect((await repo.list(user,"all",20)).length).toBe(2);
    expect(await repo.dueCount(user)).toBe(1);
  });
});
