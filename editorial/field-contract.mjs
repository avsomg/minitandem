import {hasSwissMobile} from './contact-rule.mjs';
const text=value=>typeof value==='string'&&value.trim().length>0;
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const strings=value=>Array.isArray(value)&&value.every(text);
export function validDate(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const instant=Date.parse(value+'T12:00:00Z');
  return Number.isFinite(instant)&&new Date(instant).toISOString().slice(0,10)===value;
}
const time=value=>typeof value==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const event=value=>value&&typeof value==='object'&&!Array.isArray(value)&&validDate(value.date)&&
  ['start','end'].every(key=>value[key]===undefined||typeof value[key]==='string'&&(value[key]===''||time(value[key])))&&
  ['title','address'].every(key=>value[key]===undefined||typeof value[key]==='string')&&
  Object.keys(value).every(key=>['date','start','end','title','address'].includes(key))&&
  (!value.start||!value.end||value.end>value.start);
const oneOf=values=>value=>values.includes(value);
// Organisation contacts only (decision of 14 October 2026, docs/publication-scope.md). A written-out Swiss mobile number in any string
// of a contact is refused by name, with the contact's position, never its value. Names of private persons and personal e-mail addresses
// cannot be recognised by a pattern; public-audit.mjs --strict holds every published contact to a list a person has reviewed.
const contactProblem=value=>{
  const index=Array.isArray(value)?value.findIndex(c=>c&&typeof c==='object'&&Object.values(c).some(hasSwissMobile)):-1;
  return index<0?null:`contacts[${index}] holds a Swiss mobile number. Only organisation contacts are public (organisation name, landline, role address): leave this contact out, the source link leads families to it`;
};
const spec=(type,meaning,validate,extra={})=>({type,meaning,validate,critical:true,...extra});
const bool=(meaning,extra)=>spec('boolean',meaning,value=>typeof value==='boolean',extra);
// Wording an unconfirmed field may carry after a full review. The first entry is what editors write. The entries after it are the
// wordings the one-off English rebase gave the old placeholders (migration/rebase-manifest.json); both are accepted so that an
// unchanged placeholder passes a full review.
export const FULL_REVIEW_UNKNOWN_TEXT=Object.freeze({
  age:['Age to be confirmed','Age not published','Age to be confirmed.','Age to be clarified','Check the age','Check the age.','Confirm the age'],
  parentDetails:['To be confirmed','Conditions for adult participation not published','The conditions for adult participation have not been published'],
  schedule:['Schedule to be confirmed','Schedule not published','Schedule to be confirmed.','Schedule to be clarified','Schedule to be checked.','Check the schedule','Check the schedule.','Opening hours to be confirmed'],
  address:['Address to be confirmed','Visit address not published'],
  price:['To be confirmed','Price to be confirmed','Price not published','Price not published.','Price is not published','Price is not published.','The price is not published.','Check the price']
});
export const FULL_REVIEW_UNKNOWN_PRACTICAL_TEXT=Object.freeze(['To be confirmed','Not published','Conditions not published']);
// A schedule that says something is unconfirmed or still to be checked is a placeholder, not a published timetable.
// It flags every wording the old Russian test flagged (migration/rebase-catalogue.mjs proves this on the whole catalogue).
export const UNCONFIRMED_PROSE=/\bnot (?:yet )?(?:been )?(?:confirmed|published)\b|\bto be (?:confirmed|clarified|checked)\b|\b(?:check|confirm|clarify|ask about)\b/i;

// The worker and controller use the same meanings; JSON types alone cannot resolve them.
export const FIELD_CONTRACT=Object.freeze({
  status:spec('enum','Catalogue availability: active = confirmed available offer, including a scheduled future meeting; check = availability needs confirmation; future = not yet available or out of season; closed = confirmed ended; excluded = outside catalogue scope. A future event date alone does not imply future status. A source outage is not closure.',oneOf(['active','check','future','closed','excluded'])),
  min:spec('number','Explicit published lower age for this exact programme in years, e.g. ab 4, dès 4, or für Kinder von 2 bis 4. An unqualified programme age range is sufficient; no separate prohibition of younger admission is required. This is a published-age filter, not guaranteed admission. Never infer zero from babies or convert a recommendation into a bound.',number),
  max:spec('number','Explicit published upper age for this exact programme in years, e.g. bis 3, jusqu’à 3, or für Kinder von 2 bis 4. An unqualified programme age range is sufficient; no separate prohibition of older admission is required. This is a published-age filter, not guaranteed admission. Approximate or recommended ages do not impose a hard filter.',number),
  age:spec('string','Public age description preserving approximate ranges, recommendations and exceptions.',text),
  ageUpperUncertainFrom:spec('number','Age in years from which suitability becomes uncertain; not an exclusion. Requires an explicit approximate upper age.',number),
  parent:spec('enum','Adult may or must remain with the child: yes/no/unknown. Explicit permission to stay qualifies as yes; it does not imply mandatory attendance. Accompaniment does not necessarily mean active co-participation. Preserve optional/required conditions in parentDetails.',oneOf(['yes','no','unknown'])),
  parentDetails:spec('string','Describe whether the adult accompanies, participates, watches or must leave; do not conflate these formats.',text),
  languages:spec('string[]','Explicit session language codes: DE, FR, DE/FR (bilingual), EN, or none for a language-independent self-guided visit. Website language is not session language.',value=>strings(value)&&value.every(x=>['DE','FR','DE/FR','EN','none'].includes(x))),
  schedule:spec('string','Published hours or meeting pattern for this exact offer, including holidays and season.',text),
  scheduleValidThrough:spec('date','Last confirmed published date or seasonal horizon, NOT a closure date. Retain the last date of a bounded event list.',validDate),
  days:spec('integer[]','Catalogue weekday facet: Monday=1 through Sunday=7. May describe published opening/weekly days or weekdays of confirmed individual events. It is NOT a recurrence rule; never generate new dates from days alone.',value=>Array.isArray(value)&&value.every(x=>Number.isInteger(x)&&x>=1&&x<=7)&&new Set(value).size===value.length),
  events:spec('event[]','Rows are {date:"YYYY-MM-DD",start:"HH:mm",end:"HH:mm",title?:string,address?:string}. date is required; an unknown start/end is an empty string. Never put an ISO timestamp in start/end. Only individually confirmed dates in Europe/Zurich with published local times. Do not extrapolate recurring dates.',value=>Array.isArray(value)&&value.every(event)&&new Set(value.map(e=>[e.date,e.start||'',e.end||''].join('|'))).size===value.length),
  address:spec('string','Visitor entrance for the exact session, not the organizer postal address or another branch.',text),
  addressPrecision:spec('enum','exact means a verified visitor address; area means only an approximate area is known.',oneOf(['exact','area'])),
  price:spec('string','Tariff with currency, unit, period and included/excluded extras. Per-lesson equivalent is not a drop-in ticket.',text),
  priceKind:spec('enum','unknown/free/donation/visit/course/year. A voluntary donation is not a compulsory admission price.',oneOf(['unknown','free','donation','visit','course','year'])),
  amount:spec('number','Published CHF amount for priceKind and described tariff unit, never an invented family total.',number),
  contacts:spec('contact[]','Public organisation contacts {name,phone,email} for this exact offer: the organisation\'s name, landline and role address (info@, secretariat@ …); preserve empty optional strings and exact published values. Never a mobile number, a private person\'s name, or an e-mail address that carries a person\'s name; leave such a contact out, the source link leads families to it.',
    value=>Array.isArray(value)&&value.every(c=>c&&typeof c==='object'&&!Array.isArray(c)&&Object.keys(c).every(k=>['name','phone','email'].includes(k))&&Object.values(c).every(x=>typeof x==='string')&&(text(c.phone)||text(c.email)))&&!contactProblem(value),
    {problem:contactProblem}),
  reviewAfter:spec('date','Internal next editorial review target, not a promise from the organizer.',validDate,{critical:false,operational:true}),
  checked:spec('date','Last full primary-fact review. A field edit or external visitor search cannot renew this date.',validDate,{critical:false,operational:true}),
  intro:spec('string','Concise public description of the exact activity without unsupported quality or safety judgments.',text,{critical:false}),
  notes:spec('string[]','Public practical context and limitations, never internal model or workflow details.',strings,{critical:false}),
  'practical.booking':bool('Advance registration or reservation is REQUIRED. false requires explicit no-registration/drop-in evidence.'),
  'practical.observe':bool('Organizer explicitly permits a first visit to watch without joining. Parent accompaniment alone does not establish this.'),
  'practical.trial':bool('A trial visit/lesson is explicitly available; say whether paid. Do not infer a trial from a single ticket.'),
  'practical.leave':bool('Organizer explicitly allows arriving/leaving flexibly or leaving early. It does not mean the parent may leave the child.'),
  'practical.commitment':bool('A course/block/subscription must be purchased instead of one visit. This is FINANCIAL commitment, not mandatory regular attendance. Free meetings or optional passes mean false; weekly sessions alone do not mean true.'),
  'practical.groupSize':spec('number','Published maximum participants in this exact group, not a venue capacity or a photographed group.',value=>number(value)&&Number.isInteger(value)&&value>0),
  'practical.leader':spec('string','Published current named leader/instructor of this offer. A name does not establish qualifications.',text),
  'practical.standardGerman':bool('Explicit Hochdeutsch/Standard German instruction. A German-language website or DE label is insufficient.'),
  'practical.duration':spec('number','Published length of ONE session in minutes; not travel time, course length or general opening hours.',value=>number(value)&&value>0),
  'practical.indoor':bool('This exact activity is indoors, not merely that the venue also has an indoor space.'),
  'practical.parking':bool('Parking explicitly available for visitors; distinguish paid parking in display text.'),
  'practical.access':bool('Stroller-accessible entrance/route for the activity. Ground floor alone is insufficient; this is not a medical accessibility assessment.'),
  'practical.changing':bool('A changing table/facility is explicitly available to visitors.'),
  'practical.toilet':bool('A visitor toilet is explicitly available; do not infer it from venue type.'),
  'practical.feeding':bool('An explicitly available feeding/breastfeeding space or permission; food for sale does not establish this.'),
  'practical.playArea':bool('A designated child play area is explicitly available; do not infer it from a family-friendly label.'),
  'practical.costNote':spec('string','Additional tariff conditions and missing costs. Never compute an unsupported all-in family price.',text)
});
export const PATCH_FIELDS=new Set(Object.keys(FIELD_CONTRACT).filter(k=>!k.startsWith('practical.')));
export const PRACTICAL_FIELDS=Object.keys(FIELD_CONTRACT).filter(k=>k.startsWith('practical.')).map(k=>k.slice(10));
export const CLAIM_FIELDS=new Set(Object.keys(FIELD_CONTRACT).filter(k=>!FIELD_CONTRACT[k].operational));
export const CRITICAL_FIELDS=new Set(Object.keys(FIELD_CONTRACT).filter(k=>FIELD_CONTRACT[k].critical));
// A rule may name what is wrong with a value of the right type (problem); that message reaches the worker as the reason of the rejection.
export function validateFieldValue(field,value,{allowUnknown=true}={}){
  const rule=FIELD_CONTRACT[field];
  const checked=rule&&!(allowUnknown&&value===null);
  const problem=checked&&rule.problem?.(value);
  if(problem)throw Error(`Invalid field value: ${problem}`);
  if(!rule||checked&&!rule.validate(value))throw Error(`Invalid field value type: ${field}`);
  return value;
}
export function fieldDictionary(){
  return Object.fromEntries(Object.entries(FIELD_CONTRACT).map(([key,{validate,problem,...rule}])=>[key,
    FULL_REVIEW_UNKNOWN_TEXT[key]?{...rule,fullReviewUnknownText:FULL_REVIEW_UNKNOWN_TEXT[key]}:
    key.startsWith('practical.')?{...rule,fullReviewUnknownText:FULL_REVIEW_UNKNOWN_PRACTICAL_TEXT}:rule]));
}
export function relevantPracticalFields(card){
  if(card.format==='self')return ['access','changing','toilet','playArea'];
  if(card.format==='event')return ['booking','duration','access'];
  return ['booking','commitment','duration','groupSize','leader','access'];
}
export function practicalFieldApplies(card,key){
  if(['access','changing','toilet','feeding','playArea','parking','indoor','costNote'].includes(key))return true;
  if(['booking','observe','leave','duration'].includes(key))return card.format!=='self'||card.practical?.scenario==='visit';
  if(key==='standardGerman')return card.format!=='self'&&card.languages.some(x=>x==='DE'||x==='DE/FR');
  return card.format==='group'||card.format==='individual';
}
export function fullReviewFields(card){
  const fields=['status','min','max','age','ageUpperUncertainFrom','parent','parentDetails','schedule','scheduleValidThrough','days','events','address','addressPrecision','price','priceKind','amount','contacts'];
  if(card.format!=='self')fields.push('languages','practical.booking');
  for(const key of PRACTICAL_FIELDS){
    const fact=card.practical?.[key],field='practical.'+key;
    if(fact&&Object.hasOwn(fact,'value')&&fact.value!==null&&!fields.includes(field))fields.push(field);
  }
  return fields;
}
