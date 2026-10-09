import {describe,expect,it,vi} from "vitest";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {runInNewContext} from "node:vm";

const readSource = () => readFile(resolve(process.cwd(),"web/app.js"),"utf8");
const extract = (source:string,ending:string) => {
  const from=source.indexOf("function selectNewDueReminders(reminders, seen, startedAt) {");
  const to=source.indexOf(ending,from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return source.slice(from,to);
};
describe("CORTEX V14 opt-in reminder notifications",()=>{
  it("only raises fresh due transitions after the opt-in baseline",async()=>{
    const source=await readSource();
    const selector=runInNewContext(extract(source,"function updateReminderWatchControls()")
      + "\nselectNewDueReminders;",{Date,Number}) as (
        entries:Array<{id:string;status:string;triggeredAt:string}>,
        seen:Set<string>,startedAt:number)=>Array<{id:string}>;
    const start=Date.parse("2026-10-09T15:00:00Z");
    const seen=new Set(["already-baselined"]);
    const entries=[
      {id:"already-baselined",status:"DUE",triggeredAt:"2026-10-09T15:30:00Z"},
      {id:"old-due",status:"DUE",triggeredAt:"2026-10-09T14:30:00Z"},
      {id:"fresh",status:"DUE",triggeredAt:"2026-10-09T15:30:00Z"},
      {id:"still-pending",status:"PENDING",triggeredAt:"2026-10-09T15:30:00Z"},
      {id:"invalid-date",status:"DUE",triggeredAt:"invalid"}
    ];
    expect(selector(entries,seen,start).map(x=>x.id)).toEqual(["fresh"]);
    expect(selector(entries,seen,start)).toEqual([]);
    expect(seen.has("old-due")).toBe(true);
    expect(seen.has("still-pending")).toBe(false);
  });
  it("does not leak reminder titles or notify without both opt-ins",async()=>{
    const source=await readSource();
    const segment=source.slice(source.indexOf("function notifyNewDueReminders(reminders) {"),
      source.indexOf("async function pollDueReminders()"));
    expect(segment).toContain('reminderWatchTimer === null');
    expect(segment).toContain('browserRemindersEnabled');
    const notices:Array<{title:string;body:string}>=[];
    class MockNotification {
      static permission="granted";
      onclick: (()=>void)|null=null;
      constructor(title:string,options:{body:string}){
        notices.push({title,body:options.body});
      }
      close=vi.fn();
    }
    const tab=vi.fn();
    const sandbox:{window:{Notification:typeof MockNotification;focus:()=>void};browserRemindersEnabled:boolean;reminderWatchTimer:number|null;tab:typeof tab}={
      window:{Notification:MockNotification,focus:vi.fn()},
      browserRemindersEnabled:false,reminderWatchTimer:1,tab
    };
    const notifier=runInNewContext(segment+"\nnotifyNewDueReminders;",sandbox) as (data:Array<{title:string}>)=>void;
    const item=[{title:"PRIVATE API KEY DO NOT SHARE"}];
    notifier(item);
    expect(notices).toHaveLength(0);
    sandbox.browserRemindersEnabled=true;
    sandbox.reminderWatchTimer=null;
    notifier(item);
    expect(notices).toHaveLength(0);
    sandbox.reminderWatchTimer=1;
    MockNotification.permission="denied";
    notifier(item);
    expect(notices).toHaveLength(0);
    MockNotification.permission="granted";
    notifier(item);
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices)).not.toContain("PRIVATE API KEY");
    expect(notices[0]?.title).toContain("CORTEX");
  });
  it("keeps the watch explicit, bounded and local to an open tab",async()=>{
    const source=await readSource();
    const html=await readFile(resolve(process.cwd(),"web/index.html"),"utf8");
    expect(html).toContain('id="reminder-watch-toggle"');
    expect(html).toContain('id="reminder-browser-toggle"');
    expect(html).toContain('id="nav-reminder-count"');
    expect(source).toContain("window.setInterval(()=>{");
    expect(source).toContain("},30000)");
    expect(source).toContain("window.Notification.requestPermission()");
    expect(source).toContain('api("/api/reminders?view=due&limit=100")');
    expect(source).not.toContain("new ServiceWorker");
  });
});
