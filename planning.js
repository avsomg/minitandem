/* Pure planning helpers. Public facts and private visit records remain separate.
   Nothing here is shown to a visitor as written: functions return keys, codes and card content, and the interface looks the
   words up in the language dictionaries. Errors carry a stable code besides an English message for logs and the service. */
(() => {
  'use strict';
  const fail = (code, message) => Object.assign(Error(message || code), {code});
  const scenario = a => a.practical?.scenario || ({self:'visit',event:'event',group:'course',individual:'course'}[a.format]);
  const addDays = (date,n) => {const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
  function range(mode,date,month) {
    if(mode==='today')return [date,date];
    if(mode==='week')return [date,addDays(date,6)];
    if(mode==='weekend'){
      const day=new Date(date+'T12:00:00Z').getUTCDay();
      const start=day===0?date:addDays(date,(6-day+7)%7);
      return [start,day===0?date:addDays(start,1)];
    }
    if(mode==='month')return [month+'-01',new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0,12)).toISOString().slice(0,10)];
    return [date,'9999-12-31'];
  }
  function matches(a,preset) {
    if(!preset)return true;
    if(preset==='indoor')return a.practical?.indoor?.value===true;
    if(preset==='walkin')return a.practical?.booking?.value===false;
    if(preset==='short')return a.practical?.leave?.value===true || (a.practical?.duration?.value>0 && a.practical.duration.value<=60);
    return false;
  }
  const needKeys=['trial','flexible','small','noCourse','changing','access'];
  function matchesNeeds(a,selected) {
    return [...selected].every(key=>{
      const p=a.practical||{};
      if(key==='small')return Number.isFinite(p.groupSize?.value)&&p.groupSize.value>0&&p.groupSize.value<=6;
      if(key==='noCourse')return p.commitment?.value===false;
      const field={trial:'trial',flexible:'leave',changing:'changing',access:'access'}[key];
      return Boolean(field&&p[field]?.value===true);
    });
  }
  function matchesWhen(a,mode,date,time='00:00') {
    if(!mode)return true;
    const [from,to]=range(mode,date);
    return a.events.some(e=>e.date>=from&&e.date<=to&&(e.date!==date||!e.end||e.end>=time));
  }
  const facilityKeys=['indoor','duration','access','changing','toilet','feeding','playArea','parking'];
  const attendanceKeys=['','went','missed'];
  const usefulnessKeys=['','yes','no'];
  // How old the card's own check date is, in whole days at `today`; null when the card has no valid date (or it lies in the future), so nothing is invented.
  // After STALE_CHECK_DAYS the card page adds a hint; the card's status is not changed by it. 60 days: twice the usual 30-day review window of an
  // active card (reviewAfter), and the lower end of the 60-90 day cycle planned for venues; a term-based schedule can change within that time.
  const STALE_CHECK_DAYS=60;
  function checkAge(a,today) {
    if(!validDate(a?.checked)||!validDate(today))return null;
    const days=Math.round((Date.parse(today+'T12:00:00Z')-Date.parse(a.checked+'T12:00:00Z'))/86400000);
    return days>=0?days:null;
  }
  const checkStale=(a,today)=>{const d=checkAge(a,today);return d!==null&&d>STALE_CHECK_DAYS;};
  const informationKeys=['','enough','missing'];
  // Each warning is {code} (generated here, worded by the interface) or {text} (published card content, shown as written).
  function warnings(a,date) {
    const result=(a.practical?.warnings||[]).map(text=>({text}));
    const add=(code,first=false)=>result[first?'unshift':'push']({code});
    if(a.status==='closed')add('closed',true);
    if(a.status==='excluded')add('archived',true);
    if(a.scheduleValidThrough&&a.scheduleValidThrough<date)add('scheduleExpired');
    else if(a.events.length&&a.events.every(e=>e.date<date))add('datesPassed');
    if(a.reviewAfter&&a.reviewAfter<date)add('reviewDue');
    if(a.practical?.booking?.value===true)add('bookingRequired');
    if(a.addressPrecision==='area')add('entranceUnknown');
    else if(!a.address)add('placeUnknown');
    if(a.parent==='unknown')add('adultUnconfirmed');
    if(a.priceKind==='unknown')add('priceUnclear');
    if(!a.languages.length&&a.format!=='self')add('languageUnconfirmed');
    if(a.min===null&&a.max===null&&!a.ageException)add('ageNotPublished');
    if(a.status==='check'&&!result.length)add('confirmWithOrganiser');
    const seen=new Set();
    return result.filter(w=>{const key=w.code?'c:'+w.code:'t:'+w.text;if(seen.has(key))return false;seen.add(key);return true;});
  }
  const visitFieldKeys=['booking','observe','trial','leave','commitment','groupSize','leader','standardGerman'];
  // value: true/false/null as published; text: card content or '' when nothing is published for that condition.
  function visit(a) {
    return [{key:'parent',value:a.parent==='yes'?true:a.parent==='no'?false:null,text:a.parentDetails||'',source:a.sources[0]?.url},
      ...visitFieldKeys.map(key=>({key,value:a.practical?.[key]?.value??null,text:a.practical?.[key]?.text||'',source:a.practical?.[key]?.source}))];
  }
  function shareIds(value,allowed) {
    if(typeof value!=='string'||value.length>4000)return [];
    return [...new Set(value.split(',').filter(id=>/^[a-z0-9-]{1,80}$/.test(id)&&allowed.has(id)))].slice(0,50);
  }
  function shareURL(base,ids,allowed) {
    const clean=shareIds(ids.join(','),allowed);
    if(!clean.length)throw fail('share.none','Choose at least one place.');
    const url=new URL(base);url.search='';url.hash=new URLSearchParams({view:'shared',list:clean.join(',')}).toString();return url.href;
  }
  function familyPrice(a,childAges,adults) {
    const tariff=a.practical?.tariff;
    if(!tariff)return null;
    const ages=Array.isArray(childAges)?childAges:[childAges];
    if(!ages.length||ages.length>6||!Number.isInteger(adults)||adults<1||adults>4)return null;
    const children=ages.map(age=>tariff.children.find(t=>Number.isFinite(age)&&age>=t.min&&age<t.until));
    if(children.some(child=>!child))return null;
    return {total:children.reduce((sum,child)=>sum+child.price,adults*tariff.adult),adultTotal:adults*tariff.adult,childTotals:children.map(child=>child.price),text:tariff.note,source:tariff.source};
  }
  // From this age on, suitability is uncertain (not excluded). Only a real number is a bound: a missing field and null (how an editor clears it)
  // mean there is none, and 0 is a bound like any other. One rule for the match (catalogue.js ageFit) and for the reasons below.
  const ageUncertain=(a,age)=>Number.isFinite(a.ageUpperUncertainFrom)&&age>=a.ageUpperUncertainFrom;
  // The age has reached the card's minimum. A whole age stands for that birthday, except 0: the first year, 0-11 months, so every minimum
  // under 1 year (4 or 6 months) is reached. No minimum published: false (the caller decides what that means).
  const ageFrom=(a,age)=>a.min!==null&&(age===0?a.min<1:age>=a.min);
  // Reasons are codes; the interface words them.
  function matchReasons(a,age,parentRequired,walkinRequired,date) {
    const reasons=[];
    if(age!==null){
      if(ageFrom(a,age)&&(a.max===null||age<=a.max)&&!ageUncertain(a,age))reasons.push('ageInRange');
      else reasons.push('ageToConfirm');
    }
    if(parentRequired&&a.parent==='yes')reasons.push('adultJoins');
    if(walkinRequired&&a.practical?.booking?.value===false)reasons.push('noBookingBySource');
    if(date&&a.events.some(e=>e.date===date))reasons.push('publishedDate');
    return reasons;
  }
  // ---- Notices that are over ----
  // A notice that names a date or a range of dates, all behind us, is no longer news: "Closed 3-10 October 2026" on the 17th, "The next
  // published meeting is 15 October 2026" on the 16th. It is not shown; the data keep it. The dates are read as the editorial alarm reads
  // them (editorial/alarm.mjs lineDates, in English, German and French), and the same "still in force" rule applies: a closure "since /
  // from" a past date, or without an end, is still in force and stays; only an explicit end in the past makes a notice obsolete.
  // Conservative on top of that: every date of the clause must carry its year (a day and month alone may be a yearly closure, as
  // "Closed on 25 December"; the alarm guesses the year, this does not), a closure, cancellation or "next" word must come right before
  // the first date (within 60 characters, no weekday between), and a bare year is no date. Anything else stays. The unit is the clause
  // (a sentence, or a part between ";" and the dot), so one obsolete clause of a paragraph goes and the rest stays.
  const MONTHS={januar:1,jänner:1,janvier:1,january:1,jan:1,februar:2,février:2,fevrier:2,february:2,feb:2,févr:2,fév:2,märz:3,maerz:3,mars:3,march:3,mär:3,april:4,avril:4,apr:4,avr:4,
    mai:5,may:5,juni:6,juin:6,june:6,jun:6,juli:7,juillet:7,july:7,jul:7,juil:7,august:8,août:8,aout:8,aug:8,september:9,septembre:9,sept:9,sep:9,oktober:10,octobre:10,october:10,okt:10,oct:10,
    november:11,novembre:11,nov:11,dezember:12,décembre:12,decembre:12,december:12,dez:12,déc:12,dec:12};
  const MONTH_RE=Object.keys(MONTHS).sort((a,b)=>b.length-a.length).join('|');
  const NUMERIC_DATE=/(?<!\d)(\d{1,2})\.\s?(\d{1,2})\.(?:\s?(\d{4}|\d{2})(?!\d))?|(?<!\d)(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?!\d)/gu;
  const NAMED_DATE=new RegExp(`(?<!\\d)(\\d{1,2})(?:er)?\\.?\\s(${MONTH_RE})\\.?(?:\\s(\\d{4}))?(?![\\p{L}\\p{N}])`,'giu');
  const word=source=>new RegExp(`(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`,'iu');
  const DATE_AHEAD=`(?:(?:dem|le|la|the|den|der|l')\\s*)?(?:\\d{1,2}(?:er)?\\.?\\s?(?:\\d{1,2}[./]|(?:${MONTH_RE})(?![\\p{L}]))|(?:${MONTH_RE})(?![\\p{L}])|20\\d\\d(?!\\d))`;
  const SINCE=new RegExp(`(?<![\\p{L}\\p{N}])(?:seit|depuis|since|ab|dès|from|as of|per|à partir (?:du|de))\\s+${DATE_AHEAD}`,'iu');
  const UNTIL=new RegExp(`(?<![\\p{L}\\p{N}])(?:bis(?: zum| und mit| am| ende)?|jusqu'(?:au|à|en|a)|until|till|through|thru|au|à|to)\\s+${DATE_AHEAD}|(?<=[\\d.])\\s*[–-]\\s*${DATE_AHEAD}`,'iu');
  const START=new RegExp(`(?<![\\p{L}\\p{N}])(?:starts?|started|begins?|began|beginning|beginnt|startet|débute|commence)(?:\\s+(?:on|am|le|the|den|dem|vom|du))?\\s+${DATE_AHEAD}`,'iu');
  const LASTING=word(['permanently','permanent closure','closed for good','until further notice','indefinitely','no longer (?:available|offered|takes? place)','dauerhaft','definitiv','endgültig','unbefristet',
    'bis auf weiteres','auf unbestimmte zeit','betriebsaufgabe','aufgelöst','nicht (?:mehr )?weitergeführt','définitivement','définitives?',"jusqu'à nouvel (?:avis|ordre)",'durée indéterminée',
    "cessation d'activités?","n'est plus (?:proposée?|organisée?)"].join('|'));
  const NOTICE_CUE=new RegExp(`(?<![\\p{L}\\p{N}])(?:closed?|closures?|shut|renovations?|refurbishment|cancell?ed|postponed|suspended|unavailab\\p{L}*|next(?! to)|upcoming|geschlossen|schliessung|schliesst|nichtverfügbar\\p{L}*|gesperrt|sperrung|umbau|sanierung|bauarbeiten|abgesagt|verschoben|`+
    `nächste[nrsm]?|kommende[nrsm]?|fermé\\p{L}*|fermetures?|indisponib\\p{L}*|inaccessib\\p{L}*|travaux|rénovations?|annulé\\p{L}*|reporté\\p{L}*|suspendu\\p{L}*|prochain\\p{L}*)(?![\\p{L}\\p{N}])`,'giu');
  // A weekday between the closure word and the date means a standing rule ("Closed on Mondays and 5-9 October 2026"): the clause stays.
  // A weekday right before the date only names the day ("Closed on Tuesday 6 October 2026").
  const WEEKDAY_SOURCE="(?:mon|tues|wednes|thurs|fri|satur|sun)days?|(?:mon|diens|donners|frei|sams|sonn)tags?|mittwochs?|(?:lun|mar|mercre|jeu|vendre|same)dis?|dimanches?|wochenend\\p{L}*|week-?ends?";
  const WEEKDAY=word(WEEKDAY_SOURCE),WEEKDAY_LAST=new RegExp(`(?<![\\p{L}\\p{N}])(?:${WEEKDAY_SOURCE})[\\s.,]*$`,'iu');
  const noticeKey=text=>String(text).normalize('NFC').toLowerCase().replace(/ß/g,'ss').replace(/[’‘ʼ´`]/g,"'").replace(/[\u00a0\u202f\u2007\u2009]/g,' ').replace(/\s+/g,' ').trim();
  const YEAR=/(?<!\d)(20\d\d)(?!\d)/g;
  // The calendar days a text names, as {day:'YYYY-MM-DD', at:position}, and the days it names without a year, and the bare years left over.
  function noticeDays(key) {
    const found=[],rest=[];let yearless=0;
    const add=(match,d,m,y)=>{
      if(m<1||m>12||d<1||d>31)return;
      rest.push([match.index,match[0].length]);
      if(y)found.push({day:new Date(Date.UTC(y.length===2?2000+Number(y):Number(y),m-1,d)).toISOString().slice(0,10),at:match.index});else yearless++;
    };
    for(const x of key.matchAll(NUMERIC_DATE))add(x,Number(x[1]??x[4]),Number(x[2]??x[5]),x[3]??x[6]);
    for(const x of key.matchAll(NAMED_DATE))add(x,Number(x[1]),MONTHS[x[2].toLowerCase()],x[3]);
    let blank=key;for(const [at,length] of rest)blank=blank.slice(0,at)+' '.repeat(length)+blank.slice(at+length);
    return {days:found.sort((a,b)=>a.at-b.at),yearless,years:[...blank.matchAll(YEAR)].map(m=>Number(m[1]))};
  }
  // true: this clause is a notice whose dates are all over and which is not still in force.
  function pastNotice(clause,today) {
    const key=noticeKey(clause),{days,yearless,years}=noticeDays(key);
    if(!days.length||yearless||days.some(d=>d.day>=today)||years.some(y=>y>=Number(today.slice(0,4))))return false;
    if(LASTING.test(key)||(SINCE.test(key)||START.test(key))&&!UNTIL.test(key))return false;
    return [...key.matchAll(NOTICE_CUE)].some(cue=>{const gap=key.slice(cue.index+cue[0].length,days[0].at);return cue.index<days[0].at&&gap.length<=60&&!/[!?]/.test(gap)&&!WEEKDAY.test(gap.replace(WEEKDAY_LAST,''));});
  }
  // A text without its obsolete clauses ('' when nothing is left). "15. Oktober" is a date, not the end of a sentence; a part that is
  // taken out takes its separator with it, and a text that began with a capital letter still does.
  const CLAUSE_END=/\s*[;·]\s*|[.!?]\s+(?=[A-ZÀ-ÖØ-Þ“"«])/gu,MONTH_NEXT=new RegExp(`^(?:${MONTH_RE})(?![\\p{L}])`,'iu');
  function withoutPastNotices(text,today) {
    if(typeof text!=='string'||!text)return text;
    const parts=[];let start=0,sep='';
    for(const m of text.matchAll(CLAUSE_END)){
      const sentence=/[.!?]/.test(m[0][0]);
      if(sentence&&m[0][0]==='.'&&/\d$/.test(text.slice(0,m.index))&&MONTH_NEXT.test(text.slice(m.index+m[0].length)))continue;
      parts.push({sep,clause:text.slice(start,m.index+(sentence?1:0))});sep=sentence?m[0].slice(1):m[0];start=m.index+m[0].length;
    }
    parts.push({sep,clause:text.slice(start)});
    let out='',pending=null,dropped=false;
    for(const p of parts){
      if(pastNotice(p.clause,today)){dropped=true;if(pending===null)pending=p.sep;continue;}
      const joined=out?pending??p.sep:'';
      // What follows a taken-out clause starts a sentence when the text before it ended one (or began with a capital itself).
      out+=joined+(pending!==null&&(out?/[.!?]$/.test(out):/^\p{Lu}/u.test(text))?p.clause.replace(/^\p{Ll}/u,c=>c.toUpperCase()):p.clause);pending=null;
    }
    if(!dropped)return text;
    if(/[.!?]$/.test(text)&&out&&!/[.!?]$/.test(out))out+='.';
    return out;
  }
  // The card as the visitor reads it today: the same card, or a copy without the obsolete clauses in the texts a notice can stand in
  // (introduction, schedule, good-to-know, practical conditions and warnings, what was checked, what is left to confirm). A text that
  // would be left empty stays, except in a list, where the entry goes. The key `english` of a translated card is kept.
  function current(a,today) {
    if(!a||!validDate(today))return a;
    let changed=false;
    const text=(value,keep)=>{const out=withoutPastNotices(value,today);if(out===value||(!out&&keep))return value;changed=true;return out;};
    const list=items=>Array.isArray(items)?items.map(item=>text(item)).filter(Boolean):items;
    const copy={...a,intro:text(a.intro,true),schedule:text(a.schedule,true),notes:list(a.notes)};
    if(a.practical)copy.practical=Object.fromEntries(Object.entries(a.practical).map(([key,value])=>[key,key==='warnings'?list(value):value&&typeof value.text==='string'?{...value,text:text(value.text)}:value]));
    if(a.research)copy.research={...a.research,findings:(a.research.findings||[]).map(f=>({...f,text:text(f.text)})).filter(f=>f.text),remaining:list(a.research.remaining||[])};
    if(!changed)return a;
    if(a.english)Object.defineProperty(copy,'english',{value:a.english});
    return copy;
  }
  const admissionKeys=['dropin','reservation','course','unknown'];
  function admission(a) {
    // A published course lesson is never an invitation to join an ongoing group.
    if(a.priceKind==='course'||a.practical?.commitment?.value===true)return 'course';
    if(a.practical?.booking?.value===false)return 'dropin';
    if(scenario(a)==='event'&&a.practical?.booking?.value===true)return 'reservation';
    return 'unknown';
  }
  const bookingStateKeys=['unconfirmed','requested','confirmed','notneeded','cancelled'];
  const outcomeKeys=['','repeat','consider','skip'];
  const validDate=value=>typeof value==='string'&&/^20\d{2}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
  const validTime=value=>typeof value==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  const trimText=(value,max)=>typeof value==='string'?value.slice(0,max):'';
  const maxVisits=200;
  function validateVisits(raw,allowed) {
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return {};
    const entries=Object.entries(raw).filter(([id,v])=>/^v-[a-z0-9-]{1,60}$/.test(id)&&v&&allowed.has(v.activity));
    if(entries.length>maxVisits)throw fail('visits.limit','More than 200 visits. Import cancelled, existing records unchanged.');
    return Object.fromEntries(entries.map(([id,v])=>[id,{
      activity:v.activity,date:validDate(v.date)?v.date:'',time:validTime(v.time)?v.time:'',
      booking:bookingStateKeys.includes(v.booking)?v.booking:'unconfirmed',
      reply:trimText(v.reply,2000),bring:trimText(v.bring,1000),observations:trimText(v.observations,3000),outcome:outcomeKeys.includes(v.outcome)?v.outcome:'',
      attendance:attendanceKeys.includes(v.attendance)?v.attendance:'',usefulness:usefulnessKeys.includes(v.usefulness)?v.usefulness:'',information:informationKeys.includes(v.information)?v.information:'',
      ...Object.fromEntries(Array.from({length:20},(_,i)=>['pack'+i,v['pack'+i]===true]))
    }]));
  }
  function mergeVisits(latest,current,baseline) {
    const result=structuredClone(latest||{});
    for(const [id,visit] of Object.entries(current||{})){
      for(const [key,value] of Object.entries(visit))if(value!==baseline?.[id]?.[key]){
        result[id]??={};result[id][key]=value;
      }
    }
    return result;
  }
  // What a saved card is compared against later. Values are language-neutral (card content, codes, empty strings), so changing
  // the interface language never looks like a change. rev marks this layout; older snapshots are dropped and re-taken.
  const trackedFieldKeys=['price','schedule','address','age','parent','languages','status','events','conditions'];
  const SNAPSHOT_REV=2;
  function snapshot(a,date) {
    return {date,rev:SNAPSHOT_REV,fields:{price:a.price,schedule:a.schedule,address:a.address||'',age:a.age,parent:a.parentDetails||a.parent,languages:a.languages.slice().sort().join(', '),status:a.status,
      events:a.events.map(e=>[e.date,e.start||'',e.end||'',e.title||'',e.address||a.address||''].join(' ')).sort().join('\n'),
      conditions:visit(a).filter(c=>c.key!=='parent').map(c=>c.key+': '+c.text).join('\n')
    }};
  }
  function validateTracked(raw,allowed) {
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return {};
    return Object.fromEntries(Object.entries(raw).filter(([id,v])=>allowed.has(id)&&v&&v.rev===SNAPSHOT_REV&&validDate(v.date)&&v.fields&&trackedFieldKeys.every(k=>typeof v.fields[k]==='string')).map(([id,v])=>[id,{date:v.date,rev:SNAPSHOT_REV,fields:Object.fromEntries(trackedFieldKeys.map(k=>[k,v.fields[k].slice(0,12000)]))}]));
  }
  function changes(a,previous) {
    if(!previous)return [];
    const current=snapshot(a,previous.date);
    return trackedFieldKeys.filter(key=>previous.fields[key]!==current.fields[key]).map(key=>({key,before:previous.fields[key],after:current.fields[key]}));
  }
  window.MinitandemPlanning={STALE_CHECK_DAYS,checkAge,checkStale,scenario,range,matches,needKeys,matchesNeeds,matchesWhen,facilityKeys,attendanceKeys,usefulnessKeys,informationKeys,warnings,ageUncertain,ageFrom,visit,visitFieldKeys,shareIds,shareURL,familyPrice,matchReasons,pastNotice,withoutPastNotices,noticeDays,current,admission,admissionKeys,bookingStateKeys,outcomeKeys,validDate,validTime,validateVisits,mergeVisits,snapshot,validateTracked,changes,trackedFieldKeys,maxVisits,fail};
})();
