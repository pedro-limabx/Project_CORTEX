import {describe,expect,it} from "vitest";
import {interpretReminder,REMINDER_TIME_ZONE} from "../src/reminders/interpret.js";
const now=new Date("2026-10-09T16:00:00.000Z"); // 13:00 in São Paulo

describe("V13 natural language reminder proposals",()=>{
  it("interprets tomorrow and today in the specified server time zone",()=>{
    expect(interpretReminder("Lembre-me amanhã às 14h de revisar o projeto",now)).toEqual({
      kind:"proposal",title:"revisar o projeto",dueAt:"2026-10-10T17:00:00.000Z",
      timeZone:REMINDER_TIME_ZONE
    });
    expect(interpretReminder("Me lembre de enviar relatório hoje às 17:30",now)).toEqual({
      kind:"proposal",title:"enviar relatório",dueAt:"2026-10-09T20:30:00.000Z",
      timeZone:REMINDER_TIME_ZONE
    });
  });
  it("handles minutes and hours relative to the instant, not the browser timezone",()=>{
    expect(interpretReminder("Lembre-me em 30 minutos de beber água",now)).toEqual({
      kind:"proposal",title:"beber água",dueAt:"2026-10-09T16:30:00.000Z",timeZone:REMINDER_TIME_ZONE
    });
    expect(interpretReminder("Crie um lembrete de entregar arquivo em 2 horas",now)).toEqual({
      kind:"proposal",title:"entregar arquivo",dueAt:"2026-10-09T18:00:00.000Z",
      timeZone:REMINDER_TIME_ZONE
    });
    expect(interpretReminder("Lembre-me dia 25/12/2026 às 09h30 de ligar para família",now)).toEqual({
      kind:"proposal",title:"ligar para família",dueAt:"2026-12-25T12:30:00.000Z",
      timeZone:REMINDER_TIME_ZONE
    });
  });
  it("declines ambiguity, invalid dates, past times and extreme schedules",()=>{
    for(const text of [
      "Lembre-me amanhã de estudar","Lembre-me hoje às 09h de almoçar",
      "Lembre-me em 0 minutos de revisar","Lembre-me dia 31/02/2027 às 18h de algo",
      "Lembre-me em 99999 dias de estudar","Lembre-me amanhã às 25h de estudar",
      "Lembre-me em 1 minuto"
    ]) expect(interpretReminder(text,now)).toMatchObject({kind:"help"});
  });
  it("never captures ordinary chat and never modifies storage",()=>{
    expect(interpretReminder("Quanto é 25 x 18?",now)).toBeNull();
    expect(interpretReminder("Qual é o status dos workflows?",now)).toBeNull();
    expect(interpretReminder("Explique o que é um lembrete",now)).toBeNull();
  });
});
