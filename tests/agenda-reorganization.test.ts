import {describe,expect,it} from "vitest";
import {
  agendaConflictKey,draftAgendaPlan,PlanConflictError,PlanInputError
} from "../src/integrations/agenda-reorganization.js";
import type {ConflictReport,AgendaConflict} from "../src/integrations/agenda-conflicts.js";
import type {UnifiedAgenda,UnifiedItem} from "../src/integrations/unified-agenda.js";
const now=new Date("2026-10-09T16:00:00.000Z");
const target:UnifiedItem={id:"google:second",title:"Reunião equipe",
  start:"2026-10-10T14:30:00.000Z",end:"2026-10-10T15:30:00.000Z",
  allDay:false,sources:["google"]};
const first:UnifiedItem={id:"google:first",title:"Planejamento",
  start:"2026-10-10T14:00:00.000Z",end:"2026-10-10T15:00:00.000Z",
  allDay:false,sources:["google"]};
const internal:UnifiedItem={id:"cortex:reminder",title:"Enviar orçamento",
  start:"2026-10-10T14:45:00.000Z",allDay:false,sources:["cortex"],
  cortexKind:"saved",cortexStatus:"PENDING"};
const conflict:AgendaConflict={kind:"event-overlap",severity:"confirmed",
  first:{id:first.id,title:first.title,source:"google"},
  second:{id:target.id,title:target.title,source:"google"},
  at:"2026-10-10T14:30:00.000Z",until:"2026-10-10T15:00:00.000Z",
  explanation:"Eventos coincidem"};
const report:ConflictReport={
  period:"tomorrow",timeZone:"America/Sao_Paulo",google:"connected",readOnly:true,
  truncated:false,examined:{items:3,timedEvents:2,instantReminders:1,
    allDay:0,unknownDuration:0},conflicts:[conflict],suggestions:[],warnings:[]
};
const agenda:UnifiedAgenda={
  period:"tomorrow",timeZone:"America/Sao_Paulo",
  from:"2026-10-10T03:00:00.000Z",until:"2026-10-11T03:00:00.000Z",
  google:"connected",readOnly:true,items:[first,target,internal],
  totals:{cortex:1,google:2,matched:0,displayed:3},truncated:false,warnings:[]
};
describe("V22 supervised agenda reorganization planning",()=>{
  it("has a stable key based on a real conflict, not user-provided titles",()=>{
    expect(agendaConflictKey(conflict)).toMatch(/^[0-9a-f]{32}$/);
    expect(agendaConflictKey(conflict)).toBe(agendaConflictKey({...conflict}));
    expect(agendaConflictKey({...conflict,at:"2026-10-10T14:45:00.000Z"}))
      .not.toBe(agendaConflictKey(conflict));
  });
  it("preserves the original Google event duration and never trusts proposed slots from client",()=>{
    const draft=draftAgendaPlan(agenda,report,agendaConflictKey(conflict),target.id,now);
    expect(draft).toMatchObject({
      period:"tomorrow",targetId:target.id,title:target.title,source:"google",
      originalStart:target.start,originalEnd:target.end,
      proposedStart:"2026-10-10T12:00:00.000Z",
      proposedEnd:"2026-10-10T13:00:00.000Z"
    });
    expect(Date.parse(draft.proposedEnd!)-Date.parse(draft.proposedStart))
      .toBe(Date.parse(target.end!)-Date.parse(target.start));
    expect(draft).not.toHaveProperty("externalChangeApplied");
  });
  it("handles point reminders without inventing a meeting duration",()=>{
    const pointConflict:AgendaConflict={kind:"reminder-during-event",
      severity:"potential",first:{id:internal.id,title:internal.title,source:"cortex"},
      second:{id:first.id,title:first.title,source:"google"},
      at:internal.start,until:null,explanation:"Lembrete dentro da reunião"};
    const proposal=draftAgendaPlan(agenda,{...report,conflicts:[pointConflict]},
      agendaConflictKey(pointConflict),internal.id,now);
    expect(proposal.source).toBe("cortex");
    expect(proposal.originalEnd).toBeNull();
    expect(proposal.proposedEnd).toBeNull();
    expect(proposal.proposedStart).toBe("2026-10-10T12:00:00.000Z");
  });
  it("rejects stale conflicts, partial results, disconnected Google and historical events",()=>{
    expect(()=>draftAgendaPlan(agenda,report,"a".repeat(32),target.id,now))
      .toThrow(PlanInputError);
    expect(()=>draftAgendaPlan(agenda,report,agendaConflictKey(conflict),
      "google:other",now)).toThrow(PlanInputError);
    expect(()=>draftAgendaPlan({...agenda,truncated:true},report,
      agendaConflictKey(conflict),target.id,now)).toThrow(PlanConflictError);
    expect(()=>draftAgendaPlan(agenda,{...report,google:"not-connected"},
      agendaConflictKey(conflict),target.id,now)).toThrow(PlanConflictError);
    expect(()=>draftAgendaPlan(agenda,report,agendaConflictKey(conflict),
      target.id,new Date("2026-10-11T20:00:00Z"))).toThrow(PlanConflictError);
  });
  it("does not propose a slot on an all-day calendar day",()=>{
    const holiday:UnifiedItem={id:"google:holiday",title:"Feriado",
      start:"2026-10-10",end:"2026-10-11",allDay:true,sources:["google"]};
    expect(()=>draftAgendaPlan({...agenda,items:[...agenda.items,holiday]},
      report,agendaConflictKey(conflict),target.id,now)).toThrow("dia inteiro");
  });
  it("blocks unknown end times instead of promising that the day is free",()=>{
    const unknown:UnifiedItem={id:"google:unknown",title:"Sem fim",
      start:"2026-10-10T19:00:00Z",end:null,allDay:false,sources:["google"]};
    expect(()=>draftAgendaPlan({...agenda,items:[...agenda.items,unknown]},
      report,agendaConflictKey(conflict),target.id,now)).toThrow("duração");
  });
  it("rejects ambiguous merged records and unmaterialized recurrence previews",()=>{
    const merged:UnifiedItem={...target,sources:["cortex","google"]};
    expect(()=>draftAgendaPlan({...agenda,items:[first,merged,internal]},
      report,agendaConflictKey(conflict),target.id,now)).toThrow("duas agendas");
    const future:UnifiedItem={...target,sources:["cortex"],
      cortexKind:"recurrence-preview",cortexStatus:"PROJECTED"};
    expect(()=>draftAgendaPlan({...agenda,items:[first,future,internal]},
      report,agendaConflictKey(conflict),target.id,now)).toThrow("recorrência");
  });
});
