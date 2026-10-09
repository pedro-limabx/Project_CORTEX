import {describe,it,expect,vi} from "vitest";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {
  interpretGoogleCalendarQuestion,googleCalendarChatAnswer,queryGoogleCalendarForChat
} from "../src/integrations/google-chat.js";
import {interpretAgendaQuestion} from "../src/reminders/agenda.js";
import type {AgendaPeriod} from "../src/reminders/agenda.js";
import type {GoogleEventsSnapshot} from "../src/integrations/google-calendar.js";

const snapshot:GoogleEventsSnapshot={
  source:"google-calendar",readOnly:true,timeZone:"America/Sao_Paulo",
  period:"tomorrow",from:"2026-10-10T03:00:00.000Z",
  until:"2026-10-11T03:00:00.000Z",truncated:false,
  events:[
    {id:"meeting",title:"Planejamento da equipe",allDay:false,
      start:"2026-10-10T14:00:00-03:00",end:"2026-10-10T15:00:00-03:00"},
    {id:"holiday",title:"Feriado",allDay:true,
      start:"2026-10-10",end:"2026-10-11"}
  ]
};
describe("V19 Google Agenda questions in NEURON Chat",()=>{
  it("recognizes explicit meeting / Google queries and defined civil time windows",()=>{
    const cases:Array<[string,AgendaPeriod]>=[
      ["Quais reuniões tenho amanhã?","tomorrow"],
      ["NEURON, quais reuniões tenho hoje?","today"],
      ["Quais são minhas reuniões amanhã?","tomorrow"],
      ["Quais eventos tenho no Google Agenda hoje?","today"],
      ["Mostre meus eventos do Google nos próximos 7 dias","week"],
      ["Me mostre minhas reuniões da semana","week"],
      ["O que tenho no Google Agenda amanhã?","tomorrow"],
      ["Minha agenda do Google hoje","today"]
    ];
    for(const [phrase,period] of cases)
      expect(interpretGoogleCalendarQuestion(phrase)).toBe(period);
  });
  it("rejects ambiguous periods rather than asking the LLM to invent events",()=>{
    expect(interpretGoogleCalendarQuestion("Quais reuniões tenho sexta-feira?")).toBe("unsupported");
    expect(interpretGoogleCalendarQuestion("Quais eventos tenho no Google em dezembro?")).toBe("unsupported");
    expect(interpretGoogleCalendarQuestion("O que tenho no Google Agenda no mês que vem?")).toBe("unsupported");
  });
  it("never hijacks internal reminders, generic chat, or other apps",()=>{
    for(const message of [
      "Quais são meus lembretes de hoje?","O que tenho agendado amanhã?",
      "Lembre-me amanhã às 14h de revisar o CORTEX","Quanto é 25*18?",
      "Quais são os meus compromissos amanhã?","Como uso o Google Agenda?"
    ])expect(interpretGoogleCalendarQuestion(message)).toBeNull();
    expect(interpretAgendaQuestion("O que tenho agendado amanhã?")).toBe("tomorrow");
  });
  it("does not read a remote calendar without configured credentials",async()=>{
    const output=await queryGoogleCalendarForChat(undefined,"owner","tomorrow");
    expect(output).toMatchObject({mode:"google-calendar-help",
      googleCalendarHelp:{reason:"not-configured"},actionExecuted:false,readOnly:true});
    expect(output.text).toContain("não foi configurada");
  });
  it("does not call Google's API if the authorized account is disconnected",async()=>{
    const service={
      status:vi.fn(async(user:string)=>({configured:true as const,
        connected:false,readOnly:true as const})),
      listEvents:vi.fn(async(_user:string,_period:AgendaPeriod)=>snapshot)
    };
    const result=await queryGoogleCalendarForChat(service,"owner","today");
    expect(result).toMatchObject({mode:"google-calendar-help",
      googleCalendarHelp:{reason:"not-connected"},actionExecuted:false});
    expect(service.status).toHaveBeenCalledWith("owner");
    expect(service.listEvents).not.toHaveBeenCalled();
    const unsupported=await queryGoogleCalendarForChat(service,"owner","unsupported");
    expect(unsupported).toMatchObject({googleCalendarHelp:{reason:"unsupported-period"}});
    expect(service.status).toHaveBeenCalledTimes(1);
  });
  it("queries only the authorized owner's primary Google calendar after explicit intent",async()=>{
    const service={
      status:vi.fn(async(_user:string)=>({configured:true as const,
        connected:true,readOnly:true as const})),
      listEvents:vi.fn(async(_user:string,_period:AgendaPeriod)=>snapshot)
    };
    const result=await queryGoogleCalendarForChat(service,"server-owned-id","tomorrow");
    expect(service.status).toHaveBeenCalledWith("server-owned-id");
    expect(service.listEvents).toHaveBeenCalledExactlyOnceWith("server-owned-id","tomorrow");
    expect(result).toMatchObject({mode:"google-calendar-readonly",
      googleAgenda:{source:"google-calendar",readOnly:true,period:"tomorrow"},
      actionExecuted:false,readOnly:true});
    expect(result.text).toContain("calendário principal do Google");
    expect(result.text).toContain("Planejamento da equipe");
    expect(result.text).toContain("Feriado");
    expect(result.text).toContain("Dia inteiro");
    expect(result.text).toContain("não são lembretes internos");
  });
  it("presents partial Google results honestly and sanitizes multiline titles in text",()=>{
    const many:GoogleEventsSnapshot={...snapshot,truncated:true,
      events:Array.from({length:50},(_,i)=>({
        id:"event-"+i,title:i===0?"TÍTULO\nMALICIOSO":"Evento "+i,
        start:"2026-10-10T08:00:00-03:00",end:null,allDay:false
      }))};
    const answer=googleCalendarChatAnswer(many);
    expect(answer).toContain("lista parcial");
    expect(answer).toContain("TÍTULO MALICIOSO");
    expect(answer).not.toContain("TÍTULO\nMALICIOSO");
    expect(answer).toContain("Evento 9");
    expect(answer).not.toContain("Evento 49");
    const empty=googleCalendarChatAnswer({...snapshot,events:[],truncated:false});
    expect(empty).toContain("Nenhum evento retornado");
  });
  it("never forwards calendar content to the LLM or mutating routes",async()=>{
    const server=await readFile(resolve(process.cwd(),"src/server.ts"),"utf8");
    const start=server.indexOf("const googlePeriod=interpretGoogleCalendarQuestion");
    const end=server.indexOf("// Recognize explicit read-only questions",start);
    const segment=server.slice(start,end);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(segment).toContain("queryGoogleCalendarForChat");
    expect(segment).not.toContain("neuron.respond");
    expect(segment).not.toContain("reminderStore.create");
    expect(segment).not.toContain("POST");
  });
});
