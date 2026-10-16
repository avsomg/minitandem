import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PROJECT_ID} from './project-id.mjs';

export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const ROLE_KINDS={search:['search','facts'],verify:['verify','verify-facts','review-patch'],
  arbitrate:['adjudicate','adjudicate-facts'],editor:['editorial','integrate'],qa:['qa'],release:['release']};
const decode=row=>row?{...row,payload:JSON.parse(row.payload)}:null;
export function failureCategory(message){
  if(/rate.?limit|quota|too many requests|usage limit|HTTP 429/i.test(message))return 'provider-limit';
  if(/authentication|unauthorized|invalid.*(?:key|token)|not logged in|HTTP 401|model.*(?:not found|unavailable)/i.test(message))return 'provider-configuration';
  if(/Invalid field (?:claim|value)|Public text must be English|Unsupported patch field|Missing evidence binding|Citation does not match its evidence binding|wrong worker project|wrong.*revision|does not match.*claim|Conflicting approved scalar claims|Worker input exceeds budget|checked requires a current full-card review/i.test(message))return 'contract';
  return null;
}

const RELEASE_LIMIT=10;
export const DOWNSTREAM=['verify-facts','adjudicate-facts','integrate','review-patch','qa'];
export const sourceSignal=issue=>issue.kind+':'+issue.id+':'+digest(issue.details||{});
export function urgentJob(job,now=new Date().toISOString()){
  if(job.payload.urgent)return true;
  if(job.payload.sourceIssues?.some(issue=>issue.kind==='possible-closure'||issue.details?.fields?.includes('address')))return true;
  if(job.payload.corrections?.some(row=>row.correction?.requiredFields?.includes('address'))||job.payload.reportedTopic==='address')return true;
  const date=new Date(now).toLocaleDateString('en-CA',{timeZone:'Europe/Zurich'}),until=new Date(Date.parse(date+'T12:00:00Z')+14*86400000).toISOString().slice(0,10);
  return Boolean(job.payload.card?.events?.some(event=>event.date>=date&&event.date<=until));
}
// Old rows have no chain id. Keep their latest started facts chain visible without resetting or relabelling their attempts.
export function openChains(rows,now=new Date().toISOString()){
  const cards=new Set(rows.filter(job=>job.kind==='facts').map(job=>job.card_id)),result=[];
  for(const card of cards){
    const jobs=rows.filter(job=>job.card_id===card),root=jobs.findLast(job=>job.kind==='facts'&&job.state!=='superseded'&&(job.payload.chainId||['done','leased'].includes(job.state)));
    if(!root)continue;
    const start=jobs.indexOf(root),chainId=root.payload.chainId||root.id;
    const members=jobs.filter((job,index)=>job.id===chainId||(job.payload.chainId?job.payload.chainId===chainId:index>=start&&DOWNSTREAM.includes(job.kind)));
    const last=members.at(-1);
    if(!last||['attention','await-source','superseded'].includes(last.state)||last.kind==='qa'||last.kind==='review-patch'&&last.state==='done')continue;
    const startedAt=members[0].created_at;
    result.push({card,chainId,startedAt,ageHours:Math.max(0,Math.round((Date.parse(now)-Date.parse(startedAt))/360000)/10),kind:last.kind,state:last.state});
  }
  return result;
}
export class JobQueue{
  constructor(file,{now=()=>new Date().toISOString(),readOnly=false}={}){
    if(!readOnly)fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(file,{readOnly});this.now=now;
    this.db.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;');
    if(!readOnly){fs.chmodSync(file,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(
        id TEXT PRIMARY KEY,kind TEXT NOT NULL,card_id TEXT NOT NULL,input_revision TEXT NOT NULL,
        state TEXT NOT NULL,priority INTEGER NOT NULL,payload TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,
        owner TEXT,token TEXT,lease_until TEXT,retry_after TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        error TEXT,UNIQUE(kind,card_id,input_revision));
      CREATE TABLE IF NOT EXISTS artifacts(
        hash TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),role TEXT NOT NULL,
        data TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(
        id INTEGER PRIMARY KEY,job_id TEXT REFERENCES jobs(id),file TEXT NOT NULL,data TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS events(
        id INTEGER PRIMARY KEY,job_id TEXT,kind TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS releases(
        revision TEXT PRIMARY KEY,state TEXT NOT NULL,manifest TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS captured_evidence(id TEXT PRIMARY KEY,data TEXT NOT NULL,recorded_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_dispositions(
        key TEXT PRIMARY KEY,card_id TEXT NOT NULL,source_id TEXT NOT NULL,source_version TEXT NOT NULL,
        signal TEXT NOT NULL,state TEXT NOT NULL,job_id TEXT NOT NULL,recorded_at TEXT NOT NULL);
    `);}
    const project=this.db.prepare('SELECT value FROM metadata WHERE key=?').get('project');
    if(project&&project.value!==PROJECT_ID){this.db.close();throw Error('Wrong queue project');}
    const schema=this.db.prepare('SELECT value FROM metadata WHERE key=?').get('schema');
    if(schema&&schema.value!=='1'){this.db.close();throw Error('Unsupported queue schema');}
    if(!readOnly){
      this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)').run('project',PROJECT_ID);
      this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)').run('schema','1');
    }else if(!project||!schema){this.db.close();throw Error('Missing queue identity');}
  }
  close(){this.db.close();}
  transaction(fn){
    if(this.inTransaction)return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction=true;
    try{const result=fn();this.db.exec('COMMIT');return result;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
    finally{this.inTransaction=false;}
  }
  event(job,kind,details={}){
    this.db.prepare('INSERT INTO events(job_id,kind,details,created_at) VALUES (?,?,?,?)')
      .run(job,kind,JSON.stringify(details),this.now());
  }
  circuit(){
    const row=this.db.prepare('SELECT value FROM metadata WHERE key=?').get('circuit');
    return row?JSON.parse(row.value):null;
  }
  noteFailure(job,message){
    const category=failureCategory(message);if(!category)return;
    this.event(job.id,'classified-failure',{category,kind:job.kind,cardId:job.card_id});
    const since=new Date(Date.parse(this.now())-3600000).toISOString();
    const resetId=this.db.prepare("SELECT max(id) AS id FROM events WHERE kind='circuit-reset'").get().id||0;
    const failures=this.db.prepare("SELECT details FROM events WHERE kind='classified-failure' AND created_at>=? AND id>? ORDER BY id DESC").all(since,resetId)
      .map(row=>JSON.parse(row.details)).filter(row=>row.category===category&&(category!=='contract'||row.kind===job.kind));
    const cards=[...new Set(failures.map(row=>row.cardId))];
    if(cards.length>=3&&!this.circuit()?.open){
      const circuit={open:true,openedAt:this.now(),category,kind:job.kind,cardIds:cards,reason:'Same failure category on at least three distinct cards within one hour.'};
      this.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run('circuit',JSON.stringify(circuit));
      this.event(null,'circuit-opened',circuit);
    }
  }
  resetCircuit(reason){
    if(!reason?.trim())throw Error('Circuit reset requires an investigation note');
    return this.transaction(()=>{
      const previous=this.circuit();
      const value={...previous,open:false,resetAt:this.now(),resetReason:reason.trim()};
      this.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run('circuit',JSON.stringify(value));
      this.event(null,'circuit-reset',{previous,reason:reason.trim()});return value;
    });
  }
  enqueue({kind,cardId,inputRevision,priority=0,payload={}}){
    if(!Object.values(ROLE_KINDS).flat().includes(kind)||!cardId||!inputRevision||!Number.isFinite(priority))throw Error('Invalid job');
    const existing=this.db.prepare('SELECT * FROM jobs WHERE kind=? AND card_id=? AND input_revision=?').get(kind,cardId,inputRevision);
    if(existing){
      if(existing.state==='ready')this.db.prepare('UPDATE jobs SET priority=?,payload=? WHERE id=?')
        .run(priority,JSON.stringify(payload),existing.id);
      return this.get(existing.id);
    }
    const id=randomUUID(),now=this.now();
    this.db.prepare('INSERT INTO jobs(id,kind,card_id,input_revision,state,priority,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id,kind,cardId,inputRevision,'ready',priority,JSON.stringify(payload),now,now);
    this.event(id,'enqueued',{kind,cardId,inputRevision});
    return this.get(id);
  }
  get(id){return decode(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id));}
  list(){return this.db.prepare('SELECT * FROM jobs ORDER BY priority DESC,created_at,id').all().map(decode);}
  reconcile(specs,{managedKinds=['search','facts','verify','adjudicate','editorial']}={}){
    return this.transaction(()=>{
      const active=new Set(specs.map(s=>JSON.stringify([s.kind,s.cardId,s.inputRevision])));
      for(const job of this.list())if(!job.payload.pilot&&!job.payload.resumeJob&&managedKinds.includes(job.kind)&&['ready','leased','retry'].includes(job.state)&&
        !active.has(JSON.stringify([job.kind,job.card_id,job.input_revision]))){
        this.db.prepare('UPDATE jobs SET state=?,token=NULL,lease_until=NULL,updated_at=? WHERE id=?')
          .run('superseded',this.now(),job.id);this.event(job.id,'superseded');
      }
      return specs.map(spec=>{
        const job=this.enqueue(spec);
        if(managedKinds.includes(job.kind)&&!job.payload.pilot&&job.state==='superseded'&&job.attempt===0){
          this.db.prepare("UPDATE jobs SET state='ready',priority=?,payload=?,updated_at=? WHERE id=?")
            .run(spec.priority||0,JSON.stringify(spec.payload||{}),this.now(),job.id);
          this.event(job.id,'unstarted-job-reactivated',{reason:'Current task specification requires this exact revision again.'});
          return this.get(job.id);
        }
        return job;
      });
    });
  }
  openChains(){return openChains(this.db.prepare('SELECT * FROM jobs ORDER BY rowid').all().map(decode),this.now());}
  dispositions(){return this.db.prepare('SELECT * FROM source_dispositions').all();}
  recordDisposition(job,state){
    for(const source of job.payload.sourceTasks||[])this.db.prepare('INSERT OR REPLACE INTO source_dispositions VALUES (?,?,?,?,?,?,?,?)')
      .run(source.key,job.card_id,source.sourceId,source.version,source.signal,state,job.id,this.now());
  }
  claim(role,owner,{leaseMs=900000,backpressure=24,cardId=null,maxOpenChains=8,kinds=null,urgentOnly=false}={}){
    if(!ROLE_KINDS[role]||!owner||leaseMs<1000||leaseMs>3600000)throw Error('Invalid claim');
    if(!Number.isInteger(maxOpenChains)||maxOpenChains<1)throw Error('Invalid open-chain cap');
    return this.transaction(()=>{
      const now=this.now();
      for(const job of this.db.prepare('SELECT * FROM jobs WHERE state=? AND lease_until<=?').all('leased',now))
        this.retryInside(job,'Lease expired',now);
      if(!['qa','release'].includes(role)&&this.circuit()?.open)return null;
      const allowed=ROLE_KINDS[role].filter(kind=>!kinds||kinds.includes(kind));if(!allowed.length)return null;
      const placeholders=allowed.map(()=>'?').join(',');
      const backlog=this.db.prepare("SELECT count(*) AS n FROM jobs WHERE state IN ('ready','leased','retry') AND kind IN ('verify','verify-facts','review-patch','editorial','integrate','qa')").get().n;
      const candidates=this.db.prepare(`SELECT * FROM jobs WHERE kind IN (${placeholders}) AND
        (state='ready' OR state='retry' AND retry_after<=?) AND
        (?=0 OR priority>=120 OR kind='facts' AND ?=0) AND (? IS NULL OR card_id=?) AND NOT EXISTS(
          SELECT 1 FROM jobs held WHERE held.card_id=jobs.card_id AND held.state='leased')
        AND (kind NOT IN ('qa','review-patch','release') OR NOT EXISTS(
          SELECT 1 FROM jobs held WHERE held.state='leased' AND held.kind IN ('qa','review-patch','release')))
        AND NOT EXISTS(SELECT 1 FROM jobs held WHERE held.state='leased' AND held.kind='release')
        ORDER BY priority DESC,created_at,id`).all(...allowed,now,role==='search'&&backlog>=backpressure?1:0,role==='search'&&backlog>=2*backpressure?1:0,cardId,cardId).map(decode);
      const chains=this.openChains(),job=candidates.find(job=>(!urgentOnly||urgentJob(job,now))&&
        (job.kind!=='facts'||job.payload.chainId||chains.length<maxOpenChains&&!chains.some(chain=>chain.card===job.card_id)));
      if(!job)return null;
      if(job.kind==='facts'&&!job.payload.chainId){job.payload.chainId=job.id;this.db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(JSON.stringify(job.payload),job.id);}
      const token=randomUUID(),until=new Date(Date.parse(now)+leaseMs).toISOString();
      this.db.prepare('UPDATE jobs SET state=?,owner=?,token=?,lease_until=?,attempt=attempt+1,updated_at=? WHERE id=?')
        .run('leased',owner,token,until,now,job.id);this.event(job.id,'claimed',{role,owner,until});
      return this.get(job.id);
    });
  }
  requireLease(id,token,role){
    const job=this.get(id);
    if(!job||job.state!=='leased'||job.token!==token||job.lease_until<=this.now()||
      !ROLE_KINDS[role]?.includes(job.kind))throw Object.assign(Error('Invalid, expired or wrong-role lease'),{code:'LEASE_LOST'});
    return job;
  }
  renew(id,token,role,leaseMs=900000){
    return this.transaction(()=>{
      this.requireLease(id,token,role);
      if(leaseMs<1000||leaseMs>3600000)throw Error('Invalid lease duration');
      this.db.prepare('UPDATE jobs SET lease_until=?,updated_at=? WHERE id=?')
        .run(new Date(Date.parse(this.now())+leaseMs).toISOString(),this.now(),id);
      return this.get(id);
    });
  }
  finish(id,token,role,data,{writes=[],followups=[],state='done'}={}){
    return this.transaction(()=>{
      const job=this.requireLease(id,token,role);
      if(!['done','await-source','attention'].includes(state))throw Error('Invalid completion state');
      const value={project:PROJECT_ID,jobId:id,role,inputRevision:job.input_revision,result:data},hash=digest(value);
      this.db.prepare('INSERT OR IGNORE INTO artifacts VALUES (?,?,?,?,?)').run(hash,id,role,JSON.stringify(value),this.now());
      writes=[{file:`editorial/agent-artifacts/${hash}.json`,data:value},...writes];
      for(const write of writes)this.db.prepare('INSERT INTO outbox(job_id,file,data) VALUES (?,?,?)')
        .run(id,write.file,JSON.stringify(write.data));
      this.db.prepare('UPDATE jobs SET state=?,token=NULL,lease_until=NULL,updated_at=?,error=NULL WHERE id=?')
        .run(state,this.now(),id);
      for(const next of followups)this.enqueue(next);
      if(['await-source','attention'].includes(state)||job.kind==='review-patch'&&state==='done'&&data.verdict==='approve')this.recordDisposition(job,state);
      this.event(id,'completed',{role,hash,state});
      return {jobId:id,artifact:hash,state,followups:followups.length};
    });
  }
  retryInside(job,error,now=this.now()){
    const state=job.attempt>=3?'attention':'retry';
    const after=new Date(Date.parse(now)+Math.min(86400000,3600000*2**Math.max(0,job.attempt-1))).toISOString();
    this.db.prepare('UPDATE jobs SET state=?,error=?,retry_after=?,token=NULL,lease_until=NULL,updated_at=? WHERE id=?')
      .run(state,String(error).slice(0,1000),after,now,job.id);
    this.event(job.id,state,{error:String(error).slice(0,1000),retryAfter:after});
    if(state==='attention')this.recordDisposition(decode({...job,payload:typeof job.payload==='string'?job.payload:JSON.stringify(job.payload)}),'attention');
  }
  fail(id,token,role,error){return this.transaction(()=>{
    const job=this.requireLease(id,token,role);this.retryInside(job,error);this.noteFailure(job,String(error));return this.get(id);
  });}
  // Cleanup may retire our expired lease, but never a replacement owner's work.
  failOwned(id,token,role,error,{uncounted=false}={}){return this.transaction(()=>{
    const job=this.get(id);
    if(job?.state!=='leased'||job.token!==token||!ROLE_KINDS[role]?.includes(job.kind))return {state:'lost-lease',jobId:id};
    if(job.lease_until>this.now())return uncounted?this.releaseUncounted(id,token,role,error):this.fail(id,token,role,error);
    this.retryInside(job,'Lease expired: '+error);this.event(id,'lease-lost',{role});return this.get(id);
  });}
  // A provider outage (usage limit, login) is not the job's fault: the lease goes back, the attempt it cost is returned and the job is
  // retried soon. Only provider-* messages qualify, and a job that meets one RELEASE_LIMIT times is probably the cause, so then it counts.
  releaseUncounted(id,token,role,error,{delayMs=600000}={}){return this.transaction(()=>{
    const job=this.requireLease(id,token,role),message=String(error),category=failureCategory(message);
    if(!/^provider-/.test(category||''))throw Error('Only a provider failure can be released without an attempt');
    const released=this.db.prepare("SELECT count(*) AS n FROM events WHERE job_id=? AND kind='released-uncounted'").get(id).n;
    if(released>=RELEASE_LIMIT)this.retryInside(job,message);
    else{
      const now=this.now(),after=new Date(Date.parse(now)+delayMs).toISOString(),attempt=Math.max(0,job.attempt-1);
      this.db.prepare("UPDATE jobs SET state='retry',attempt=?,error=?,retry_after=?,token=NULL,lease_until=NULL,updated_at=? WHERE id=?")
        .run(attempt,message.slice(0,1000),after,now,id);
      this.event(id,'released-uncounted',{category,error:message.slice(0,1000),retryAfter:after,attempt});
    }
    this.noteFailure(job,message);return this.get(id);
  });}
  flush(root){
    return this.transaction(()=>{
      const writes=this.db.prepare('SELECT * FROM outbox WHERE delivered=0 ORDER BY id').all();
      for(const item of writes){
        if(!/^editorial\/(external-candidates|external-disputes|external-decisions|corrections|agent-artifacts|correction-versions)\/[a-zA-Z0-9-]+\.json$/.test(item.file)&&
          !['editorial/external-review-receipts.json','editorial/approved-updates.json'].includes(item.file))throw Error('Unsafe outbox path');
        const file=path.resolve(root,item.file);
        if(!file.startsWith(path.resolve(root)+path.sep))throw Error('Unsafe outbox path');
        fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
        if(/\/(agent-artifacts|correction-versions)\//.test(item.file)&&fs.existsSync(file)&&
          digest(JSON.parse(fs.readFileSync(file,'utf8')))!==digest(JSON.parse(item.data)))throw Error('Immutable artifact conflict');
        const temp=file+'.tmp-'+randomUUID();
        try{fs.writeFileSync(temp,JSON.stringify(JSON.parse(item.data),null,2)+'\n',{mode:0o600});fs.renameSync(temp,file);}
        finally{fs.rmSync(temp,{force:true});}
        this.db.prepare('UPDATE outbox SET delivered=1 WHERE id=?').run(item.id);
      }
      return writes.length;
    });
  }
  summary(){
    const counts=this.db.prepare('SELECT kind,state,count(*) AS count FROM jobs GROUP BY kind,state').all();
    return {project:PROJECT_ID,generatedAt:this.now(),counts,circuit:this.circuit(),
      oldestReady:this.db.prepare("SELECT min(created_at) AS date FROM jobs WHERE state='ready'").get().date,
      artifacts:this.db.prepare('SELECT count(*) AS count FROM artifacts').get().count,
      completedJobs:this.db.prepare("SELECT count(*) AS count FROM jobs WHERE state='done'").get().count,
      appliedUpdates:this.db.prepare(`SELECT count(*) AS count FROM jobs WHERE kind='review-patch' AND state='done' AND EXISTS(
        SELECT 1 FROM artifacts WHERE artifacts.job_id=jobs.id AND json_extract(data,'$.result.verdict')='approve'
        AND json_extract(data,'$.rejected') IS NULL)`).get().count,
      updatedCards:this.db.prepare(`SELECT count(DISTINCT card_id) AS count FROM jobs WHERE kind='review-patch' AND state='done' AND EXISTS(
        SELECT 1 FROM artifacts WHERE artifacts.job_id=jobs.id AND json_extract(data,'$.result.verdict')='approve'
        AND json_extract(data,'$.rejected') IS NULL)`).get().count,
      fullyReviewedCards:this.db.prepare(`SELECT count(DISTINCT card_id) AS count FROM jobs WHERE kind='review-patch' AND state='done' AND EXISTS(
        SELECT 1 FROM artifacts WHERE artifacts.job_id=jobs.id AND json_extract(data,'$.result.verdict')='approve'
        AND json_array_length(data,'$.result.checkedCoverage')>0 AND json_extract(data,'$.rejected') IS NULL)`).get().count,
      publishedReleases:this.db.prepare("SELECT count(*) AS count FROM releases WHERE state='published'").get().count,
      pendingWrites:this.db.prepare('SELECT count(*) AS count FROM outbox WHERE delivered=0').get().count};
  }
}
