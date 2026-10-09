import {describe,it,expect,afterAll} from "vitest";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {PostgresAgendaProposalStore} from "../src/integrations/agenda-proposal-store.js";
import type {PlanDraft} from "../src/integrations/agenda-reorganization.js";
const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL}):null;
const suite=pool?describe:describe.skip;
afterAll(async()=>{await pool?.end();});
const draft:PlanDraft={
  period:"tomorrow",conflictKey:"a".repeat(32),targetId:"google:an-event",
  title:"Revisão de projeto",source:"google",
  originalStart:"2026-10-10T14:00:00.000Z",
  originalEnd:"2026-10-10T15:00:00.000Z",
  proposedStart:"2026-10-10T12:00:00.000Z",
  proposedEnd:"2026-10-10T13:00:00.000Z"
};
suite("V22 persisted manual decisions (PostgreSQL)",()=>{
  it("records approval exactly once across concurrent requests and never modifies events",async()=>{
    if(!pool)throw new Error("Missing PostgreSQL");
    const store=new PostgresAgendaProposalStore(pool),user=randomUUID();
    await Promise.all([store.initialize(),new PostgresAgendaProposalStore(pool).initialize()]);
    const proposal=await store.create(user,draft);
    expect(proposal).toMatchObject({status:"PENDING_REVIEW",expired:false,
      externalChangeApplied:false,originalStart:draft.originalStart,
      proposedStart:draft.proposedStart});
    expect(await store.list(randomUUID(),30)).toEqual([]);
    expect(await store.get(randomUUID(),proposal.id)).toBeNull();
    const [one,two]=await Promise.all([
      store.review(user,proposal.id,"approve"),
      new PostgresAgendaProposalStore(pool).review(user,proposal.id,"reject")
    ]);
    expect([one,two].filter(Boolean)).toHaveLength(1);
    const saved=await store.get(user,proposal.id);
    expect(saved?.status).toBe(one?"APPROVED":"REJECTED");
    expect(saved?.reviewedAt).not.toBeNull();
    expect(saved?.externalChangeApplied).toBe(false);
    expect(await store.review(user,proposal.id,"approve")).toBeNull();
    expect(await store.list(user,30)).toHaveLength(1);
  });
  it("rejects expired, missing and other-user decisions",async()=>{
    if(!pool)throw new Error("Missing PostgreSQL");
    const store=new PostgresAgendaProposalStore(pool),user=randomUUID();
    await store.initialize();
    const proposal=await store.create(user,draft);
    expect(await store.review(randomUUID(),proposal.id,"approve")).toBeNull();
    expect(await store.review(user,randomUUID(),"reject")).toBeNull();
    await pool.query("UPDATE cortex_agenda_proposals SET expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1",[proposal.id]);
    expect((await store.get(user,proposal.id))?.expired).toBe(true);
    expect(await store.review(user,proposal.id,"approve")).toBeNull();
    expect((await store.get(user,proposal.id))?.status).toBe("PENDING_REVIEW");
  });
});
