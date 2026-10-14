import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshot} from './evidence.mjs';
import {validateControl,scoreControl} from './calibrate-agents.mjs';

const sample=()=>({schema:1,project:'vmeste',createdAt:'2026-10-02T10:00:00Z',cases:Array.from({length:24},(_,index)=>({
  cardId:'card-'+index,holdout:index>=18,target:{name:'Course '+index},
  evidence:snapshot({url:'https://example.org/course-'+index,fetchedAt:'2026-10-02T10:00:00Z',text:'The course is free. No advance booking required.'}),
  checks:[{key:index+'-a',field:'practical.booking',value:false,expected:'approve',quote:'No advance booking required.'},
    {key:index+'-b',field:'amount',value:50,expected:'reject',quote:'The course is free.'}]}))});
test('control sample preserves typed claims, complete coverage and source-isolated holdout',()=>{
  const control=sample();assert.equal(validateControl(control),control);
  const leaked=sample();leaked.cases[18].evidence=leaked.cases[0].evidence;assert.throws(()=>validateControl(leaked),/leakage/);
  const wrongType=sample();wrongType.cases[0].checks[0].value='false';assert.throws(()=>validateControl(wrongType),/value type/);
  const missing=sample();missing.cases[0].checks.pop();assert.throws(()=>validateControl(missing),/two claims/);
  const absentQuote=sample();absentQuote.cases[0].checks[0].quote='Never published';assert.throws(()=>validateControl(absentQuote),/quote/);
});
test('scorer distinguishes unsafe approvals from missed supported claims and rejects omissions',()=>{
  const control=sample(),rows=control.cases.flatMap(row=>row.checks.map(c=>({key:c.key,verdict:c.expected,reason:'Source verified.'})));
  const good=scoreControl(rows,control.cases);assert.deepEqual(good.holdout,{claims:12,scored:12,ambiguous:0,ambiguousApprovals:0,correct:12,falseApprovals:0,missedSupported:0});
  const uncertain=scoreControl(rows,control.cases,{ambiguousKeys:['18-a']});assert.equal(uncertain.holdout.scored,11);assert.equal(uncertain.holdout.ambiguousApprovals,1);
  rows[1].verdict='approve';rows[36].verdict='await-source';
  const score=scoreControl(rows,control.cases);assert.equal(score.all.falseApprovals,1);assert.equal(score.holdout.missedSupported,1);
  assert.throws(()=>scoreControl(rows.slice(1),control.cases),/omits/);
  assert.throws(()=>scoreControl([...rows,rows[0]],control.cases),/duplicate/);
});
