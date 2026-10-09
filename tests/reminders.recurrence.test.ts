import {describe,expect,it} from "vitest";
import {nextRecurrenceAfter,validateNewSchedule} from "../src/reminders/recurrence.js";
import {interpretRecurringReminder} from "../src/reminders/recurrence-interpret.js";
const now=new Date("2026-10-09T16:00:00.000Z"); // Friday 13:00 São Paulo
describe("V15 recurring reminder timezone and input",()=>{
  it("calculates daily 07:00 in São Paulo without accumulating drift",()=>{
    expect(nextRecurrenceAfter(now,"DAILY","07:00",null).toISOString())
      .toBe("2026-10-10T10:00:00.000Z");
    expect(nextRecurrenceAfter(new Date("2026-10-10T09:59:59Z"),
      "DAILY","07:00",null).toISOString()).toBe("2026-10-10T10:00:00.000Z");
    expect(nextRecurrenceAfter(new Date("2026-10-10T10:00:00Z"),
      "DAILY","07:00",null).toISOString()).toBe("2026-10-11T10:00:00.000Z");
  });
  it("handles weekly weekday and year boundaries",()=>{
    expect(nextRecurrenceAfter(now,"WEEKLY","09:30",1).toISOString())
      .toBe("2026-10-12T12:30:00.000Z");
    expect(nextRecurrenceAfter(new Date("2026-12-31T22:00:00Z"),
      "WEEKLY","09:30",1).toISOString()).toBe("2027-01-04T12:30:00.000Z");
  });
  it("validates bounded schedules and fixed timezone",()=>{
    expect(validateNewSchedule({title:"  Planejamento  ",frequency:"WEEKLY",
      weekday:1,time:"07:00"},now)).toMatchObject({
      title:"Planejamento",frequency:"WEEKLY",weekday:1,
      nextDueAt:"2026-10-12T10:00:00.000Z"
    });
    for(const invalid of [
      {},{title:"",frequency:"DAILY",time:"07:00"},
      {title:"x",frequency:"MONTHLY",time:"07:00"},
      {title:"x",frequency:"DAILY",weekday:1,time:"07:00"},
      {title:"x",frequency:"WEEKLY",time:"07:00"},
      {title:"x",frequency:"WEEKLY",weekday:7,time:"07:00"},
      {title:"x",frequency:"DAILY",time:"25:00"},
      {title:"x",frequency:"DAILY",time:"07:00",timeZone:"UTC"}
    ])expect(()=>validateNewSchedule(invalid,now)).toThrow();
  });
  it("previews daily and weekly PT-BR commands; rejects ambiguous schedules",()=>{
    expect(interpretRecurringReminder("Lembre-me todos os dias às 7h de verificar meus compromissos",now))
      .toMatchObject({kind:"proposal",frequency:"DAILY",
        title:"verificar meus compromissos",time:"07:00"});
    expect(interpretRecurringReminder("Lembre-me toda segunda-feira às 9h de conferir a agenda",now))
      .toMatchObject({kind:"proposal",frequency:"WEEKLY",weekday:1,
        title:"conferir a agenda",time:"09:00"});
    expect(interpretRecurringReminder("Lembre-me toda quarta às 9h30 de estudar",now))
      .toMatchObject({kind:"proposal",frequency:"WEEKLY",weekday:3,time:"09:30"});
    expect(interpretRecurringReminder("Lembre-me toda semana de beber água",now))
      .toMatchObject({kind:"help"});
    expect(interpretRecurringReminder("Lembre-me amanhã às 14h de estudar",now)).toBeNull();
    expect(interpretRecurringReminder("Qual é a temperatura?",now)).toBeNull();
  });
});
