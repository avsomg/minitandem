import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {CONTACT_RULE,contactDigest,hasSwissMobile,swissMobileCount} from './contact-rule.mjs';
import {pendingContacts,acceptContacts} from './review-contacts.mjs';

// Invented numbers, joined at run time so that no line of this file holds a written-out number (scan-public.mjs reads files line by line).
const mobile=(separator=' ',prefix='079')=>[prefix,'000','00','00'].join(separator);

test('a written-out Swiss mobile number is found in national and international form, grouped or not',()=>{
  for(const number of [mobile(),mobile(''),mobile('.'),mobile('-'),mobile(' '),mobile(' '),mobile(' ','075'),mobile(' ','076'),mobile(' ','077'),mobile(' ','078'),
    '079 '+['000','00','00'].join(''),'+41 '+mobile(' ','79'),'+41'+mobile('','79'),'0041 '+mobile(' ','79'),'0041'+mobile('','79'),'+41 (0)'+mobile(' ','79'),
    'Tel. '+mobile(),'Tel.'+mobile(),'('+mobile()+')',mobile()+'.','mailto:'+mobile('')+'@example.org',mobile('\\u00a0'),mobile('&nbsp;')])
    assert.equal(swissMobileCount(number),1,JSON.stringify(number));
  assert.equal(swissMobileCount(`Call ${mobile()} or ${mobile(' ','078')}.`),2);
  assert.equal(hasSwissMobile(mobile()),true);
});
test('landlines, other numbers and digits in web addresses are not mobile numbers',()=>{
  for(const text of ['026 000 00 00','+41 26 000 00 00','0800 000 000',mobile(' ','074'),mobile(' ','070'),'079 000 00 0','CHF 079',
    '46.0'+mobile('','79'),'12'+mobile(''),mobile('')+'123','id-'+mobile('')+'x','v'+mobile(''),
    'https://example.org/'+mobile(''),'https://example.org/?tel='+mobile('-'),'www.example.org/p/'+mobile('-'),'"https://example.org/'+mobile('')+'","label"',
    '',undefined,null,42])
    assert.equal(swissMobileCount(text),0,JSON.stringify(text));
  // A web address is cut at a quote or a closing bracket, so a number after it in the same line still counts.
  assert.equal(swissMobileCount(`{"url":"https://example.org/a","phone":"${mobile()}"}`),1);
  assert.equal(swissMobileCount(`[Source](https://example.org/a) ${mobile()}`),1);
});
test('a contact digest is sha256 of name, phone and email in that order, a missing field counted as empty',()=>{
  const sha=text=>createHash('sha256').update(text).digest('hex');
  assert.equal(contactDigest({name:'Office',phone:'026 000 00 00',email:'info@example.org'}),sha('{"name":"Office","phone":"026 000 00 00","email":"info@example.org"}'));
  assert.equal(contactDigest({email:'info@example.org',name:'Office'}),contactDigest({name:'Office',phone:'',email:'info@example.org'}));
  assert.notEqual(contactDigest({name:'Office',phone:'',email:''}),contactDigest({name:'',phone:'Office',email:''}));
  assert.match(contactDigest({}),/^[a-f0-9]{64}$/);
});
test('the review command lists unreviewed contacts and accepts only after a person looked; it never accepts a mobile number',()=>{
  const office={name:'Office',phone:'026 000 00 00',email:'info@example.org'},desk={name:'Desk',phone:'',email:'desk@example.org'};
  const records=[{id:'a',contacts:[office]},{id:'b',contacts:[desk,office]},{id:'c',contacts:[]}];
  const reviewed={reviewedOn:'2026-10-14',rule:CONTACT_RULE,digests:[contactDigest(office)]};
  assert.deepEqual(pendingContacts(records,reviewed).map(row=>[row.card,row.position,row.mobile]),[['b','contacts[0]',false]]);
  const {list,accepted}=acceptContacts(records,reviewed,{date:'2026-10-15'});
  assert.equal(accepted,1);assert.equal(list.reviewedOn,'2026-10-15');assert.equal(list.rule,CONTACT_RULE);
  assert.deepEqual(list.digests,[contactDigest(office),contactDigest(desk)].sort());
  assert.deepEqual(Object.keys(list),['reviewedOn','rule','digests'],'the list holds digests only, never a contact value');
  assert.equal(acceptContacts(records,list,{date:'2026-10-16'}).list.reviewedOn,'2026-10-15','nothing new to accept keeps the date');
  const leader={name:'Leader',phone:mobile(),email:''};
  assert.throws(()=>acceptContacts([...records,{id:'d',contacts:[office,leader]}],list),
    error=>/Not accepted: d contacts\[1\] holds a Swiss mobile number/.test(error.message)&&!error.message.includes(mobile()));
});
test('the tracked list of reviewed contacts holds sorted distinct digests, the rule and the review date only',()=>{
  const list=JSON.parse(fs.readFileSync(new URL('./public-contacts-reviewed.json',import.meta.url),'utf8'));
  assert.deepEqual(Object.keys(list).sort(),['digests','reviewedOn','rule']);
  assert.match(list.reviewedOn,/^\d{4}-\d{2}-\d{2}$/);assert.match(list.rule,/organisation contacts only/);
  assert.ok(list.digests.length>0&&list.digests.every(digest=>/^[a-f0-9]{64}$/.test(digest)));
  assert.deepEqual(list.digests,[...new Set(list.digests)].sort());
});
