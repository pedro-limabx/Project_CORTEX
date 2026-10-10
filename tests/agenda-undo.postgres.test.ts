import {describe,it,expect,afterAll} from "vitest";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {PostgresReminderRepository} from "../src/reminders/store.js";
import {PostgresAgendaProposalStore} from "../src/integrations/agenda-proposal-store.js";
import type {PlanDraft} from "../src/integrations/agenda-reorganization.js";
const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL}):null;
const suite=pool?describe:describe.skip;
afterAll(async()=>{await pool?.end();});
const future=(minutes:number)=>new Date(Date.now()+minutes*60_000).toISOString();
async function setup(user:string){
  if(!pool)throw new Error("PostgreSQL required");
  const reminders=new PostgresReminderRepository(pool);
  const proposals=new PostgresAgendaProposalStore(pool);
  await Promise.all([reminders.initialize(),proposals.initialize()]);
  const original=future(120),proposed=future(160);
  const reminder=await reminders.create(user,"Registro de auditoria",original,new Date().toISOString());
  const draft:PlanDraft={period:"today",targetId:"cortex:"+reminder.id,
    conflictKey:"a".repeat(32),title:reminder.title,source:"cortex",
    originalStart:original,originalEnd:null,
    proposedStart:proposed,proposedEnd:null};
  const created=await proposals.create(user,draft);
  const approved=await proposals.review(user,created.id,"approve");
  if(!approved)throw new Error("Approval failed");
  const applied=await proposals.applyInternalReminder(user,approved.id,approved);
  if(!applied)throw new Error("Apply failed");
  return {reminders,proposals,reminder,applied:applied.proposal,original,proposed};
}
suite("V24 PostgreSQL change history and transactional undo",()=>{
  it("preserves V23 history, restores the original time and marks REVERTED once",async()=>{
    const user=randomUUID();
    const {reminders,proposals,reminder,applied,original,proposed}=await setup(user);
    const history=await proposals.listChangeHistory(user,50);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({id:applied.id,status:"APPLIED",
      originalStart:original,proposedStart:proposed,externalChangeApplied:false});
    expect((await proposals.listChangeHistory(randomUUID(),50))).toEqual([]);
    const result=await proposals.undoInternalReminder(user,applied.id,applied);
    expect(result).toMatchObject({proposal:{status:"REVERTED",
      externalChangeApplied:false},reminder:{id:reminder.id,
        previousDueAt:proposed,dueAt:original}});
    expect(result?.proposal.revertedAt).toEqual(expect.any(String));
    expect((await reminders.get(user,reminder.id))?.dueAt).toBe(original);
    expect(await proposals.undoInternalReminder(user,applied.id,applied)).toBeNull();
    expect((await proposals.listChangeHistory(user,50))[0]?.status).toBe("REVERTED");
  });
  it("serializes two simultaneous undo confirmations",async()=>{
    if(!pool)throw new Error("PostgreSQL required");
    const user=randomUUID(),s=await setup(user);
    const second=new PostgresAgendaProposalStore(pool);
    const outcomes=await Promise.all([
      s.proposals.undoInternalReminder(user,s.applied.id,s.applied),
      second.undoInternalReminder(user,s.applied.id,s.applied)
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect((await s.reminders.get(user,s.reminder.id))?.dueAt).toBe(s.original);
  });
  it("refuses wrong owner, changed/completed reminder and new reminder collision",async()=>{
    const user=randomUUID(),s=await setup(user);
    expect(await s.proposals.undoInternalReminder(randomUUID(),s.applied.id,s.applied)).toBeNull();
    expect(await s.proposals.undoInternalReminder(user,s.applied.id,
      {...s.applied,originalStart:future(700)})).toBeNull();
    await s.reminders.create(user,"Collision",s.original,new Date().toISOString());
    expect(await s.proposals.undoInternalReminder(user,s.applied.id,s.applied)).toBeNull();
    expect((await s.reminders.get(user,s.reminder.id))?.dueAt).toBe(s.proposed);
    const otherUser=randomUUID(),other=await setup(otherUser);
    expect(await other.reminders.transition(otherUser,other.reminder.id,
      "DONE",new Date().toISOString())).toBe(true);
    expect(await other.proposals.undoInternalReminder(otherUser,other.applied.id,other.applied))
      .toBeNull();
  });
  it("blocks after the undo deadline without changing the reminder",async()=>{
    if(!pool)throw new Error("PostgreSQL required");
    const user=randomUUID(),s=await setup(user);
    const old=new Date(Date.now()-31*60_000).toISOString();
    await pool.query([
      "UPDATE cortex_agenda_proposals SET",
      "state=jsonb_set(state,'{appliedAt}',to_jsonb($2::text))",
      "WHERE id=$1::uuid"
    ].join(" "),[s.applied.id,old]);
    const historic=await s.proposals.get(user,s.applied.id);
    expect(historic).not.toBeNull();
    expect(await s.proposals.undoInternalReminder(user,s.applied.id,historic!))
      .toBeNull();
    expect((await s.reminders.get(user,s.reminder.id))?.dueAt).toBe(s.proposed);
    expect((await s.proposals.get(user,s.applied.id))?.status).toBe("APPLIED");
  });
  it("does not expose or modify a plan for Google-only events",async()=>{
    if(!pool)throw new Error("PostgreSQL required");
    const user=randomUUID(),proposals=new PostgresAgendaProposalStore(pool);
    await proposals.initialize();
    const created=await proposals.create(user,{period:"week",title:"Google only",
      conflictKey:"b".repeat(32),targetId:"google:external-id",source:"google",
      originalStart:future(180),originalEnd:future(240),
      proposedStart:future(300),proposedEnd:future(360)});
    expect(await proposals.undoInternalReminder(user,created.id,created)).toBeNull();
    expect(await proposals.listChangeHistory(user,30)).toEqual([]);
  });
});
