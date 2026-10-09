import {describe,expect,it} from "vitest";
import {
  validateInternalApplication,PlanConflictError,agendaConflictKey
} from "../src/integrations/agenda-reorganization.js";
import type {AgendaPlan} from "../src/integrations/agenda-reorganization.js";
import type {UnifiedAgenda,UnifiedItem} from "../src/integrations/unified-agenda.js";
import type {ConflictReport,AgendaConflict} from "../src/integrations/agenda-conflicts.js";

const now=new Date("2026-10-09T16:00:00Z");
const reminder:UnifiedItem={id:"cortex:11111111-1111-4111-8111-111111111111",
  title:"Entregar relatório",start:"2026-10-10T14:30:00.000Z",
  allDay:false,sources:["cortex"],cortexKind:"saved",cortexStatus:"PENDING"};
const meeting:UnifiedItem={id:"google:meeting",title:"Reunião externa",
  start:"2026-10-10T14:00:00.000Z",end:"2026-10-10T15:00:00.000Z",
  allDay:false,sources:["google"]};
const conflict:AgendaConflict={kind:"reminder-during-event",
  severity:"potential",first:{id:reminder.id,title:reminder.title,source:"cortex"},
  second:{id:meeting.id,title:meeting.title,source:"google"},
  at:reminder.start,until:null,explanation:"Lembrete no horário de uma reunião"};
const agenda:UnifiedAgenda={
  period:"tomorrow",from:"2026-10-10T03:00:00.000Z",
  until:"2026-10-11T03:00:00.000Z",timeZone:"America/Sao_Paulo",
  google:"connected",readOnly:true,items:[reminder,meeting],
  totals:{cortex:1,google:1,matched:0,displayed:2},
  warnings:[],truncated:false
};
const report:ConflictReport={
  period:"tomorrow",timeZone:"America/Sao_Paulo",readOnly:true,
  google:"connected",truncated:false,examined:{
    items:2,timedEvents:1,instantReminders:1,allDay:0,unknownDuration:0
  },conflicts:[conflict],suggestions:[],warnings:[]
};
const plan:AgendaPlan={
  id:"22222222-2222-4222-8222-222222222222",
  period:"tomorrow",conflictKey:agendaConflictKey(conflict),targetId:reminder.id,
  title:reminder.title,source:"cortex",originalStart:reminder.start,originalEnd:null,
  proposedStart:"2026-10-10T12:00:00.000Z",proposedEnd:null,
  status:"APPROVED",createdAt:"2026-10-09T15:59:00Z",
  updatedAt:"2026-10-09T16:00:00Z",expiresAt:"2026-10-09T16:10:00Z",
  reviewedAt:"2026-10-09T16:00:00Z",externalChangeApplied:false
};
describe("V23 fail-closed internal reminder revalidation",()=>{
  it("allows only approved, unexpired CORTEX reminder plans whose full suggestion still matches",()=>{
    expect(()=>validateInternalApplication(plan,agenda,report,now)).not.toThrow();
  });
  it("rejects proposals unapproved, expired, already applied or targeting Google",()=>{
    for(const invalid of [
      {...plan,status:"PENDING_REVIEW" as const},
      {...plan,status:"REJECTED" as const},
      {...plan,status:"APPLIED" as const,appliedAt:now.toISOString()},
      {...plan,source:"google" as const},
      {...plan,expiresAt:"2026-10-09T15:00:00Z"},
      {...plan,proposedStart:"2026-10-09T16:00:01Z"}
    ])expect(()=>validateInternalApplication(invalid,agenda,report,now))
      .toThrow(PlanConflictError);
  });
  it("blocks if the original conflict, its title, or the suggested time have changed",()=>{
    expect(()=>validateInternalApplication(plan,agenda,
      {...report,conflicts:[]},now)).toThrow();
    expect(()=>validateInternalApplication({...plan,title:"Mudou"},
      agenda,report,now)).toThrow("desatualizada");
    expect(()=>validateInternalApplication({...plan,proposedStart:"2026-10-10T13:00:00.000Z"},
      agenda,report,now)).toThrow("desatualizada");
    expect(()=>validateInternalApplication(plan,
      {...agenda,items:[{...reminder,start:"2026-10-10T14:40:00.000Z"},meeting]},
      report,now)).toThrow();
  });
  it("blocks partial/offline Google snapshots and merged/recurrence targets",()=>{
    expect(()=>validateInternalApplication(plan,
      {...agenda,google:"not-connected"},report,now)).toThrow();
    expect(()=>validateInternalApplication(plan,
      {...agenda,truncated:true},report,now)).toThrow();
    expect(()=>validateInternalApplication(plan,agenda,
      {...report,truncated:true},now)).toThrow();
    expect(()=>validateInternalApplication(plan,
      {...agenda,items:[{...reminder,sources:["google","cortex"]},meeting]},
      report,now)).toThrow();
    expect(()=>validateInternalApplication(plan,
      {...agenda,items:[{...reminder,cortexKind:"recurrence-preview"},meeting]},
      report,now)).toThrow();
  });
});
