import {describe,expect,it,vi} from "vitest";
import {
  interpretUnifiedAgendaQuestion,mergeUnifiedAgenda,getUnifiedAgenda,unifiedAgendaAnswer
} from "../src/integrations/unified-agenda.js";
import {interpretAgendaQuestion} from "../src/reminders/agenda.js";
import {interpretGoogleCalendarQuestion} from "../src/integrations/google-chat.js";
import {GoogleCalendarAuthError} from "../src/integrations/google-calendar.js";
import type {AgendaSnapshot} from "../src/reminders/agenda.js";
import type {GoogleEventsSnapshot} from "../src/integrations/google-calendar.js";

const now=new Date("2026-10-09T16:00:00.000Z");
const local:AgendaSnapshot={
  period:"tomorrow",from:"2026-10-10T03:00:00.000Z",
  until:"2026-10-11T03:00:00.000Z",generatedAt:now.toISOString(),
  timeZone:"America/Sao_Paulo",readOnly:true,truncated:false,
  counts:{saved:2,projected:1},
  items:[
    {id:"internal-1",title:"Reunião   mensal",dueAt:"2026-10-10T17:00:00.000Z",
      status:"PENDING",source:"saved"},
    {id:"internal-2",title:"Reunião mensal",dueAt:"2026-10-10T18:00:00.000Z",
      status:"DUE",source:"saved"},
    {id:"recurrence-1",title:"Exercício",dueAt:"2026-10-10T10:00:00.000Z",
      status:"PROJECTED",source:"recurrence-preview"}
  ]
};
const google:GoogleEventsSnapshot={
  period:"tomorrow",from:local.from,until:local.until,
  timeZone:"America/Sao_Paulo",readOnly:true,source:"google-calendar",
  truncated:false,events:[
    {id:"google-one",title:" reunião mensal ",start:"2026-10-10T14:00:00-03:00",
      end:"2026-10-10T15:00:00-03:00",allDay:false},
    {id:"google-other-time",title:"Reunião mensal",
      start:"2026-10-10T14:30:00-03:00",end:null,allDay:false},
    {id:"all-day",title:"Reunião mensal",start:"2026-10-10",end:"2026-10-11",
      allDay:true},
    {id:"google-unique",title:"Dentista",start:"2026-10-10T16:00:00-03:00",
      end:null,allDay:false}
  ]
};
describe("V20 unified agenda intent and deduplicated read-only view",()=>{
  it("parses only explicit unified requests, local/Google routes remain distinct",()=>{
    expect(interpretUnifiedAgendaQuestion("Minha agenda completa de hoje")).toBe("today");
    expect(interpretUnifiedAgendaQuestion("NEURON, minha agenda unificada de amanhã")).toBe("tomorrow");
    expect(interpretUnifiedAgendaQuestion("Mostre tudo que tenho agendado hoje")).toBe("today");
    expect(interpretUnifiedAgendaQuestion("Junte meus lembretes e eventos do Google amanhã")).toBe("tomorrow");
    expect(interpretUnifiedAgendaQuestion("Minha agenda completa dos próximos 7 dias")).toBe("week");
    expect(interpretUnifiedAgendaQuestion("Quais são todos os meus compromissos de hoje?")).toBe("today");
    expect(interpretUnifiedAgendaQuestion("Minha agenda completa na sexta que vem")).toBe("unsupported");
    for(const x of [
      "Quais são meus lembretes de hoje?","Quais reuniões tenho amanhã?",
      "Lembre-me amanhã às 14h de estudar","Calcule 25*18","Apague tudo da minha agenda"
    ])expect(interpretUnifiedAgendaQuestion(x)).toBeNull();
    expect(interpretAgendaQuestion("Quais são meus lembretes de hoje?")).toBe("today");
    expect(interpretGoogleCalendarQuestion("Quais reuniões tenho amanhã?")).toBe("tomorrow");
  });
  it("merges exact title + UTC time across sources and preserves unlike/all-day events",()=>{
    const result=mergeUnifiedAgenda(local,google,"connected");
    expect(result.readOnly).toBe(true);
    expect(result.totals).toEqual({cortex:3,google:4,matched:1,displayed:6});
    expect(result.items).toHaveLength(6);
    const both=result.items.find(x=>x.sources.includes("cortex")&&x.sources.includes("google"));
    expect(both).toMatchObject({
      title:"Reunião   mensal",start:"2026-10-10T17:00:00.000Z",
      cortexKind:"saved",sources:["cortex","google"]
    });
    expect(result.items.filter(x=>x.title.trim().replace(/\s+/gu," ").toLowerCase()==="reunião mensal")).toHaveLength(4);
    const day=result.items[0];
    expect(day).toMatchObject({allDay:true,start:"2026-10-10",sources:["google"]});
    expect(result.items.some(x=>x.cortexKind==="recurrence-preview"&&x.sources[0]==="cortex")).toBe(true);
    expect(unifiedAgendaAnswer(result)).toContain("[CORTEX + Google]");
    expect(unifiedAgendaAnswer(result)).toContain("Dia inteiro");
    expect(result.warnings).toEqual([]);
  });
  it("runs locally if OAuth is unconfigured or not connected; never makes remote event request",async()=>{
    const dependencies={
      reminders:{listWindow:vi.fn(async()=>local.items.filter(x=>x.source==="saved").map(x=>({
        id:x.id,title:x.title,dueAt:x.dueAt,status:x.status==="DUE"?"DUE" as const:"PENDING" as const,
        createdAt:now.toISOString(),triggeredAt:null,completedAt:null,cancelledAt:null
      })))},
      recurrences:{listActive:vi.fn(async()=>[])}
    };
    const disabled=await getUnifiedAgenda(dependencies,undefined,"owner","tomorrow",now);
    expect(disabled.google).toBe("not-configured");
    expect(disabled.items).toHaveLength(2);
    expect(disabled.warnings.join(" ")).toContain("não está configurado");
    const service={
      status:vi.fn(async(_user:string)=>({configured:true as const,
        connected:false,readOnly:true as const})),
      listEvents:vi.fn(async(_user:string,_period:string,_now:Date)=>google)
    };
    const result=await getUnifiedAgenda(dependencies,service,"owner","tomorrow",now);
    expect(service.status).toHaveBeenCalledExactlyOnceWith("owner");
    expect(service.listEvents).not.toHaveBeenCalled();
    expect(result.google).toBe("not-connected");
    expect(result.items).toHaveLength(2);
    expect(dependencies.reminders.listWindow).toHaveBeenCalledWith("owner",
      "2026-10-10T03:00:00.000Z","2026-10-11T03:00:00.000Z",101);
  });
  it("fetches live Google events only for authenticated owner and preserves local fallback after outage",async()=>{
    const deps={
      reminders:{listWindow:vi.fn(async()=>[] as any[])},
      recurrences:{listActive:vi.fn(async()=>[] as any[])}
    };
    const service={
      status:vi.fn(async(_user:string)=>({configured:true as const,connected:true,
        readOnly:true as const})),
      listEvents:vi.fn(async(_user:string,_period:string,_now:Date)=>google)
    };
    const result=await getUnifiedAgenda(deps,service,"owner-123","tomorrow",now);
    expect(service.status).toHaveBeenCalledWith("owner-123");
    expect(service.listEvents).toHaveBeenCalledExactlyOnceWith("owner-123","tomorrow",now);
    expect(result.google).toBe("connected");
    expect(result.totals.google).toBe(4);
    service.listEvents.mockRejectedValueOnce(new Error("DO_NOT_ECHO_GOOGLE_SECRET"));
    const failed=await getUnifiedAgenda(deps,service,"owner-123","tomorrow",now);
    expect(failed.google).toBe("unavailable");
    expect(JSON.stringify(failed)).not.toContain("DO_NOT_ECHO_GOOGLE_SECRET");
    expect(unifiedAgendaAnswer(failed)).toContain("Não foi possível consultar o Google");
    service.listEvents.mockRejectedValueOnce(new GoogleCalendarAuthError("OAuth failed"));
    const expired=await getUnifiedAgenda(deps,service,"owner-123","tomorrow",now);
    expect(expired.google).toBe("reconnect");
    expect(expired.warnings.join(" ")).toContain("Reconecte");
  });
  it("does not hide partial data: both provider paging and local limit remain visible",()=>{
    expect(mergeUnifiedAgenda({...local,truncated:true},google,"connected")
      .truncated).toBe(true);
    expect(mergeUnifiedAgenda(local,{...google,truncated:true},"connected")
      .warnings.join(" ")).toContain("Consulta parcial");
    const large:AgendaSnapshot={...local,items:Array.from({length:30},(_,i)=>({
      id:"r"+i,title:"Revisão "+i,dueAt:new Date(Date.parse(local.from)+i*60000).toISOString(),
      source:"saved" as const,status:"PENDING" as const
    }))};
    const many:GoogleEventsSnapshot={...google,events:Array.from({length:50},(_,i)=>({
      id:"g"+i,title:"Google "+i,start:new Date(Date.parse(local.from)+i*60000).toISOString(),
      end:null,allDay:false
    }))};
    const result=mergeUnifiedAgenda(large,many,"connected");
    expect(result.items).toHaveLength(50);
    expect(result.truncated).toBe(true);
    expect(result.totals.displayed).toBe(50);
    expect(result.totals.matched).toBe(0);
  });
});
