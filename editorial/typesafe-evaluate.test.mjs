import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {hash,snapshot,saveSnapshot,writeJsonAtomic} from './evidence.mjs';
import {readPolicy} from './typesafe.mjs';
import {evaluate} from './typesafe-evaluate.mjs';

const policy=await readPolicy();
const now='2026-10-01T12:00:00Z';
const group={id:'frozen-real',provenance:'real-source',url:'https://example.org/course',recordId:'example',
  target:{id:'example',name:'Example',town:'Fribourg'},language:'DE',
  checks:[['age','Participants are aged 3 to 6.','supports',3]]};
const mock=calls=>({systemOne:async request=>{
  calls.push(request);
  return {model:policy.model,usage:{input_tokens:100,output_tokens:0},answers:Object.fromEntries(
    Object.keys(request.questions).map(key=>[key,{type:'choice',choice:'supports',confidence:1,
      probabilities:{supports:1,contradicts:0,not_stated:0}}]))};
}});

test('evaluation reuses frozen source identity without sending labels or ages to the model',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'minitandem-evaluation-'));
  try{
    const groups=[group],datasetHash=hash(JSON.stringify(groups));
    const evidence=snapshot({url:group.url,fetchedAt:now,text:'Example activity in Fribourg for participants aged 3 to 6.'});
    await saveSnapshot(directory,evidence);
    await writeJsonAtomic(path.join(directory,'evaluations',datasetHash,'sources.json'),{schema:1,datasetHash,sources:{[group.url]:evidence.id}});
    const calls=[];
    const first=await evaluate({groups,policy,client:mock(calls),now,directory});
    const next=await evaluate({groups,policy,client:mock(calls),now:'2026-10-02T12:00:00Z',directory});
    assert.equal(first.rows[0].snapshotId,evidence.id);assert.equal(next.rows[0].snapshotId,evidence.id);
    assert.equal(calls.length,1);assert.equal(next.requests,0);assert.equal(first.overall.correct,1);
    assert.doesNotMatch(JSON.stringify(calls),/"expected"|"childAge"/);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('tampered frozen sources fail closed and do not invoke TypeSafe',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'minitandem-evaluation-tamper-'));
  try{
    const groups=[group],datasetHash=hash(JSON.stringify(groups));
    const evidence=snapshot({url:group.url,fetchedAt:now,text:'Original public information for this example activity.'});
    await saveSnapshot(directory,evidence);
    await writeJsonAtomic(path.join(directory,'snapshots',evidence.id+'.json'),{...evidence,text:'Changed unsupported information that must not enter the model.'});
    await writeJsonAtomic(path.join(directory,'evaluations',datasetHash,'sources.json'),{schema:1,datasetHash,sources:{[group.url]:evidence.id}});
    const calls=[],report=await evaluate({groups,policy,client:mock(calls),now,directory});
    assert.equal(calls.length,0);assert.equal(report.overall.judged,0);assert.equal(report.rows[0].status,'source-unavailable');
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
