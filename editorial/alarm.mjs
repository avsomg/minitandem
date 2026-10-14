// Alarm lines: notices of closure, works, cancellation, postponement, breaks, full courses, last editions, moves, suspensions,
// reopenings and vanished pages in the full text of a source page. Pure module: no I/O; the clock is read only when `now` is omitted.
// The monitor compares the keys of these lines with the keys it saw last time; only a new line becomes a task, and a task never
// changes a card by itself (METHOD.md, OPERATIONS.md). Word lists: German, French and English, Swiss words included; a strong term
// raises a line on its own, a weak term only with a date, a "until/from" word or a strong term on the same line.

export const ALARM_PARSER='alarm-v1';
export const LONG_DOCUMENT_CHARS=20_000;
export const MAX_KEYS=100;
const HISTORY_MAX=30,WINDOW_DAYS=30,ANCHOR_RADIUS=5,DAY=86_400_000;

const GS='[^.!?;]{0,60}?'; // a gap inside one sentence ("bleibt ... geschlossen")
const GD='[^!?;]{0,40}?';  // a gap that may hold dates ("fermé du 16.11. au 21.11.")

export const ALARM_TERMS={
  closure:{
    de:{strong:['(?:vorübergehend|vorläufig|definitiv|endgültig|dauerhaft) geschlossen',`bleib(?:t|en)${GS} geschlossen`,'schliessung(?:en)?','schliesst (?:per|ende)','betriebsaufgabe','aufgelöst',
      `\\p{L}*(?:angebot|kurs|kurse|gruppe|treff)${GS} (?:eingestellt|beendet)`,'(?:findet|finden) nicht mehr statt','(?:wird|werden) nicht mehr angeboten','nicht (?:mehr )?weitergeführt'],
      weak:['geschlossen']},
    fr:{strong:["fermée?s? (?:temporairement|définitivement|provisoirement|jusqu'à nouvel (?:avis|ordre))",`fermée?s? du${GD} au`,'fermetures? (?:exceptionnelles?|définitives?|temporaires?|provisoires?)',
      "cessation d'activités?",'cesse(?:nt)? (?:ses|leurs) activités','dissolution',"n'est plus (?:proposée?|organisée?)",'ne sont plus (?:proposée?s|organisée?s)'],
      weak:['fermée?s?','fermetures?']},
    en:{strong:['(?:temporarily|permanently) closed','closed until','closure','no longer (?:available|offered|takes? place)'],weak:['closed']}
  },
  works:{
    de:{strong:['umbau(?:arbeiten)?','renovation(?:sarbeiten)?','renovierung(?:sarbeiten)?','sanierung(?:sarbeiten)?','bauarbeiten','revision(?:sarbeiten)?','unterhaltsarbeiten'],weak:['baustelle']},
    fr:{strong:['rénovations?','réfection','en travaux','pour (?:cause de )?travaux','travaux de','vidange','révision annuelle'],weak:['chantier']},
    en:{strong:['renovations?','refurbishment','maintenance work','closed for maintenance'],weak:[]}
  },
  cancel:{
    de:{strong:['abgesagt','absagen?',`(?:fällt|fallen)${GS} aus`,'entfällt','entfallen','annulliert','storniert','gestrichen'],weak:[]},
    fr:{strong:['annulée?s?','annulations?',"n'aura pas lieu","n'auront pas lieu",'supprimée?s?','décommandée?s?'],weak:[]},
    en:{strong:['cancell?ed','cancellations?','will not take place','called off'],weak:[]}
  },
  postpone:{
    de:{strong:['verschoben','verschiebung','neues datum','ersatzdatum','neuer termin',`(?:findet|finden) neu am${GS} statt`],weak:[]},
    fr:{strong:['reportée?s?','report au','nouvelle date','date de remplacement','déplacée?s? au'],weak:[]},
    en:{strong:['postponed','rescheduled','new date'],weak:['moved to']}
  },
  break:{
    de:{strong:['betriebsferien','ferienpause','sommerpause','winterpause','herbstpause','weihnachtspause','saisonpause','saisonende','saisonschluss','saison(?: 20\\d\\d(?:[/-]\\d{2,4})?)? beendet',
      `(?:während|in) (?:den |der )?(?:schul)?ferien${GS} (?:geschlossen|keine|findet nicht statt|finden keine)`,'geschlossen (?:während|in) (?:den |der )?(?:schul)?ferien',
      'keine \\p{L}*(?:treffen|kurse?|lektionen|gruppe)','pausiert','pausieren'],weak:[]},
    fr:{strong:['relâche','pause (?:estivale|hivernale)','fermeture (?:annuelle|estivale|hivernale)','vacances annuelles','fin de (?:la )?saison','saison terminée','pas de (?:cours|rencontres?|séances?|café)',
      `(?:pendant|durant) les vacances${GS} (?:fermée?s?|pas de)`,'fermée?s? (?:pendant|durant) les vacances'],weak:[]},
    en:{strong:['holiday closure','closed for the holidays','(?:summer|winter) break','end of (?:the )?season','no (?:classes|sessions)'],weak:[]}
  },
  full:{
    de:{strong:['ausgebucht','ausverkauft','(?:voll|vollständig) belegt','keine (?:freien )?plätze(?: mehr)?','(?:kurs|gruppe) ist voll','(?:kurse|gruppen) sind voll','anmeldung(?:en)? geschlossen','keine anmeldungen mehr'],weak:['warteliste']},
    fr:{strong:['(?:est|sont) compl(?:ets?|ètes?)','(?:cours|ateliers?|groupes?|stages?) compl(?:ets?|ètes?)','compl(?:ets?|ètes?) ?!','^compl(?:ets?|ètes?)$','plus de places?','inscriptions? (?:closes?|fermées?|terminées?)'],weak:["liste d'attente"]},
    en:{strong:['fully booked','sold out','no (?:places|spaces|spots) left','registrations? (?:is |are )?closed'],weak:['waiting list']}
  },
  last:{
    de:{strong:['zum letzten mal','letztmals','ein letztes mal','letzte (?:durchführung|ausgabe|saison)'],weak:['abschied']},
    fr:{strong:['pour la dernière fois','dernière (?:édition|séance|rencontre|saison)'],weak:[]},
    en:{strong:['for the last time','final (?:session|edition|season)'],weak:[]}
  },
  move:{
    de:{strong:['umgezogen','neue adresse','neuer standort','neues lokal','zügeln','gezügelt','zügelt','umzug (?:nach|in|an)'],weak:[]},
    fr:{strong:['nous avons déménagé','déménagée?s?','nouvelle adresse','nouveau lieu','nouveaux locaux','(?:a|ont) lieu désormais à','transférée?s? à'],weak:['déménagement']},
    en:{strong:['we have moved','new address','new location','relocated'],weak:[]}
  },
  suspend:{
    de:{strong:['bis auf weiteres','sistiert','ausgesetzt','unterbrochen'],weak:[]},
    fr:{strong:["jusqu'à nouvel (?:avis|ordre)",'suspendue?s?','suspension','interrompue?s?'],weak:[]},
    en:{strong:['until further notice','suspended','on hold'],weak:[]}
  },
  reopen:{
    de:{strong:['wiedereröffnung','wieder geöffnet','öffnet wieder'],weak:[]},
    fr:{strong:['réouverture','ré-ouverture','rouvre(?:nt)?'],weak:[]},
    en:{strong:['reopening','re-opening','reopens'],weak:[]}
  },
  'missing-page':{
    de:{strong:['seite nicht gefunden','existiert nicht mehr','nicht mehr verfügbar'],weak:[]},
    fr:{strong:['page introuvable',"n'existe plus",'cette page a été supprimée'],weak:[]},
    en:{strong:['page not found','no longer exists'],weak:[]}
  }
};

// False-alarm rules (applied in this order; see classifyLines). Each list is a set of regex sources matched against the line key.
export const IGNORE_RULES={
  // Interface and consent text: the whole line is skipped.
  ui:['cookies?','datenschutz\\p{L}*','rgpd','gdpr','consent\\p{L}*','einwilligung','newsletter','abonnieren',"s'abonner",'captcha','recaptcha'],
  // Buttons that are a line of their own.
  uiLine:['^(?:menu |menü )?(?:schliessen|fermer|close|zurück|retour|back|accepter|akzeptieren|accept)$'],
  // Words that look like an alarm and are not one; masked before the terms are matched.
  doppelganger:['chaussures (?:\\p{L}+ )?fermées','geschlossene[nrs]? (?:\\p{L}+ )?schuhe','closed[- ]toe','espaces? fermée?s?','geschlossene[nrs]? (?:spielplatz|gelände|raum|areal)','travaux manuels','sans relâche',
    'moments? suspendus?','(?:laternen|räbeliechtli|räbeli|fasnachts|lampions?|fackel)umz[uü]ge?\\p{L}*','ferienpass\\p{L}*','passeports?[- ]vacances','(?:programme|texte|petit-déjeuner|menu|repas|dossier) complet',
    '(?:die )?kommentare sind geschlossen','commentaires (?:sont )?fermés','comments are closed'],
  // Rules and conditions, not events: the whole line is skipped.
  policy:["(?:conditions?|frais|en cas) d'annulation",'assurance[- ]annulation','annull?(?:ierungs|ations)\\p{L}*','stornierungs\\p{L}*','cancellation (?:policy|fees?|terms|conditions)',
    "à l'avance",'im voraus','in advance','bei (?:regen|schlechtem wetter|schlechter witterung|ungünstiger witterung|zu wenigen anmeldungen)',"en cas (?:de pluie|de mauvais temps|de participation insuffisante|d'empêchement)",'votre annulation','jours? de pluie',
    'in case of (?:rain|bad weather)','(?:si|lorsque|quand|wenn|falls|if|when) [^.!?]{0,60}(?:compl(?:ets?|ètes?)|fermée?s?|annulée?s?|geschlossen|abgesagt|ausgebucht|voll|full|closed|cancell?ed)(?![\\p{L}\\p{N}])',
    'kurzfristige?n? (?:absagen|änderungen)','(?:kann|können) [^.!?]{0,60}(?:abgesagt|annulliert|verschoben) werden','peu(?:t|vent) être (?:annulée?s?|reportée?s?)','may be (?:cancell?ed|postponed)'],
  // "Open now / closed now" changes with the hour of the visit. Applies to lines whose terms are all weak.
  live:['(?:actuellement|en ce moment|jetzt|momentan|currently|now)(?: \\p{L}+)? (?:fermée?s?|ouverte?s?|geschlossen|geöffnet|offen|closed|open)','(?:fermée?s?|ouverte?s?|geschlossen|geöffnet|closed|open) (?:now|jetzt|actuellement|en ce moment)'],
  // An office or desk closing is not the venue closing: the line stays, as information only.
  office:['gemeindeverwaltung','stadtverwaltung','verwaltung','gemeindekanzlei','kanzlei','schalter','sekretariat','secrétariat','bureau communal','administration communale','bureau','büro','guichet','office du tourisme','tourist office']
};

const bounded=source=>new RegExp(`(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`,'iu');
const boundedAll=sources=>new RegExp(`(?<![\\p{L}\\p{N}])(?:${sources.join('|')})(?![\\p{L}\\p{N}])`,'giu');
const TERMS=Object.entries(ALARM_TERMS).flatMap(([cat,langs])=>Object.entries(langs).flatMap(([lang,{strong,weak=[]}])=>[
  ...strong.map(term=>({cat,lang,strength:'strong',term,re:bounded(term)})),
  ...weak.map(term=>({cat,lang,strength:'weak',term,re:bounded(term)}))
]));
const RULE=Object.fromEntries(Object.entries(IGNORE_RULES).map(([name,sources])=>[name,name==='doppelganger'?boundedAll(sources):bounded(sources.join('|'))]));
const QUALIFIER=bounded("bis|jusqu'au|jusqu'à|until|ab|dès|from");

const MONTHS={januar:1,jänner:1,janvier:1,january:1,jan:1,februar:2,février:2,fevrier:2,february:2,feb:2,févr:2,fév:2,märz:3,maerz:3,mars:3,march:3,mär:3,april:4,avril:4,apr:4,avr:4,
  mai:5,may:5,juni:6,juin:6,june:6,jun:6,juli:7,juillet:7,july:7,jul:7,juil:7,august:8,août:8,aout:8,aug:8,september:9,septembre:9,sept:9,sep:9,oktober:10,octobre:10,october:10,okt:10,oct:10,
  november:11,novembre:11,nov:11,dezember:12,décembre:12,decembre:12,december:12,dez:12,déc:12,dec:12};
const MONTH_NAMES=Object.keys(MONTHS).sort((a,b)=>b.length-a.length).join('|');
const NUMERIC_DATE=/(?<!\d)(\d{1,2})\.\s?(\d{1,2})\.(?:\s?(\d{4}|\d{2})(?!\d))?|(?<!\d)(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?!\d)/gu;
const NAMED_DATE=new RegExp(`(?<!\\d)(\\d{1,2})(?:er)?\\.?\\s(${MONTH_NAMES})\\.?(?:\\s(\\d{4}))?(?![\\p{L}\\p{N}])`,'giu');
const YEAR=/(?<!\d)(20\d\d)(?:\s?[/–-]\s?(20\d\d|\d{2}))?(?!\d)/gu;
const WEEKDAY=bounded(['(?:mon|diens|donners|frei|sams|sonn)tags?','mittwochs?','ruhetage?','feiertage?n?','(?:lun|mar|mercre|jeu|vendre|same)dis?','dimanches?','(?:mon|tues|wednes|thurs|fri|satur|sun)days?',
  'jours? fériés?','wochenenden?','week-ends?',"(?:mo|di|mi|do|fr|sa|so|lu|ma|me|je|ve|mon|tue|wed|thu|fri|sat|sun)\\.?(?=\\s*(?:[-–:,/&]|$|bis |à |au |to |und |et ))"].join('|'));

const NAMED_ENTITIES={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0',rsquo:'\u2019',lsquo:'\u2018',rdquo:'\u201d',ldquo:'\u201c',laquo:'\u00ab',raquo:'\u00bb',ndash:'\u2013',mdash:'\u2014',
  hellip:'\u2026',szlig:'\u00df',euro:'\u20ac',copy:'\u00a9',shy:'',zwnj:'',zwj:'',thinsp:' ',ensp:' ',emsp:' ',middot:'\u00b7',bull:'\u2022',deg:'\u00b0'};
const MARKS={grave:'\u0300',acute:'\u0301',circ:'\u0302',tilde:'\u0303',uml:'\u0308',cedil:'\u0327',ring:'\u030a'};
// Stored texts of the first parser still hold entities (`&rsquo;`, `&agrave;`); letters with accents are composed from their name.
export function decodeEntities(text){
  return String(text).replace(/&(#x[\da-f]+|#\d+|[a-z]+\d*);/gi,(whole,name)=>{
    if(name[0]==='#'){const code=name[1].toLowerCase()==='x'?parseInt(name.slice(2),16):parseInt(name.slice(1),10);return code>0&&code<0x110000?String.fromCodePoint(code):whole;}
    if(name in NAMED_ENTITIES)return NAMED_ENTITIES[name];
    const lower=name.toLowerCase();
    if(lower in NAMED_ENTITIES&&!/^[A-Z]/.test(name))return NAMED_ENTITIES[lower];
    const accent=name.match(/^([a-zA-Z])(grave|acute|circ|tilde|uml|cedil|ring)$/);
    return accent?(accent[1]+MARKS[accent[2]]).normalize('NFC'):whole;
  });
}

export function normalizeLine(line){
  return String(line).normalize('NFC').toLowerCase().replace(/ß/g,'ss').replace(/[\u2019\u2018\u02bc\u00b4`]/g,"'").replace(/[\u00a0\u202f\u2007\u2009]/g,' ').replace(/\s+/g,' ').trim();
}

const isoDay=date=>date.toISOString().slice(0,10);
const validDay=(d,m)=>m>=1&&m<=12&&d>=1&&d<=31;
function inferYear(d,m,now){
  const year=now.getUTCFullYear(),candidate=Date.UTC(year,m-1,d),offset=candidate-now.getTime();
  return offset<-183*DAY?year+1:offset>183*DAY?year-1:year;
}
const fullYear=value=>value.length===2?2000+Number(value):Number(value);
// Dates on a line, as YYYY-MM-DD days and bare years (a year alone means the whole year).
export function lineDates(key,now=new Date()){
  const days=[],years=[];let rest=key;
  for(const match of key.matchAll(NUMERIC_DATE)){
    const d=Number(match[1]??match[4]),m=Number(match[2]??match[5]),y=match[3]??match[6];
    if(!validDay(d,m))continue;
    days.push(isoDay(new Date(Date.UTC(y?fullYear(y):inferYear(d,m,now),m-1,d))));rest=rest.replace(match[0],' ');
  }
  for(const match of key.matchAll(NAMED_DATE)){
    const d=Number(match[1]),m=MONTHS[match[2].toLowerCase()];
    if(!validDay(d,m))continue;
    days.push(isoDay(new Date(Date.UTC(match[3]?Number(match[3]):inferYear(d,m,now),m-1,d))));rest=rest.replace(match[0],' ');
  }
  for(const match of rest.matchAll(YEAR))years.push(match[2]?fullYear(match[2]):Number(match[1]));
  return {days,years};
}

function matchTerms(key){
  const masked=key.replace(RULE.doppelganger,' \u00b7 ');
  const hits=TERMS.filter(term=>term.re.test(masked));
  const doppel=masked!==key&&!hits.length&&TERMS.some(term=>term.re.test(key));
  return {hits,doppel};
}

/**
 * Every line of `text` that carries an alarm term, with the rule that drops it (`dropped`, null when it stays).
 * Rule order: ui, doppelganger, cell, weekday, live, weak, past, policy, (office lowers strength to info), far, ignored.
 */
export function classifyLines(text,{now=new Date(),ignore=[],longDocument,anchors=[]}={}){
  const at=now instanceof Date?now:new Date(now);
  const today=isoDay(at),thisYear=at.getUTCFullYear();
  const lines=decodeEntities(text).split(/\r?\n/).map(line=>line.replace(/[\u00a0\s]+/g,' ').trim()).filter(Boolean);
  const keys=lines.map(normalizeLine);
  const long=longDocument??String(text).length>LONG_DOCUMENT_CHARS;
  const anchorKeys=anchors.map(normalizeLine).filter(Boolean);
  const anchorAt=long?keys.flatMap((key,index)=>anchorKeys.some(anchor=>key.includes(anchor))?[index]:[]):[];
  const ignores=ignore.map(pattern=>pattern instanceof RegExp?pattern:new RegExp(pattern));
  const out=[],seen=new Set();
  keys.forEach((key,index)=>{
    const {hits,doppel}=matchTerms(key);
    if(!hits.length&&!doppel)return;
    if(seen.has(key))return;
    seen.add(key);
    const text=lines[index];
    const cats=[...new Set(hits.map(hit=>hit.cat))].sort();
    const strong=hits.some(hit=>hit.strength==='strong');
    const {days,years}=lineDates(key,at);
    const dated=days.length+years.length>0;
    const words=key.split(' ').filter(token=>/[\p{L}\p{N}]/u.test(token)).length;
    const weekdayNear=WEEKDAY.test(key)||words<=2&&keys.slice(Math.max(0,index-2),index).some(previous=>WEEKDAY.test(previous));
    let dropped=null,strength=strong?'strong':'weak+date',office=false;
    if(RULE.ui.test(key)||RULE.uiLine.test(key))dropped='ui';
    else if(doppel)dropped='doppelganger';
    else if(!strong&&words<=2&&!dated)dropped='cell';
    else if(!strong&&!dated&&weekdayNear)dropped='weekday';
    else if(!strong&&RULE.live.test(key))dropped='live';
    else if(!strong&&!dated&&!QUALIFIER.test(key))dropped='weak';
    else if(dated&&days.every(day=>day<today)&&years.every(year=>year<thisYear))dropped='past';
    else if(RULE.policy.test(key))dropped='policy';
    if(!dropped&&RULE.office.test(key)){strength='info';office=true;}
    if(!dropped&&long&&!anchorAt.some(anchor=>Math.abs(anchor-index)<=ANCHOR_RADIUS))dropped='far';
    if(!dropped&&ignores.some(pattern=>pattern.test(text)||pattern.test(key)))dropped='ignored';
    const line={key,text,cats,strength,index,context:lines.slice(Math.max(0,index-3),index+4),dropped};
    if(office)line.office=true;
    out.push(line);
  });
  return out;
}

/** Alarm lines of a page: `[{key, text, cats, strength:'strong'|'weak+date'|'info', index, context, office?}]`, one per distinct key. */
export function alarmLines(text,options={}){
  return classifyLines(text,options).filter(line=>!line.dropped).map(({dropped,...line})=>line);
}

/**
 * Compares the alarm lines of this run with the keys stored last time.
 * prevKeys null/undefined: first run, nothing is issued (`baseline:true`). A key that appeared and went away at least twice within
 * 30 days is muted (news rotation). Returns the keys and the history to store: `{baseline, added, muted, keys, history}`.
 */
export function newAlarms(prevKeys,current,history=[],now=new Date()){
  const at=now instanceof Date?now.toISOString():new Date(now).toISOString();
  const keys=[...new Set(current.map(line=>line.key))].slice(0,MAX_KEYS);
  const since=Date.parse(at)-WINDOW_DAYS*DAY;
  const prune=entries=>entries.filter(entry=>!entry.goneAt||Date.parse(entry.goneAt)>=since).slice(-HISTORY_MAX);
  const entries=(history??[]).map(entry=>({...entry}));
  if(prevKeys==null)return {baseline:true,added:[],muted:[],keys,history:prune(entries)};
  const prev=new Set(prevKeys),present=new Set(current.map(line=>line.key));
  for(const key of prev)if(!present.has(key)){
    const open=entries.findLast(entry=>entry.key===key&&!entry.goneAt);
    if(open)open.goneAt=at;else entries.push({key,seenAt:null,goneAt:at});
  }
  const added=[],muted=[],done=new Set();
  for(const line of current){
    if(prev.has(line.key)||done.has(line.key))continue;
    done.add(line.key);
    const flaps=entries.filter(entry=>entry.key===line.key&&entry.goneAt&&Date.parse(entry.goneAt)>=since).length;
    (flaps>=2?muted:added).push(line);
    entries.push({key:line.key,seenAt:at,goneAt:null});
  }
  return {baseline:false,added,muted,keys,history:prune(entries)};
}

// Significance of a content change from its changed lines: facts (dates, times, prices, ages, weekdays, alarm terms) are high,
// page furniture (cookies, counters, copyright, "updated on") is low, other prose is normal.
const META=bounded(['cookies?','datenschutz\\p{L}*','rgpd','consent\\p{L}*','newsletter','abonnieren',"s'abonner",'copyright','©','alle rechte','tous droits','all rights','besuche','visites','bereitgestellt',
  'aktualisiert','mise à jour','mis à jour','last updated','publié le','veröffentlicht','stand:','letzte änderung','partager','teilen','share','menu','menü','suche','recherche','search'].join('|'));
const FACT=[/\b\d{1,2}[.:h]\d{2}\b/u,/\b\d{1,2} ?(?:uhr|h)(?![\p{L}])/u,/(?:chf|fr\.|sfr\.?|€|eur)\s?\d|\d(?:[.,]\d{2}|\.[-–])\s?(?:chf|fr\.?|francs?|franken)?/u,
  /\d+\s?(?:[-–]|à|bis|to)?\s?\d*\s?(?:ans|jahren?|years?|mois|monaten?|months?)(?![\p{L}])/u];
export function significance(addedLines=[],removedLines=[]){
  const all=[...addedLines,...removedLines].map(decodeEntities).map(normalizeLine).filter(Boolean);
  let level='low';
  for(const key of all){
    if(META.test(key))continue;
    const {days,years}=lineDates(key);
    if(days.length||years.length||WEEKDAY.test(key)||FACT.some(re=>re.test(key))||matchTerms(key).hits.length)return 'high';
    if(key.split(' ').length>2)level='normal';
  }
  return level;
}
