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

// Recorded 20 Oct 2026 from `claude -p --model claude-haiku-5-5 --tools '' --output-format stream-json --verbose
// --json-schema ...` (CLI 2.1.295): the answer arrives as a tool_use block named StructuredOutput, then its tool_result.
// Ids, timestamps and unrelated bookkeeping fields were dropped; the block and result shapes are untouched.
const recorded=[{"type": "assistant", "message": {"model": "claude-haiku-5-5", "type": "message", "role": "assistant", "content": [{"type": "tool_use", "id": "toolu_01LYst9LAGzEpWWYhgA3rTNr", "name": "StructuredOutput", "input": {"verdict": "yes", "reason": "2 + 2 = 4 under standard arithmetic."}, "caller": {"type": "direct"}}], "container": null, "stop_reason": null, "stop_sequence": null, "stop_details": null, "usage": {"input_tokens": 2, "cache_creation_input_tokens": 3047, "cache_read_input_tokens": 0, "cache_creation": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 3047}, "output_tokens": 24, "service_tier": "standard", "inference_geo": "global", "speed": "standard"}, "input_transformations": [], "diagnostics": null, "context_management": null}, "parent_tool_use_id": null},
  {"type": "user", "message": {"role": "user", "content": [{"tool_use_id": "toolu_01LYst9LAGzEpWWYhgA3rTNr", "type": "tool_result", "content": "Structured output provided successfully"}]}, "parent_tool_use_id": null, "tool_use_result": "Structured output provided successfully", "tool_result_meta": [{"id": "toolu_01LYst9LAGzEpWWYhgA3rTNr", "permission_decision": {"decision": "accept", "source": "config"}}]},
  {"stop_reason": "tool_use", "total_cost_usd": 0.0006565999999999999, "usage": {"input_tokens": 2, "cache_creation_input_tokens": 3047, "cache_read_input_tokens": 0, "output_tokens": 94, "output_tokens_details": {"thinking_tokens": 0}, "server_tool_use": {"web_search_requests": 0, "web_fetch_requests": 0}, "service_tier": "standard", "cache_creation": {"ephemeral_1h_input_tokens": 3047, "ephemeral_5m_input_tokens": 0}, "inference_geo": "global", "iterations": [], "speed": "standard", "fallback_credit": null}, "permission_denials": [], "terminal_reason": "completed", "safety_stops": 0, "is_error": false, "num_turns": 2, "subtype": "success", "api_error_status": null, "result": "{\"verdict\":\"yes\",\"reason\":\"2 + 2 = 4 under standard arithmetic.\"}", "structured_output": {"verdict": "yes", "reason": "2 + 2 = 4 under standard arithmetic."}, "type": "result", "result_index": 0}];
test('the CLI structured-output block is the answer channel, not a tool call',async()=>{
  const out=await runClaudeNoTools({prompt:'Is 2+2 equal to 4?',schema:{type:'object'},model:'claude-haiku-5-5',cwd:os.tmpdir()},
    {authImpl:()=>{},cliImpl:()=>{},runImpl:()=>child(recorded)});
  assert.deepEqual(out.answer,{verdict:'yes',reason:'2 + 2 = 4 under standard arithmetic.'});
  assert.equal(out.usage.toolCalls,0);assert.equal(out.usage.input_tokens,3049);assert.equal(out.usage.output_tokens,94);
});
test('a real tool call still stops a no-tools worker, even next to the structured-output block',async()=>{
  const structured=recorded[0],real=name=>({type:'assistant',message:{content:[{type:'tool_use',id:'toolu_x',name,input:{}}]}});
  for(const events of [[real('Read'),...recorded],[real('Bash'),...recorded],[real('WebSearch')],[real('mcp__x__y')],
    [{type:'assistant',message:{content:[{type:'tool_use'}]}},...recorded],
    [{type:'assistant',message:{content:[{type:'tool_use',name:'structuredoutput'}]}},...recorded],
    [{...structured,message:{...structured.message,content:[...structured.message.content,{type:'tool_use',id:'toolu_y',name:'Read',input:{}}]}},...recorded.slice(1)]]){
    await assert.rejects(runClaudeNoTools({prompt:'text',schema:{},model:'sonnet',cwd:os.tmpdir()},{authImpl:()=>{},cliImpl:()=>{},runImpl:()=>child(events)}),/attempted a tool call/);
  }
});
