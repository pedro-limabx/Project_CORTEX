import {afterAll,describe,expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {PostgresReminderRepository} from "../src/reminders/store.js";
import {PostgresAgendaProposalStore} from "../src/integrations/agenda-proposal-store.js";
import type {PlanDraft} from "../src/integrations/agenda-reorganization.js";

const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL}):null;
const suite=pool?describe:describe.skip;
afterAll(async()=>{await pool?.end();});
const future=(minutes:number)=>new Date(Date.now()+minutes*60_000).toISOString();
async function setup(user:string) {
  if(!pool)throw new Error("PostgreSQL unavailable");
  const reminders=new PostgresReminderRepository(pool);
  const proposals=new PostgresAgendaProposalStore(pool);
  await reminders.initialize();
  await proposals.initialize(); // includes migration from V22 CHECK constraint
  const original=future(120),alternative=future(150);
  const reminder=await reminders.create(user,"Preparar orçamento",original,future(0));
  const draft:PlanDraft={
    period:"today",conflictKey:"a".repeat(32),targetId:"cortex:"+reminder.id,
    title:reminder.title,source:"cortex",originalStart:original,originalEnd:null,
    proposedStart:alternative,proposedEnd:null
  };
  const candidate=await proposals.create(user,draft);
  const approved=await proposals.review(user,candidate.id,"approve");
  if(!approved)throw new Error("Could not approve plan");
  return {reminders,proposals,reminder,approved,original,alternative};
}
suite("V23 atomic application in PostgreSQL",()=>{
  it("moves one PENDING reminder and records APPLIED atomically, never on replay",async()=>{
    const user=randomUUID(),{reminders,proposals,reminder,approved,original,alternative}
      =await setup(user);
    expect((await reminders.get(user,reminder.id))?.dueAt).toBe(original);
    const result=await proposals.applyInternalReminder(user,approved.id,approved);
    expect(result).toMatchObject({
      reminder:{id:reminder.id,title:reminder.title,previousDueAt:original,dueAt:alternative},
      proposal:{status:"APPLIED",externalChangeApplied:false}
    });
    expect(result?.proposal.appliedAt).toEqual(expect.any(String));
    expect((await reminders.get(user,reminder.id))?.dueAt).toBe(alternative);
    expect(await proposals.applyInternalReminder(user,approved.id,approved)).toBeNull();
    expect((await proposals.get(user,approved.id))?.status).toBe("APPLIED");
  });
  it("prevents concurrent double application across repository instances",async()=>{
    if(!pool)throw new Error("Postgres unavailable");
    const user=randomUUID(),{proposals,approved,reminders,reminder,alternative}=await setup(user);
    const second=new PostgresAgendaProposalStore(pool);
    const outcomes=await Promise.all([
      proposals.applyInternalReminder(user,approved.id,approved),
      second.applyInternalReminder(user,approved.id,approved)
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect((await reminders.get(user,reminder.id))?.dueAt).toBe(alternative);
  });
  it("refuses other owners, changed dates, completed reminders and expired plans",async()=>{
    const user=randomUUID(),{proposals,approved,reminders,reminder,original}=await setup(user);
    expect(await proposals.applyInternalReminder(randomUUID(),approved.id,approved)).toBeNull();
    expect(await proposals.applyInternalReminder(user,approved.id,
      {...approved,originalStart:future(350)})).toBeNull();
    expect(await reminders.transition(user,reminder.id,"DONE",new Date().toISOString())).toBe(true);
    expect(await proposals.applyInternalReminder(user,approved.id,approved)).toBeNull();
    expect((await proposals.get(user,approved.id))?.status).toBe("APPROVED");
    expect((await reminders.get(user,reminder.id))?.dueAt).toBe(original);
    const second=await setup(randomUUID());
    if(!pool)throw new Error("Postgres unavailable");
    await pool.query("UPDATE cortex_agenda_proposals SET expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1",
      [second.approved.id]);
    expect(await second.proposals.applyInternalReminder(second.reminder.id,
      second.approved.id,second.approved)).toBeNull();
  });
  it("refuses to occupy another persisted reminder in a 30-minute candidate window",async()=>{
    const user=randomUUID(),{proposals,approved,reminders,alternative,reminder}=await setup(user);
    await reminders.create(user,"Outro compromisso",alternative,new Date().toISOString());
    expect(await proposals.applyInternalReminder(user,approved.id,approved)).toBeNull();
    expect((await reminders.get(user,reminder.id))?.dueAt).toBe(approved.originalStart);
    expect((await proposals.get(user,approved.id))?.status).toBe("APPROVED");
  });
  it("never applies a Google-only proposal even if it is approved",async()=>{
    if(!pool)throw new Error("Postgres unavailable");
    const user=randomUUID(),proposals=new PostgresAgendaProposalStore(pool);
    await proposals.initialize();
    const created=await proposals.create(user,{
      period:"today",conflictKey:"b".repeat(32),targetId:"google:external-id",
      title:"Event only in Google",source:"google",originalStart:future(120),
      originalEnd:future(180),proposedStart:future(240),proposedEnd:future(300)
    });
    const approved=await proposals.review(user,created.id,"approve");
    expect(approved).not.toBeNull();
    expect(await proposals.applyInternalReminder(user,created.id,approved!)).toBeNull();
    expect((await proposals.get(user,created.id))?.status).toBe("APPROVED");
  });
});
