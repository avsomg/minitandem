import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {JobQueue} from './jobs.mjs';
import {root,loadCatalog,qualityReport} from './quality.mjs';
import {writeJsonAtomic} from './evidence.mjs';

export function jobMetrics(queue){
  const events=queue.db.prepare("SELECT job_id,kind,details,created_at FROM events WHERE kind IN ('claimed','completed','usage','retry','attention') ORDER BY id").all();
  const jobs=queue.list(),byId=new Map(jobs.map(j=>[j.id,j]));
  const usage=new Map(),started=new Map(),times=new Map();
  for(const event of events){
    const job=byId.get(event.job_id);if(!job)continue;
    const data=JSON.parse(event.details);
    if(event.kind==='claimed')started.set(job.id,event.created_at);
    if(event.kind==='completed'&&started.has(job.id)){
      const seconds=(Date.parse(event.created_at)-Date.parse(started.get(job.id)))/1000;
      if(!times.has(job.kind))times.set(job.kind,[]);times.get(job.kind).push(seconds);
    }
    if(event.kind==='usage'&&!data.replayed){
      const key=[data.model||'unknown',data.effort||'unknown'].join(' / ');
      const row=usage.get(key)||{route:key,runs:0,inputTokens:0,cachedInputTokens:0,outputTokens:0,toolCalls:0};
      row.runs++;for(const [a,b] of [['inputTokens','input_tokens'],['cachedInputTokens','cached_input_tokens'],['outputTokens','output_tokens'],['toolCalls','toolCalls']])row[a]+=Number(data[b])||0;
      usage.set(key,row);
    }
  }
  const stageTimes=[...times].map(([kind,values])=>{values.sort((a,b)=>a-b);const n=values.length;
    return {kind,completedAttempts:n,medianSeconds:Math.round(n%2?values[(n-1)/2]:(values[n/2-1]+values[n/2])/2)};});
  return {usage:[...usage.values()],usageScope:'Recorded CLI workers only; heartbeat/chat overhead and provider invoices are not included.',stageTimes,
    blocked:jobs.filter(j=>['attention','await-source','retry'].includes(j.state)).map(j=>({id:j.id,cardId:j.card_id,kind:j.kind,state:j.state,
      attempt:j.attempt,retryAfter:j.retry_after,error:j.error?.replace(/(?:sk-|ts_)[A-Za-z0-9_-]+/g,'[redacted]')||null})),
    active:jobs.filter(j=>j.state==='leased').map(j=>({cardId:j.card_id,kind:j.kind,leaseUntil:j.lease_until}))};
}
export function operationsReport(queue){
  const sources=JSON.parse(fs.readFileSync(path.join(root,'editorial/source-watch.json'),'utf8')).sources;
  const monitorFile=path.join(root,'editorial/monitor-state.json');
  const monitor=fs.existsSync(monitorFile)?JSON.parse(fs.readFileSync(monitorFile,'utf8')):null;
  const date=new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Zurich'});
  const quality=qualityReport(loadCatalog().ACTIVITIES,sources,date,monitor);
  const externalFile=path.join(root,'editorial/external-review-report.json');
  const external=fs.existsSync(externalFile)?JSON.parse(fs.readFileSync(externalFile,'utf8')):null;
  return {schema:1,...queue.summary(),quality:{date:quality.generatedFor,records:quality.records,stale:quality.stale,
    sourceAffected:quality.sourceAffected,imminent:quality.imminent,coverage:quality.coverage},
    external:external?{generatedFor:external.generatedFor,summary:external.summary}:null,
    ...jobMetrics(queue)};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const queue=new JobQueue(path.join(root,'editorial/workflow-state/jobs.sqlite'),{readOnly:true});
  try{const report=operationsReport(queue);await writeJsonAtomic(path.join(root,'editorial/operations-report.json'),report);console.log(JSON.stringify(report,null,2));}
  finally{queue.close();}
}
