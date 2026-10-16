import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';
import {JobQueue,sourceSignal} from './jobs.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const file=path.join(here,'monitor-state.json');
const args=process.argv.slice(2);
const value=name=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
const run=promisify(execFile);
export function resolveFromDispositions(state,dispositions,now=new Date().toISOString()){
  const resolved=[];
  for(const task of state.queue.filter(task=>task.status==='open')){
    const version=state.sources?.[task.sourceId]?.hash||task.details?.to||'unavailable';
    const rows=dispositions.filter(row=>row.source_id===task.sourceId&&row.source_version===version&&row.signal===sourceSignal(task));
    if(!task.recordIds?.length||!task.recordIds.every(id=>rows.some(row=>row.card_id===id&&row.state==='done')))continue;
    task.status='resolved';task.resolution={decision:'catalog-updated',at:now,note:'Every affected card has an independently approved disposition for this source version.'};
    resolved.push(task.id);
  }
  return resolved;
}
async function main(){
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
  const queueFile=path.join(here,'workflow-state','jobs.sqlite');
  if(existsSync(queueFile)){
    const queue=new JobQueue(queueFile,{readOnly:true});
    try{
      const exists=queue.db.prepare("SELECT name FROM sqlite_master WHERE name='source_dispositions'").get();
      if(exists&&resolveFromDispositions(state,queue.dispositions()).length){
        const temp=`${file}.tmp-${process.pid}`;await fs.writeFile(temp,JSON.stringify(state,null,2)+'\n',{mode:0o600});await fs.rename(temp,file);
      }
    }finally{queue.close();}
  }
  const open=state.queue.filter(q=>q.status==='open');
  console.log(JSON.stringify({open:open.length,tasks:open.map(q=>({id:q.id,kind:q.kind,sourceId:q.sourceId,recordIds:q.recordIds,firstSeen:q.firstSeen,occurrences:q.occurrences,details:q.details,...(['possible-closure','possible-reopen'].includes(q.kind)?{lines:(q.details?.lines||[]).map(l=>({cats:l.cats,strength:l.strength,text:l.text,context:l.context}))}:{}),...(q.kind==='redirect-changed'?{redirect:`${q.details?.from} -> ${q.details?.to} (${q.details?.class})`}:{})}))},null,2));
}

}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
