import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {JobQueue} from './jobs.mjs';
import {jobMetrics} from './operations-report.mjs';

test('operational metrics count failed usage and completed retries without exposing lease tokens',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-metrics-'));let now='2026-10-02T08:00:00.000Z';
  const q=new JobQueue(path.join(dir,'jobs.sqlite'),{now:()=>now});t.after(()=>{q.close();fs.rmSync(dir,{recursive:true,force:true});});
  q.enqueue({kind:'facts',cardId:'a',inputRevision:'one'});const first=q.claim('search','test');
  q.event(first.id,'usage',{model:'test-model',effort:'low',input_tokens:100,cached_input_tokens:80,output_tokens:20,toolCalls:2,failed:true});
  now='2026-10-02T08:00:10.000Z';q.fail(first.id,first.token,'search','network sk-secretvalue');
  let report=jobMetrics(q);assert.match(report.blocked[0].error,/\[redacted\]/);assert.equal(report.usage[0].runs,1);
  now='2026-10-02T09:01:00.000Z';const retry=q.claim('search','test');
  report=jobMetrics(q);assert.equal(report.active[0].cardId,'a');assert.doesNotMatch(JSON.stringify(report),new RegExp(retry.token));
  now='2026-10-02T09:01:30.000Z';q.finish(retry.id,retry.token,'search',{ok:true});
  q.event(retry.id,'usage',{model:'test-model',effort:'low',input_tokens:150,cached_input_tokens:120,output_tokens:30,toolCalls:3});
  q.event(retry.id,'usage',{model:'test-model',effort:'low',input_tokens:999,replayed:true});
  report=jobMetrics(q);assert.equal(report.stageTimes[0].medianSeconds,30);assert.equal(report.stageTimes[0].completedAttempts,1);
  assert.deepEqual(report.usage[0],{route:'test-model / low',runs:2,inputTokens:250,cachedInputTokens:200,outputTokens:50,toolCalls:5});
});
