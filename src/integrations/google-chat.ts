// V19: deterministic, explicit calendar-read intent. Never calls an LLM,
// schedules reminders, or changes events on Google Calendar.
import type {AgendaPeriod} from "../reminders/agenda.js";
import type {GoogleEventsSnapshot,GoogleEvent} from "./google-calendar.js";

const prefix=/^(?:neuron\s*[,!]\s*)?(?:quais(?: sao)? (?:as )?(?:minhas )?reunioes(?: tenho)?|quais(?: sao)? (?:os )?(?:meus )?(?:eventos|compromissos) (?:tenho )?(?:do |no )?google(?: agenda| calendar)?|(?:(?:me )?mostre|listar|consulte|consultar|ver) (?:as )?(?:minhas )?reunioes|(?:(?:me )?mostre|listar|consulte|consultar|ver) (?:os )?(?:meus )?(?:eventos|compromissos) (?:do |no )?google(?: agenda| calendar)?|o que (?:tenho|esta agendado) (?:no |na )(?:meu |minha )?google(?: agenda| calendar)?|(?:minha agenda|meus eventos|meus compromissos|minhas reunioes) (?:no |na |do |da )google(?: agenda| calendar)?)\b/u;
const periods:Record<string,AgendaPeriod>={
  "hoje":"today","amanha":"tomorrow",
  "esta semana":"week","da semana":"week","na semana":"week",
  "semana":"week","nos proximos 7 dias":"week",
  "proximos 7 dias":"week","os proximos 7 dias":"week"
};
export function interpretGoogleCalendarQuestion(message:string):AgendaPeriod|null {
  const normalized=message.normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .trim().toLowerCase().replace(/[?.!]+$/u,"").trim();
  const match=prefix.exec(normalized);
  if(!match)return null;
  const tail=normalized.slice(match[0].length).trim();
  if(!tail)return "today";
  const period=tail.replace(/^(?:de|para|da|do|na|no|nesta|nos)\s+/u,"");
  return periods[period]??null;
}

const ptPeriod:Record<AgendaPeriod,string>={
  today:"hoje",tomorrow:"amanhã",week:"os próximos 7 dias"
};
function formattedEvent(event:GoogleEvent):string {
  const label=event.title.replace(/[\r\n\t]+/g," ").replace(/\s+/g," ").trim().slice(0,120)
    ||"(Sem título)";
  if(event.allDay){
    const day=/^(\d{4})-(\d{2})-(\d{2})$/u.exec(event.start);
    return (day?day[3]+"/"+day[2]+"/"+day[1]:event.start)
      +" · Dia inteiro — "+label;
  }
  const at=new Date(event.start);
  const date=Number.isFinite(at.getTime())
    ?new Intl.DateTimeFormat("pt-BR",{
      timeZone:"America/Sao_Paulo",day:"2-digit",month:"2-digit",
      hour:"2-digit",minute:"2-digit"
    }).format(at):"Horário indisponível";
  return date+" — "+label;
}
export function googleCalendarChatAnswer(snapshot:GoogleEventsSnapshot):string {
  const intro="Eventos do calendário principal do Google para "+
    ptPeriod[snapshot.period]+" (horário de São Paulo).";
  if(!snapshot.events.length){
    return intro+"\nNenhum evento retornado neste período."+
      (snapshot.truncated?" O Google indicou outros resultados não carregados.":"");
  }
  const preview=snapshot.events.slice(0,10).map(e=>"• "+formattedEvent(e)).join("\n");
  return intro+"\n"+preview+
    (snapshot.events.length>10||snapshot.truncated
      ?"\nEsta é uma lista parcial. Consulte a aba Google Agenda para os detalhes.":"")+
    "\nSão eventos Google consultados ao vivo; não são lembretes internos do CORTEX."+
    " Pedidos sobre reuniões mostram os eventos do período, sem filtrar automaticamente o tipo.";
}
