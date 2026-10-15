import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {workerOutputSchema,decodeWorkerOutput} from './worker-schema.mjs';
import {validateSnapshot} from './evidence.mjs';

export function claudeEnvironment(source=process.env){
  const env=Object.fromEntries(['PATH','HOME','TMPDIR','USER','LOGNAME','SHELL','LANG','LC_ALL','TZ'].filter(k=>source[k]).map(k=>[k,source[k]]));
  // Authentication stays in the existing Claude login. No API keys, alternative
  // providers, shared project variables, Codex thread identity or client tokens.
  return {...env,CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
}
export function requireClaudeSubscription({execImpl=execFileSync,env=claudeEnvironment()}={}){
  let auth;
  try{auth=JSON.parse(execImpl('claude',['auth','status','--json'],{env,timeout:20000,maxBuffer:20000,encoding:'utf8',stdio:['ignore','pipe','pipe']}));}
  catch{throw Error('Claude subscription login could not be verified; no API fallback');}
  if(!auth.loggedIn||auth.authMethod!=='claude.ai'||auth.apiProvider!=='firstParty'||!['max','pro'].includes(auth.subscriptionType))
    throw Error('Claude subscription required; API and alternative-provider fallback forbidden');
  return {provider:'claude',authMethod:auth.authMethod,subscriptionType:auth.subscriptionType};
}
// Model ids and tool behaviour depend on the CLI release, and an older copy can
// sit earlier in PATH. 2.1.295 is the release the adapter was verified against.
const MIN_CLI=[2,1,280];
export function requireClaudeCli({execImpl=execFileSync,env=claudeEnvironment()}={}){
  let found;
  try{found=String(execImpl('claude',['--version'],{env,timeout:20000,maxBuffer:20000,encoding:'utf8',stdio:['ignore','pipe','pipe']})).match(/(\d+)\.(\d+)\.(\d+)/);}
  catch{found=null;}
  if(!found)throw Error('Claude CLI was not found or did not report a version');
  const version=found.slice(1).map(Number),older=MIN_CLI.findIndex((part,index)=>version[index]!==part);
  if(older>=0&&version[older]<MIN_CLI[older])throw Error(`Claude CLI ${version.join('.')} is older than the verified minimum ${MIN_CLI.join('.')}`);
  return {cliVersion:version.join('.')};
}
export const isolationArgs=['--setting-sources','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
  '--disable-slash-commands','--no-chrome','--no-session-persistence'];
const redact=text=>String(text).replace(/(?:sk-[A-Za-z0-9_-]+|Bearer\s+[^\s]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+)/gi,'[redacted]');
export function failureDetail(event,stderr='',code=null){
  const text=redact([event?.result,event?.errors?.join('; '),event&&event.subtype!=='success'?event.subtype:'',stderr]
    .filter(Boolean).join(' | ')).slice(0,800)||'no detail';
  // The CLI words these failures differently from the controller's failure
  // categories; a canonical prefix keeps a provider outage counted as one.
  const hint=/API Error: 401|authentication_error|OAuth (?:access )?token|Please run \/login|Invalid API key/i.test(text)?'authentication; ':
    /API Error: (?:429|529)|rate_limit_error|overloaded_error|hit your[^.|]*limit|limit reached/i.test(text)?'usage limit; ':'';
  return `${hint}${code===null||code===0?'':`exit ${code}; `}${text}`;
}
// A saved login reports an active subscription even when the server rejects its
// token, so readiness takes one real minimal request and no job input.
export function claudeLoginProbe({runImpl=spawnSync,env=claudeEnvironment(),model='haiku',timeoutMs=60000}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-claude-probe-'));
  try{
    const run=runImpl('claude',['-p','--model',model,'--output-format','json','--tools','',...isolationArgs],
      {cwd:directory,env,input:'Reply with the single word OK.',timeout:timeoutMs,maxBuffer:200000,encoding:'utf8'});
    let event=null;try{event=JSON.parse(run.stdout);}catch{}
    if(run.error||run.status!==0||event?.type!=='result'||event.is_error||event.subtype!=='success')
      throw Error('Claude login check failed: '+failureDetail(event,run.stderr||run.error?.message||'',run.status??null));
    return {probeModel:model,actualModels:Object.keys(event.modelUsage||{})};
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
}
const inside=(file,parent)=>file===parent||file.startsWith(parent+path.sep);
export function workerRoot(tmp=os.tmpdir(),home=os.homedir()){
  const real=fs.realpathSync(tmp);
  if(inside(real,fs.realpathSync(home))||inside(real,'/Users')||inside(real,'/Volumes'))
    throw Error('Claude worker directory must be outside home folders; their reads are denied');
  return real;
}
export function assertClaudeReady({authImpl=requireClaudeSubscription,probeImpl=claudeLoginProbe,rootImpl=workerRoot,cliImpl=requireClaudeCli,env=claudeEnvironment()}={}){
  rootImpl();
  return {...cliImpl({env}),...authImpl({env}),...probeImpl({env})};
}
// Read returns a limited number of tokens per call and pages by line, while a
// snapshot is one JSON line of up to about 300 KB that Read cannot open at all.
// Larger text therefore moves to a wrapped plain-text file the worker can page
// through. A break replaces one whitespace character, which quote matching
// already ignores; only an unbroken run longer than the width is cut hard.
const INLINE_EVIDENCE=20000,WRAP_WIDTH=1000;
export function wrapText(text,width=WRAP_WIDTH){
  let hardBreaks=0;
  const wrapped=String(text).split('\n').map(line=>{
    const parts=[];
    while(line.length>width){
      let cut=width;while(cut>0&&!/\s/u.test(line[cut]))cut--;
      if(cut>0){parts.push(line.slice(0,cut));line=line.slice(cut+1);continue;}
      cut=/[\ud800-\udbff]/.test(line[width-1])?width-1:width;
      parts.push(line.slice(0,cut));line=line.slice(cut);hardBreaks++;
    }
    parts.push(line);return parts.join('\n');
  }).join('\n');
  return {wrapped,hardBreaks};
}
export function readableEvidence(file,evidence){
  const json=JSON.stringify(evidence);
  if(json.length<=INLINE_EVIDENCE)return [{file,content:json}];
  const textFile=file.replace(/\.json$/,'.txt');
  if(textFile===file)throw Error('Invalid worker evidence filename');
  const {text,...metadata}=evidence,{wrapped,hardBreaks}=wrapText(text),textLines=wrapped.split('\n').length;
  // About 50,000 characters stay under the per-call limit of Read for the texts captured so far.
  const linesPerRead=Math.max(20,Math.min(1500,Math.floor(50000/Math.max(1,wrapped.length/textLines))));
  return [{file,content:JSON.stringify({...metadata,text:null,textFile,textLines,linesPerRead,textChars:text.length,hardBreaks})},
    {file:textFile,content:wrapped}];
}
const SPLIT_LAYOUT=`
EVIDENCE FILES IN THIS WORKER: when an evidence JSON has "text":null, its complete captured text is the plain-text file named by textFile in the same directory. One Read call returns only a part of a long file and refuses a larger request: read it with limit set to linesPerRead and advance offset until all textLines are covered before you judge what the source does or does not say. Lines were wrapped at whitespace and quotes are matched after whitespace normalization, so a wrapped line break counts as a space. hardBreaks counts cuts inside an unbroken string; do not quote across such a cut.`;
// '//path' is the absolute form of a permission rule; a single leading slash
// would be read relative to the settings location and match nothing here.
const readRule=directory=>`Read(/${directory}/**)`;
export function claudeSettings(directory){
  return {disableAllHooks:true,autoMemoryEnabled:false,enabledPlugins:{},
    permissions:{defaultMode:'dontAsk',allow:[readRule(directory),'WebSearch','WebFetch'],
      deny:['Bash','Edit','Write','NotebookEdit','Agent','Task','Skill','mcp__*','Read(~/**)','Read(//Users/**)','Read(//Volumes/**)']}};
}
export function claudeArgs(directory,route,schema,settingsFile){
  return ['-p','--model',route.model,'--effort',route.effort,'--output-format','stream-json','--verbose',
    '--json-schema',JSON.stringify(schema),'--tools','Read,WebSearch,WebFetch',
    '--allowedTools',`${readRule(directory)},WebSearch,WebFetch`,
    '--permission-mode','dontAsk','--settings',settingsFile,...isolationArgs];
}
// The shared envelope carries a non-fact result as a JSON string, a form the
// earlier provider's closed schemas required. Hand-escaped JSON inside a string
// is where a model slips, so here the result travels as an object and code encodes it.
export function claudeSchema(job){
  const schema=workerOutputSchema(job);
  if(!schema.properties.resultJson)return schema;
  const {resultJson,...properties}=schema.properties;
  return {...schema,properties:{...properties,result:{type:'object'}},required:schema.required.map(name=>name==='resultJson'?'result':name)};
}
export function claudeEnvelope(structured,job){
  if(!workerOutputSchema(job).properties.resultJson)return structured;
  const {result,...envelope}=structured||{};
  if(!result||typeof result!=='object'||Array.isArray(result))throw Error('Missing Claude result object');
  return {...envelope,resultJson:JSON.stringify(result)};
}
const OBJECT_RESULT=`
OUTPUT IN THIS WORKER: the structured output has a field named result in place of resultJson. Put the result object itself there, as a JSON object and never as a string; wherever these instructions say resultJson, that object is meant.`;
export function claudeUsage(event,route,toolCalls){
  const u=event.usage||{},cached=u.cache_read_input_tokens||0,written=u.cache_creation_input_tokens||0;
  return {provider:'claude',model:route.model,effort:route.effort,toolCalls,
    input_tokens:(u.input_tokens||0)+cached+written,cached_input_tokens:cached,cache_write_input_tokens:written,
    output_tokens:u.output_tokens||0,actualModels:Object.keys(event.modelUsage||{}),
    permissionDenials:(event.permission_denials||[]).slice(0,10).map(denial=>denial.tool_name||'unknown'),
    sessionId:event.session_id||null,apiCostEstimateUsd:event.total_cost_usd??null,
    costCaveat:'CLI estimate is not subscription billing or a quota percentage'};
}
export async function runClaudeWorker(job,policy,{route,promptImpl,evidenceFilesImpl,copyImagesImpl,
  authImpl=requireClaudeSubscription,runImpl=spawn,timeoutMs=720000}={}){
  if(!route?.model||!promptImpl||!evidenceFilesImpl||!copyImagesImpl)throw Error('Missing Claude worker contract');
  const env=claudeEnvironment();authImpl({env});
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-claude-worker-')));fs.chmodSync(directory,0o700);
  const usage={provider:'claude',model:route.model,effort:route.effort,toolCalls:0};
  try{
    const schema=claudeSchema(job),objectResult=Boolean(schema.properties.result?.type);
    const settingsFile=path.join(directory,'worker-settings.json');
    fs.writeFileSync(settingsFile,JSON.stringify(claudeSettings(directory)),{mode:0o600});
    let split=false;
    for(const {file,evidence} of evidenceFilesImpl(job)){
      validateSnapshot(evidence);
      if(path.basename(file)!==file)throw Error('Invalid worker evidence filename');
      const written=readableEvidence(file,evidence);split||=written.length>1;
      for(const part of written)fs.writeFileSync(path.join(directory,part.file),part.content,{mode:0o600,flag:'wx'});
    }
    const images=copyImagesImpl(job,directory);
    const prompt=promptImpl(job)+(objectResult?OBJECT_RESULT:'')+(split?SPLIT_LAYOUT:'')+(images.length?'\nRead these original poster images with Read, not OCR alone:\n'+images.join('\n'):'');
    if(prompt.length>60000)throw Error('Worker input exceeds budget; split the task without truncating evidence');
    let resultEvent=null;
    await new Promise((resolve,reject)=>{
      const child=runImpl('claude',claudeArgs(directory,route,schema,settingsFile),{cwd:directory,stdio:['pipe','pipe','pipe'],env});
      let pending='',stderr='',settled=false,failure=null,totalBytes=0;
      const stop=reason=>{
        if(failure||settled)return;failure=reason;child.kill('SIGTERM');
        setTimeout(()=>{if(!settled)child.kill('SIGKILL');},2000).unref();
      };
      const timeout=setTimeout(()=>stop('Worker time limit'),timeoutMs);
      const parse=line=>{
        if(!line.trim())return;
        let event;try{event=JSON.parse(line);}catch{stop('Invalid Claude event JSON');return;}
        if(event.type==='assistant')for(const block of event.message?.content||[])if(block.type==='tool_use')usage.toolCalls++;
        if(usage.toolCalls>policy.maxToolCallsPerJob)stop('Worker tool-call budget exceeded');
        if(event.type==='result'){
          if(resultEvent){stop('Duplicate Claude result');return;}
          resultEvent=event;Object.assign(usage,claudeUsage(event,route,usage.toolCalls));
        }
      };
      child.stdout.on('data',chunk=>{
        totalBytes+=chunk.length;if(totalBytes>12000000){stop('Claude worker event budget exceeded');return;}
        pending+=chunk.toString();const lines=pending.split('\n');pending=lines.pop();for(const line of lines)parse(line);
        if(pending.length>2000000)stop('Oversized worker event');
      });
      child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-3000);});
      child.on('error',error=>{clearTimeout(timeout);if(settled)return;settled=true;reject(error);});
      child.on('close',code=>{
        clearTimeout(timeout);if(settled)return;parse(pending);settled=true;
        if(failure)reject(Error(failure));
        else if(code!==0||!resultEvent||resultEvent.is_error||resultEvent.subtype!=='success')
          reject(Error('Claude worker did not complete successfully: '+failureDetail(resultEvent,stderr,code)));
        else resolve();
      });
      child.stdin.end(prompt);
    });
    if(!resultEvent.structured_output||JSON.stringify(resultEvent.structured_output).length>2000000)throw Error('Missing or oversized Claude structured output');
    return {result:decodeWorkerOutput(claudeEnvelope(resultEvent.structured_output,job),job),usage};
  }catch(error){error.usage=usage;throw error;}
  finally{fs.rmSync(directory,{recursive:true,force:true});}
}
