// Short notices (toast) and the family price calculator behind the card page. The page itself is DOM wiring and is not loaded here:
// the toast is created with fake nodes, the price comes from the planning module and the card markup from the views module.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {loadStack} from './test-support.mjs';

const plain=v=>JSON.parse(JSON.stringify(v));
const stack=(age=null)=>loadStack({local:age===null?{}:{'minitandem-family-v1':{version:1,favorites:[],notes:{},statuses:{},age}}});

// Fake page: one notice node, a body, and the dialogs that are open (in document order, so the last one is on top).
function toastRig(dialogs=[],ms){
  const s=stack();
  const node={hidden:true,textContent:'',parentElement:null};
  const body={append:el=>{el.parentElement=body;}};
  const queries=[],timers=[],cleared=[];
  const document={body,querySelectorAll:selector=>{queries.push(selector);return dialogs;}};
  const toast=s.window.MinitandemToast.create({node,document,setTimer:(fn,delay)=>{timers.push({fn,delay});return timers.length;},clearTimer:id=>cleared.push(id),...(ms?{ms}:{})});
  return {s,node,body,toast,queries,timers,cleared,expire:()=>timers.at(-1).fn()};
}
const modal=()=>{const host={append:node=>{node.parentElement=host;}};return host;};

test('copy confirmation enters the topmost modal rather than the inert page',()=>{
  const detail=modal(),utility=modal();
  const app=toastRig([detail,utility]);
  const copied=app.s.t('toast.copied');
  assert.notEqual(copied,'toast.copied','the notice text comes from the dictionary');
  app.toast(copied);
  assert.equal(app.node.parentElement,utility);
  assert.equal(app.node.hidden,false);
  assert.equal(app.node.textContent,copied);
  assert.deepEqual(app.queries,['dialog[open]'],'only open dialogs are considered');
  app.expire();
  assert.equal(app.node.hidden,true);
});

test('ordinary notifications remain in the page when no modal is open',()=>{
  const app=toastRig();app.toast(app.s.t('visit.saved'));
  assert.equal(app.node.parentElement,app.body);
  assert.equal(app.node.hidden,false);assert.equal(app.node.textContent,app.s.t('visit.saved'));
});

test('one notice at a time: a new message replaces the old one, restarts the timer and follows the modal that is open now',()=>{
  const dialog=modal(),dialogs=[dialog];
  const app=toastRig(dialogs);
  app.toast('First');
  assert.equal(app.node.parentElement,dialog);
  dialogs.length=0;                       // the dialog was closed
  app.toast('Second');
  assert.equal(app.node.parentElement,app.body,'a notice never stays in a closed dialog');
  assert.equal(app.node.textContent,'Second');
  assert.equal(app.cleared.at(-1),1,'the running timer is cancelled before the next one starts');
  assert.equal(app.timers.length,2);
  assert.equal(app.node.hidden,false);
  app.expire();
  assert.equal(app.node.hidden,true);
});

test('the notice stays for a few seconds and the duration can be set',()=>{
  const normal=toastRig();normal.toast('Saved.');
  assert.ok(normal.timers[0].delay>=2000&&normal.timers[0].delay<=10000,'long enough to read, short enough not to linger: '+normal.timers[0].delay);
  const fast=toastRig([],250);fast.toast('Saved.');
  assert.equal(fast.timers[0].delay,250);
});

// The tariff behind the family price: adult CHF 9, children from 1 to under 4 CHF 10, from 4 to under 16 CHF 19.
test('family price updates for several children and rejects incomplete ages',()=>{
  const {P,byId,t}=stack(),beo=byId.get('beo-funpark');
  assert.equal(beo.practical.tariff.adult,9);
  assert.deepEqual(plain(beo.practical.tariff.children),[{min:1,until:4,price:10},{min:4,until:16,price:19}]);
  // The page reads the adult count and every child field, an empty field becoming NaN.
  const two=P.familyPrice(beo,[2.5,4],2);
  assert.equal(two.total,47);assert.equal(two.adultTotal,18);assert.deepEqual(plain(two.childTotals),[10,19]);
  assert.equal(two.text,beo.practical.tariff.note);assert.match(two.source,/^https:\/\//);
  // The line under the total names the adults and each child.
  const breakdown=t('cost.breakdown',{adults:two.adultTotal,children:two.childTotals.join(' + ')});
  assert.notEqual(breakdown,'cost.breakdown');assert.ok(breakdown.includes('18'),'adults total');assert.ok(breakdown.includes('10 + 19'),'each child, in the order of the fields');
  assert.equal(P.familyPrice(beo,[4,4],2).total,56);
  assert.equal(P.familyPrice(beo,[4,NaN],2),null,'one child without an age gives no price');
  assert.equal(P.familyPrice(beo,[NaN,NaN],2),null);
  assert.equal(P.familyPrice(beo,[4,4],0),null,'no adults gives no price');
  assert.equal(P.familyPrice(beo,[4,4],NaN),null,'an empty adults field gives no price');
  assert.equal(P.familyPrice(beo,[4,4],5),null);assert.equal(P.familyPrice(beo,[4,4],1.5),null);
  assert.equal(P.familyPrice(beo,[],1),null);assert.equal(P.familyPrice(beo,Array(7).fill(4),1),null);
  assert.equal(P.familyPrice(beo,[0.5],1),null,'a baby under the first band has no published price');
  assert.equal(P.familyPrice(beo,[16],1),null,'the oldest band ends below 16');
  // The helper is also called with a single age, as the card page does for the age the visitor already chose.
  assert.equal(P.familyPrice(beo,2.5,1).total,19);assert.equal(P.familyPrice(beo,null,1),null);
  // A course never exposes a unit price as a ticket.
  assert.equal(P.familyPrice(byId.get('swim-tentlingen'),[2.5],1),null);
});

test('the card page starts the price from the chosen age and says what is missing when there is none',()=>{
  const total=html=>/id="family-total"[^>]*>([^<]*)</.exec(html)[1];
  const known=stack(2.5),withAge=known.V.detail(known.byId.get('beo-funpark'));
  assert.equal(total(withAge),'CHF 19.00');
  assert.match(withAge,/class="field short family-child-age"[^>]*value="2.5"/);
  assert.ok(/id="family-breakdown"[^>]*>([^<]+)</.exec(withAge)[1].length>0);
  const unknown=stack(),withoutAge=unknown.V.detail(unknown.byId.get('beo-funpark'));
  assert.equal(total(withoutAge),unknown.t('cost.unknownAge'));assert.doesNotMatch(total(withoutAge),/CHF \d/);
  assert.match(withoutAge,/class="field short family-child-age"[^>]*value=""/);
  // An age below the first band cannot be priced either.
  const baby=stack(0.5);assert.doesNotMatch(total(baby.V.detail(baby.byId.get('beo-funpark'))),/CHF \d/);
  // Cards without a tariff have no calculator.
  assert.doesNotMatch(unknown.V.detail(unknown.byId.get('mpe')),/family-total/);
});

test('amounts read as the Swiss write them, CHF 12.50, in every language: two decimals and a point, also in French',()=>{
  const {F}=stack();
  assert.equal(F.amount(12.5),'12.50');assert.equal(F.amount(19),'19.00');assert.equal(F.amount(0),'0.00');
  // A tariff with half francs, on the French card page: the total and the line under it keep the point and both decimals.
  const fr=loadStack({lang:'fr',local:{'minitandem-family-v1':{version:1,favorites:[],notes:{},statuses:{},age:3}}}),beo=fr.byId.get('beo-funpark');
  const card={...beo,practical:{...beo.practical,tariff:{...beo.practical.tariff,adult:12.5}}};
  const html=fr.V.detail(card);
  assert.equal(/id="family-total"[^>]*>([^<]*)</.exec(html)[1],'CHF 22.50');
  const breakdown=/id="family-breakdown"[^>]*>([^<]*)</.exec(html)[1];
  assert.match(breakdown,/CHF\s12\.50\b/);assert.match(breakdown,/CHF\s10\.00\b/);
  assert.doesNotMatch(breakdown,/12,5|12\.5(?!0)/);
  // The page script formats the total and the line the same way when the fields change.
  const app=fs.readFileSync(new URL('app.js',import.meta.url),'utf8');
  assert.match(app,/'CHF ' \+ F\.amount\(result\.total\)/);
  assert.match(app,/adults: F\.amount\(result\.adultTotal\), children: result\.childTotals\.map\(F\.amount\)/);
});

test('the price controls in the card markup are the ones the page script updates',()=>{
  const s=stack(2.5),html=s.V.detail(s.byId.get('beo-funpark')),app=fs.readFileSync(new URL('app.js',import.meta.url),'utf8');
  for(const hook of ['id="family-adults"','id="family-children"','class="field short family-child-age"','id="family-total"','id="family-breakdown"','data-action="add-child"'])assert.ok(html.includes(hook),hook+' is in the card markup');
  for(const hook of ['family-adults','family-child-age','family-total','family-breakdown','add-child','familyPrice'])assert.ok(app.includes(hook),hook+' is handled by the page script');
  // The field limits match what the tariff can price.
  assert.match(html,/id="family-adults" type="number" min="1" max="4"/);
  assert.match(html,/family-child-age" type="number" min="0" max="15"/);
});
