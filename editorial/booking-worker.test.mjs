import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {runClaudeNoTools,isolationArgs} from './claude-worker.mjs';
function child(events,code=0){
  const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.kill=()=>queueMicrotask(()=>c.emit('close',1));
  c.stdin={end:()=>queueMicrotask(()=>{for(const e of events)c.stdout.emit('data',Buffer.from(JSON.stringify(e)+'\n'));c.emit('close',code);})};return c;
}
const success={type:'result',subtype:'success',structured_output:{value:true},usage:{input_tokens:10,cache_read_input_tokens:30,cache_creation_input_tokens:5,output_tokens:2}};
test('saved-text worker uses shared isolation with no tools and counts cache tokens',async t=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'booking-worker-test-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  const out=await runClaudeNoTools({prompt:'Complete saved text',schema:{type:'object'},model:'haiku',cwd},{authImpl:()=>{},cliImpl:()=>{},runImpl:(command,args,options)=>{
    assert.equal(command,'claude');assert.equal(options.cwd,cwd);assert.equal(args[args.indexOf('--tools')+1],'');
    for(const arg of isolationArgs)assert.ok(args.includes(arg));
    const settings=JSON.parse(args[args.indexOf('--settings')+1]);assert.deepEqual(settings.permissions.allow,[]);
    assert.ok(settings.disableAllHooks);assert.equal(options.env.ANTHROPIC_API_KEY,undefined);return child([success]);
  }});
  assert.equal(out.usage.input_tokens,45);assert.equal(out.usage.output_tokens,2);assert.deepEqual(out.answer,{value:true});
  assert.deepEqual(fs.readdirSync(cwd),[]);
});
test('invalid, tool-using, duplicated and denied results fail closed',async()=>{
  for(const events of [[{...success,is_error:true}], [success,success], [{type:'assistant',message:{content:[{type:'tool_use'}]}},success],
    [{...success,permission_denials:[{tool_name:'Read'}]}], [{...success,structured_output:null}]]){
    await assert.rejects(runClaudeNoTools({prompt:'text',schema:{},model:'sonnet',cwd:os.tmpdir()},{authImpl:()=>{},cliImpl:()=>{},runImpl:()=>child(events)}));
  }
  const unmeasured=await runClaudeNoTools({prompt:'text',schema:{},model:'sonnet',cwd:os.tmpdir()},{authImpl:()=>{},cliImpl:()=>{},runImpl:()=>child([{...success,usage:undefined}])});
  assert.equal(unmeasured.usage,null);
  await assert.rejects(runClaudeNoTools({prompt:'x'.repeat(60001),schema:{},model:'sonnet',cwd:os.tmpdir()},{runImpl:()=>{throw Error('must not spawn');}}),/not truncated/);
});
