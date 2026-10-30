import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {classify,deadlineAfter,runNight,RULES} from './night-run.mjs';

const ok={code:0,output:{results:[{kind:'facts',cardId:'a',result:{state:'done'}}],stopReason:null},seconds:1};
const stopped=reason=>({code:0,output:{results:[],stopReason:reason},seconds:1});
const idle={code:0,output:{results:[],stopReason:null},seconds:1};

function scene(script,{cards=[],until='04:45',start='2026-10-30T19:00:00Z',stepMs=60000}={}){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'night-'));
  fs.mkdirSync(path.join(base,'workflow-state'),{recursive:true});
  let clock=Date.parse(start),released=0;
  const calls=[],notes=[],waits=[];
  const record=runNight({base,until,cards,now:()=>new Date(clock),notify:(_,text)=>notes.push(text),
    sleep:ms=>{waits.push(ms);clock+=ms;},lock:()=>()=>{released++;},readDigest:()=>null,
    run:(_,args)=>{calls.push(args);clock+=stepMs;const next=typeof script==='function'?script(calls.length,base):script[calls.length-1];return next??idle;}});
  return {record,calls,notes,released,base,waits};
}

test('classify',()=>{
  assert.equal(classify(ok),'ok');
  assert.equal(classify(stopped('systemic-failure-circuit')),'fatal');
  assert.equal(classify(stopped('editorial-runtime-changed')),'fatal');
  assert.equal(classify(stopped('worker-provider-failure')),'provider');
  assert.equal(classify(stopped('worker-login-unavailable')),'provider');
  assert.equal(classify({code:1,output:null}),'failed');
  assert.equal(classify({code:0,output:{results:[{error:'x'},{error:'y'}],stopReason:null}}),'failed');
  assert.equal(classify({code:0,output:{results:[{error:'x'},{result:{}}],stopReason:null}}),'ok');
  assert.equal(classify(stopped('lease-lost')),'soft');
  assert.equal(classify(stopped('run-time-budget')),'soft');
  assert.equal(classify(idle),'idle');
});

test('the deadline is the next 04:45 in Zurich',()=>{
  assert.equal(deadlineAfter(new Date('2026-10-30T19:00:00Z'),'04:45').toISOString(),'2026-10-31T03:45:00.000Z');
  assert.equal(deadlineAfter(new Date('2026-10-31T02:00:00Z'),'04:45').toISOString(),'2026-10-31T03:45:00.000Z');
});

test('stops at the hour and never starts a run after it',()=>{
  const {record,calls,released}=scene(()=>ok,{stepMs:3600000});
  assert.match(record.stopped,/no new run after 04:45/);
  assert.equal(calls.length,9);
  assert.equal(released,1);
});

test('the circuit or a runtime change stops at once',()=>{
  const {record,calls}=scene([ok,stopped('editorial-runtime-changed'),ok]);
  assert.equal(calls.length,2);
  assert.equal(record.stopped,'editorial-runtime-changed');
});

test('a usage limit waits, and a good run clears the streak',()=>{
  const {record,calls,waits}=scene((n)=>n<=2?stopped('worker-provider-failure'):n===3?ok:n===4?stopped('systemic-failure-circuit'):ok);
  assert.equal(calls.length,4);
  assert.equal(record.streaks.provider,0);
  assert.ok(waits.length>0);
});

test('provider stops give up after the set number',()=>{
  const {record,calls}=scene(()=>stopped('worker-provider-failure'));
  assert.equal(calls.length,RULES.provider.max);
  assert.match(record.stopped,/provider/);
});

test('three failed runs stop the night',()=>{
  const {record,calls}=scene(()=>({code:1,output:null,error:'boom',seconds:1}));
  assert.equal(calls.length,RULES.failed.max);
  assert.match(record.stopped,/failed/);
});

test('an empty queue stops after the idle waits',()=>{
  const {record,calls}=scene(()=>idle);
  assert.equal(calls.length,RULES.idle.max);
  assert.match(record.stopped,/idle/);
});

test('the first cards run on their own, then the queue',()=>{
  const {calls}=scene((n)=>n===1||n===2||n===4?ok:n===3?idle:n===6?stopped('systemic-failure-circuit'):n===5?idle:ok,{cards:['a','b']});
  assert.deepEqual(calls[0],['--card=a']);
  assert.deepEqual(calls[1],['--card=a']);
  assert.deepEqual(calls[2],['--card=a']);
  assert.deepEqual(calls[3],['--card=b']);
  assert.deepEqual(calls[4],['--card=b']);
  assert.deepEqual(calls[5],[]);
});

test('the stop file ends the night after the current run and is removed',()=>{
  const {record,calls,base}=scene((n,dir)=>{if(n===2)fs.writeFileSync(path.join(dir,'workflow-state','night.stop'),'');return ok;});
  assert.equal(calls.length,2);
  assert.equal(record.stopped,'stop file');
  assert.equal(fs.existsSync(path.join(base,'workflow-state','night.stop')),false);
});

test('an open circuit found before a run stops without running',()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'night-'));
  fs.mkdirSync(path.join(base,'workflow-state'),{recursive:true});
  let runs=0;
  const record=runNight({base,now:()=>new Date('2026-10-30T19:00:00Z'),notify:()=>{},sleep:()=>{},lock:()=>()=>{},
    readDigest:()=>({lastEventId:1,claimed:0,completed:{},attention:[],retries:[],rejectedOutputs:0,usage:{line:''},open:{},circuit:{open:true}}),run:()=>{runs++;return ok;}});
  assert.equal(runs,0);
  assert.equal(record.stopped,'the circuit is open');
});

test('a held lock is waited for, then given up on',()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'night-'));
  fs.mkdirSync(path.join(base,'workflow-state'),{recursive:true});
  let tries=0,runs=0;
  const record=runNight({base,now:()=>new Date('2026-10-30T19:00:00Z'),notify:()=>{},sleep:()=>{},lock:()=>{tries++;return null;},readDigest:()=>null,run:()=>{runs++;return ok;},lockWaitMinutes:2});
  assert.equal(tries,3);
  assert.equal(runs,0);
  assert.match(record.stopped,/lock/);
});
