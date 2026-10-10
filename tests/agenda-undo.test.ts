import {describe,expect,it} from "vitest";
import {previewReminderUndo,UNDO_WINDOW_MINUTES} from "../src/integrations/agenda-undo.js";
import type {AgendaPlan} from "../src/integrations/agenda-reorganization.js";
import type {UnifiedAgenda,UnifiedItem} from "../src/integrations/unified-agenda.js";
const applied=new Date("2026-10-09T16:00:00.000Z");
const now=new Date("2026-10-09T16:05:00.000Z");
const userReminder:UnifiedItem={
  id:"cortex:11111111-1111-4111-8111-111111111111",
  title:"Enviar relatório",start:"2026-10-10T15:00:00.000Z",
  allDay:false,sources:["cortex"],cortexKind:"saved",cortexStatus:"PENDING"
};
const plan:AgendaPlan={
  id:"22222222-2222-4222-8222-222222222222",period:"tomorrow",
  conflictKey:"a".repeat(32),targetId:userReminder.id,
  title:userReminder.title,source:"cortex",
  originalStart:"2026-10-10T12:00:00.000Z",
  originalEnd:null,proposedStart:userReminder.start,proposedEnd:null,
  createdAt:"2026-10-09T15:55:00.000Z",
  updatedAt:applied.toISOString(),expiresAt:"2026-10-09T16:10:00.000Z",
  reviewedAt:applied.toISOString(),appliedAt:applied.toISOString(),
  status:"APPLIED",externalChangeApplied:false
};
const agenda:UnifiedAgenda={
  period:"week",from:"2026-10-09T03:00:00.000Z",
  until:"2026-10-16T03:00:00.000Z",
  timeZone:"America/Sao_Paulo",readOnly:true,
  google:"connected",truncated:false,warnings:[],items:[userReminder],
  totals:{cortex:1,google:0,matched:0,displayed:1}
};
const clone=(props:Partial<UnifiedItem>={}):UnifiedItem=>({
  id:"google:example",title:"Exemplo",start:"2026-10-10T12:15:00.000Z",
  end:"2026-10-10T13:15:00.000Z",allDay:false,sources:["google"],...props
});
describe("V24 preview and fail-closed undo rules",()=>{
  it("permits only a fresh, covered, conflict-free pending CORTEX reminder",()=>{
    const result=previewReminderUndo(plan,agenda,now);
    expect(result).toMatchObject({eligible:true,title:plan.title,
      currentDueAt:plan.proposedStart,restoreDueAt:plan.originalStart,
      reminderId:"11111111-1111-4111-8111-111111111111",
      externalChangeApplied:false,internalChangeApplied:false,
      expiresAt:"2026-10-09T16:30:00.000Z"});
    expect(UNDO_WINDOW_MINUTES).toBe(30);
  });
  it("declines non-applied, replayed, Google-only, or overdue history entries",()=>{
    for(const candidate of [
      {...plan,status:"APPROVED" as const},
      {...plan,status:"REVERTED" as const,revertedAt:now.toISOString()},
      {...plan,source:"google" as const},
      {...plan,appliedAt:undefined},
      {...plan,originalEnd:"2026-10-10T12:30:00.000Z"},
      {...plan,proposedStart:plan.originalStart}
    ])expect(previewReminderUndo(candidate,agenda,now).eligible).toBe(false);
    expect(previewReminderUndo(plan,agenda,new Date("2026-10-09T16:30:00.000Z")).eligible)
      .toBe(false);
    expect(previewReminderUndo({...plan,originalStart:"2026-10-09T16:04:00.000Z"},
      agenda,now).eligible).toBe(false);
  });
  it("fails closed when Google is not authorized or either provider is partial",()=>{
    for(const altered of [
      {...agenda,google:"not-connected" as const},
      {...agenda,google:"unavailable" as const},
      {...agenda,truncated:true},
      {...agenda,from:"2026-10-11T03:00:00.000Z"}
    ])expect(previewReminderUndo(plan,altered,now).eligible).toBe(false);
  });
  it("blocks original slot if busy with Google, local reminders or all-day events",()=>{
    const cases:UnifiedItem[]=[
      clone(),
      clone({id:"google:all",allDay:true,start:"2026-10-10",end:"2026-10-11"}),
      clone({id:"google:unknown",start:"2026-10-10T10:00:00Z",end:null}),
      {id:"cortex:another",title:"Outro aviso",
        start:"2026-10-10T12:20:00.000Z",allDay:false,sources:["cortex"],
        cortexKind:"saved",cortexStatus:"PENDING"}
    ];
    for(const item of cases){
      const result=previewReminderUndo(plan,{...agenda,items:[userReminder,item]},now);
      expect(result.eligible).toBe(false);
      expect(result.reason).toMatch(/Google|lembrete|dia inteiro/i);
    }
  });
  it("allows an adjacent event ending exactly at the old instant",()=>{
    const result=previewReminderUndo(plan,{...agenda,items:[userReminder,
      clone({start:"2026-10-10T11:00:00.000Z",end:plan.originalStart})]},now);
    expect(result.eligible).toBe(true);
  });
  it("rejects reminders already completed, moved or merged with Google",()=>{
    for(const altered of [
      {...userReminder,cortexStatus:"DUE" as const},
      {...userReminder,start:"2026-10-10T16:00:00.000Z"},
      {...userReminder,sources:["cortex","google"] as Array<"cortex"|"google">},
      {...userReminder,cortexKind:"recurrence-preview" as const}
    ])expect(previewReminderUndo(plan,{...agenda,items:[altered]},now).eligible).toBe(false);
  });
});
