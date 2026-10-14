import test from 'node:test';
import assert from 'node:assert/strict';
import {workPackets} from './work-packets.mjs';

const record={id:'meeting',name:'Meeting',region:'sense',checked:'2026-09-27',reviewAfter:'2026-10-20',
  status:'check',format:'event',category:'music',min:2,parent:'yes',priceKind:'free',address:'A',languages:['DE'],
  events:[{date:'2026-09-29',start:'10:00',end:'11:00'}],sources:[{url:'https://example.org/event'}],
  research:{remaining:['Can a parent stay?']},practical:{}};
const sources=[{id:'official',url:'https://example.org/event',recordIds:['meeting']}];
const monitor={queue:[{id:'source-task',sourceId:'official',recordIds:['meeting'],kind:'source-unavailable',status:'open',
  firstSeen:'2026-09-27',lastSeen:'2026-09-28',details:{error:'HTTP 503'}}]};
const coverage={catalogueCards:1,officialSource:'https://example.org/municipalities',categoryPresence:{music:{},water:{}},
  districts:{sense:{municipalities:2}},municipalitiesList:[
    {name:'A',ofs:1,region:'sense',recordIds:['meeting'],categoryCounts:{music:1,water:0}},
    {name:'B',ofs:2,region:'sense',recordIds:[],categoryCounts:{music:0,water:0}}]};

test('packets separate source failures, card verification and discovery without private data',()=>{
  const packets=workPackets([record],sources,monitor,coverage,'2026-09-28');
  assert.equal(packets.review[0].id,'meeting');
  assert.deepEqual(packets.review[0].openQuestions,['Can a parent stay?']);
  assert.equal(packets.review[0].decision,'research-only');
  assert.equal(packets.sourceFailures[0].id,'source-task');
  assert.equal(packets.discovery[0].municipalities[0].name,'B');
  assert.deepEqual(packets.discovery[0].unrepresentedCategories,['water']);
  assert.doesNotMatch(JSON.stringify(packets),/favorites|familyToken|personalNote/);
});

test('outdated geographic coverage is not issued as a discovery brief',()=>{
  const packets=workPackets([record],sources,monitor,{...coverage,catalogueCards:0},'2026-09-28');
  assert.equal(packets.coverageCurrent,false);
  assert.deepEqual(packets.discovery,[]);
});
test('semantic worker availability is distinct from a completed empty review',()=>{
  const status=report=>workPackets([record],sources,monitor,coverage,'2026-09-28',null,null,report).semanticStatus;
  assert.equal(status(null),'not-requested');assert.equal(status({busy:true}),'busy');
  assert.equal(status({unavailable:true}),'unavailable');assert.equal(status({enabled:false}),'disabled');
  assert.equal(status({generatedFor:'2026-09-28'}),'completed');assert.equal(status({generatedFor:'2026-09-27'}),'outdated');
});
test('dated event candidates are separate research-only briefs and stale reports are withheld',()=>{
  const eventReport={generatedFor:'2026-09-28',errors:[],series:[
    {title:'Parent-child cafe',feedId:'aef',url:'https://example.org/cafe',dates:['2026-09-29'],matchedRecordIds:[],familyHint:true,status:'new'},
    {title:'Adult lecture',feedId:'city',url:'https://example.org/adult',dates:['2026-11-29'],matchedRecordIds:[],familyHint:false,status:'pending'}]};
  const packets=workPackets([record],sources,monitor,coverage,'2026-09-28',eventReport);
  assert.equal(packets.summary.eventSeries,2);
  assert.equal(packets.summary.nearTermFamilySeries,1);
  assert.equal(packets.eventDiscovery[0].priority,'near-term-family');
  assert.equal(packets.eventDiscovery[0].decision,'candidate-research-only');
  assert.deepEqual(workPackets([record],sources,monitor,coverage,'2026-09-29',eventReport).eventDiscovery,[]);
});
test('external evidence backlog joins research packets only for the current catalogue',()=>{
  const external={generatedFor:'2026-09-28',records:1,queue:[{id:'meeting',status:'pending',decision:'research-only'}]};
  const packets=workPackets([record],sources,monitor,coverage,'2026-09-28',null,external);
  assert.equal(packets.summary.externalReviewBacklog,1);
  assert.equal(packets.externalReview[0].id,'meeting');
  assert.deepEqual(workPackets([record],sources,monitor,coverage,'2026-09-29',null,external).externalReview,[]);
});
