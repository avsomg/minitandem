import fs from 'node:fs';
import {digest,ROLE_KINDS} from './jobs.mjs';
import {promptFor} from './worker-prompt.mjs';

const DEFAULT_LIMIT=60000,RESERVE=4096;
export function inputLimit(job,policy){
  const role=Object.keys(ROLE_KINDS).find(role=>ROLE_KINDS[role].includes(job.kind));
  const config=policy.roles?.[role],limit=config?.maxInputChars??DEFAULT_LIMIT;
  if(!Number.isInteger(limit)||limit<1000||limit>120000||limit>DEFAULT_LIMIT&&!config.inputBudgetReason?.trim())
    throw Error('Invalid worker input budget policy');
  return limit;
}
export function workerInputSize(job,policy,{prompt=promptFor(job),reserve=RESERVE}={}){
  const limit=inputLimit(job,policy),characters=prompt.length;
  return {characters,reserve,limit,fits:characters+reserve<=limit};
}
export function assertWorkerInput(job,policy,prompt){
  const size=workerInputSize(job,policy,{prompt,reserve:0});
  if(!size.fits)throw Object.assign(Error(`Worker input exceeds budget: ${size.characters} > ${size.limit}; retain all evidence and investigate the input policy`),{code:'INPUT_BUDGET',inputSize:size});
}
export function blockWorkerInput(queue,job,size){
  const reason=`Worker input exceeds budget: ${size.characters} + ${size.reserve} reserved > ${size.limit}. Await an investigated input-contract or budget change; evidence was not truncated.`;
  const payload={...job.payload,inputBudget:{...size,reason}};
  queue.db.prepare("UPDATE jobs SET state='await-source',payload=?,error=?,token=NULL,lease_until=NULL,updated_at=? WHERE id=?")
    .run(JSON.stringify(payload),reason,queue.now(),job.id);
  queue.recordDisposition({...job,payload},'await-source');queue.event(job.id,'input-budget-blocked',size);
  return false;
}
export function canClaimWorker(queue,job,policy){
  if(['qa','release'].includes(job.kind))return true;
  const size=workerInputSize(job,policy);
  return size.fits||blockWorkerInput(queue,job,size);
}

// Sync upgrades only the diagnosed size failure, against an unchanged card.
export function reconcileWorkerInputs(queue,records,policy){
  const revision=digest([fs.readFileSync(new URL('./worker-prompt.mjs',import.meta.url),'utf8'),policy.roles]),resumed=[];
  return queue.transaction(()=>{
    for(const job of queue.list()){
      if(['qa','release'].includes(job.kind))continue;
      const failed=['retry','attention'].includes(job.state)&&/^Worker input exceeds budget/.test(job.error||'')||
        job.state==='await-source'&&Boolean(job.payload.inputBudget);
      if(!failed&&!['ready','retry'].includes(job.state))continue;
      const card=records.find(card=>card.id===job.card_id);
      if(!card||job.payload.cardRevision!==digest(card))continue;
      const size=workerInputSize(job,policy);
      if(!size.fits){
        if(job.state!=='await-source')blockWorkerInput(queue,job,size);
        continue;
      }
      if(!failed||job.payload.workerInputRevision===revision)continue;
      const {inputBudget,...previous}=job.payload;
      const payload={...previous,workerInputRevision:revision,previousJobId:job.id,resumeJob:true,
        inputBudgetRecovery:{previousAttempts:job.attempt,previousError:job.error}};
      const inputRevision=digest(['worker-input-repair',job.input_revision,revision]);
      const nextSize=workerInputSize({...job,input_revision:inputRevision,payload},policy);
      if(!nextSize.fits)continue;
      const next=queue.enqueue({kind:job.kind,cardId:job.card_id,inputRevision,priority:job.priority,payload});
      queue.db.prepare("UPDATE jobs SET state='superseded',updated_at=? WHERE id=?").run(queue.now(),job.id);
      queue.event(job.id,'input-budget-resumed',{nextJobId:next.id,previousAttempts:job.attempt,...nextSize});resumed.push(next.id);
    }
    return resumed;
  });
}
