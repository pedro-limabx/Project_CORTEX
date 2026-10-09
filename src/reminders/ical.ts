// V17: RFC 5545 iCalendar snapshot export. No calendar account/network calls.
// Titles are private; never log ICS bodies or expose credentials in URLs.
import {createHash} from "node:crypto";
import type {AgendaSnapshot} from "./agenda.js";

const CRLF="\r\n";
export class CalendarExportTooLargeError extends Error {}

// Escape TEXT property values and strip control characters to prevent
// calendar line injection. The caller must not pass raw property names.
export function escapeCalendarText(input:string):string {
  return input.replace(/\r\n|\r|\n/g,"\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,"")
    .replace(/\\/g,"\\\\")
    .replace(/,/g,"\\,")
    .replace(/;/g,"\\;")
    .replace(/\n/g,"\\n");
}
// RFC 5545 §3.1: physical lines SHOULD be <= 75 UTF-8 octets; fold on
// Unicode code-point boundaries. Continuation lines start with a space.
export function foldCalendarLine(line:string):string {
  let output="",width=0;
  for(const codePoint of line){
    const length=Buffer.byteLength(codePoint,"utf8");
    if(width+length>75){output+=CRLF+" ";width=1;}
    output+=codePoint;
    width+=length;
  }
  return output;
}
function utcStamp(value:string):string {
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))throw new Error("Data de calendário inválida");
  return date.toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z");
}
function calendarUid(owner:string,id:string):string {
  // Stable across manual re-exports, without exposing raw user/record IDs.
  const hash=createHash("sha256").update(owner).update("\0").update(id).digest("hex");
  return hash+"@cortex.local";
}
export function exportAgendaIcs(snapshot:AgendaSnapshot,owner:string):string {
  if(snapshot.truncated)throw new CalendarExportTooLargeError(
    "A agenda ultrapassa o limite de 30 itens. Exporte um período menor para evitar perda de compromissos.");
  if(!owner)throw new Error("A identidade do usuário não pode estar vazia");
  const lines=[
    "BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//CORTEX//Agenda Export V17//PT-BR",
    "CALSCALE:GREGORIAN","X-WR-CALNAME:CORTEX - Importação manual",
    "X-WR-TIMEZONE:America/Sao_Paulo"
  ];
  for(const item of snapshot.items){
    const projected=item.source==="recurrence-preview";
    const label=projected?"[Previsão] "+item.title:item.title;
    const description=projected
      ? "Ocorrência prevista pelo CORTEX. Ainda não foi criada como lembrete no sistema. Importação manual: futuras alterações não são sincronizadas."
      : "Lembrete salvo no CORTEX. Importação manual: alterações futuras não são sincronizadas.";
    lines.push(
      "BEGIN:VEVENT",
      "UID:"+calendarUid(owner,item.id),
      "DTSTAMP:"+utcStamp(snapshot.generatedAt),
      "DTSTART:"+utcStamp(item.dueAt),
      // No arbitrary duration: each calendar event represents an instant.
      "SUMMARY:"+escapeCalendarText(label),
      "DESCRIPTION:"+escapeCalendarText(description),
      "TRANSP:TRANSPARENT",
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldCalendarLine).join(CRLF)+CRLF;
}
