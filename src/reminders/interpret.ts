// V13 deterministic, deliberately limited PT-BR reminder grammar.
// Parsing is only a proposal: saving requires a separate user confirmation.
// All local dates are interpreted in the fixed, disclosed São Paulo timezone.
import { validateNewReminder, ReminderInputError } from "./service.js";
export const REMINDER_TIME_ZONE = "America/Sao_Paulo";

export type ReminderDraft =
  { kind: "proposal"; title: string; dueAt: string; timeZone: typeof REMINDER_TIME_ZONE }
  | { kind: "help"; message: string };

function localParts(date: Date): {year:number;month:number;day:number;hour:number;minute:number} {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: REMINDER_TIME_ZONE, hourCycle:"h23",
    year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"
  });
  const parts = Object.fromEntries(formatter.formatToParts(date)
    .filter(p => p.type !== "literal").map(p=>[p.type,Number(p.value)]));
  return {year:parts.year!,month:parts.month!,day:parts.day!,hour:parts.hour!,minute:parts.minute!};
}
function zonedUtc(year:number,month:number,day:number,hour:number,minute:number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const wall = Date.UTC(year,month-1,day,hour,minute);
  const guess = new Date(wall);
  const local = localParts(guess);
  const localAsUtc = Date.UTC(local.year,local.month-1,local.day,local.hour,local.minute);
  const candidate = new Date(wall - (localAsUtc - wall));
  const checked = localParts(candidate);
  return checked.year === year && checked.month === month && checked.day === day
    && checked.hour === hour && checked.minute === minute ? candidate : null;
}
function normalizedTitle(text:string): string {
  return text.trim().replace(/^de\s+/iu,"").replace(/[.!?]+$/u,"").trim();
}
const HOUR = "(\\d{1,2})(?:h|:)(\\d{2})?\\b"; // 14h, 14h30, 14:30
const EXAMPLE = "Exemplos: “Lembre-me amanhã às 14h de revisar o projeto” ou “Lembre-me de beber água em 30 minutos”.";

export function interpretReminder(text: string, now = new Date()): ReminderDraft | null {
  const lead = /^\s*(?:lembre[\s-]*me|me lembre|crie um lembrete(?: para mim)?)(?:\s+(?:de|para))?\s+(.+)\s*$/iu.exec(text);
  if (!lead) return null;
  const command = (lead[1] ?? "").trim();
  if (!command || command.length > 350) return {kind:"help",message:"Descreva um lembrete curto. "+EXAMPLE};
  let title = "";
  let due: Date | null = null;
  const duration = /\bem\s+(\d{1,5})\s+(minutos?|horas?|dias?)\b/iu.exec(command);
  if (duration) {
    const count = Number(duration[1]), unit = (duration[2] ?? "").toLowerCase();
    const factor = unit.startsWith("minuto") ? 60_000 : unit.startsWith("hora") ? 3_600_000 : 86_400_000;
    if (count > 0) due = new Date(now.getTime()+count*factor);
    title = normalizedTitle((command.slice(0,duration.index)+" "+command.slice(duration.index+duration[0].length)).trim());
  } else {
    const dateTime = new RegExp("\\b(hoje|amanhã|amanha|dia\\s+(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4}))\\s+às?\\s+"+HOUR,"iu");
    const match = dateTime.exec(command);
    if (match) {
      const ref = localParts(now);
      let year = ref.year,month = ref.month,day = ref.day;
      if (/^amanh/iu.test(match[1] ?? "")) {
        const next = new Date(Date.UTC(year,month-1,day+1,12,0));
        const nextDate = localParts(next);
        year=nextDate.year;month=nextDate.month;day=nextDate.day;
      } else if (/^dia/iu.test(match[1] ?? "")) {
        day=Number(match[2]);month=Number(match[3]);year=Number(match[4]);
      }
      due = zonedUtc(year,month,day,Number(match[5]),Number(match[6] ?? "0"));
      title = normalizedTitle((command.slice(0,match.index)+" "+command.slice(match.index+match[0].length)).trim());
    }
  }
  if (!due || !title) return {kind:"help",message:"Preciso do assunto e de uma data/hora específica. "+EXAMPLE};
  try {
    const validated = validateNewReminder({title,dueAt:due.toISOString()},now);
    return {kind:"proposal",...validated,timeZone:REMINDER_TIME_ZONE};
  } catch(error) {
    return {kind:"help",message:error instanceof ReminderInputError ? error.message+" "+EXAMPLE : "Data inválida. "+EXAMPLE};
  }
}
