import {describe,expect,it} from "vitest";
import {
  exportAgendaIcs,escapeCalendarText,foldCalendarLine,CalendarExportTooLargeError
} from "../src/reminders/ical.js";
import type {AgendaSnapshot} from "../src/reminders/agenda.js";

const snapshot:AgendaSnapshot={
  period:"tomorrow",
  from:"2026-10-10T03:00:00.000Z",until:"2026-10-11T03:00:00.000Z",
  timeZone:"America/Sao_Paulo",generatedAt:"2026-10-09T16:00:00.000Z",
  readOnly:true,truncated:false,counts:{saved:1,projected:1},
  items:[
    {id:"reminder-uuid",title:"Planejar, testar; revisar \\ logs\nAmanhã",
      dueAt:"2026-10-10T17:00:00.000Z",status:"PENDING",source:"saved"},
    {id:"schedule-uuid:2026-10-10T10:00:00.000Z",title:"Agenda diária",
      dueAt:"2026-10-10T10:00:00.000Z",status:"PROJECTED",source:"recurrence-preview"}
  ]
};
const unfold=(x:string)=>x.replace(/\r\n /g,"");
describe("V17 RFC 5545 iCalendar snapshot",()=>{
  it("creates valid CRLF calendar with stable owner-scoped UIDs and UTC date-times",()=>{
    const content=exportAgendaIcs(snapshot,"local-user");
    expect(content.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(content.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect((content.match(/BEGIN:VEVENT\r\n/g)||[])).toHaveLength(2);
    const flattened=unfold(content);
    expect(flattened).toContain("DTSTART:20261010T170000Z");
    expect(flattened).toContain("DTSTART:20261010T100000Z");
    expect(flattened).toContain("DTSTAMP:20261009T160000Z");
    expect(flattened).toContain("SUMMARY:Planejar\\, testar\\; revisar \\\\ logs\\nAmanhã");
    expect(flattened).toContain("SUMMARY:[Previsão] Agenda diária");
    expect(flattened).toContain("TRANSP:TRANSPARENT");
    expect(content).not.toContain("DTEND");
    expect(content).not.toContain("RRULE:");
    expect(content).not.toContain("VALARM");
    expect(exportAgendaIcs(snapshot,"local-user")).toBe(content);
    const other=exportAgendaIcs(snapshot,"different-user");
    expect(other).not.toBe(content);
    expect(other).toContain("SUMMARY:[Previsão] Agenda diária");
    expect(content).not.toContain("local-user");
    expect(content).not.toContain("reminder-uuid");
  });
  it("escapes hostile titles without producing executable iCalendar properties",()=>{
    const evil="Reunião\r\nBEGIN:VTODO\nTRIGGER:-PT1M\r\nEND:VCALENDAR\\,;";
    const value=escapeCalendarText(evil);
    expect(value).toContain("\\nBEGIN:VTODO\\nTRIGGER:-PT1M\\nEND:VCALENDAR");
    const file=exportAgendaIcs({...snapshot,items:[{...snapshot.items[0]!,title:evil}]},"owner");
    expect(file).not.toContain("\r\nBEGIN:VTODO\r\n");
    expect(file).not.toContain("\r\nTRIGGER:-PT1M\r\n");
    expect((file.match(/\r\nEND:VCALENDAR\r\n/g)||[])).toHaveLength(1);
    expect(file).not.toContain("\r\nEND:VCALENDAR\r\nBEGIN");
  });
  it("folds UTF-8 lines at <=75 octets without corrupting multi-byte characters",()=>{
    const long="SUMMARY:"+("Cérebro 🧠 — ".repeat(30));
    const folded=foldCalendarLine(long);
    expect(folded).toContain("\r\n ");
    for(const line of folded.split("\r\n"))
      expect(Buffer.byteLength(line,"utf8")).toBeLessThanOrEqual(75);
    expect(unfold(folded)).toBe(long);
    const bigger=exportAgendaIcs({...snapshot,items:[{
      ...snapshot.items[0]!,title:"😊".repeat(80)
    }]},"owner");
    for(const line of bigger.split("\r\n").filter(Boolean))
      expect(Buffer.byteLength(line,"utf8")).toBeLessThanOrEqual(75);
  });
  it("refuses partial exports and tolerates empty calendars",()=>{
    expect(()=>exportAgendaIcs({...snapshot,truncated:true},"owner"))
      .toThrow(CalendarExportTooLargeError);
    const empty=exportAgendaIcs({...snapshot,items:[],counts:{saved:0,projected:0}},"owner");
    expect(empty).toContain("BEGIN:VCALENDAR");
    expect(empty).not.toContain("BEGIN:VEVENT");
    expect(empty).toContain("END:VCALENDAR");
  });
});
