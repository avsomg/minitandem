import ICAL from 'ical.js';

export function swissStamp(time){
  if(!time)return null;
  if(time.isDate)return {date:time.toString(),time:''};
  if(time.zone===ICAL.Timezone.localTimezone)throw Error('Calendar timezone is unresolved');
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Zurich',
    year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
    .formatToParts(time.toJSDate()).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
  return {date:`${parts.year}-${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}`};
}
export function withCalendarZones(calendar,fn){
  const zones=calendar.getAllSubcomponents('vtimezone');
  const previousZones=new Map(zones.map(component=>{
    const id=component.getFirstPropertyValue('tzid');return [id,ICAL.TimezoneService.get(id)];
  }));
  for(const component of zones)ICAL.TimezoneService.register(component.getFirstPropertyValue('tzid'),new ICAL.Timezone({component}));
  try{return fn();}
  finally{for(const [id,previous] of previousZones){
    if(previous)ICAL.TimezoneService.register(id,previous);else ICAL.TimezoneService.remove(id);
  }}
}
