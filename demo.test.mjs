import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {runDemo} from './demo/run.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
// The earlier working title, assembled so that this file does not contain it.
const OLD_NAME=new RegExp('vme'+'ste','i');
const CYRILLIC=/[\u0400-\u04FF]/;
// Name, size and modification time of every file under the private editorial state the demo must not touch (if that state exists at all).
function privateState(){
  const rows=[];
  const walk=file=>{
    if(!fs.existsSync(file))return;
    const stat=fs.statSync(file);
    if(!stat.isDirectory()){rows.push(path.relative(root,file)+':'+stat.size+':'+stat.mtimeMs);return;}
    for(const entry of fs.readdirSync(file))walk(path.join(file,entry));
  };
  for(const name of ['workflow-state','agent-artifacts','typesafe-runtime','external-candidates','corrections','correction-versions','approved-updates.json','external-review-receipts.json'])
    walk(path.join(root,'editorial',name));
  return rows.sort();
}

test('the demo ends in the expected state: one wrong claim caught, one refused draft, one applied update, gates passed',async()=>{
  const before=privateState(),lines=[];
  const result=await runDemo({write:line=>lines.push(line)});
  assert.equal(result.claims,5);
  assert.equal(result.approvedClaims,3);
  assert.equal(result.rejectedClaims,1);
  assert.match(result.refusal,/Patch binding does not match an approved claim: priceKind/);
  assert.deepEqual(result.firstAttempt,{state:'retry',attempt:1,category:'contract',circuitOpen:false});
  assert.equal(result.secondAttempt.attempt,2);
  assert.equal(result.updates,1);
  assert.deepEqual(result.changedFields,['min','max','age','parent']);
  assert.equal(result.priceUnchanged,true);
  assert.equal(result.gate,'passed');
  assert.equal(result.qaRefusal,'Release lacks required QA');
  assert.equal(result.networkCalls,0);
  assert.ok(result.queue.includes('qa:ready:1'),'the QA job is queued, not run');
  const text=lines.join('\n');
  assert.match(text,/REJECT\s+priceKind/);
  assert.match(text,/controller refuses the draft/);
  assert.match(text,/editorial gates pass/);
  // The demo must be readable English and must not leak the internal project identifier.
  assert.doesNotMatch(text,CYRILLIC);
  assert.doesNotMatch(text,OLD_NAME);
  assert.deepEqual(privateState(),before,'the demo opened or changed private editorial state');
});

test('the demo restores the global fetch and cleans up its temporary folder',async()=>{
  const fetchBefore=globalThis.fetch;
  const folders=()=>fs.readdirSync(os.tmpdir()).filter(name=>name.startsWith('minitandem-demo-'));
  const before=folders();
  await runDemo({write:()=>{}});
  assert.equal(globalThis.fetch,fetchBefore);
  assert.deepEqual(folders(),before);
});

test('npm run demo: the command runs offline, exits 0 and prints the story step by step',()=>{
  const run=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','demo/run.mjs'],{cwd:root,encoding:'utf8',
    env:{...process.env,HTTP_PROXY:'http://127.0.0.1:9',HTTPS_PROXY:'http://127.0.0.1:9',NO_COLOR:'1'}});
  assert.equal(run.status,0,run.stderr);
  assert.equal(run.stderr,'');
  const order=['1  Search worker','2  Independent verifier','3  Editor, first draft','[stopped] controller refuses the draft','4  Editor, second draft',
    '5  Second verifier approves','6  Release check','network calls: 0'];
  let at=-1;
  for(const marker of order){const next=run.stdout.indexOf(marker);assert.ok(next>at,marker+' is missing or out of order');at=next;}
  assert.doesNotMatch(run.stdout,CYRILLIC);
  assert.doesNotMatch(run.stdout,OLD_NAME);
});

test('every demo fixture is English, names no internal identifier and describes only invented places',()=>{
  const folder=path.join(root,'demo','fixtures');
  for(const name of fs.readdirSync(folder)){
    const text=fs.readFileSync(path.join(folder,name),'utf8');
    assert.doesNotMatch(text,CYRILLIC,name);
    assert.doesNotMatch(text,OLD_NAME,name);
  }
  const cards=JSON.parse(fs.readFileSync(path.join(folder,'training-cards.json'),'utf8'));
  assert.equal(cards.length,3);
  for(const card of cards){
    assert.match(card.name,/\(training card\)$/);
    for(const source of card.sources)assert.match(new URL(source.url).hostname,/\.example\.org$/);
  }
});
