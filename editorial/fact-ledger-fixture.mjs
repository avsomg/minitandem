// Invented controller artifacts only; no owner data is used by ledger tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {root} from './quality.mjs';
import {JobQueue,digest} from './jobs.mjs';
import {snapshot} from './evidence.mjs';
import {approvalSummary} from './catalogue-journal.mjs';
import {applyDraftRecord} from './workflow.mjs';
import {PROJECT_ID} from './project-id.mjs';

export const writeJson=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');};
export const fixtureCard=(id='fixture')=>({id,name:'Fixture meeting',category:'play',town:'Teststadt',region:'sarine',route:'local',format:'group',status:'active',
  min:null,max:null,age:'Age to be confirmed',parent:'yes',languages:[],schedule:'Schedule to be confirmed',days:[],events:[],address:'Fixture road 1',
  price:'Free',priceKind:'free',amount:0,contacts:[],sources:[{url:'https://fixture.example.org/meeting',label:'Official'}],notes:[],
  checked:'2026-09-30',practical:{booking:{value:false,text:'No registration required',source:'https://fixture.example.org/meeting',checked:'2026-09-30'}},
  research:{findings:[],remaining:[]}});
export function ledgerFixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-ledger-fixture-')),editorial=path.join(directory,'editorial');
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));fs.mkdirSync(editorial);
  const base=fixtureCard(),cardFile=path.join(directory,'data.js');
  const setCards=cards=>fs.writeFileSync(cardFile,'window.ACTIVITIES = '+JSON.stringify(cards)+';');setCards([base]);
  for(const file of ['data-reviewed.js','data-practical.js','data-geo.js','planning.js','exchange.js'])fs.writeFileSync(path.join(directory,file),'');
  fs.copyFileSync(path.join(root,'regions.js'),path.join(directory,'regions.js'));
  const evidence=snapshot({url:base.sources[0].url,fetchedAt:'2026-10-15T08:00:00.000Z',text:'This invented meeting is free. No registration required. Children from 2 years. Monday at 09:00.'});
  const claim=(field,value,quote)=>({key:field+'-'+digest([field,evidence.url,value,quote]).slice(0,12),field,value,quote,source:evidence.url,snapshotId:evidence.id,
    status:'supported',scope:'exact-card',kind:'official',note:'Explicit fixture condition.'});
  const claims=[claim('amount',0,'This invented meeting is free.'),claim('practical.booking',false,'No registration required.')];
  const bundle={project:PROJECT_ID,cardId:base.id,claims,snapshots:[evidence]};
  const queue=new JobQueue(path.join(editorial,'workflow-state/jobs.sqlite'),{now:()=> '2026-10-15T09:00:00.000Z'});
  queue.db.prepare('INSERT INTO captured_evidence VALUES (?,?,?)').run(evidence.id,JSON.stringify(evidence),evidence.fetchedAt);
  const putArtifact=(job,result,role='verify')=>{
    const data={project:PROJECT_ID,jobId:job.id,role,inputRevision:job.input_revision,result},id=digest(data);
    queue.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?)').run(id,job.id,role,JSON.stringify(data),'2026-10-15T09:00:00.000Z');
    writeJson(path.join(editorial,'agent-artifacts',id+'.json'),data);return id;
  };
  const verdicts=claims.map(c=>({key:c.key,verdict:'approve',reason:'The invented quote supports this value.'}));
  const verifier=queue.enqueue({kind:'verify-facts',cardId:base.id,inputRevision:'fixture-verifier',payload:{bundle}});
  queue.db.prepare("UPDATE jobs SET state='done' WHERE id=?").run(verifier.id);
  const verdictArtifact=putArtifact(verifier,{verdicts});
  const draft={cardId:base.id,patch:{amount:0},practicalPatch:{booking:{...base.practical.booking,checked:'2026-10-15'}},
    findings:[{field:'Participation',kind:'official',url:evidence.url,text:'The meeting is free and needs no registration.'}],remaining:[],
    snapshots:[evidence],bindings:claims.map(c=>({field:c.field,claimKey:c.key,quote:c.quote,source:c.source,snapshotId:c.snapshotId,kind:c.kind,scope:c.scope}))};
  const payload={draft,bundle,approved:claims,verdicts,editorJobId:'fixture-editor'};
  const reviewer=queue.enqueue({kind:'review-patch',cardId:base.id,inputRevision:'fixture-reviewer',payload});
  queue.db.prepare("UPDATE jobs SET state='done' WHERE id=?").run(reviewer.id);
  const result={verdict:'approve',draftHash:digest(draft),checkedFields:['amount','practical.booking','research.findings','research.remaining'],
    approvedBindings:claims.map(c=>c.field),reason:'The exact patch and bindings are approved.'};
  const approvalArtifact=putArtifact(reviewer,result),applied=applyDraftRecord(base,draft,'2026-10-15');
  const update={jobId:reviewer.id,editorJobId:'fixture-editor',approvalArtifact,approval:approvalSummary('verify',result),approvedOn:'2026-10-15',
    cardRevision:digest(base),baseRecord:base,appliedRecordRevision:digest(applied),research:applied.research,draft};
  const journal={schema:1,project:PROJECT_ID,updates:[update]};
  const save=()=>writeJson(path.join(editorial,'approved-updates.json'),journal);save();queue.close();
  writeJson(path.join(editorial,'source-watch.json'),{schema:1,sources:[]});
  return {root:directory,editorial,base,setCards,evidence,claims,bundle,verdicts,draft,payload,verifier,reviewer,verdictArtifact,approvalArtifact,journal,update,save};
}
