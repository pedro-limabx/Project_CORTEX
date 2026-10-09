import {validateNewSchedule} from "./recurrence.js";
import {ReminderInputError} from "./service.js";
export type RecurringCommand =
  {kind:"proposal";title:string;frequency:"DAILY"|"WEEKLY";weekday:number|null;
    time:string;timeZone:"America/Sao_Paulo";nextDueAt:string}
  |{kind:"help";message:string};
const weekdays:Record<string,number>={domingo:0,segunda:1,terca:2,quarta:3,quinta:4,sexta:5,sabado:6};
const hourPattern="(\\d{1,2})(?:h(\\d{2})?|:(\\d{2}))";
const hint="Exemplos: Lembre-me todos os dias às 7h de verificar meus compromissos; Lembre-me toda segunda-feira às 9h de conferir a agenda.";
export function interpretRecurringReminder(text:string,now=new Date()):RecurringCommand|null{
  const normalized=text.normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim();
  const lead=/^(?:lembre[\s-]*me|me lembre|crie um lembrete(?: para mim)?)(?:\s+(?:de|para))?\s+(.+)$/iu.exec(normalized);
  if(!lead)return null;
  const command=(lead[1]??"").trim();
  if(!/\b(todos os dias|toda|todo)\b/iu.test(command))return null;
  if(command.length>320)return {kind:"help",message:"Comando muito longo. "+hint};
  const daily=new RegExp("^todos os dias\\s+as\\s+"+hourPattern+"\\s+de\\s+(.+)$","iu").exec(command);
  const weekly=new RegExp("^tod[ao]\\s+(segunda|terca|quarta|quinta|sexta|sabado|domingo)(?:-feira)?\\s+as\\s+"+hourPattern+"\\s+de\\s+(.+)$","iu").exec(command);
  if(!daily&&!weekly)return {kind:"help",message:"Não entendi dia, hora ou assunto. "+hint};
  const match=(daily??weekly)!;
  const title=(daily?match[4]:match[5])?.trim().replace(/[.!?]+$/u,"").trim()??"";
  const hour=daily?match[1]:match[2];
  const minute=daily?(match[2]??match[3]):(match[3]??match[4]);
  const frequency=daily?"DAILY":"WEEKLY";
  const weekday=weekly?weekdays[(match[1]??"").toLowerCase()]??null:null;
  const time=(hour??"").padStart(2,"0")+":"+(minute??"00");
  try{
    const data=validateNewSchedule({title,frequency,time,
      ...(frequency==="WEEKLY"?{weekday}:{})},now);
    return {kind:"proposal",title:data.title,frequency:data.frequency,
      weekday:data.weekday,time:data.localTime,timeZone:data.timeZone,nextDueAt:data.nextDueAt};
  }catch(error){
    return {kind:"help",message:(error instanceof ReminderInputError?error.message:"Regra inválida")+". "+hint};
  }
}
