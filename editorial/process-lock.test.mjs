import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {takeProcessLock,processStart,pidAlive,UNVERIFIED_MAX_AGE_MS} from './process-lock.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const MIN=60000,HOUR=3600000,DAY=24*HOUR;
const folder=t=>{const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'minitandem-lock-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;};
const record=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Invented processes and a clock the test moves: no real pid, no real time, no ps.
function world(){
  const processes=new Map();let time=Date.parse('2026-10-15T08:00:00Z');
  const world={
    clock:()=>time,
    advance:ms=>{time+=ms;},
    start:pid=>{processes.set(pid,new Date(time).toISOString());return pid;},
    stop:pid=>{processes.delete(pid);},
    as:pid=>({pid,alive:other=>processes.has(other),startOf:other=>processes.get(other)??null,clock:()=>time}),
    // file times follow the invented clock, so "this old" means old for the code under test
    age:(file,ms)=>{const seconds=(time-ms)/1000;fs.utimesSync(file,seconds,seconds);}
  };
  return world;
}

test('two contenders: one owns the lock, the other is told who does; after the release the other can take it and no temporary file is left',t=>{
  const dir=folder(t),file=path.join(dir,'cycle.lock'),w=world();w.start(100);w.start(200);
  const a=takeProcessLock(file,w.as(100)),b=takeProcessLock(file,w.as(200));
  assert.equal(a.ok,true);assert.equal(b.ok,false);assert.equal(b.holder.pid,100);
  assert.deepEqual(Object.keys(record(file)).sort(),['pid','processStart','schema','startedAt','token']);
  assert.equal(record(file).token,a.token);assert.equal(record(file).processStart,'2026-10-15T08:00:00.000Z');
  assert.equal(a.release(),true);assert.equal(fs.existsSync(file),false);
  assert.equal(takeProcessLock(file,w.as(200)).ok,true);
  assert.deepEqual(fs.readdirSync(dir),['cycle.lock']);
});

test('contenders that start at the same moment (real processes): exactly one owns the lock',async t=>{
  const dir=folder(t),control=path.join(dir,'control'),file=path.join(dir,'cycle.lock'),script=path.join(dir,'contender.mjs');
  fs.mkdirSync(control);
  fs.writeFileSync(script,`import fs from 'node:fs';import path from 'node:path';
import {takeProcessLock} from ${JSON.stringify(new URL('./process-lock.mjs',import.meta.url).href)};
const [file,control,id]=process.argv.slice(2),has=name=>fs.existsSync(path.join(control,name));
fs.writeFileSync(path.join(control,'ready-'+id),'');
while(!has('go'));
const lock=takeProcessLock(file);
fs.writeFileSync(path.join(control,'result-'+id),lock.ok?'owner':'busy');
while(!has('done'));
if(lock.ok)lock.release();
`);
  const count=8,children=[];
  for(let id=0;id<count;id++){
    const child=spawn(process.execPath,[script,file,control,String(id)],{stdio:['ignore','ignore','pipe']});
    let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
    children.push({child,closed:new Promise(resolve=>child.on('close',code=>resolve({code,stderr})))});
  }
  t.after(()=>{for(const {child} of children)child.kill();});
  const waitFor=async(predicate,what)=>{for(let i=0;i<1500;i++){if(predicate())return;await sleep(20);}throw new Error('timeout waiting for '+what);};
  const names=()=>fs.readdirSync(control);
  await waitFor(()=>names().filter(name=>name.startsWith('ready-')).length===count,'the contenders to be ready');
  fs.writeFileSync(path.join(control,'go'),'');
  await waitFor(()=>names().filter(name=>name.startsWith('result-')).length===count,'every contender to decide');
  const results=names().filter(name=>name.startsWith('result-')).map(name=>fs.readFileSync(path.join(control,name),'utf8')).sort();
  assert.deepEqual(results,['busy','busy','busy','busy','busy','busy','busy','owner']);
  fs.writeFileSync(path.join(control,'done'),'');
  for(const {closed} of children){const {code,stderr}=await closed;assert.equal(code,0,stderr);}
  assert.deepEqual(fs.readdirSync(dir).filter(name=>name!=='control'&&name!=='contender.mjs'),[],'the owner released, nothing else is left');
});

test('whenever the lock file can be seen, it already holds a complete owner record (observed from outside while another process takes and releases it)',async t=>{
  const dir=folder(t),file=path.join(dir,'cycle.lock'),script=path.join(dir,'churn.mjs'),stop=path.join(dir,'stop');
  fs.writeFileSync(script,`import fs from 'node:fs';
import {takeProcessLock} from ${JSON.stringify(new URL('./process-lock.mjs',import.meta.url).href)};
const [file,stop]=process.argv.slice(2);
while(!fs.existsSync(stop)){const lock=takeProcessLock(file);if(lock.ok)lock.release();}
`);
  const child=spawn(process.execPath,[script,file,stop],{stdio:['ignore','ignore','pipe']});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  const closed=new Promise(resolve=>child.on('close',code=>resolve(code)));
  t.after(()=>child.kill());
  let seen=0,bad=[];
  const until=Date.now()+1500;
  while(Date.now()<until){
    for(let i=0;i<2000;i++){
      let text;try{text=fs.readFileSync(file,'utf8');}catch(error){if(error.code==='ENOENT')continue;throw error;}
      seen++;
      try{const value=JSON.parse(text);if(!(value.schema===1&&value.pid>0&&value.token&&value.startedAt))bad.push(text);}catch{bad.push(text);}
    }
    await sleep(0);
  }
  fs.writeFileSync(stop,'');
  assert.equal(await closed,0,stderr);
  assert.ok(seen>20,`the lock was seen ${seen} times`);
  assert.deepEqual(bad.slice(0,3),[],`${bad.length} of ${seen} sightings were not a complete record`);
});

test('a lock never exists without its owner: a contender during a slow creation sees no lock, takes it, and the slow one then finds it taken',t=>{
  const dir=folder(t),file=path.join(dir,'cycle.lock'),w=world();w.start(100);w.start(200);
  let during=null,second=null;
  const first=takeProcessLock(file,{...w.as(100),hooks:{beforeLink(){
    during={lockExists:fs.existsSync(file),files:fs.readdirSync(dir).length};
    second=takeProcessLock(file,w.as(200));
  }}});
  assert.deepEqual(during,{lockExists:false,files:1},'only the creator\'s own temporary file exists, not a lock without an owner');
  assert.equal(second.ok,true);
  assert.equal(first.ok,false);assert.equal(first.holder.pid,200,'the slow creator is told who won');
  assert.equal(record(file).token,second.token,'the winner\'s lock is untouched');
  assert.deepEqual(fs.readdirSync(dir),['cycle.lock']);
});

test('a lock whose process is gone is taken over; one whose process lives is not, however much time has passed',t=>{
  const dir=folder(t),file=path.join(dir,'cycle.lock'),w=world();w.start(100);w.start(200);
  const a=takeProcessLock(file,w.as(100));
  // sleep/resume, a clock that jumped, a batch that really runs for a week: the owner is alive and the same process
  for(const jump of [3*HOUR+1,10*HOUR,30*DAY]){
    w.advance(jump);
    const b=takeProcessLock(file,w.as(200));
    assert.equal(b.ok,false,`after ${jump} ms`);assert.equal(b.holder.pid,100);assert.equal(record(file).token,a.token);
  }
  // the process is gone (a crash, a kill, a restart)
  w.stop(100);
  const c=takeProcessLock(file,w.as(200));
  assert.equal(c.ok,true);assert.equal(record(file).token,c.token);assert.equal(record(file).pid,200);
  assert.deepEqual(fs.readdirSync(dir),['cycle.lock'],'no marker or temporary file is left');
});

test('a reused pid is not the owner: another start time, or a start after the lock was written, makes the lock stale; an unknown start time keeps it',t=>{
  const dir=folder(t),file=path.join(dir,'cycle.lock'),w=world();w.start(100);w.start(200);
  const a=takeProcessLock(file,w.as(100));
  // ps cannot tell right now: the pid is alive, so the lock is kept
  assert.equal(takeProcessLock(file,{...w.as(200),startOf:pid=>pid===100?null:w.as(200).startOf(pid)}).ok,false);
  // the same pid, a few seconds off in the report of ps: still the same process
  assert.equal(takeProcessLock(file,{...w.as(200),startOf:pid=>pid===100?'2026-10-15T08:00:05.000Z':null}).ok,false);
  // the owner died, an hour later the system gave its pid to another process
  w.stop(100);w.advance(HOUR);w.start(100);
  const b=takeProcessLock(file,w.as(200));
  assert.equal(b.ok,true);assert.notEqual(b.token,a.token);assert.equal(record(file).pid,200);
});

test('when the start time of the owner was not recorded, the pid alone decides, with a day as the longest a lock can be believed',t=>{
  const dir=folder(t),file=path.join(dir,'cycle.lock'),w=world();w.start(100);w.start(200);
  const a=takeProcessLock(file,{...w.as(100),startOf:()=>null});
  assert.equal(record(file).processStart,null);
  w.advance(UNVERIFIED_MAX_AGE_MS-MIN);
  assert.equal(takeProcessLock(file,w.as(200)).ok,false,'alive and younger than a day');
  w.advance(2*MIN);
  const b=takeProcessLock(file,w.as(200));
  assert.equal(b.ok,true,'older than a day, and the start time cannot show that it is the same process');
  assert.notEqual(record(file).token,a.token);
  // an owner whose recorded start is unknown but whose pid now belongs to a process that started later is not the owner either
  const dir2=folder(t),file2=path.join(dir2,'cycle.lock'),w2=world();w2.start(100);w2.start(200);
  takeProcessLock(file2,{...w2.as(100),startOf:()=>null});
  w2.stop(100);w2.advance(HOUR);w2.start(100);
  assert.equal(takeProcessLock(file2,w2.as(200)).ok,true);
});

test('an old owner cannot delete the lock that replaced its own',t=>{
  const dir=folder(t),file=path.join(dir,'cycle.lock'),w=world();w.start(100);w.start(200);
  const a=takeProcessLock(file,w.as(100));
  w.stop(100);                                   // judged gone (say, the Mac restarted and ran something else)
  const b=takeProcessLock(file,w.as(200));
  assert.equal(b.ok,true);
  assert.equal(a.release(),false,'the old owner finds a lock that is not its own');
  assert.equal(record(file).token,b.token,'the replacement is still there');
  assert.equal(takeProcessLock(file,w.as(100)).ok,false,'and still holds against a third run');
  assert.equal(b.release(),true);assert.equal(fs.existsSync(file),false);
  assert.equal(b.release(),false,'a second release does nothing');
  assert.equal(a.release(),false,'nor does a release when there is no lock');
});

test('a lock that was replaced between looking at it and removing it is left alone',t=>{
  const dir=folder(t),file=path.join(dir,'cycle.lock'),w=world();w.start(100);w.start(200);w.start(300);
  const a=takeProcessLock(file,w.as(100));w.stop(100);
  let third=null;
  const b=takeProcessLock(file,{...w.as(200),hooks:{beforeReap(){
    // while B holds the right to remove A's stale lock, C has already done so and taken the place
    fs.unlinkSync(file);third=takeProcessLock(file,w.as(300));
  }}});
  assert.equal(third.ok,true);
  assert.equal(b.ok,false,'B backs off instead of removing C\'s fresh lock');
  assert.equal(record(file).token,third.token);assert.notEqual(third.token,a.token);
  assert.deepEqual(fs.readdirSync(dir),['cycle.lock'],'B\'s marker and temporary file are gone');
});

test('only one contender removes a given stale lock; the marker of a remover that died ages out',t=>{
  const dir=folder(t),file=path.join(dir,'cycle.lock'),w=world();w.start(100);w.start(200);
  const a=takeProcessLock(file,w.as(100));w.stop(100);
  const marker=`${file}.reap-${a.token}`;
  fs.writeFileSync(marker,'999');w.age(marker,5000);
  const blocked=takeProcessLock(file,w.as(200));
  assert.equal(blocked.ok,false,'somebody is removing it right now: this run backs off');
  assert.equal(record(file).token,a.token,'and nothing was removed');
  w.age(marker,3*MIN);
  const later=takeProcessLock(file,w.as(200));
  assert.equal(later.ok,true,'the marker of a remover that is long gone does not block for ever');
  assert.deepEqual(fs.readdirSync(dir),['cycle.lock']);
});

test('a lock file that cannot be read is left alone for ten minutes and removed after that; old temporary files are cleared',t=>{
  const dir=folder(t),file=path.join(dir,'cycle.lock'),w=world();w.start(100);w.start(200);
  for(const content of ['','{"schema":1,"pid":','not json at all','{"schema":2,"pid":1,"token":"abcdefgh","startedAt":"2026-10-15T08:00:00Z"}']){
    fs.writeFileSync(file,content);w.age(file,2*MIN);
    const young=takeProcessLock(file,w.as(200));
    assert.equal(young.ok,false,JSON.stringify(content));assert.equal(young.holder,null);assert.equal(fs.readFileSync(file,'utf8'),content);
    w.age(file,11*MIN);
    const old=takeProcessLock(file,w.as(200));
    assert.equal(old.ok,true,JSON.stringify(content));assert.equal(record(file).token,old.token);
    old.release();
  }
  fs.writeFileSync(`${file}.tmp-1-aaaaaaaa`,'x');w.age(`${file}.tmp-1-aaaaaaaa`,2*HOUR);
  fs.writeFileSync(`${file}.tmp-2-bbbbbbbb`,'x');w.age(`${file}.tmp-2-bbbbbbbb`,5*MIN);
  fs.writeFileSync(path.join(dir,'state.json'),'{}');
  takeProcessLock(file,w.as(200)).release();
  assert.deepEqual(fs.readdirSync(dir).sort(),['cycle.lock.tmp-2-bbbbbbbb','state.json'],'a leftover of a killed run goes, a young file and other files stay');
});

test('a directory left by an older version: respected while its owner lives and is young, removed when the owner is gone, old or missing',t=>{
  const dir=folder(t),file=path.join(dir,'cycle.lock'),old=path.join(dir,'lock'),w=world();w.start(100);w.start(200);
  const options=pid=>({...w.as(pid),legacyDirectory:old});
  const legacy=(owner,fileName='owner.json')=>{fs.rmSync(old,{recursive:true,force:true});fs.mkdirSync(old);if(owner!==undefined)fs.writeFileSync(path.join(old,fileName),owner);};
  const iso=ms=>new Date(w.clock()-ms).toISOString();
  // a live old owner, started an hour ago
  legacy(JSON.stringify({pid:100,startedAt:iso(HOUR)}));
  const held=takeProcessLock(file,options(200));
  assert.equal(held.ok,false);assert.deepEqual(held.holder,{pid:100,legacy:true});assert.ok(fs.existsSync(old),'the old directory is not touched');assert.equal(fs.existsSync(file),false);
  // live, but older than the three hours the old code allowed
  legacy(JSON.stringify({pid:100,startedAt:iso(4*HOUR)}));
  assert.equal(takeProcessLock(file,options(200)).ok,true);assert.equal(fs.existsSync(old),false);fs.unlinkSync(file);
  // the old owner is gone
  w.stop(100);
  legacy(JSON.stringify({pid:100,startedAt:iso(MIN)}));
  assert.equal(takeProcessLock(file,options(200)).ok,true);assert.equal(fs.existsSync(old),false);fs.unlinkSync(file);
  // the format of the off-site copy: a plain pid file, age from the directory
  w.start(100);
  legacy('100','pid');
  assert.deepEqual(takeProcessLock(file,options(200)).holder,{pid:100,legacy:true});
  w.age(old,4*HOUR);
  assert.equal(takeProcessLock(file,options(200)).ok,true);assert.equal(fs.existsSync(old),false);fs.unlinkSync(file);
  // no owner file yet: perhaps its creator is still writing it; later it is abandoned
  legacy(undefined);w.age(old,5000);
  const young=takeProcessLock(file,options(200));
  assert.equal(young.ok,false);assert.deepEqual(young.holder,{pid:0,legacy:true});assert.ok(fs.existsSync(old));
  w.age(old,2*MIN);
  assert.equal(takeProcessLock(file,options(200)).ok,true);assert.equal(fs.existsSync(old),false);fs.unlinkSync(file);
  // unreadable owner file, old directory
  legacy('garbage');w.age(old,2*MIN);
  assert.equal(takeProcessLock(file,options(200)).ok,true);assert.equal(fs.existsSync(old),false);
});

test('with the real process table: the default owner is this process, a second take in it is refused, the start time is stable and independent of the time zone',t=>{
  const dir=folder(t),file=path.join(dir,'cycle.lock');
  const a=takeProcessLock(file);
  assert.equal(a.ok,true);assert.equal(record(file).pid,process.pid);
  assert.equal(takeProcessLock(file).ok,false,'this very process is alive and has not changed');
  const start=processStart(process.pid);
  if(start){
    assert.equal(record(file).processStart,start);
    assert.ok(Date.parse(start)<=Date.now()&&Date.parse(start)>Date.now()-365*DAY,start);
    const zone=process.env.TZ;
    try{process.env.TZ='Pacific/Auckland';assert.equal(processStart(process.pid),start);process.env.TZ='America/Los_Angeles';assert.equal(processStart(process.pid),start);}
    finally{if(zone===undefined)delete process.env.TZ;else process.env.TZ=zone;}
  }
  assert.equal(a.release(),true);
  const gone=spawnSync(process.execPath,['-e','0']);
  assert.equal(pidAlive(gone.pid),false);assert.equal(pidAlive(process.pid),true);
  assert.equal(processStart(gone.pid),null,'no such process');
  // a lock left by a process that is gone is taken over by the default checks too
  fs.writeFileSync(file,JSON.stringify({schema:1,pid:gone.pid,token:'deadbeef-0000',startedAt:new Date().toISOString(),processStart:null})+'\n');
  const b=takeProcessLock(file);
  assert.equal(b.ok,true);assert.equal(record(file).token,b.token);
  assert.deepEqual(fs.readdirSync(dir),['cycle.lock']);
});
