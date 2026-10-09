// V15: bounded, deterministic recurring reminders in São Paulo civil time.
import {ReminderInputError} from "./service.js";

export const RECURRENCE_ZONE = "America/Sao_Paulo" as const;
export type Frequency = "DAILY" | "WEEKLY";
export type ScheduleStatus = "ACTIVE" | "PAUSED" | "CANCELLED";
export type NewSchedule = {
  title:string; frequency:Frequency; weekday:number|null;
  localTime:string; timeZone:typeof RECURRENCE_ZONE; nextDueAt:string;
};
type Parts = {year:number;month:number;day:number;hour:number;minute:number};

const format = new Intl.DateTimeFormat("en-GB", {
  timeZone:RECURRENCE_ZONE,year:"numeric",month:"2-digit",day:"2-digit",
  hour:"2-digit",minute:"2-digit",hourCycle:"h23"
});
function parts(date:Date):Parts {
  const obj = Object.fromEntries(format.formatToParts(date).filter(x=>x.type!=="literal")
    .map(x=>[x.type,Number(x.value)]));
  return {year:obj.year!,month:obj.month!,day:obj.day!,hour:obj.hour!,minute:obj.minute!};
}
function utcFromCivil(year:number,month:number,day:number,hour:number,minute:number):Date|null {
  const wall=Date.UTC(year,month-1,day,hour,minute);
  let utc=wall;
  for(let i=0;i<4;i++){
    const local=parts(new Date(utc));
    const got=Date.UTC(local.year,local.month-1,local.day,local.hour,local.minute);
    if(got===wall) break;
    utc+=wall-got;
  }
  const date=new Date(utc);
  const check=parts(date);
  return check.year===year&&check.month===month&&check.day===day
    &&check.hour===hour&&check.minute===minute?date:null;
}

export function nextRecurrenceAfter(after:Date,frequency:Frequency,localTime:string,weekday:number|null):Date {
  if(!Number.isFinite(after.getTime()) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(localTime)
      || !["DAILY","WEEKLY"].includes(frequency)
      || (frequency==="WEEKLY" && (!Number.isInteger(weekday) || weekday===null || weekday<0 || weekday>6))
      || (frequency==="DAILY" && weekday!==null)) throw new ReminderInputError("Regra de recorrência inválida");
  const [hh,mm]=localTime.split(":").map(Number);
  const local=parts(after);
  const dayStart=Date.UTC(local.year,local.month-1,local.day);
  for(let day=0;day<=14;day++){
    const civil=new Date(dayStart+day*86_400_000);
    if(frequency==="WEEKLY"&&civil.getUTCDay()!==weekday)continue;
    const candidate=utcFromCivil(civil.getUTCFullYear(),civil.getUTCMonth()+1,
      civil.getUTCDate(),hh!,mm!);
    if(candidate&&candidate.getTime()>after.getTime())return candidate;
  }
  throw new ReminderInputError("Não foi possível calcular a próxima ocorrência");
}

export function validateNewSchedule(value:unknown,now=new Date()):NewSchedule {
  if(!value||Array.isArray(value)||typeof value!=="object")
    throw new ReminderInputError("Informe assunto, frequência e horário");
  const body=value as Record<string,unknown>;
  if(Object.keys(body).some(x=>!["title","frequency","weekday","time"].includes(x))
      ||typeof body.title!=="string"||typeof body.frequency!=="string"
      ||typeof body.time!=="string")
    throw new ReminderInputError("Use title, frequency, time e weekday (somente semanal)");
  const title=body.title.trim(),frequency=body.frequency;
  if(title.length<1||title.length>160)throw new ReminderInputError("Título deve ter 1–160 caracteres");
  if(frequency!=="DAILY"&&frequency!=="WEEKLY")throw new ReminderInputError("Frequência deve ser DAILY ou WEEKLY");
  if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.time))
    throw new ReminderInputError("Horário deve ser HH:MM");
  const weekday=frequency==="WEEKLY"?body.weekday:null;
  if(frequency==="DAILY"&&body.weekday!==undefined)
    throw new ReminderInputError("Recorrência diária não aceita weekday");
  if(frequency==="WEEKLY"&&(!Number.isInteger(weekday)||typeof weekday!=="number"
      ||weekday<0||weekday>6))
    throw new ReminderInputError("weekday deve ser inteiro entre 0 (domingo) e 6 (sábado)");
  const next=nextRecurrenceAfter(new Date(now.getTime()+60_000),
    frequency,body.time,weekday as number|null);
  return {title,frequency,weekday:weekday as number|null,localTime:body.time,
    timeZone:RECURRENCE_ZONE,nextDueAt:next.toISOString()};
}
