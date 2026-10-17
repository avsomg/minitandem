import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {JobQueue,digest} from './jobs.mjs';
import {here,root,currentInputs} from './workflow.mjs';
import {publicManifest} from './agent-run.mjs';
import {assertEditorialReady} from './external-pipeline.mjs';
import {assertPublicationReviewed,externalReviewReport,readExternalReviewInputs} from './external-review.mjs';
import {SCRIPTS,LAZY_SCRIPTS,STATIC} from '../ui-files.mjs';

export function sourceRevision(base=root,{generated=true}={}){
  const files={};
  for(const file of [...new Set([...STATIC,...SCRIPTS,...LAZY_SCRIPTS])].concat(['research.md','.vercelignore','vercel.json',
    'editorial/approved-updates.json','editorial/geocode-candidates.json','editorial/agent-policy.json',
    'editorial/agent-output.schema.json','editorial/package.json','editorial/package-lock.json',
    'build.mjs','maintain.mjs','public-pages.mjs','site.mjs','ui-files.mjs','verify-age.mjs'])){
    if(!generated&&['data-reviewed.js','data-geo.js','research.md'].includes(file))continue;
    const full=path.join(base,file);files[file]=fs.existsSync(full)?digest(fs.readFileSync(full).toString('base64')):null;
  }
  for(const directory of ['','editorial','assets']){
    const full=path.join(base,directory);if(!fs.existsSync(full))continue;
    for(const entry of fs.readdirSync(full,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      if(!entry.isFile()||directory!=='assets'&&!entry.name.endsWith('.mjs'))continue;
      const file=path.posix.join(directory,entry.name);files[file]=digest(fs.readFileSync(path.join(full,entry.name)).toString('base64'));
    }
  }
  for(const directory of ['editorial/geo']){
    const full=path.join(base,directory);if(!fs.existsSync(full))continue;
    for(const file of fs.readdirSync(full).filter(f=>f.endsWith('.json')).sort())files[directory+'/'+file]=digest(fs.readFileSync(path.join(full,file)).toString('base64'));
  }
  return digest(files);
}
export function assertReleaseCurrent(tested,{manifest=publicManifest(),source=sourceRevision()}={}){
  if(!tested?.checks?.includes('unit')||!tested.checks.includes('mobile-ages')||!tested.checks.includes('mobile-flow')||!tested.checks.includes('build'))throw Error('Release lacks required QA');
  if(tested.manifest.revision!==manifest.revision||digest(tested.manifest.files)!==digest(manifest.files))throw Error('Public build changed after QA');
  if(tested.sourceRevision!==source)throw Error('Source files changed after QA');
  return true;
}
export function assertEditorialReleaseReady({input=currentInputs(),external=readExternalReviewInputs(),
  date=new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Zurich'})}={}){
  assertEditorialReady(input.pipeline);
  if(input.staleUpdates.length)throw Error('Stale approved updates require reapproval');
  assertPublicationReviewed(externalReviewReport(input.records,external.receipts,external.legacyRecords,external.baseline,date));
  return true;
}
// The Vercel project, team and scope of the release are account identifiers. They live in editorial/release-identity.json,
// which is private and ignored by git; editorial/release-identity.example.json shows the shape.
export function releaseIdentity(file=path.join(here,'release-identity.json')){
  let identity;
  try{identity=JSON.parse(fs.readFileSync(file,'utf8'));}
  catch{throw Error('Release identity missing: create editorial/release-identity.json (see release-identity.example.json)');}
  if(!['projectId','orgId','scope'].every(key=>typeof identity[key]==='string'&&identity[key].trim()))throw Error('Release identity needs projectId, orgId and scope');
  return identity;
}
export function publish(queue,{run=execFileSync,identity=releaseIdentity}={}){
  const expected=identity();
  let row,tested,lease,snapshot;
  queue.transaction(()=>{
    queue.flush(root);
    row=queue.db.prepare("SELECT * FROM releases WHERE state='tested' ORDER BY created_at DESC LIMIT 1").get();
    if(!row)throw Error('No tested release');
    tested=JSON.parse(row.manifest);
    lease=queue.claim('release','operator',{leaseMs:900000});
    if(!lease||lease.input_revision!==row.revision)throw Error('QA, patch approval or another release is in progress');
    if(!/^[a-f0-9]{64}$/.test(row.revision))throw Error('Invalid release revision');
    snapshot=path.join(here,'workflow-state','release-snapshots',row.revision);
    assertReleaseCurrent(tested,{manifest:publicManifest(snapshot)});
    assertEditorialReleaseReady();
  });
  try{
  const configured=JSON.parse(fs.readFileSync(path.join(snapshot,'.vercel','project.json'),'utf8'));
  if(configured.projectId!==expected.projectId||configured.orgId!==expected.orgId)throw Error('Wrong Vercel project');
  const output=run('vercel',['deploy','--prod','--yes','--cwd',snapshot,'--scope',expected.scope],
    {cwd:root,timeout:180000,maxBuffer:2000000,encoding:'utf8'});
  queue.transaction(()=>{
    queue.db.prepare('UPDATE releases SET state=? WHERE revision=?').run('published',row.revision);
    queue.event(null,'published',{revision:row.revision,output:String(output).slice(-2000)});
    queue.finish(lease.id,lease.token,'release',{revision:row.revision,published:true});
  });return {revision:row.revision,output};
  }catch(error){queue.fail(lease.id,lease.token,'release',error.message);throw error;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const queue=new JobQueue(path.join(here,'workflow-state','jobs.sqlite'));
  try{
    if(process.argv[2]==='publish')console.log(JSON.stringify(publish(queue),null,2));
    else if(process.argv[2]==='check'){
      const row=queue.db.prepare("SELECT * FROM releases WHERE state='tested' ORDER BY created_at DESC LIMIT 1").get();
      if(!row)throw Error('No tested release');assertReleaseCurrent(JSON.parse(row.manifest),{manifest:publicManifest(path.join(here,'workflow-state','release-snapshots',row.revision))});
      assertEditorialReleaseReady();
      console.log(JSON.stringify({ready:true,revision:row.revision,automaticPublication:false},null,2));
    }else throw Error('Use check or publish; publish requires explicit release authorization');
  }finally{queue.close();}
}
