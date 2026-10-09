import {describe,expect,it,vi} from "vitest";
import {
  agendaWindow,interpretAgendaQuestion,readAgenda,agendaAnswer
} from "../src/reminders/agenda.js";
import type {Reminder} from "../src/reminders/store.js";
import type {RecurringSchedule} from "../src/reminders/recurrence-store.js";

const now=new Date("2026-10-09T16:00:00.000Z"); // Friday, Oct 9 13:00 São Paulo
describe("V16 deterministic agenda window and queries",()=>{
  it("parses only explicit questions without hijacking ordinary NEURON chat",()=>{
    expect(interpretAgendaQuestion("Quais são meus lembretes de hoje?")).toBe("today");
    expect(interpretAgendaQuestion("O que tenho agendado amanhã?")).toBe("tomorrow");
    expect(interpretAgendaQuestion("Minha agenda da semana")).toBe("week");
    expect(interpretAgendaQuestion("Mostre minha agenda para os próximos 7 dias")).toBe("week");
    expect(interpretAgendaQuestion("Quais são meus compromissos amanhã?")).toBe("tomorrow");
    expect(interpretAgendaQuestion("Quais são meus lembretes?")).toBe("today");
    expect(interpretAgendaQuestion("Quero criar um lembrete para amanhã")).toBeNull();
    expect(interpretAgendaQuestion("Explique como funciona uma agenda")).toBeNull();
    expect(interpretAgendaQuestion("Quais são meus lembretes vencidos?")).toBeNull();
    expect(interpretAgendaQuestion("Quanto é 25*18?")).toBeNull();
  });
  it("uses São Paulo civil days instead of the server OS timezone",()=>{
    expect(agendaWindow("today",now)).toEqual({
      from:"2026-10-09T03:00:00.000Z",until:"2026-10-10T03:00:00.000Z"
    });
    expect(agendaWindow("tomorrow",now)).toEqual({
      from:"2026-10-10T03:00:00.000Z",until:"2026-10-11T03:00:00.000Z"
    });
    expect(agendaWindow("week",now)).toEqual({
      from:"2026-10-09T03:00:00.000Z",until:"2026-10-16T03:00:00.000Z"
    });
    expect(agendaWindow("today",new Date("2026-12-31T23:59:00Z"))).toEqual({
      from:"2026-12-31T03:00:00.000Z",until:"2027-01-01T03:00:00.000Z"
    });
  });
  it("separates saved reminders from unmaterialized recurring occurrences",async()=>{
    const stored:Reminder={
      id:"saved-id",title:"Enviar relatório",status:"PENDING",
      dueAt:"2026-10-09T18:00:00.000Z",createdAt:now.toISOString(),
      triggeredAt:null,completedAt:null,cancelledAt:null
    };
    const active:RecurringSchedule={
      id:"rule-id",title:"Verificar agenda",frequency:"DAILY",weekday:null,
      localTime:"07:00",timeZone:"America/Sao_Paulo",status:"ACTIVE",
      nextDueAt:"2026-10-10T10:00:00.000Z",createdAt:now.toISOString(),
      pausedAt:null,cancelledAt:null
    };
    const listWindow=vi.fn(async()=>[stored]);
    const listActive=vi.fn(async()=>[active]);
    const result=await readAgenda({reminders:{listWindow},recurrences:{listActive}},
      "owner","week",now);
    expect(listWindow).toHaveBeenCalledWith("owner",
      "2026-10-09T03:00:00.000Z","2026-10-16T03:00:00.000Z",101);
    expect(listActive).toHaveBeenCalledWith("owner",101);
    expect(result.readOnly).toBe(true);
    expect(result.counts).toEqual({saved:1,projected:6});
    expect(result.items[0]).toMatchObject({
      id:"saved-id",title:"Enviar relatório",source:"saved",status:"PENDING"
    });
    expect(result.items[1]).toMatchObject({
      id:"rule-id:2026-10-10T10:00:00.000Z",
      source:"recurrence-preview",status:"PROJECTED"
    });
    expect(result.items).toHaveLength(7);
    expect(agendaAnswer(result)).toContain("recorrência prevista");
    expect(result.truncated).toBe(false);
  });
  it("limits output and marks that the data is partial",async()=>{
    const base="2026-10-09T14:00:00.000Z";
    const reminders:Array<Reminder>=Array.from({length:32},(_,i)=>({
      id:"id-"+i,title:"Teste "+i,status:"PENDING",
      dueAt:new Date(Date.parse(base)+i*60_000).toISOString(),
      createdAt:now.toISOString(),triggeredAt:null,completedAt:null,cancelledAt:null
    }));
    const result=await readAgenda({
      reminders:{listWindow:async()=>reminders},
      recurrences:{listActive:async()=>[]}
    },"owner","today",now);
    expect(result.items).toHaveLength(30);
    expect(result.truncated).toBe(true);
    expect(agendaAnswer(result)).toContain("lista foi limitada");
  });
});
