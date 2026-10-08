import {describe,expect,it,vi} from "vitest";
import {ReminderScheduler,ReminderInputError,validateNewReminder} from "../src/reminders/service.js";

const now=new Date("2026-10-08T16:00:00.000Z");
describe("CORTEX V12 reminder scheduling",()=>{
  it("normalizes explicit timezone and rejects unsafe schedules",()=>{
    expect(validateNewReminder({title:"  Revisar projeto  ",dueAt:"2026-10-08T14:02:00-03:00"},now))
      .toEqual({title:"Revisar projeto",dueAt:"2026-10-08T17:02:00.000Z"});
    for(const input of [
      {},{title:"",dueAt:"2026-10-09T14:00:00Z"},
      {title:"a",dueAt:"2026-10-09T14:00"},
      {title:"a",dueAt:"2026-10-08T15:59:00Z"},
      {title:"a",dueAt:"2026-10-08T16:00:30Z"},
      {title:"a",dueAt:"2030-01-01T15:00:00Z"},
      {title:"a",dueAt:"2026-10-09T15:00:00Z",executeTool:true}
    ]) expect(()=>validateNewReminder(input,now)).toThrow(ReminderInputError);
  });
  it("serializes concurrent checks and never invokes execution APIs",async()=>{
    const markDue=vi.fn(async()=>{await new Promise(resolve=>setTimeout(resolve,15));return 2;});
    const clock=()=>now;
    const scheduler=new ReminderScheduler({markDue},"owner",clock);
    const results=await Promise.all([scheduler.checkDue(),scheduler.checkDue(),scheduler.checkDue()]);
    expect(results).toEqual([2,2,2]);
    expect(markDue).toHaveBeenCalledTimes(1);
    expect(markDue).toHaveBeenCalledWith("owner",now.toISOString(),100);
    await scheduler.stop();
  });
});
