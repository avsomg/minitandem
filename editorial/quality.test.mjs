import test from 'node:test';
import assert from 'node:assert/strict';
import {qualityReport} from './quality.mjs';

const base={
  id:'cafe',name:'Cafe',region:'sarine',checked:'2026-09-27',reviewAfter:'2026-10-20',
  status:'active',format:'self',category:'dining',min:null,parent:'yes',priceKind:'unknown',
  address:'Main Street 1',languages:[],events:[],sources:[{url:'https://example.com/cafe'}],practical:{}
};

test('quality queue does not demand course conditions or menu prices from a cafe',()=>{
  const row=qualityReport([base],[{id:'cafe-source',recordIds:['cafe']}],'2026-09-28').queue[0];
  assert.deepEqual(row.critical,['age']);
  assert.ok(!row.missing.includes('booking'));
  assert.ok(!row.missing.includes('leader'));
  assert.ok(!row.missing.includes('commitment'));
});

test('imminent uncertain meeting outranks a distant venue and gets relevant questions',()=>{
  const event={...base,id:'event',name:'Meeting',format:'event',category:'music',status:'check',
    priceKind:'free',languages:[],events:[{date:'2026-09-29',start:'10:00',end:'11:00'}]};
  const report=qualityReport([base,event],[], '2026-09-28');
  assert.equal(report.queue[0].id,'event');
  assert.equal(report.queue[0].nextEvent,'2026-09-29');
  assert.ok(report.queue[0].critical.includes('booking'));
  assert.equal(report.imminent,1);
});

test('due date is inclusive and unresolved monitor tasks reach affected records',()=>{
  const due={...base,reviewAfter:'2026-09-28'};
  const sources=[{id:'cafe-source',recordIds:['cafe']}];
  const monitor={queue:[{id:'task-1',sourceId:'cafe-source',kind:'source-unavailable',status:'open'},
    {id:'task-2',sourceId:'cafe-source',kind:'content-changed',status:'resolved'}]};
  const report=qualityReport([due],sources,'2026-09-28',monitor);
  assert.equal(report.stale,1);
  assert.equal(report.sourceAffected,1);
  assert.deepEqual(report.queue[0].sourceIssues,[{id:'task-1',sourceId:'cafe-source',kind:'source-unavailable',status:'open',details:undefined}]);
  assert.equal(report.queue[0].priority,60+60+8);// source-unavailable 60 + self stale 60 + age 8
});

const issue=(kind,details)=>({id:'t-'+kind,sourceId:'s',kind,status:'open',details});
const priorityWith=(issues,card={},date='2026-10-01')=>{
  const record={...base,reviewAfter:'2026-12-01',min:3,priceKind:'free',languages:['de'],...card};
  const monitor={queue:issues.map(i=>({...i,sourceId:'s'}))};
  return qualityReport([record],[{id:'s',recordIds:[record.id]}],date,monitor).queue[0].priority;
};
test('source signal weight depends on task kind and takes the maximum, not the sum',()=>{
  const none=priorityWith([]);
  const w=issues=>priorityWith(issues)-none;
  assert.equal(w([issue('possible-closure',{lines:[{strength:'strong'}]})]),400);
  assert.equal(w([issue('redirect-changed',{class:'domain'})]),150);
  assert.equal(w([issue('redirect-changed',{class:'language'})]),80);
  assert.equal(w([issue('redirect-changed',{class:'path'})]),80);
  assert.equal(w([issue('content-changed',{})]),80);
  assert.equal(w([issue('content-changed',{significance:'high'})]),150);
  assert.equal(w([issue('content-changed',{significance:'low'})]),20);
  assert.equal(w([issue('parser-failed')]),80);
  assert.equal(w([issue('possible-reopen')]),80);
  assert.equal(w([issue('source-unavailable')]),60);
  assert.equal(w([issue('possible-closure',{lines:[{office:true},{strength:'info'}]})]),80);
  assert.equal(w([issue('possible-closure',{lines:[{office:true},{strength:'strong'}]})]),400);
  assert.equal(w([issue('possible-closure',{}),issue('content-changed',{}),issue('source-unavailable')]),400);
  assert.equal(w([issue('content-changed',{}),issue('content-changed',{})]),80);
});
test('stale weight is 60 for a self-guided place and 120 for a group; imminent self counts as group',()=>{
  const stale=date=>({reviewAfter:date});
  const self=priorityWith([],stale('2026-09-01')),selfFresh=priorityWith([]);
  assert.equal(self-selfFresh,60);
  assert.equal(priorityWith([],{format:'group',...stale('2026-09-01')})-priorityWith([],{format:'group'}),120);
  const events=[{date:'2026-10-05',start:'10:00',end:'11:00'}];
  assert.equal(priorityWith([],{...stale('2026-09-01'),events})-priorityWith([],{events}),120);
});
test('imminent weight is 100 with a source signal, 55 when uncertain, 10 otherwise',()=>{
  const events=[{date:'2026-10-05',start:'10:00',end:'11:00'}];
  assert.equal(priorityWith([],{events})-priorityWith([]),10);
  assert.equal(priorityWith([],{events,status:'check'})-priorityWith([],{status:'check'}),55);
  assert.equal(priorityWith([issue('source-unavailable')],{events})-priorityWith([issue('source-unavailable')]),100);
});
