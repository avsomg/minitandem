import test from 'node:test';
import assert from 'node:assert/strict';
import {FIELD_CONTRACT,CLAIM_FIELDS,validateFieldValue,fullReviewFields,practicalFieldApplies,validDate,fieldDictionary} from './field-contract.mjs';
import {validateDraft,validateFullReview,today,assertConsistentClaims} from './workflow.mjs';
import {promptFor} from './agent-run.mjs';
import {loadCatalog} from './quality.mjs';
import {failureCategory} from './jobs.mjs';

test('field meanings distinguish money, attendance, accompaniment and schedule horizon',()=>{
  assert.match(FIELD_CONTRACT['practical.commitment'].meaning,/FINANCIAL.*not mandatory regular attendance/);
  assert.match(FIELD_CONTRACT.parent.meaning,/does not necessarily mean active/);
  assert.match(FIELD_CONTRACT.scheduleValidThrough.meaning,/NOT a closure/);
  assert.match(FIELD_CONTRACT.status.meaning,/future event date alone does not imply future status/);
  assert.ok(!CLAIM_FIELDS.has('checked'));assert.ok(!CLAIM_FIELDS.has('reviewAfter'));
  const prompt=promptFor({id:'j',kind:'facts',input_revision:'r',payload:{card:{format:'event'}}});
  assert.match(prompt,/mandatory FINANCIAL/);assert.match(prompt,/reviewCoverage/);
});
test('published programme bounds do not require an explicit admission prohibition',()=>{
  assert.match(FIELD_CONTRACT.min.meaning,/Explicit published lower age/);
  assert.match(FIELD_CONTRACT.max.meaning,/no separate prohibition of older admission is required/);
  assert.match(FIELD_CONTRACT.max.meaning,/Approximate or recommended ages do not impose a hard filter/);
  const prompt=promptFor({id:'j',kind:'verify-facts',input_revision:'r',payload:{bundle:{claims:[],snapshots:[]}}});
  assert.match(prompt,/supports max 3 even without a separate admission prohibition/);
  assert.match(prompt,/does not support min 0/);
});
test('types cover nested payloads, positive duration and practical feeding',()=>{
  for(const [field,value] of [['practical.duration','30 minutes'],['practical.duration',0],['practical.feeding','yes'],
    ['contacts',[{email:42}]],['events',[{date:'2026-02-30'}]],['events',[{date:'2026-10-04',start:null}]],
    ['events',[{date:'2026-10-04',title:{name:'Event'}}]],['days',[3,3]],['languages',['Deutsch']]]){
    assert.throws(()=>validateFieldValue(field,value),/field value type/);
  }
  validateFieldValue('practical.feeding',true);
  validateFieldValue('contacts',[{name:'Office',email:'info@example.org',phone:''}]);
  validateFieldValue('min',null);assert.throws(()=>validateFieldValue('min',null,{allowUnknown:false}));
  assert.equal(validDate('2026-02-30'),false);assert.equal(validDate('2028-02-29'),true);
});
test('optional first-visit fields apply to groups but not every self-guided venue',()=>{
  assert.equal(practicalFieldApplies({format:'self',languages:['none']},'commitment'),false);
  assert.equal(practicalFieldApplies({format:'group',languages:['DE']},'trial'),true);
  assert.equal(practicalFieldApplies({format:'group',languages:['FR']},'standardGerman'),false);
});
test('weekday contract matches existing Sunday facets and never represents a recurrence rule',()=>{
  validateFieldValue('days',[1,7]);assert.throws(()=>validateFieldValue('days',[0]));
  for(const record of loadCatalog().ACTIVITIES)validateFieldValue('days',record.days);
  assert.match(FIELD_CONTRACT.days.meaning,/NOT a recurrence rule/);
});
test('independent approval cannot silently choose between contradictory scalar filter values',()=>{
  assert.throws(()=>assertConsistentClaims([{field:'min',value:2},{field:'min',value:3}]),/Conflicting approved/);
  assert.throws(()=>assertConsistentClaims([{field:'practical.booking',value:true},{field:'practical.booking',value:false}]),/Conflicting approved/);
  assertConsistentClaims([{field:'min',value:2},{field:'min',value:2}]);
  assertConsistentClaims([{field:'events',value:[{date:'2026-10-03'}]},{field:'events',value:[{date:'2026-10-10'}]}]);
});
test('full review also covers existing practical filter conditions without anchoring extraction on their values',()=>{
  const base={...card,practical:{indoor:{value:true,text:'Old claim'}}};
  assert.ok(fullReviewFields(base).includes('practical.indoor'));
  const prompt=promptFor({id:'job',kind:'facts',input_revision:'r',payload:{card:base}});
  assert.match(prompt,/"practical.indoor"/);assert.doesNotMatch(prompt,/Old claim/);
  const fields=coverage().fields.concat({field:'practical.indoor',value:true,outcome:'unknown',snapshotIds:['source'],reason:'Not published'});
  assert.throws(()=>validateFullReview({patch:{checked:today()},reviewCoverage:{mode:'full',fields}},base),/Unconfirmed practical/);
});
const card={id:'a',format:'group',status:'check',min:null,max:null,age:'Age to be confirmed',parent:'unknown',parentDetails:'To be confirmed',
  languages:[],days:[],events:[],schedule:'Schedule to be confirmed',address:'Address to be confirmed',priceKind:'unknown',price:'Price to be confirmed',
  amount:null,contacts:[],notes:[],sources:[],practical:{},checked:'2026-09-01'};
const coverage=()=>({mode:'full',fields:fullReviewFields(card).map(field=>({field,value:card[field]??null,
  outcome:field==='status'?'confirmed':'unknown',snapshotIds:['source'],reason:'Primary source inspected; unresolved fields remain unknown.'}))});
test('partial edits cannot renew checked; full review covers every resulting primary value',()=>{
  const draft={cardId:'a',patch:{checked:today()},findings:[{field:'Visit',kind:'official',text:'Condition',url:'https://example.org/offer'}],remaining:[]};
  assert.throws(()=>validateDraft(draft,card),/full-card review/);
  const full={...draft,reviewCoverage:coverage()};assert.equal(validateFullReview(full,card),full.reviewCoverage);
  assert.throws(()=>validateFullReview({...full,reviewCoverage:{...full.reviewCoverage,fields:full.reviewCoverage.fields.slice(1)}},card),/omits/);
  assert.throws(()=>validateFullReview({...full,patch:{checked:today(),min:3}},card),/resulting value/);
  const uncertain=coverage();uncertain.fields.find(r=>r.field==='min').value=3;
  assert.throws(()=>validateFullReview({...full,patch:{checked:today(),min:3},reviewCoverage:uncertain},card),/positive filter/);
  const oldProse=coverage();oldProse.fields.find(r=>r.field==='age').value='2–5 years';
  assert.throws(()=>validateFullReview({...full,patch:{checked:today(),age:'2–5 years'},reviewCoverage:oldProse},card),/unsupported public prose/);
  // Zero and false are filter values as well. The instruction used to say "positive numeric", and an editor kept amount 0 in an unknown row.
  const zero=coverage();zero.fields.find(r=>r.field==='amount').value=0;
  assert.throws(()=>validateFullReview({...full,patch:{checked:today(),amount:0},reviewCoverage:zero},card),/positive filter value: amount/);
  const prompt=promptFor({id:'j',kind:'integrate',input_revision:'r',payload:{card,primaryReviewStatus:'complete',requestedReview:'full'}});
  assert.match(prompt,/A row that is not confirmed must not keep a filter value, and 0 or false is a value: patch min, max, ageUpperUncertainFrom, amount, scheduleValidThrough and practical\.booking to null, languages, days, events and contacts to \[\], parent and priceKind to unknown, addressPrecision to area; a status with outcome unknown must be check/);
  assert.doesNotMatch(prompt,/clear unconfirmed positive numeric/);
});
test('every worker prompt states that public catalogue text is English',()=>{
  for(const kind of ['facts','verify-facts','integrate','editorial','review-patch'])
    assert.match(promptFor({id:'j',kind,input_revision:'r',payload:{card:{format:'event'},bundle:{claims:[],snapshots:[]}}}),/Every public catalogue text you write .* is English/);
  assert.match(promptFor({id:'j',kind:'editorial',input_revision:'r',payload:{card:{format:'event'}}}),/public English text/);
  assert.doesNotMatch(promptFor({id:'j',kind:'editorial',input_revision:'r',payload:{card:{format:'event'}}}),/Russian/);
});
// Organisation contacts only (decision of 14 October 2026, docs/publication-scope.md). The numbers are invented and joined at run time,
// so that no line of this file holds a written-out number (scan-public.mjs reads files line by line).
const mobile=(separator=' ',prefix='079')=>[prefix,'000','00','00'].join(separator);
test('contacts are organisation contacts: a Swiss mobile number in any string of a contact is refused by position, never by value',()=>{
  assert.match(FIELD_CONTRACT.contacts.meaning,/^Public organisation contacts \{name,phone,email\}/);
  assert.match(FIELD_CONTRACT.contacts.meaning,/landline and role address \(info@, secretariat@/);
  assert.match(FIELD_CONTRACT.contacts.meaning,/Never a mobile number, a private person's name, or an e-mail address that carries a person's name; leave such a contact out, the source link leads families to it/);
  const office={name:'Office',phone:'026 000 00 00',email:'info@example.org'};
  for(const value of [[office],[{name:'Office',phone:'+41 26 000 00 00',email:''}],[{name:'',phone:'0800 000 000',email:''}],[{name:'Office',phone:'',email:'info@example.org'}]])
    validateFieldValue('contacts',value,{allowUnknown:false});
  for(const number of [mobile(),mobile(''),'+41 '+mobile(' ','79'),'0041'+mobile('','79'),mobile('.','076')]){
    for(const contact of [{name:'Leader',phone:number,email:''},{name:'Call '+number,phone:'',email:'info@example.org'},{name:'Office',phone:'',email:mobile('')+'@example.org'}]){
      assert.equal(FIELD_CONTRACT.contacts.validate([office,contact]),false);
      assert.throws(()=>validateFieldValue('contacts',[office,contact]),error=>
        error.message.startsWith('Invalid field value: contacts[1] holds a Swiss mobile number. Only organisation contacts are public')&&
        !error.message.includes(number)&&!error.message.includes(contact.name)&&failureCategory(error.message)==='contract');
    }
  }
  // A full review cannot confirm a card's existing contact row that holds one either.
  const held={...card,contacts:[office,{name:'Leader',phone:mobile(),email:''}]};
  const rows=coverage().fields.map(row=>row.field==='contacts'?{...row,value:held.contacts,outcome:'confirmed'}:row);
  assert.throws(()=>validateFullReview({patch:{checked:today()},reviewCoverage:{mode:'full',fields:rows}},held),/^Error: Invalid field value: contacts\[1\] holds a Swiss mobile number/);
  // A wrong type is still named as a type error, and an unknown value is still allowed where it was.
  assert.throws(()=>validateFieldValue('contacts',[{name:'Office',phone:7,email:''}]),/Invalid field value type: contacts/);
  validateFieldValue('contacts',null);
  assert.equal(JSON.stringify(Object.keys(fieldDictionary().contacts)),JSON.stringify(['type','meaning','critical']),'the dictionary sent to workers carries no code');
});
test('every worker that records or copies contacts is told the organisation-contacts rule',()=>{
  const facts=promptFor({id:'j',kind:'facts',input_revision:'r',payload:{card:{format:'event'}}});
  assert.match(facts,/contacts holds organisation contacts only \(organisation name, landline, role address such as info@\): never record a mobile number, a private person's name or an e-mail address that carries a person's name; leave such a contact out, the source link leads families to it/);
  for(const kind of ['integrate','editorial','review-patch']){
    const prompt=promptFor({id:'j',kind,input_revision:'r',payload:{card,bundle:{claims:[],snapshots:[]}}});
    assert.match(prompt,/contacts is copied whole: a patch\.contacts, and a confirmed contacts row of a full review, must equal an approved contacts claim's value exactly, names included/);
    assert.match(prompt,/Only organisation contacts are public: never copy a contacts claim that holds a mobile number, a private person's name or an e-mail address carrying a person's name; leave contacts out of patch instead/);
    assert.match(prompt,/days, languages and contacts are not combined: each must equal the whole value of one approved claim \(for contacts, a claim that holds organisation contacts only\)/);
    assert.match(JSON.parse(prompt.split('TASK DATA:\n')[1]).fieldDictionary.contacts.meaning,/Never a mobile number/);
  }
});

