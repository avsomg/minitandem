import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {CLAIM_FIELDS,validateFieldValue} from './field-contract.mjs';
import {claimValueSchema,workerOutputSchema,decodeWorkerOutput} from './worker-schema.mjs';

const job={id:'job',kind:'facts',input_revision:'revision',card_id:'activity'};
const claim={key:'event',field:'events',value:[{date:'2026-10-04',start:'09:30',end:'10:30',title:'',address:''}],
  status:'supported',scope:'exact-card',kind:'official',source:'https://example.org/event',quote:'4 October, 09:30–10:30',snapshotId:null,note:'Published exact session.'};
const envelope=claims=>({project:'vmeste',jobId:job.id,inputRevision:job.input_revision,
  result:{bundle:{project:'vmeste',cardId:job.card_id,snapshots:[],claims}}});

test('every extraction field has a compiled native value schema',()=>{
  const ajv=new Ajv({strict:true});
  for(const field of CLAIM_FIELDS)assert.equal(typeof ajv.compile(claimValueSchema(field)),'function',field);
  assert.equal(typeof ajv.compile(workerOutputSchema(job)),'function');
});
test('native extraction refuses invented fields, ISO clock values, mismatched identity and fabricated snapshots',()=>{
  assert.deepEqual(decodeWorkerOutput(envelope([claim]),job),envelope([claim]).result);
  for(const changed of [
    {...claim,field:'research.findings.0'},
    {...claim,value:[{start:'2026-10-04T09:30:00+02:00',end:'2026-10-04T10:30:00+02:00'}]},
    {...claim,value:[{...claim.value[0],end:{hour:10}}]},
    {...claim,field:'practical.booking',value:'No registration'},
    {...claim,status:'unknown',value:true}
  ])assert.throws(()=>decodeWorkerOutput(envelope([changed]),job),/schema mismatch/);
  const wrong=envelope([claim]);wrong.result.bundle.cardId='another';
  assert.throws(()=>decodeWorkerOutput(wrong,job),/schema mismatch/);
  const fake=envelope([claim]);fake.result.bundle.snapshots=[{text:'Manufactured'}];
  assert.throws(()=>decodeWorkerOutput(fake,job),/schema mismatch/);
});
test('schema success cannot bypass calendar semantics or independent source verification',()=>{
  const impossible={...claim,value:[{...claim.value[0],date:'2026-02-30'}]};
  decodeWorkerOutput(envelope([impossible]),job);
  assert.throws(()=>validateFieldValue('events',impossible.value),/field value type/);
  const unknown={...claim,value:null,status:'unknown',quote:''};
  decodeWorkerOutput(envelope([unknown]),job);
});
test('other stages retain their output contract while enforcing the exact job and revision',()=>{
  const verify={...job,kind:'verify-facts'},answer={project:'vmeste',jobId:job.id,inputRevision:job.input_revision,resultJson:'{"verdicts":[]}'};
  assert.deepEqual(decodeWorkerOutput(answer,verify),{verdicts:[]});
  assert.throws(()=>decodeWorkerOutput({...answer,inputRevision:'old'},verify),/schema mismatch/);
});
