import {afterAll,describe,expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {PostgresReminderRepository} from "../src/reminders/store.js";
import {PostgresAgendaProposalStore} from "../src/integrations/agenda-proposal-store.js";
import {computePriorities,type PriorityDependencies} from "../src/priorities/service.js";

const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL}):null;
const suite=pool?describe:describe.skip;
afterAll(async()=>{await pool?.end();});
suite("V26 owner-scoped priorities with PostgreSQL",()=>{
  it("exposes only the owner's due reminders and reviewable plans, without state changes",async()=>{
    if(!pool)throw new Error("PostgreSQL required");
    const reminders=new PostgresReminderRepository(pool);
    const proposals=new PostgresAgendaProposalStore(pool);
    await reminders.initialize();
    await proposals.initialize();
    const owner=randomUUID(),other=randomUUID();
    const now=new Date(),due=new Date(now.getTime()-15*60_000).toISOString();
    const created=new Date(now.getTime()-30*60_000).toISOString();
    const owned=await reminders.create(owner,"Conferir comprovante",due,created);
    const hidden=await reminders.create(other,"DADO DE OUTRO USUÁRIO",due,created);
    expect(await reminders.markDue(owner,now.toISOString(),10)).toBe(1);
    expect(await reminders.markDue(other,now.toISOString(),10)).toBe(1);
    const proposal=await proposals.create(owner,{
      period:"tomorrow",conflictKey:"a".repeat(32),
      targetId:"cortex:"+owned.id,title:"Ajustar horário",source:"cortex",
      originalStart:new Date(now.getTime()+90*60_000).toISOString(),
      originalEnd:null,proposedStart:new Date(now.getTime()+120*60_000).toISOString(),
      proposedEnd:null
    });
    const deps={reminders,proposals,alerts:{
      inbox:async()=>({alerts:[],scope:{sampled:0,limit:100,isAllTime:false}})
    }} as unknown as PriorityDependencies;
    const snapshot=await computePriorities(deps,owner,"all",20,now);
    expect(snapshot.items.map(x=>x.kind)).toEqual(["reminder","decision"]);
    expect(snapshot.items[0]?.referenceId).toBe(owned.id);
    expect(snapshot.items[1]?.referenceId).toBe(proposal.id);
    expect(JSON.stringify(snapshot)).not.toContain(hidden.title);
    expect(snapshot.actionExecuted).toBe(false);
    expect((await reminders.get(owner,owned.id))?.status).toBe("DUE");
    expect((await proposals.get(owner,proposal.id))?.status).toBe("PENDING_REVIEW");
    const isolated=await computePriorities(deps,randomUUID(),"all",20,now);
    expect(isolated.items).toEqual([]);
  });
});
