import {afterAll,describe,expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {PostgresReminderRepository} from "../src/reminders/store.js";
import {PostgresAgendaProposalStore} from "../src/integrations/agenda-proposal-store.js";
import {PostgresMonitorRepository} from "../src/autonomy/store.js";
import {PostgresAuditStore} from "../src/audit/postgres-store.js";
import {PostgresActivityFeed} from "../src/activity/feed.js";

const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL}):null;
const suite=pool?describe:describe.skip;
afterAll(async()=>{await pool?.end();});

suite("V25 PostgreSQL activity feed (owner-scoped, durable and read-only)",()=>{
  it("merges all four durable categories with exact lifecycle events and no secret error details",async()=>{
    if(!pool)throw new Error("PostgreSQL required");
    const reminders=new PostgresReminderRepository(pool);
    const proposals=new PostgresAgendaProposalStore(pool);
    const monitor=new PostgresMonitorRepository(pool);
    const audit=new PostgresAuditStore(pool);
    await reminders.initialize();
    await proposals.initialize();
    await monitor.initialize();
    await audit.initialize();
    const feed=new PostgresActivityFeed(pool);
    const owner=randomUUID(),stranger=randomUUID(),now=Date.now();
    const iso=(mins:number)=>new Date(now+mins*60_000).toISOString();
    const reminder=await reminders.create(owner,"Lembrete privado",iso(-45),iso(-60));
    expect(await reminders.markDue(owner,iso(-40),5)).toBe(1);
    expect(await reminders.transition(owner,reminder.id,"DONE",iso(-30))).toBe(true);
    const other=await reminders.create(stranger,"NUNCA MOSTRAR OUTRO USUÁRIO",iso(100),iso(-5));
    const plan=await proposals.create(owner,{
      period:"today",conflictKey:"a".repeat(32),targetId:"cortex:"+reminder.id,
      source:"cortex",title:"Ajustar agenda privada",originalStart:iso(70),
      originalEnd:null,proposedStart:iso(90),proposedEnd:null
    },new Date(now-4*60_000));
    expect(await proposals.review(owner,plan.id,"approve")).not.toBeNull();
    const workflowId=randomUUID();
    expect(await monitor.insert(owner,{
      workflowId,version:1,status:"FAILED",severity:"critical"
    },60,iso(-8))).toBe(true);
    const notices=await monitor.list(owner,"all",5);
    const notice=notices.notifications[0]!;
    expect(notice).toBeDefined();
    expect(await monitor.read(owner,notice.id,iso(-6))).toBe(true);
    const auditId=randomUUID();
    await pool.query([
      "INSERT INTO neuron_audit_events",
      "(id,user_id,request_id,tool,ok,requires_approval,error,created_at)",
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)"
    ].join(" "),[auditId,owner,randomUUID(),"calculator.evaluate",false,
      false,"SENSITIVE_ERROR_DO_NOT_EXPOSE",iso(-2)]);
    const snapshot=await feed.list(owner,"all",100);
    expect(snapshot.readOnly).toBe(true);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.entries.map(x=>x.category)).toEqual(expect.arrayContaining(
      ["reminders","agenda","notifications","tools"]));
    expect(snapshot.entries.filter(x=>x.category==="reminders")
      .map(x=>x.status).sort()).toEqual(["CREATED","DONE","DUE"]);
    expect(snapshot.entries.filter(x=>x.category==="agenda")
      .map(x=>x.status).sort()).toEqual(["APPROVED","PENDING_REVIEW"]);
    expect(snapshot.entries.filter(x=>x.category==="notifications")
      .map(x=>x.status).sort()).toEqual(["CREATED","READ"]);
    expect(snapshot.entries.filter(x=>x.category==="tools")
      .map(x=>x.status)).toEqual(["FAILED"]);
    expect(snapshot.entries).toHaveLength(8);
    expect(snapshot.entries.every(x=>x.source==="cortex")).toBe(true);
    expect(snapshot.entries.every((x,i,all)=>i===0||
      all[i-1]!.occurredAt>=x.occurredAt)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("SENSITIVE_ERROR_DO_NOT_EXPOSE");
    expect(JSON.stringify(snapshot)).not.toContain(other.title);
    const only=await feed.list(owner,"agenda",10);
    expect(only.entries.every(x=>x.category==="agenda")).toBe(true);
    expect(only.entries).toHaveLength(2);
    expect((await feed.list(stranger,"all",100)).entries.some(x=>
      x.description.includes("Lembrete privado"))).toBe(false);
    const capped=await feed.list(owner,"all",2);
    expect(capped.entries).toHaveLength(2);
    expect(capped.truncated).toBe(true);
    const repeat=await feed.list(owner,"all",100);
    expect(repeat.entries).toEqual(snapshot.entries); // no side effects
  });
  it("returns empty, bounded results for an owner with no events",async()=>{
    if(!pool)throw new Error("PostgreSQL required");
    const feed=new PostgresActivityFeed(pool);
    const fresh=await feed.list(randomUUID(),"all",10);
    expect(fresh.entries).toEqual([]);
    expect(fresh.truncated).toBe(false);
  });
});
