import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const file=path.join(here,'monitor-state.json');
const args=process.argv.slice(2);
const value=name=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
const run=promisify(execFile);
const state=JSON.parse(await fs.readFile(file,'utf8'));
if(value('show')){
  const task=state.queue.find(q=>q.id===value('show'));
  if(!task)throw Error('Task not found');
  console.log(JSON.stringify(task,null,2));
  const d=task.details||{};
  if(['possible-closure','possible-reopen'].includes(task.kind))for(const line of d.lines||[]){
    console.log(`\n[${(line.cats||[]).join(',')}] ${line.strength||''}${line.office?' (office)':''}: ${line.text}`);
    for(const c of line.context||[])console.log(`    | ${c}`);
  }
  if(task.kind==='redirect-changed')console.log(`\nRedirect (${d.class||'?'}, HTTP ${d.httpStatus??'?'}): ${d.from} -> ${d.to}`);
  const old=task.details?.firstOldVersion||task.details?.oldVersion,newVersion=task.details?.newVersion;
  if(old&&newVersion){
    const a=path.join(here,'versions',task.sourceId,old+'.txt');
    const b=path.join(here,'versions',task.sourceId,newVersion+'.txt');
    try{const {stdout}=await run('diff',['-u',a,b],{maxBuffer:300000});console.log(stdout);}catch(error){if(error.code!==1)throw error;console.log(error.stdout);}
  }
}else if(value('resolve')){
  const task=state.queue.find(q=>q.id===value('resolve'));
  if(!task||task.status!=='open')throw Error('Open task not found');
  const decision=value('decision'),note=value('note')?.trim();
  if(!['catalog-updated','no-catalog-change','source-restored','false-positive'].includes(decision)||!note)throw Error('Use --decision=catalog-updated|no-catalog-change|source-restored|false-positive and --note=...');
  task.status='resolved';task.resolution={decision,note,at:new Date().toISOString()};
  const temp=`${file}.tmp-${process.pid}`;await fs.writeFile(temp,JSON.stringify(state,null,2)+'\n');await fs.rename(temp,file);
  console.log(JSON.stringify({resolved:task.id,decision,note},null,2));
}else{
  const open=state.queue.filter(q=>q.status==='open');
  console.log(JSON.stringify({open:open.length,tasks:open.map(q=>({id:q.id,kind:q.kind,sourceId:q.sourceId,recordIds:q.recordIds,firstSeen:q.firstSeen,occurrences:q.occurrences,details:q.details,...(['possible-closure','possible-reopen'].includes(q.kind)?{lines:(q.details?.lines||[]).map(l=>({cats:l.cats,strength:l.strength,text:l.text,context:l.context}))}:{}),...(q.kind==='redirect-changed'?{redirect:`${q.details?.from} -> ${q.details?.to} (${q.details?.class})`}:{})}))},null,2));
}
