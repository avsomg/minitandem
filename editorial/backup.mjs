import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {JobQueue,digest} from './jobs.mjs';
import {root,loadCatalog} from './quality.mjs';
import {PROJECT_ID,CORRECTION_FORMAT} from './project-id.mjs';

const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const excluded=new Set(['node_modules','.git','.publish','.vercel','server-state','.DS_Store','.env']);
const databaseState=queue=>digest(['metadata','jobs','artifacts','outbox','events','releases','captured_evidence'].map(table=>
  [table,queue.db.prepare(`SELECT * FROM ${table} ORDER BY ${table==='metadata'?'key':table==='artifacts'?'hash':table==='releases'?'revision':'id'}`).all()]));
export function backupFiles(base){
  const files={};
  const walk=(directory,relative='')=>{
    for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      const name=path.posix.join(relative,entry.name);
      if(excluded.has(entry.name)||entry.name.startsWith('.env.')||name.startsWith('editorial/workflow-state/')||/\.tmp(?:-|$)|worker\.lock$/.test(entry.name))continue;
      const file=path.join(directory,entry.name);
      if(entry.isSymbolicLink())throw Error('Backup source contains a symlink: '+name);
      if(entry.isDirectory())walk(file,name);
      else{
        if(name.startsWith('editorial/corrections/')&&entry.name.endsWith('.json')){
          const value=JSON.parse(fs.readFileSync(file,'utf8'));
          if(value.report||value.type===CORRECTION_FORMAT)continue;
        }
        files[name]=hash(file);
      }
    }
  };walk(base);return files;
}
export function createBackup({source=root,destination,queue,now=new Date().toISOString()}={}){
  if(!destination||path.resolve(destination).startsWith(path.resolve(source)+path.sep))throw Error('Backup destination must be outside the application');
  if(fs.existsSync(destination))throw Error('Backup destination already exists');
  const temporary=destination+'.tmp-'+randomUUID();
  fs.mkdirSync(temporary,{recursive:true,mode:0o700});
  try{
    let manifest;
    queue.flush(source);
    if(queue.list().some(job=>job.state==='leased'))throw Error('Wait for active workers before taking a consistent backup');
    const database=path.join(temporary,'jobs.sqlite');queue.db.prepare('VACUUM INTO ?').run(database);fs.chmodSync(database,0o600);
    const copy=new JobQueue(database,{readOnly:true});let queueRevision;
    try{queueRevision=databaseState(copy);}finally{copy.close();}
    queue.transaction(()=>{
      queue.flush(source);
      if(queue.list().some(job=>job.state==='leased'))throw Error('Wait for active workers before taking a consistent backup');
      if(databaseState(queue)!==queueRevision)throw Error('Queue changed during backup; retry after the worker finishes');
      const files=backupFiles(source);
      for(const name of Object.keys(files)){
        const file=path.join(temporary,'project',name);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
        fs.copyFileSync(path.join(source,name),file);fs.chmodSync(file,0o600);
      }
      if(digest(backupFiles(source))!==digest(files))throw Error('Project changed during backup; retry after the writer finishes');
      const records=source===root?loadCatalog().ACTIVITIES:null;
      manifest={schema:1,project:PROJECT_ID,createdAt:now,scope:'editorial-and-code',familyDataIncluded:false,
        exclusions:['family server-state and raw family correction submissions','credentials outside project','installed dependencies','builds and release snapshots','older queue backups'],
        files,queueHash:hash(database),catalogue:records?{records:records.length,revision:digest(records)}:null};
    });
    fs.writeFileSync(path.join(temporary,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
    verifyBackup(temporary);fs.renameSync(temporary,destination);return {destination,...manifest};
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
}
export function verifyBackup(directory){
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  if(manifest.project!==PROJECT_ID||manifest.schema!==1||manifest.familyDataIncluded!==false)throw Error('Invalid backup identity or scope');
  const project=path.join(directory,'project');
  if(digest(backupFiles(project))!==digest(manifest.files)||hash(path.join(directory,'jobs.sqlite'))!==manifest.queueHash)throw Error('Backup hash mismatch');
  const queue=new JobQueue(path.join(directory,'jobs.sqlite'),{readOnly:true});
  try{if(queue.db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Queue integrity check failed');}
  finally{queue.close();}
  return manifest;
}
export async function restoreBackup(directory,destination){
  const manifest=verifyBackup(directory);
  if(!destination||path.resolve(destination).startsWith(path.resolve(directory)+path.sep))throw Error('Restore destination must be outside the backup');
  if(fs.existsSync(destination))throw Error('Restore requires a new, empty destination');
  fs.mkdirSync(destination,{recursive:true,mode:0o700});
  try{
    fs.cpSync(path.join(directory,'project'),destination,{recursive:true});
    const queuePath=path.join(destination,'editorial/workflow-state/jobs.sqlite');
    fs.mkdirSync(path.dirname(queuePath),{recursive:true,mode:0o700});fs.copyFileSync(path.join(directory,'jobs.sqlite'),queuePath);fs.chmodSync(queuePath,0o600);
    if(manifest.catalogue){
      const restored=await import(pathToFileURL(path.join(destination,'editorial/quality.mjs')).href);
      const records=restored.loadCatalog().ACTIVITIES;
      if(digest(records)!==manifest.catalogue.revision)throw Error('Restored catalogue differs from backup');
    }
    return {destination,verified:true,scope:manifest.scope,familyDataIncluded:false,catalogue:manifest.catalogue};
  }catch(error){fs.rmSync(destination,{recursive:true,force:true});throw error;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const command=process.argv[2],directory=process.argv.find(x=>x.startsWith('--to='))?.slice(5);
  if(command==='create'){
    const queue=new JobQueue(path.join(root,'editorial/workflow-state/jobs.sqlite'));
    try{const backup=createBackup({destination:directory,queue});console.log(JSON.stringify({destination:backup.destination,scope:backup.scope,files:Object.keys(backup.files).length,catalogue:backup.catalogue},null,2));}
    finally{queue.close();}
  }else if(command==='verify')console.log(JSON.stringify(verifyBackup(process.argv[3]),null,2));
  else if(command==='restore')console.log(JSON.stringify(await restoreBackup(process.argv[3],directory),null,2));
  else throw Error('Use create --to=OUTSIDE_DIRECTORY, verify DIRECTORY or restore DIRECTORY --to=NEW_DIRECTORY');
}
