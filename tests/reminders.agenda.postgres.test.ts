import {describe,expect,it,afterAll} from "vitest";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {PostgresReminderRepository} from "../src/reminders/store.js";
import {PostgresRecurrenceRepository} from "../src/reminders/recurrence-store.js";
import {validateNewSchedule} from "../src/reminders/recurrence.js";
import {readAgenda} from "../src/reminders/agenda.js";
const available=Boolean(process.env.DATABASE_URL);
const suite=available?describe:describe.skip;
const pool=available?new Pool({connectionString:process.env.DATABASE_URL}):undefined;
afterAll(async()=>{await pool?.end();});
suite("V16 agenda queries with PostgreSQL",()=>{
  it("scopes reminders and schedule projections by owner, date and status",async()=>{
    if(!pool)throw new Error("PostgreSQL required");
    const reminders=new PostgresReminderRepository(pool);
    const recurrences=new PostgresRecurrenceRepository(pool);
    await reminders.initialize();
    await recurrences.initialize();
    const owner=randomUUID(),other=randomUUID();
    const now=new Date("2026-10-09T16:00:00.000Z");
    const included=await reminders.create(owner,"Minha reunião","2026-10-09T20:00:00Z",now.toISOString());
    const tomorrow=await reminders.create(owner,"Minha entrega","2026-10-10T16:00:00Z",now.toISOString());
    const archived=await reminders.create(owner,"Já concluída","2026-10-09T19:00:00Z",now.toISOString());
    expect(await reminders.transition(owner,archived.id,"DONE",now.toISOString())).toBe(true);
    await reminders.create(other,"SEGREDO DE OUTRO USUÁRIO","2026-10-09T17:00:00Z",now.toISOString());
    await recurrences.create(owner,validateNewSchedule({
      title:"Rotina diária",frequency:"DAILY",time:"07:00"
    },now),now.toISOString());
    await recurrences.create(other,validateNewSchedule({
      title:"ROTINA SECRETA",frequency:"DAILY",time:"07:00"
    },now),now.toISOString());
    const deps={reminders,recurrences};
    const today=await readAgenda(deps,owner,"today",now);
    expect(today.counts).toEqual({saved:1,projected:0});
    expect(today.items.map(x=>x.id)).toEqual([included.id]);
    expect(today.items.map(x=>x.title).join(" ")).not.toContain("SEGREDO");
    expect(today.items.map(x=>x.title).join(" ")).not.toContain("concluída");
    const next=await readAgenda(deps,owner,"tomorrow",now);
    expect(next.items.some(x=>x.id===tomorrow.id)).toBe(true);
    expect(next.items.some(x=>x.source==="recurrence-preview")).toBe(true);
    expect(next.items.map(x=>x.title).join(" ")).not.toContain("ROTINA SECRETA");
    expect((await reminders.listWindow(owner,"2026-10-09T03:00:00Z",
      "2026-10-10T03:00:00Z",20)).map(x=>x.id)).toEqual([included.id]);
    expect(await recurrences.listActive(other,10)).toHaveLength(1);
  });
  it("does not write data when preparing a read-only agenda view",async()=>{
    if(!pool)throw new Error("PostgreSQL required");
    const reminders=new PostgresReminderRepository(pool);
    const recurrences=new PostgresRecurrenceRepository(pool);
    await reminders.initialize();
    await recurrences.initialize();
    const owner=randomUUID(),now=new Date("2026-10-09T16:00:00Z");
    const schedule=await recurrences.create(owner,validateNewSchedule({
      title:"Projeção ainda não criada",frequency:"DAILY",time:"07:00"
    },now),now.toISOString());
    const before=await reminders.list(owner,"all",100);
    const result=await readAgenda({reminders,recurrences},owner,"week",now);
    const after=await reminders.list(owner,"all",100);
    expect(before).toEqual([]);
    expect(after).toEqual([]);
    expect(result.items.filter(x=>x.source==="recurrence-preview")).toHaveLength(6);
    expect((await recurrences.get(owner,schedule.id))?.nextDueAt).toBe(schedule.nextDueAt);
  });
});
