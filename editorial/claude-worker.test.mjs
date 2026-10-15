import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {JobQueue,failureCategory} from './jobs.mjs';
import {runClaude,modelRoute,runModel,gatedRoles,assertWorkerPolicy,modelPreflight} from './agent-run.mjs';
import {claudeEnvironment,claudeSettings,requireClaudeSubscription,claudeUsage,claudeLoginProbe,assertClaudeReady,failureDetail,workerRoot,requireClaudeCli,wrapText,readableEvidence,claudeSchema,claudeEnvelope} from './claude-worker.mjs';
import {snapshot,locateQuote,normalizeQuote} from './evidence.mjs';
const job={id:'migration-contract-job',kind:'verify-facts',input_revision:'migration-contract-revision',payload:{bundle:{claims:[],snapshots:[]}}};
const policy={workerProvider:'claude',roles:{verify:{model:'retained-codex-model',claudeModel:'sonnet',effort:'low',criticalEffort:'medium'}},maxToolCallsPerJob:3};
const envelope={project:'vmeste',jobId:job.id,inputRevision:job.input_revision,result:{verdicts:[]}};
function childFor(args,options,events,exit=0){
  const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.kill=()=>queueMicrotask(()=>c.emit('close',1));
  c.stdin={end:()=>queueMicrotask(()=>{for(const e of events)c.stdout.emit('data',Buffer.from(JSON.stringify(e)+'\n'));c.emit('close',exit);})};return c;
}
test('only subscription authentication is accepted; API providers never silently substitute',()=>{
  const execImpl=()=>JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max'});
  assert.equal(requireClaudeSubscription({execImpl}).subscriptionType,'max');
  for(const obj of [{loggedIn:false},{loggedIn:true,authMethod:'apiKey',apiProvider:'firstParty',subscriptionType:'max'}, {loggedIn:true,authMethod:'claude.ai',apiProvider:'bedrock',subscriptionType:'max'}])
    assert.throws(()=>requireClaudeSubscription({execImpl:()=>JSON.stringify(obj)}),/required/);
});
test('environment drops client credentials, API keys, Codex identity and provider overrides',()=>{
  const env=claudeEnvironment({PATH:'/bin',HOME:'/owner',ANTHROPIC_API_KEY:'test',CODEX_THREAD_ID:'other',RANDEWOO_TOKEN:'test',CLAUDE_CODE_USE_VERTEX:'1'});
  assert.equal(env.HOME,'/owner');for(const key of ['ANTHROPIC_API_KEY','CODEX_THREAD_ID','RANDEWOO_TOKEN','CLAUDE_CODE_USE_VERTEX'])assert.equal(env[key],undefined);
});
test('worker tools have no shell, writes, agents, Chrome or shared MCP servers',async()=>{
  let directory;
  const out=await runClaude(job,policy,{authImpl:()=>{},runImpl:(command,args,options)=>{
    assert.equal(command,'claude');directory=options.cwd;
    assert.equal(args[args.indexOf('--tools')+1],'Read,WebSearch,WebFetch');
    assert.equal(args[args.indexOf('--allowedTools')+1],`Read(/${directory}/**),WebSearch,WebFetch`);
    assert.equal(args[args.indexOf('--permission-mode')+1],'dontAsk');assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(args.includes('--disable-slash-commands'));assert.ok(args.includes('--no-session-persistence'));assert.ok(args.includes('--no-chrome'));
    assert.equal(args.includes('--dangerously-skip-permissions'),false);
    assert.deepEqual(JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1])),claudeSettings(directory));
    return childFor(args,options,[{type:'result',subtype:'success',structured_output:envelope,usage:{input_tokens:11,cache_read_input_tokens:30,cache_creation_input_tokens:7,output_tokens:5}}]);
  }});
  assert.deepEqual(out.result,{verdicts:[]});assert.equal(out.usage.input_tokens,48);assert.equal(out.usage.cached_input_tokens,30);assert.equal(fs.existsSync(directory),false);
});
test('wrong job identity, unstructured output and provider errors fail closed',async()=>{
  for(const event of [ {type:'result',subtype:'success',structured_output:{...envelope,jobId:'other'}},
    {type:'result',subtype:'success',result:JSON.stringify(envelope)}, {type:'result',subtype:'error_max_turns',is_error:true},
    {type:'result',subtype:'success',structured_output:{...envelope,result:'{"verdicts":[]}'}},
    {type:'result',subtype:'success',structured_output:{project:'vmeste',jobId:job.id,inputRevision:job.input_revision,resultJson:'{"verdicts":[]}'}}]){
    await assert.rejects(runClaude(job,policy,{authImpl:()=>{},runImpl:(_c,args,options)=>childFor(args,options,[event])}));
  }
});
test('tool-call excess rejects output even if the provider emits a success result',async()=>{
  const events=[{type:'assistant',message:{content:Array.from({length:4},()=>({type:'tool_use'}))}}, {type:'result',subtype:'success',structured_output:envelope}];
  await assert.rejects(runClaude(job,policy,{authImpl:()=>{},runImpl:(_c,args,options)=>childFor(args,options,events)}),/tool-call budget/);
});
test('provider choice is explicit and existing Codex routes stay unchanged',()=>{
  assert.equal(modelRoute(job,policy).model,'sonnet');assert.equal(modelRoute(job,{...policy,workerProvider:'codex'}).model,'retained-codex-model');
  assert.throws(()=>runModel(job,{...policy,workerProvider:'unknown'}),/Unknown/);
});
// Shape returned by CLI 2.1.109 on 8 October 2026 while `auth status` reported an active Max login.
const rejectedLogin={status:1,stderr:'',stdout:JSON.stringify({type:'result',subtype:'success',is_error:true,
  result:'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token is invalid."},"request_id":null}'})};
const savedLogin=()=>({provider:'claude',authMethod:'claude.ai',subscriptionType:'max'});
test('a saved subscription login that the server rejects is not readiness',()=>{
  const probeImpl=options=>claudeLoginProbe({...options,runImpl:()=>rejectedLogin});
  assert.throws(()=>assertClaudeReady({authImpl:savedLogin,probeImpl,rootImpl:()=>{},cliImpl:()=>({})}),error=>
    /authentication/.test(error.message)&&failureCategory(error.message)==='provider-configuration');
  assert.throws(()=>claudeLoginProbe({runImpl:()=>({status:null,stdout:'',stderr:'',error:Error('spawnSync claude ETIMEDOUT')})}),/ETIMEDOUT/);
  assert.throws(()=>claudeLoginProbe({runImpl:()=>({status:0,stdout:'not json',stderr:''})}),/login check failed/);
  let call;
  const ready=assertClaudeReady({authImpl:savedLogin,rootImpl:()=>{},cliImpl:()=>({cliVersion:'2.1.295'}),probeImpl:options=>claudeLoginProbe({...options,runImpl:(command,args,spawnOptions)=>{
    call={command,args,spawnOptions};
    return {status:0,stderr:'',stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,result:'OK',modelUsage:{'probe-model':{}}})};
  }})});
  assert.deepEqual(ready,{cliVersion:'2.1.295',provider:'claude',authMethod:'claude.ai',subscriptionType:'max',probeModel:'haiku',actualModels:['probe-model']});
  assert.equal(call.command,'claude');assert.equal(call.args[call.args.indexOf('--tools')+1],'');
  assert.equal(call.spawnOptions.env.ANTHROPIC_API_KEY,undefined);assert.equal(fs.existsSync(call.spawnOptions.cwd),false);
});
test('a failed readiness check leaves model jobs unclaimed with their attempts intact',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-gate-test-')),q=new JobQueue(path.join(directory,'jobs.sqlite'));
  t.after(()=>{q.close();fs.rmSync(directory,{recursive:true,force:true});});
  const verify=q.enqueue({kind:'verify-facts',cardId:'card-a',inputRevision:'r',priority:10});
  const qa=q.enqueue({kind:'qa',cardId:'catalogue',inputRevision:'r',priority:1});
  let calls=0;const pauses=[];
  const gate={preflight:async()=>{calls++;throw Error('Claude login check failed: authentication; exit 1');},ready:null,reason:null,retryMs:7,sleep:async ms=>{pauses.push(ms);}};
  const priorities=new Map([['verify',10],['qa',1]]);
  for(let i=0;i<2;i++){
    const roles=await gatedRoles(['verify','qa'],priorities,gate);
    assert.deepEqual(roles,['qa']);
    for(const role of roles)q.claim(role,`runtime-${role}`);
  }
  // Asked twice with one pause in between, and not again on the next loop.
  assert.equal(calls,2);assert.deepEqual(pauses,[7]);assert.equal(gate.tries,2);assert.match(gate.reason,/authentication/);
  assert.equal(q.get(verify.id).state,'ready');assert.equal(q.get(verify.id).attempt,0);assert.equal(q.get(qa.id).state,'leased');
  const idle={preflight:async()=>{calls++;},ready:null,reason:null};
  assert.deepEqual(await gatedRoles(['verify','qa'],new Map([['qa',1]]),idle),['qa']);assert.equal(calls,2);
  assert.deepEqual(await gatedRoles(['verify','qa'],priorities,idle),['verify','qa']);assert.equal(calls,3);
  assert.deepEqual(await gatedRoles(['verify','qa'],priorities,{preflight:null,ready:null}),['verify','qa']);
});
test('a login check that fails once and then succeeds does not lose the batch',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-gate-retry-')),q=new JobQueue(path.join(directory,'jobs.sqlite'));
  t.after(()=>{q.close();fs.rmSync(directory,{recursive:true,force:true});});
  const verify=q.enqueue({kind:'verify-facts',cardId:'card-a',inputRevision:'r',priority:10});
  let calls=0;const pauses=[];
  const gate={preflight:async()=>{if(++calls===1)throw Error('Claude subscription login could not be verified; no API fallback');},ready:null,reason:null,
    retryMs:60000,sleep:async ms=>{pauses.push(ms);}};
  const roles=await gatedRoles(['verify','qa'],new Map([['verify',10]]),gate);
  assert.deepEqual(roles,['verify','qa']);assert.equal(gate.ready,true);assert.equal(calls,2);assert.deepEqual(pauses,[60000]);
  const job=q.claim('verify','runtime-verify');assert.equal(job.id,verify.id);assert.equal(job.attempt,1);
  // A check that passes at once never pauses.
  const quick={preflight:async()=>{calls++;},ready:null,reason:null,sleep:async ms=>{pauses.push(ms);}};
  assert.deepEqual(await gatedRoles(['verify'],new Map([['verify',1]]),quick),['verify']);assert.deepEqual(pauses,[60000]);assert.equal(quick.tries,1);
});
test('an incomplete Claude route is refused before any job can be claimed',()=>{
  const roles={verify:{model:'retained-codex-model',claudeModel:'sonnet',effort:'low',criticalEffort:'medium'},qa:{model:null,effort:null}};
  assert.equal(assertWorkerPolicy({roles}),'codex');assert.equal(assertWorkerPolicy({workerProvider:'claude',roles}),'claude');
  assert.equal(modelPreflight({roles}),null);
  assert.throws(()=>assertWorkerPolicy({workerProvider:'api',roles}),/Unknown worker provider/);
  assert.throws(()=>assertWorkerPolicy({workerProvider:'claude',roles:{...roles,editor:{model:'retained-codex-model',effort:'medium',criticalEffort:'medium'}}}),/editor needs claudeModel/);
  assert.throws(()=>assertWorkerPolicy({workerProvider:'claude',roles:{verify:{...roles.verify,criticalEffort:'xhigh'}}}),/supported effort/);
});
test('subscription limits and rejected logins count as provider failures, task failures do not',()=>{
  const limit='Claude worker did not complete successfully: '+failureDetail({type:'result',subtype:'success',is_error:true,result:"You've hit your limit · resets 7pm"},'',1);
  assert.equal(failureCategory(limit),'provider-limit');
  assert.equal(failureCategory('Claude worker did not complete successfully: '+failureDetail(JSON.parse(rejectedLogin.stdout),'',1)),'provider-configuration');
  assert.equal(failureCategory('Claude worker did not complete successfully: '+failureDetail({type:'result',subtype:'error_max_turns',is_error:true},'',0)),null);
  assert.doesNotMatch(failureDetail({result:'owner@example.org sk-test_123'},'Bearer abc',1),/owner@|sk-test|Bearer abc/);
});
test('reads are allowed by absolute rule for the job folder only, and home folders are denied',()=>{
  const settings=claudeSettings('/private/var/folders/x/minitandem-claude-worker-1');
  assert.equal(settings.permissions.allow[0],'Read(//private/var/folders/x/minitandem-claude-worker-1/**)');
  for(const rule of ['Read(~/**)','Read(//Users/**)','Read(//Volumes/**)'])assert.ok(settings.permissions.deny.includes(rule));
  assert.throws(()=>workerRoot(os.homedir()),/outside home folders/);
  // The system temporary folder exists on every runner (on the Mac it resolves under /private, on Linux it is /tmp).
  const temp=fs.realpathSync(os.tmpdir());assert.equal(workerRoot(temp),temp);
  assert.deepEqual(claudeUsage({permission_denials:[{tool_name:'Read'},{}]},{model:'m',effort:'low'},2).permissionDenials,['Read','unknown']);
});
test('an older CLI earlier in PATH is refused before any job is claimed',()=>{
  assert.deepEqual(requireClaudeCli({execImpl:()=>'2.1.295 (Claude Code)\n'}),{cliVersion:'2.1.295'});
  assert.deepEqual(requireClaudeCli({execImpl:()=>'2.2.0 (Claude Code)'}),{cliVersion:'2.2.0'});
  for(const old of ['2.1.15 (Claude Code)','2.1.109 (Claude Code)','1.9.999'])assert.throws(()=>requireClaudeCli({execImpl:()=>old}),/older than the verified minimum/);
  assert.throws(()=>requireClaudeCli({execImpl:()=>{throw Error('ENOENT');}}),/not found/);
});
test('large evidence becomes a pageable text file whose quotes still match the original snapshot',async()=>{
  const sentence=index=>`Satz ${index}: Eintritt frei für Kinder bis 4 Jahre, Anmeldung nicht nötig.`;
  const text=Array.from({length:900},(_,index)=>sentence(index)).join(' ')+'\nSecond original line stays separate.';
  const {wrapped,hardBreaks}=wrapText(text);
  assert.equal(hardBreaks,0);assert.ok(wrapped.split('\n').every(line=>line.length<=1000));
  assert.equal(normalizeQuote(wrapped),normalizeQuote(text));
  const unbroken=wrapText('x'.repeat(2500));
  assert.equal(unbroken.hardBreaks,2);assert.ok(unbroken.wrapped.split('\n').every(line=>line.length<=1000));
  const small=snapshot({url:'https://example.org/small',fetchedAt:new Date().toISOString(),text:'Official page: admission is free for families.'});
  assert.deepEqual(readableEvidence('evidence-0.json',small),[{file:'evidence-0.json',content:JSON.stringify(small)}]);
  const large=snapshot({url:'https://example.org/large',fetchedAt:new Date().toISOString(),text});
  const [meta,body]=readableEvidence('bundle-evidence-3.json',large),described=JSON.parse(meta.content);
  assert.equal(meta.file,'bundle-evidence-3.json');assert.equal(body.file,'bundle-evidence-3.txt');
  assert.equal(described.text,null);assert.equal(described.textFile,'bundle-evidence-3.txt');assert.equal(described.id,large.id);
  assert.equal(described.textLines,body.content.split('\n').length);assert.equal(described.textChars,text.length);
  assert.ok(Number.isInteger(described.linesPerRead)&&described.linesPerRead>=20&&described.linesPerRead*1000<=60000);
  const lines=body.content.split('\n'),acrossBreak=lines[0].slice(-30)+'\n'+lines[1].slice(0,30);
  assert.ok(locateQuote(large,acrossBreak));assert.ok(locateQuote(large,lines[5]));
  let seen;
  const bigJob={...job,payload:{bundle:{claims:[],snapshots:[large]},preparedEvidence:[small]}};
  await runClaude(bigJob,policy,{authImpl:()=>{},runImpl:(_command,args,options)=>{
    const child=childFor(args,options,[{type:'result',subtype:'success',structured_output:envelope}]),end=child.stdin.end;
    child.stdin.end=prompt=>{seen={prompt,files:fs.readdirSync(options.cwd).sort(),body:fs.readFileSync(path.join(options.cwd,'bundle-evidence-0.txt'),'utf8')};end();};
    return child;
  }});
  assert.deepEqual(seen.files,['bundle-evidence-0.json','bundle-evidence-0.txt','evidence-0.json','worker-settings.json']);
  assert.equal(seen.body,body.content);assert.match(seen.prompt,/EVIDENCE FILES IN THIS WORKER/);
  await runClaude(job,policy,{authImpl:()=>{},runImpl:(_command,args,options)=>{
    const child=childFor(args,options,[{type:'result',subtype:'success',structured_output:envelope}]),end=child.stdin.end;
    child.stdin.end=prompt=>{seen={prompt};end();};return child;
  }});
  assert.doesNotMatch(seen.prompt,/EVIDENCE FILES IN THIS WORKER/);
});
test('a non-fact result travels as an object and is encoded by code, never hand-escaped by the model',async()=>{
  const schema=claudeSchema(job);
  assert.deepEqual(schema.properties.result,{type:'object'});assert.equal(schema.properties.resultJson,undefined);
  assert.deepEqual(schema.required,['project','jobId','inputRevision','result']);assert.deepEqual(schema.properties.jobId,{type:'string',enum:[job.id]});
  const tricky={verdicts:[{reason:'Quote "ab 2.5 Jahren" \\ with a backslash,\nnew line and a } brace'}]};
  assert.deepEqual(JSON.parse(claudeEnvelope({...envelope,result:tricky},job).resultJson),tricky);
  for(const bad of ['{"verdicts":[]}',null,[],undefined])assert.throws(()=>claudeEnvelope({...envelope,result:bad},job),/result object/);
  const factsJob={id:'facts-job',kind:'facts',card_id:'course',input_revision:'r',payload:{card:{id:'course'}}};
  assert.equal(claudeSchema(factsJob).properties.resultJson,undefined);assert.equal(claudeSchema(factsJob).properties.result.type,'object');
  assert.ok(claudeSchema(factsJob).properties.result.properties.bundle);
  let seen;
  const out=await runClaude(job,policy,{authImpl:()=>{},runImpl:(_command,args,options)=>{
    const child=childFor(args,options,[{type:'result',subtype:'success',structured_output:{...envelope,result:tricky}}]),end=child.stdin.end;
    child.stdin.end=prompt=>{seen={prompt,schema:JSON.parse(args[args.indexOf('--json-schema')+1])};end();};return child;
  }});
  assert.deepEqual(out.result,tricky);assert.match(seen.prompt,/OUTPUT IN THIS WORKER/);assert.deepEqual(seen.schema.properties.result,{type:'object'});
});
