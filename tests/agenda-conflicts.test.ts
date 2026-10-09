import {describe,expect,it} from "vitest";
import {
  analyzeAgendaConflicts,interpretConflictQuestion,conflictAnswer
} from "../src/integrations/agenda-conflicts.js";
import type {UnifiedAgenda,UnifiedItem} from "../src/integrations/unified-agenda.js";

const from="2026-10-10T03:00:00.000Z";
const until="2026-10-11T03:00:00.000Z";
const now=new Date("2026-10-09T16:00:00.000Z");
const entry=(id:string,title:string,start:string,end:string|null,
  source:"google"|"cortex"="google"):UnifiedItem=>({
    id,title,start,end,allDay:false,sources:[source],
    ...(source==="cortex"?{cortexKind:"saved" as const,cortexStatus:"PENDING" as const}:{})
  });
function agenda(items:UnifiedItem[],extras:Partial<UnifiedAgenda>={}):UnifiedAgenda {
  return {period:"tomorrow",from,until,timeZone:"America/Sao_Paulo",
    readOnly:true,google:"connected",items,
    totals:{cortex:items.filter(x=>x.sources.includes("cortex")).length,
      google:items.filter(x=>x.sources.includes("google")).length,
      matched:0,displayed:items.length},truncated:false,warnings:[],...extras};
}
describe("V21 owner-scoped, read-only agenda conflict analysis",()=>{
  it("recognizes supported PT-BR conflict questions without hijacking the chat",()=>{
    expect(interpretConflictQuestion("Tenho conflitos na agenda amanhã?")).toBe("tomorrow");
    expect(interpretConflictQuestion("NEURON, tenho conflitos na agenda hoje?")).toBe("today");
    expect(interpretConflictQuestion("Verifique conflitos na agenda hoje")).toBe("today");
    expect(interpretConflictQuestion("Analise sobreposições na agenda nos próximos 7 dias")).toBe("week");
    expect(interpretConflictQuestion("Onde minha agenda está sobreposta hoje?")).toBe("today");
    expect(interpretConflictQuestion("Tenho conflitos na agenda na próxima sexta?")).toBe("unsupported");
    for(const msg of [
      "Minha agenda completa de amanhã","Quais reuniões tenho amanhã?",
      "Lembre-me amanhã de estudar","Calcule 25*18","Mova a reunião para sexta"
    ])expect(interpretConflictQuestion(msg)).toBeNull();
  });
  it("detects known Google-Google overlap and point reminders without made-up durations",()=>{
    const data=agenda([
      entry("google:1","Equipe","2026-10-10T12:30:00.000Z","2026-10-10T14:00:00.000Z"),
      entry("google:2","Planejamento","2026-10-10T13:15:00.000Z","2026-10-10T14:30:00.000Z"),
      entry("cortex:3","Lembrete pontual","2026-10-10T13:45:00.000Z",null,"cortex"),
      entry("cortex:4","Lembrete na borda","2026-10-10T14:30:00.000Z",null,"cortex")
    ]);
    const report=analyzeAgendaConflicts(data,now);
    expect(report.readOnly).toBe(true);
    expect(report.conflicts.filter(x=>x.kind==="event-overlap")).toHaveLength(1);
    const overlap=report.conflicts.find(x=>x.kind==="event-overlap");
    expect(overlap).toMatchObject({severity:"confirmed",
      at:"2026-10-10T13:15:00.000Z",until:"2026-10-10T14:00:00.000Z"});
    const points=report.conflicts.filter(x=>x.kind==="reminder-during-event");
    expect(points).toHaveLength(2);
    expect(points.every(x=>x.severity==="potential"&&x.until===null)).toBe(true);
    expect(report.examined.timedEvents).toBe(2);
    expect(report.examined.instantReminders).toBe(2);
    expect(conflictAnswer(report)).toContain("Nenhum compromisso foi alterado");
    for(const proposal of report.suggestions){
      const start=Date.parse(proposal.start),end=Date.parse(proposal.end);
      expect(end-start).toBe(30*60_000);
      for(const busy of data.items.slice(0,2))
        expect(start<Date.parse(busy.end!)&&Date.parse(busy.start)<end).toBe(false);
      expect(start<=Date.parse(data.items[2]!.start)&&Date.parse(data.items[2]!.start)<end).toBe(false);
    }
  });
  it("does not count an already matched CORTEX+Google item as a conflict with itself",()=>{
    const merged=entry("cortex:merged","Retorno","2026-10-10T12:00:00.000Z",
      "2026-10-10T13:00:00.000Z");
    merged.sources=["cortex","google"];
    merged.cortexKind="saved";
    merged.cortexStatus="PENDING";
    const report=analyzeAgendaConflicts(agenda([merged]),now);
    expect(report.conflicts).toHaveLength(0);
    expect(report.examined.timedEvents).toBe(1);
    expect(report.examined.instantReminders).toBe(1);
  });
  it("distinguishes all-day and unknown end times from hard conflicts",()=>{
    const allDay:UnifiedItem={
      id:"google:holiday",title:"Feriado",start:"2026-10-10",end:"2026-10-11",
      allDay:true,sources:["google"]
    };
    const report=analyzeAgendaConflicts(agenda([
      allDay,
      entry("google:no-end","Evento sem fim","2026-10-10T15:00:00.000Z",null),
      entry("cortex:point","Revisar","2026-10-10T15:15:00.000Z",null,"cortex")
    ]),now);
    expect(report.conflicts).toHaveLength(0);
    expect(report.examined.allDay).toBe(1);
    expect(report.examined.unknownDuration).toBe(1);
    expect(report.warnings.join(" ")).toContain("dia inteiro");
    expect(report.warnings.join(" ")).toContain("término");
    expect(report.suggestions).toHaveLength(0); // entire day excluded as advisory
  });
  it("warns about disconnects, Google failures and partial results; keeps recommendations tentative",()=>{
    const report=analyzeAgendaConflicts(agenda([],{
      google:"not-connected",truncated:true,warnings:["Amostra limitada"]
    }),now);
    expect(report.google).toBe("not-connected");
    expect(report.truncated).toBe(true);
    expect(report.warnings.join(" ")).toContain("Amostra limitada");
    expect(report.warnings.join(" ")).toContain("Google");
    expect(report.warnings.join(" ")).toContain("parcial");
    expect(report.suggestions.length).toBeGreaterThan(0);
    expect(report.suggestions.length).toBeLessThanOrEqual(4);
    const answer=conflictAnswer(report);
    expect(answer).toContain("Google");
    expect(answer).toContain("Sugestões tentativas");
    expect(answer).not.toContain("horário confirmado como livre");
  });
  it("limits high-overlap outputs and warns that the report is incomplete",()=>{
    const events=Array.from({length:15},(_,i)=>entry("google:"+i,"Evento "+i,
      "2026-10-10T12:00:00.000Z","2026-10-10T13:00:00.000Z"));
    const report=analyzeAgendaConflicts(agenda(events),now);
    expect(report.conflicts).toHaveLength(20);
    expect(report.truncated).toBe(true);
    expect(report.warnings.join(" ")).toContain("mais conflitos");
    expect(report.conflicts.every(x=>x.severity==="confirmed")).toBe(true);
  });
});
