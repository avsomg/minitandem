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
  assert.ok(report.queue[0].priority>=200);
});
