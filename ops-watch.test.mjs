// Tests of the scripts that let the server watch the editorial cycle on the Mac and keep a daily copy of its private state:
// ops/drop.sh, ops/cycle-run.mjs, ops/editorial-offsite.mjs, ops/cycle-watch.sh and the install templates.
// The real scripts run; ssh, sendmail and editorial/backup.mjs are replaced by small stand-ins, everything happens in temporary folders.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildHeartbeat} from './ops/cycle-run.mjs';
import {processStart} from './editorial/process-lock.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const TMP=fs.realpathSync(os.tmpdir());
const tmp=(t,prefix)=>{const directory=fs.mkdtempSync(path.join(TMP,prefix));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;};
const sha=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
const have=program=>spawnSync('sh',['-c',`command -v ${program}`],{stdio:'ignore'}).status===0;
// /bin/sh is dash on Ubuntu (the server and CI) and bash on a Mac: the scripts are POSIX sh and run under both
const realShell=()=>{try{return path.basename(fs.realpathSync(spawnSync('sh',['-c','command -v sh'],{encoding:'utf8'}).stdout.trim()));}catch{return 'sh';}};
const SHELLS=['sh',...(have('dash')&&realShell()!=='dash'?['dash']:[])];
// The drop refuses dates after tomorrow (UTC), so the tests count from the real day
const dayFromNow=n=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);
const D0=dayFromNow(-1);
const DROP=path.join(root,'ops','drop.sh');
const WATCH=path.join(root,'ops','cycle-watch.sh');
const write=(file,text,mode)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text,mode?{mode}:undefined);return file;};
const archive=content=>zlib.gzipSync(Buffer.from(content));

// ---- the drop (forced command on the server) ---------------------------------------------------------------------------------------------

function dropSandbox(t){
  const folder=tmp(t,'minitandem-drop-');
  const env={PATH:process.env.PATH,HOME:folder,WATCH_DIR:path.join(folder,'watch'),DROP_BACKUP_DIR:path.join(folder,'backups')};
  const run=(command,input='',extra={},shell='sh')=>{
    const environment={...env,...extra};
    if(command!==undefined)environment.SSH_ORIGINAL_COMMAND=command;
    const result=spawnSync(shell,[DROP],{input,env:environment,encoding:'utf8'});
    return {status:result.status,stdout:result.stdout,stderr:result.stderr};
  };
  const list=directory=>fs.existsSync(directory)?fs.readdirSync(directory).sort():[];
  return {folder,env,run,watch:env.WATCH_DIR,backups:env.DROP_BACKUP_DIR,list};
}

for(const shell of SHELLS){
  test(`drop.sh (${shell}) stores a heartbeat atomically and nothing else lands next to it`,t=>{
    const box=dropSandbox(t),beat='{"at":"2026-10-15T05:30:00.000Z","exit":0,"ok":true}\n';
    const stored=box.run('heartbeat',beat,{},shell);
    assert.equal(stored.status,0,stored.stderr);
    assert.equal(fs.readFileSync(path.join(box.watch,'heartbeat.json'),'utf8'),beat);
    assert.deepEqual(box.list(box.watch),['heartbeat.json']);
    // a newer one replaces it
    assert.equal(box.run('heartbeat','{"ok":false}\n',{},shell).status,0);
    assert.equal(fs.readFileSync(path.join(box.watch,'heartbeat.json'),'utf8'),'{"ok":false}\n');
  });

  test(`drop.sh (${shell}) refuses a heartbeat that is too large, not JSON, several lines or not plain text, and keeps the old one`,t=>{
    const box=dropSandbox(t),good='{"ok":true}\n';
    assert.equal(box.run('heartbeat',good,{},shell).status,0);
    const bad={
      oversize:'{"pad":"'+'x'.repeat(17000)+'"}\n',
      oneByteOverTheLimit:'{"pad":"'+'x'.repeat(16384-10)+'"}\n',
      empty:'',
      notJson:'hello\n',
      twoLines:'{"a":1}\n{"b":2}\n',
      control:'{"a":"\u001b[31m"}\n',
      nonAscii:'{"a":"caf\u00e9"}\n',
      binary:Buffer.from([0x7b,0,0x7d,0x0a]).toString('latin1')
    };
    for(const [name,input] of Object.entries(bad)){
      const result=box.run('heartbeat',input,{},shell);
      assert.equal(result.status,1,`${name} must be refused`);
      assert.match(result.stderr,/^minitandem-drop: /,name);
    }
    assert.equal(fs.readFileSync(path.join(box.watch,'heartbeat.json'),'utf8'),good,'the old heartbeat survives');
    assert.deepEqual(box.list(box.watch),['heartbeat.json'],'no temporary file is left');
    // the limit itself is allowed: exactly 16 KB including the newline
    const edge='{"pad":"'+'x'.repeat(16384-11)+'"}\n';
    assert.equal(Buffer.byteLength(edge),16384);
    assert.equal(box.run('heartbeat',edge,{},shell).status,0);
  });

  test(`drop.sh (${shell}) stores a daily archive after checking its checksum and writes the receipt`,t=>{
    const box=dropSandbox(t),data=archive('state of the day');
    const result=box.run(`backup ${D0} ${sha(data)}`,data,{},shell);
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(fs.readFileSync(path.join(box.backups,`editorial-${D0}.tar.gz`)),data);
    assert.deepEqual(box.list(box.backups),[`editorial-${D0}.tar.gz`]);
    const receipt=JSON.parse(fs.readFileSync(path.join(box.watch,'backup.json'),'utf8'));
    assert.equal(receipt.name,`editorial-${D0}.tar.gz`);
    assert.equal(receipt.bytes,data.length);
    assert.match(receipt.at,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(fs.statSync(box.backups).mode&0o077,0,'the archive folder is private');
  });

  test(`drop.sh (${shell}) refuses a wrong checksum, a bad date, a bad checksum format, a file that is not gzip and an archive over the limit`,t=>{
    const box=dropSandbox(t),data=archive('state'),good=sha(data);
    const refused=(command,input,extra)=>{const result=box.run(command,input,extra,shell);assert.equal(result.status,1,command+'\n'+result.stderr);assert.match(result.stderr,/^minitandem-drop: /);return result;};
    assert.match(refused(`backup ${D0} ${sha(Buffer.from('other'))}`,data).stderr,/checksum mismatch/);
    for(const day of ['2099-12-31',dayFromNow(2),'2026-13-01','2026-10-32','2026-00-10','2026-10-00','20261015','2026-1-5','1999-10-15','2026-10-15x','tomorrow'])
      refused(`backup ${day} ${good}`,data);
    for(const bad of ['abc',good.toUpperCase(),good+'0',good.slice(1),good.replace(/.$/,'g')])refused(`backup ${D0} ${bad}`,data);
    const plain=Buffer.from('this is not gzip');
    assert.match(refused(`backup ${D0} ${sha(plain)}`,plain).stderr,/not a gzip file/);
    assert.match(refused(`backup ${D0} ${good}`,data,{DROP_MAX_BACKUP_BYTES:String(data.length-1)}).stderr,/larger than/);
    assert.deepEqual(box.list(box.backups),[],'nothing was stored, no temporary file is left');
    assert.equal(fs.existsSync(path.join(box.watch,'backup.json')),false,'no receipt for a refused archive');
  });

  test(`drop.sh (${shell}) accepts exactly its two commands and refuses everything else`,t=>{
    const box=dropSandbox(t),data=archive('x'),good=sha(data);
    for(const command of ['ls','rm -rf /','heartbeat; id','heartbeat && id','heartbeat | cat','heartbeat $(id)','heartbeat `id`','heartbeat\nid','heartbeat extra',
      'heartbeat > /tmp/x','backup',`backup ${D0}`,`backup ${D0} ${good} extra`,`backup ../../etc/passwd ${good}`,`backup ${D0}/../x ${good}`,
      'HEARTBEAT','scp -t /tmp','sftp','cat /etc/passwd','',' ','--help']){
      const result=box.run(command,data,{},shell);
      assert.equal(result.status,1,JSON.stringify(command));
      assert.match(result.stderr,/^minitandem-drop: /,JSON.stringify(command));
      assert.equal(result.stdout,'');
    }
    const without=box.run(undefined,data,{},shell);
    assert.equal(without.status,1);assert.match(without.stderr,/no command/);
    assert.deepEqual(box.list(box.watch),[],'a refused command stores nothing');
    assert.deepEqual(box.list(box.backups),[]);
  });

  test(`drop.sh (${shell}) keeps the newest 14 archives, touches no other file and never overwrites a different archive`,t=>{
    const box=dropSandbox(t);
    fs.mkdirSync(box.backups,{recursive:true});
    for(let day=1;day<=16;day++)fs.writeFileSync(path.join(box.backups,`editorial-2026-09-${String(day).padStart(2,'0')}.tar.gz`),'old');
    fs.writeFileSync(path.join(box.backups,'notes.txt'),'not an archive');
    const data=archive('new');
    assert.equal(box.run(`backup ${D0} ${sha(data)}`,data,{},shell).status,0);
    const names=box.list(box.backups);
    assert.equal(names.filter(name=>name.startsWith('editorial-')).length,14);
    assert.ok(names.includes(`editorial-${D0}.tar.gz`));
    assert.ok(names.includes('editorial-2026-09-16.tar.gz'),'the newest old one is kept');
    assert.ok(!names.includes('editorial-2026-09-01.tar.gz')&&!names.includes('editorial-2026-09-03.tar.gz'),'the oldest are gone');
    assert.ok(names.includes('editorial-2026-09-04.tar.gz'));
    assert.ok(names.includes('notes.txt'),'files that are not archives are left alone');
    // a different archive for the same day is refused and the first one stays
    const other=archive('different');
    const again=box.run(`backup ${D0} ${sha(other)}`,other,{},shell);
    assert.equal(again.status,1);assert.match(again.stderr,/never overwritten/);
    assert.deepEqual(fs.readFileSync(path.join(box.backups,`editorial-${D0}.tar.gz`)),data);
    // the same bytes again (a retry after a cut connection) is fine
    const retry=box.run(`backup ${D0} ${sha(data)}`,data,{},shell);
    assert.equal(retry.status,0);assert.match(retry.stdout,/already stored/);
    assert.deepEqual(box.list(box.backups).filter(name=>name.startsWith('.')),[],'no temporary file is left');
    // tomorrow (UTC) is still accepted: the Mac's day in Zurich can be a day ahead of UTC late in the evening
    assert.equal(box.run(`backup ${dayFromNow(1)} ${sha(data)}`,data,{},shell).status,0);
  });
}

// ---- stand-ins for ssh (talks to the real drop.sh, or fails on request) -------------------------------------------------------------------

function fakeSsh(folder){
  return write(path.join(folder,'fake-ssh'),`#!/bin/sh
echo "$@" >> "$FAKE_SSH_LOG"
for last; do :; done
case "\${FAKE_SSH_MODE:-drop}" in
  timeout) cat > /dev/null; echo "ssh: connect to host: Operation timed out" >&2; exit 255 ;;
  refuse) cat > /dev/null; echo "minitandem-drop: refused for the test" >&2; exit 1 ;;
  capture) cat > "$FAKE_SSH_STDIN"; echo "captured"; exit 0 ;;
  drop) SSH_ORIGINAL_COMMAND="$last" exec sh "${DROP}" ;;
esac
`,0o755);
}
const sshCalls=log=>fs.existsSync(log)?fs.readFileSync(log,'utf8').split('\n').filter(Boolean):[];

// ---- cycle-run.mjs -------------------------------------------------------------------------------------------------------------------------

// A tree like the repository: ops/cycle-run.mjs next to editorial/cycle.mjs, where the stand-in cycle plays one of several parts.
function cycleSandbox(t){
  const folder=tmp(t,'minitandem-cycle-run-');
  for(const file of ['cycle-run.mjs','drop-client.mjs'])fs.copyFileSync(path.join(root,'ops',file),write(path.join(folder,'ops',file),''));
  write(path.join(folder,'editorial','cycle.mjs'),`import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),mode=process.env.FAKE_CYCLE||'ok';
const latest=path.join(here,'workflow-state','cycle','latest.json');
const save=record=>{fs.mkdirSync(path.dirname(latest),{recursive:true});fs.writeFileSync(latest,JSON.stringify({runId:process.env.MINITANDEM_CYCLE_RUN_ID,...record}));};
const started=new Date().toISOString();
console.log('cycle arguments: '+process.argv.slice(2).join(' '));
if(mode==='ok'){save({startedAt:started,daily:true,failedSteps:[],batch:{stopReason:null,jobs:[{card:'card-a',kind:'verify',state:'done'},{card:'card-b',kind:'search',state:'done'}]},approvedUpdates:[{card:'card-a'}],changes:{attention:[],circuitOpened:[],loginUnavailable:[]}});process.exit(0);}
if(mode==='failed'){save({startedAt:started,failedSteps:['sync','report'],batch:{stopReason:'worker-login-unavailable',jobs:[]},
  changes:{attention:[{card:'card-private',error:'PRIVATE QUOTE the place said something'}],circuitOpened:[{x:1}],loginUnavailable:['the reason text']}});process.exit(1);}
if(mode==='login'){save({startedAt:started,failedSteps:[],batch:{stopReason:'worker-login-unavailable',jobs:[]},changes:{attention:[],circuitOpened:[],loginUnavailable:['not logged in']}});process.exit(0);}
if(mode==='blocked'){save({startedAt:started,blocked:'Codex schedules are active: automation'});process.exit(1);}
if(mode==='paused'){save({startedAt:started,skipped:'paused by editorial/cycle.pause'});process.exit(0);}
if(mode==='crash'){process.exit(3);}
if(mode==='stale'){save({runId:'earlier-run',startedAt:'2020-01-01T00:00:00.000Z',failedSteps:['old']});process.exit(0);}
if(mode==='silent'){process.exit(0);}
if(mode==='other-run'){save({runId:'an-overlapping-run',startedAt:started,failedSteps:[],batch:{jobs:[]}});process.exit(0);}
if(mode==='garbage'){fs.mkdirSync(path.dirname(latest),{recursive:true});fs.writeFileSync(latest,'{"runId":');process.exit(0);}
if(mode==='busy'){save({startedAt:started,skipped:'another cycle is still running'});process.exit(0);}
if(mode==='echo-env'){console.log('run id: '+process.env.MINITANDEM_CYCLE_RUN_ID);save({startedAt:started,failedSteps:[]});process.exit(0);}
`);
  const env={PATH:process.env.PATH,HOME:folder,MINITANDEM_DROP_SSH:fakeSsh(folder),MINITANDEM_DROP_KEY:path.join(folder,'key'),
    MINITANDEM_DROP_RETRY_DELAYS_MS:'0,0',FAKE_SSH_LOG:path.join(folder,'ssh.log'),FAKE_SSH_STDIN:path.join(folder,'ssh.stdin'),FAKE_SSH_MODE:'capture'};
  const run=(extra={},args=[])=>spawnSync(process.execPath,[path.join(folder,'ops','cycle-run.mjs'),...args],{env:{...env,...extra},encoding:'utf8'});
  const heartbeat=()=>JSON.parse(fs.readFileSync(env.FAKE_SSH_STDIN,'utf8'));
  return {folder,env,run,heartbeat,calls:()=>sshCalls(env.FAKE_SSH_LOG)};
}

test('cycle-run passes the cycle through (arguments, output, exit code) and sends an ok heartbeat with counts only',t=>{
  const box=cycleSandbox(t);
  const result=box.run({FAKE_CYCLE:'ok'},['--no-notify']);
  assert.equal(result.status,0);
  assert.match(result.stdout,/cycle arguments: --no-notify/,'the arguments reach the cycle and its output is shown');
  const [call]=box.calls();
  for(const part of ['-i '+box.env.MINITANDEM_DROP_KEY,'IdentitiesOnly=yes','BatchMode=yes','ConnectTimeout=20','ubuntu@179.237.77.144'])assert.ok(call.includes(part),part+' in '+call);
  assert.ok(call.endsWith(' heartbeat'),call);
  const beat=box.heartbeat();
  assert.deepEqual({exit:beat.exit,ok:beat.ok,paused:beat.paused,failedSteps:beat.failedSteps,jobsRun:beat.jobsRun,approvedUpdates:beat.approvedUpdates,daily:beat.daily,record:beat.record},
    {exit:0,ok:true,paused:false,failedSteps:[],jobsRun:2,approvedUpdates:1,daily:true,record:true});
  assert.deepEqual(beat.needsOwner,{count:0,text:''});
  assert.equal(beat.reason,null);assert.match(beat.runId,/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.match(beat.at,/^\d{4}-\d{2}-\d{2}T/);
  assert.ok(fs.readFileSync(box.env.FAKE_SSH_STDIN,'utf8').trim().split('\n').length===1,'one line of JSON');
});

test('cycle-run sends ok:false with the failed steps and what needs the owner, but never card text or quotes, and exits with the cycle\'s code',t=>{
  const box=cycleSandbox(t);
  const result=box.run({FAKE_CYCLE:'failed'});
  assert.equal(result.status,1);
  const raw=fs.readFileSync(box.env.FAKE_SSH_STDIN,'utf8'),beat=JSON.parse(raw);
  assert.equal(beat.ok,false);assert.equal(beat.exit,1);assert.equal(beat.paused,false);
  assert.deepEqual(beat.failedSteps,['sync','report']);
  assert.equal(beat.needsOwner.count,5);
  assert.match(beat.needsOwner.text,/failed steps: sync, report/);
  assert.match(beat.needsOwner.text,/attention: card-private/);
  assert.match(beat.needsOwner.text,/circuit breaker opened/);
  assert.match(beat.needsOwner.text,/Claude login unavailable/);
  assert.match(beat.needsOwner.text,/batch stopped: worker-login-unavailable/);
  assert.doesNotMatch(raw,/PRIVATE QUOTE|the place said|the reason text/);
  const blocked=box.run({FAKE_CYCLE:'blocked'});
  assert.equal(blocked.status,1);
  assert.match(box.heartbeat().needsOwner.text,/blocked: Codex schedules are active: automation/);
});

test('cycle-run reports ok:false when the cycle exits with 0 but says it needs the owner (a batch lost to a missing login)',t=>{
  const box=cycleSandbox(t);
  assert.equal(box.run({FAKE_CYCLE:'login'}).status,0,'the exit code is still the cycle\'s');
  const beat=box.heartbeat();
  assert.equal(beat.exit,0);assert.equal(beat.ok,false);assert.deepEqual(beat.failedSteps,[]);
  assert.equal(beat.needsOwner.count,2);assert.match(beat.needsOwner.text,/Claude login unavailable; batch stopped: worker-login-unavailable/);
});

test('cycle-run reports a pause as alive (paused:true, ok:true, reason null) and a skip because another cycle runs as a skip, not as work',t=>{
  const box=cycleSandbox(t);
  assert.equal(box.run({FAKE_CYCLE:'paused'}).status,0);
  const beat=box.heartbeat();
  assert.equal(beat.paused,true);assert.equal(beat.ok,true);assert.equal(beat.reason,null);assert.equal(beat.exit,0);assert.match(beat.skipped,/^paused/);assert.equal(beat.record,true);
  assert.equal(box.run({FAKE_CYCLE:'busy'}).status,0);
  const busy=box.heartbeat();
  assert.equal(busy.paused,false);assert.equal(busy.ok,true);assert.equal(busy.reason,null);assert.equal(busy.skipped,'another cycle is still running');assert.equal(busy.record,true);
});

test('cycle-run never reports success for a run without its own receipt: missing, earlier, unreadable or written by an overlapping run',t=>{
  const box=cycleSandbox(t);
  for(const mode of ['silent','stale','other-run','garbage']){
    const result=box.run({FAKE_CYCLE:mode});
    assert.equal(result.status,0,mode+': the exit code is still the cycle\'s');
    const beat=box.heartbeat();
    assert.equal(beat.ok,false,mode);assert.equal(beat.reason,'no-receipt',mode);assert.equal(beat.exit,0,mode);assert.equal(beat.record,false,mode);
    assert.equal(beat.paused,false,mode);assert.equal(beat.skipped,null,mode);assert.deepEqual(beat.failedSteps,[],'the receipt of another run is not read: '+mode);
    assert.match(beat.runId,/^[0-9a-f-]{36}$/,mode);
    assert.match(result.stderr,/left no receipt of run [0-9a-f-]{36}/,mode);
  }
  // a cycle that dies without a receipt: the exit code is the reason
  assert.equal(box.run({FAKE_CYCLE:'crash'}).status,3,'the exit code of the cycle is the exit code of cycle-run');
  const crashed=box.heartbeat();
  assert.equal(crashed.ok,false);assert.equal(crashed.exit,3);assert.equal(crashed.reason,'exit');assert.equal(crashed.record,false);
});

test('cycle-run gives every invocation its own run id, hands it to the cycle and sends it in the heartbeat',t=>{
  const box=cycleSandbox(t);
  const first=box.run({FAKE_CYCLE:'echo-env'}),beatOne=box.heartbeat();
  assert.equal(first.stdout.match(/run id: (\S+)/)[1],beatOne.runId,'the cycle got the id the heartbeat carries');
  assert.equal(beatOne.ok,true);assert.equal(beatOne.record,true);
  box.run({FAKE_CYCLE:'echo-env'});
  assert.notEqual(box.heartbeat().runId,beatOne.runId);
  // the receipt of the first invocation, still on disk, does not stand in for the second one
  const latest=path.join(box.folder,'editorial','workflow-state','cycle','latest.json');
  const earlier=fs.readFileSync(latest,'utf8');
  box.run({FAKE_CYCLE:'silent'});
  assert.equal(fs.readFileSync(latest,'utf8'),earlier);
  assert.equal(box.heartbeat().reason,'no-receipt');
});

test('cycle-run survives ssh failures: retries a dead connection, does not retry a refusal, never changes the exit code',t=>{
  const box=cycleSandbox(t);
  for(const code of ['ok','failed']){
    fs.writeFileSync(box.env.FAKE_SSH_LOG,'');
    const dead=box.run({FAKE_CYCLE:code,FAKE_SSH_MODE:'timeout'});
    assert.equal(dead.status,code==='ok'?0:1,'exit code of the cycle');
    assert.equal(box.calls().length,3,'one attempt and two retries');
    assert.match(dead.stderr,/heartbeat NOT sent after 3 attempt\(s\): ssh status 255/);
  }
  fs.writeFileSync(box.env.FAKE_SSH_LOG,'');
  const refused=box.run({FAKE_CYCLE:'ok',FAKE_SSH_MODE:'refuse'});
  assert.equal(refused.status,0);assert.equal(box.calls().length,1);
  assert.match(refused.stderr,/heartbeat NOT sent after 1 attempt/);
  // no ssh program at all
  const missing=box.run({FAKE_CYCLE:'ok',MINITANDEM_DROP_SSH:path.join(box.folder,'does-not-exist')});
  assert.equal(missing.status,0);assert.match(missing.stderr,/heartbeat NOT sent/);
});

test('cycle-run sends nothing for --status and --dry-run, which do not run a cycle',t=>{
  const box=cycleSandbox(t);
  assert.equal(box.run({FAKE_CYCLE:'ok'},['--status']).status,0);
  assert.equal(box.run({FAKE_CYCLE:'ok'},['--dry-run']).status,0);
  assert.deepEqual(box.calls(),[]);
});

test('buildHeartbeat: ok only with the receipt of this very run; a missing, earlier or foreign receipt, and a missing run id, are never success',()=>{
  const startedMs=Date.parse('2026-10-15T10:00:00Z'),now=new Date('2026-10-15T10:01:00Z');
  const make=over=>buildHeartbeat({exit:0,startedMs,now,runId:'run-a',record:{runId:'run-a',startedAt:'2026-10-15T10:00:01Z',failedSteps:[],batch:{jobs:[{card:'c1'}]}},...over});
  const good=make();
  assert.deepEqual({ok:good.ok,reason:good.reason,record:good.record,runId:good.runId,jobsRun:good.jobsRun,seconds:good.seconds},{ok:true,reason:null,record:true,runId:'run-a',jobsRun:1,seconds:60});
  for(const [name,beat] of Object.entries({
    missing:make({record:null}),
    'earlier run':make({record:{runId:'run-0',startedAt:'2026-10-15T10:00:30Z',failedSteps:[]}}),
    'no run id in the receipt':make({record:{startedAt:'2026-10-15T10:00:30Z',failedSteps:[]}}),
    'no run id given':make({runId:null}),
    'no run id at all':make({runId:undefined,record:{startedAt:'2026-10-15T10:00:30Z'}}),
    'empty run id on both sides':make({runId:'',record:{runId:'',startedAt:'2026-10-15T10:00:30Z'}})
  })){
    assert.equal(beat.ok,false,name);assert.equal(beat.reason,'no-receipt',name);assert.equal(beat.record,false,name);assert.equal(beat.jobsRun,0,name);
  }
  // other states keep their meaning
  assert.deepEqual([make({exit:2}).ok,make({exit:2}).reason],[false,'exit']);
  assert.deepEqual([make({exit:2,record:null}).ok,make({exit:2,record:null}).reason],[false,'exit']);
  const owner=make({record:{runId:'run-a',startedAt:'2026-10-15T10:00:01Z',failedSteps:['sync']}});
  assert.deepEqual([owner.ok,owner.reason,owner.needsOwner.count],[false,'needs-owner',1]);
  const paused=make({record:{runId:'run-a',startedAt:'2026-10-15T10:00:01Z',skipped:'paused by editorial/cycle.pause'}});
  assert.deepEqual([paused.ok,paused.reason,paused.paused,paused.skipped],[true,null,true,'paused by editorial/cycle.pause']);
  const busy=make({record:{runId:'run-a',startedAt:'2026-10-15T10:00:01Z',skipped:'another cycle is still running'}});
  assert.deepEqual([busy.ok,busy.reason,busy.paused,busy.skipped],[true,null,false,'another cycle is still running']);
  // the heartbeat stays small: counts, ids and short codes
  assert.ok(JSON.stringify(good).length<500,JSON.stringify(good));
});

test('buildHeartbeat keeps the text plain and short',()=>{
  const beat=buildHeartbeat({exit:1,runId:'run-1',startedMs:Date.now()-5000,record:{runId:'run-1',startedAt:new Date().toISOString(),blocked:'quote "x" \\ <b>\n é'+'y'.repeat(500),failedSteps:['a"b']}});
  const raw=JSON.stringify(beat);
  assert.ok(raw.length<1500);
  assert.doesNotMatch(beat.needsOwner.text,/["\\<>\né]/);
  assert.ok(beat.needsOwner.text.length<=300);
});

// ---- editorial-offsite.mjs -----------------------------------------------------------------------------------------------------------------

function offsiteSandbox(t){
  const folder=tmp(t,'minitandem-offsite-'),staging=tmp(t,'minitandem-offsite-staging-');
  for(const file of ['editorial-offsite.mjs','drop-client.mjs'])fs.copyFileSync(path.join(root,'ops',file),write(path.join(folder,'ops',file),''));
  fs.copyFileSync(path.join(root,'editorial','process-lock.mjs'),write(path.join(folder,'editorial','process-lock.mjs'),''));
  // editorial/backup.mjs as the pipeline has it, reduced to the commands the script uses
  write(path.join(folder,'editorial','backup.mjs'),`import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const [command,target]=process.argv.slice(2),directory=target?.startsWith('--to=')?target.slice(5):target;
if(process.env.FAKE_FAIL===command){console.error('Wait for active workers before taking a consistent backup');process.exit(1);}
if(command==='create'&&process.env.FAKE_LOCK_PROBE)fs.copyFileSync(path.join(process.env.MINITANDEM_OFFSITE_STAGING,'.offsite.lock'),process.env.FAKE_LOCK_PROBE);
if(command==='create'){fs.mkdirSync(path.join(directory,'project','editorial'),{recursive:true});
  fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify({schema:1,id:crypto.randomUUID()}));fs.writeFileSync(path.join(directory,'jobs.sqlite'),'queue');
  fs.writeFileSync(path.join(directory,'project','editorial','approved-updates.json'),'{"updates":[]}');console.log('{"destination":"'+directory+'"}');}
else if(command==='verify'){if(!fs.existsSync(path.join(directory,'manifest.json'))){console.error('Invalid backup');process.exit(1);}console.log('{}');}
else{console.error('unexpected command '+command);process.exit(2);}
`);
  const env={PATH:process.env.PATH,HOME:folder,MINITANDEM_OFFSITE_STAGING:staging,MINITANDEM_DROP_SSH:fakeSsh(folder),MINITANDEM_DROP_KEY:path.join(folder,'key'),
    MINITANDEM_DROP_RETRY_DELAYS_MS:'0',OFFSITE_BACKUP_SCRIPT:path.join(folder,'editorial','backup.mjs'),
    FAKE_SSH_LOG:path.join(folder,'ssh.log'),FAKE_SSH_STDIN:path.join(folder,'ssh.stdin'),FAKE_SSH_MODE:'capture'};
  const run=(extra={},args=[`--date=${D0}`])=>spawnSync(process.execPath,[path.join(folder,'ops','editorial-offsite.mjs'),...args],{env:{...env,...extra},encoding:'utf8'});
  return {folder,staging,env,run,calls:()=>sshCalls(env.FAKE_SSH_LOG),left:()=>fs.readdirSync(staging).sort()};
}
const untar=(file,into)=>{fs.mkdirSync(into,{recursive:true});assert.equal(spawnSync('tar',['-xzf',file,'-C',into]).status,0);return into;};

test('editorial-offsite creates, verifies, packs and streams the archive with its checksum, then leaves nothing behind',t=>{
  const box=offsiteSandbox(t);
  const result=box.run();
  assert.equal(result.status,0,result.stderr+result.stdout);
  const [call]=box.calls();
  const match=call.match(/ubuntu@179\.237\.77\.144 backup (\d{4}-\d{2}-\d{2}) ([0-9a-f]{64})$/);
  assert.ok(match,call);assert.equal(match[1],D0);
  for(const part of ['-i '+box.env.MINITANDEM_DROP_KEY,'IdentitiesOnly=yes','BatchMode=yes','ConnectTimeout=20'])assert.ok(call.includes(part),part);
  const sent=fs.readFileSync(box.env.FAKE_SSH_STDIN);
  assert.equal(sha(sent),match[2],'the checksum in the command is the checksum of the bytes that were streamed');
  const archivePath=path.join(box.folder,'sent.tar.gz');fs.writeFileSync(archivePath,sent);
  const unpacked=untar(archivePath,path.join(box.folder,'unpacked'));
  assert.ok(fs.existsSync(path.join(unpacked,D0,'manifest.json')));
  assert.equal(fs.readFileSync(path.join(unpacked,D0,'jobs.sqlite'),'utf8'),'queue');
  assert.ok(fs.existsSync(path.join(unpacked,D0,'project','editorial','approved-updates.json')));
  assert.deepEqual(box.left(),[],'no folder, archive or lock stays on the Mac');
  assert.match(result.stdout,new RegExp('done: '+D0));
});

test('editorial-offsite --dry-run does everything but the upload and keeps the archive',t=>{
  const box=offsiteSandbox(t);
  const result=box.run({},[`--date=${D0}`,'--dry-run']);
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(box.calls(),[],'nothing is sent');
  assert.deepEqual(box.left(),[`editorial-${D0}.tar.gz`],'only the archive is kept, the unpacked folder is gone');
  const file=path.join(box.staging,`editorial-${D0}.tar.gz`),bytes=fs.statSync(file).size;
  assert.match(result.stdout,new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(result.stdout,new RegExp(`${bytes} bytes, sha256 ${sha(fs.readFileSync(file))}`));
});

test('editorial-offsite stops on a failed verify or a failed create, sends nothing and leaves nothing half-written',t=>{
  const box=offsiteSandbox(t);
  for(const [step,message] of [['verify','backup verify'],['create','backup create']]){
    const result=box.run({FAKE_FAIL:step});
    assert.equal(result.status,1,step);
    assert.match(result.stderr,new RegExp(`FAILED at step "${message}"`));
    assert.deepEqual(box.calls(),[],'no upload after a failed '+step);
    assert.deepEqual(box.left(),[],'nothing stays in the staging folder after a failed '+step);
  }
  const dry=box.run({FAKE_FAIL:'verify'},[`--date=${D0}`,'--dry-run']);
  assert.equal(dry.status,1);assert.deepEqual(box.left(),[]);
});

test('editorial-offsite reports a failed upload, tries a dead connection again, does not repeat a refusal and still cleans up',t=>{
  const box=offsiteSandbox(t);
  const dead=box.run({FAKE_SSH_MODE:'timeout'});
  assert.equal(dead.status,1);assert.match(dead.stderr,/FAILED at step "upload": ssh status 255 after 2 attempt\(s\)/);
  assert.equal(box.calls().length,2);assert.deepEqual(box.left(),[]);
  fs.writeFileSync(box.env.FAKE_SSH_LOG,'');
  const refused=box.run({FAKE_SSH_MODE:'refuse'});
  assert.equal(refused.status,1);assert.match(refused.stderr,/ssh status 1 after 1 attempt\(s\).*refused for the test/);
  assert.equal(box.calls().length,1);assert.deepEqual(box.left(),[]);
});

test('editorial-offsite sweeps leftovers of a killed run, refuses a second run at the same time and a staging folder inside the repository',t=>{
  const box=offsiteSandbox(t);
  fs.mkdirSync(path.join(box.staging,'2026-10-14'));fs.writeFileSync(path.join(box.staging,'2026-10-14','x'),'x');
  fs.writeFileSync(path.join(box.staging,'editorial-2026-10-14.tar.gz'),'old');fs.writeFileSync(path.join(box.staging,'editorial-2026-10-15.tar.gz.part'),'half');
  fs.writeFileSync(path.join(box.staging,'keep-me.txt'),'not ours');
  assert.equal(box.run().status,0);
  assert.deepEqual(box.left(),['keep-me.txt'],'only its own leftovers are removed');
  fs.mkdirSync(path.join(box.staging,'.lock'));fs.writeFileSync(path.join(box.staging,'.lock','pid'),String(process.pid));
  const busy=box.run();
  assert.equal(busy.status,1);assert.match(busy.stderr,/another run is active/);
  assert.ok(fs.existsSync(path.join(box.staging,'.lock')),'the other run\'s lock is not touched');
  const inside=box.run({},[`--date=${D0}`,`--staging=${path.join(box.folder,'inside')}`]);
  assert.equal(inside.status,1);assert.match(inside.stderr,/outside the repository/);
});

test('editorial-offsite holds the same kind of lock as the cycle: a file with its pid while it runs, never taken from a live process, taken over from a dead one, an older version\'s directory respected',t=>{
  const box=offsiteSandbox(t),lock=path.join(box.staging,'.offsite.lock'),probe=path.join(box.folder,'lock-during-run.json');
  assert.equal(box.run({FAKE_LOCK_PROBE:probe}).status,0);
  const held=JSON.parse(fs.readFileSync(probe,'utf8'));
  assert.equal(held.schema,1);assert.ok(held.pid>0&&held.pid!==process.pid);assert.match(held.token,/^[0-9a-f-]{36}$/);assert.ok(Date.parse(held.startedAt)>Date.now()-60000);
  assert.deepEqual(box.left(),[],'released at the end, no marker or temporary file left');
  const sent=box.calls().length;
  // a live owner, however long ago it says it started: this run is refused and the lock stays as it was
  const start=processStart(process.pid);   // this test process is the live owner; null only where ps does not exist, then the record is young
  const alive={schema:1,pid:process.pid,token:'0123456789abcdef',startedAt:start?'2020-01-01T00:00:00.000Z':new Date().toISOString(),processStart:start};
  fs.writeFileSync(lock,JSON.stringify(alive)+'\n');
  const busy=box.run();
  assert.equal(busy.status,1);assert.match(busy.stderr,new RegExp(`another run is active \\(pid ${process.pid}\\)`));
  assert.equal(JSON.parse(fs.readFileSync(lock,'utf8')).token,alive.token);assert.equal(box.calls().length,sent,'nothing was sent');
  // an owner that is gone
  const gone=spawnSync(process.execPath,['-e','0']).pid;
  fs.writeFileSync(lock,JSON.stringify({...alive,pid:gone})+'\n');
  assert.equal(box.run().status,0);assert.deepEqual(box.left(),[]);
  // a directory of the older version: a dead owner is cleared, a live one is respected
  fs.mkdirSync(path.join(box.staging,'.lock'));fs.writeFileSync(path.join(box.staging,'.lock','pid'),String(gone));
  assert.equal(box.run().status,0);assert.deepEqual(box.left(),[],'the old directory is gone');
});

// ---- the whole way: cycle-run and editorial-offsite talk to the real drop.sh, cycle-watch reads what it left -----------------------------

function fakeSendmail(folder){
  const mailbox=path.join(folder,'mailbox.txt');
  const program=write(path.join(folder,'fake-sendmail'),`#!/bin/sh\nif [ -f "${folder}/sendmail-fails" ]; then cat >/dev/null; exit 75; fi\ncat >> '${mailbox}'\necho '--- end of mail ---' >> '${mailbox}'\n`,0o755);
  const mails=()=>fs.existsSync(mailbox)?fs.readFileSync(mailbox,'utf8').split('--- end of mail ---').map(part=>part.trim()).filter(Boolean):[];
  return {program,mails,fails:on=>on?fs.writeFileSync(path.join(folder,'sendmail-fails'),''):fs.rmSync(path.join(folder,'sendmail-fails'),{force:true})};
}

function watchSandbox(t,shell='sh'){
  const folder=tmp(t,'minitandem-watch-'),watch=path.join(folder,'watch'),state=path.join(folder,'state');
  fs.mkdirSync(watch,{recursive:true});
  const mail=fakeSendmail(folder);
  const age=(file,seconds,now)=>{const time=now-seconds;fs.utimesSync(file,time,time);};
  const put=(name,text,seconds,now)=>{const file=path.join(watch,name);fs.writeFileSync(file,text);age(file,seconds,now);};
  const run=(now,extra={})=>{
    const result=spawnSync(shell,[WATCH],{encoding:'utf8',env:{PATH:process.env.PATH,HEALTH_MAIL_TO:'owner@example.org',HEALTH_MAIL_FROM:'monitor@example.org',HEALTH_SENDMAIL:mail.program,
      WATCH_DIR:watch,WATCH_STATE_DIR:state,WATCH_NOW:String(now),...extra}});
    return {status:result.status,stdout:result.stdout,stderr:result.stderr};
  };
  return {folder,watch,state,mail,put,age,run};
}
const NOW=1_800_000_000,H=3600;
const RUN='run-0001';
const beat=(over={})=>JSON.stringify(buildHeartbeat({exit:0,runId:RUN,startedMs:Date.now()-1000,record:{runId:RUN,startedAt:new Date().toISOString(),failedSteps:[],batch:{jobs:[]}},...over}))+'\n';
const failedBeat=()=>JSON.stringify(buildHeartbeat({exit:1,runId:RUN,startedMs:Date.now()-1000,record:{runId:RUN,startedAt:new Date().toISOString(),failedSteps:['sync','batch'],
  changes:{attention:[{card:'card-x'}],circuitOpened:[],loginUnavailable:[]}}}))+'\n';
const pausedBeat=()=>JSON.stringify(buildHeartbeat({exit:0,runId:RUN,startedMs:Date.now()-1000,record:{runId:RUN,startedAt:new Date().toISOString(),skipped:'paused by editorial/cycle.pause'}}))+'\n';
const busyBeat=()=>JSON.stringify(buildHeartbeat({exit:0,runId:RUN,startedMs:Date.now()-1000,record:{runId:RUN,startedAt:new Date().toISOString(),skipped:'another cycle is still running'}}))+'\n';
const noReceiptBeat=()=>JSON.stringify(buildHeartbeat({exit:0,runId:RUN,startedMs:Date.now()-1000,record:null}))+'\n';
const subjects=box=>box.mail.mails().map(mail=>mail.match(/^Subject: (.*)$/m)[1]);

for(const shell of SHELLS)test(`cycle-watch (${shell}) sends exactly one mail when the cycle goes silent and one when it is back, and stays quiet otherwise`,t=>{
  const box=watchSandbox(t,shell);
  box.put('heartbeat.json',beat(),H,NOW);box.put('backup.json','{"at":"x","name":"editorial-2026-10-15.tar.gz","bytes":10}\n',H,NOW);
  assert.equal(box.run(NOW).status,0);assert.deepEqual(subjects(box),[],'fresh: no mail');
  box.age(path.join(box.watch,'heartbeat.json'),9*H+1800,NOW);
  assert.equal(box.run(NOW).status,0);assert.deepEqual(subjects(box),[],'the nine-hour night gap is normal');
  box.age(path.join(box.watch,'heartbeat.json'),11*H,NOW);
  assert.equal(box.run(NOW).status,1);assert.deepEqual(subjects(box),['Minitandem editorial: cycle silent']);
  assert.equal(box.run(NOW+1800).status,1);assert.equal(box.run(NOW+3600).status,1);assert.equal(subjects(box).length,1,'still silent: no second mail');
  const [mail]=box.mail.mails();
  assert.match(mail,/^To: owner@example\.org$/m);assert.match(mail,/^From: monitor@example\.org$/m);assert.match(mail,/no heartbeat for 11 hours/);assert.match(mail,/Last heartbeat: /);
  box.put('heartbeat.json',beat(),0,NOW+7200);
  assert.equal(box.run(NOW+7200).status,0);
  assert.deepEqual(subjects(box),['Minitandem editorial: cycle silent','Minitandem editorial: cycle is running again']);
  assert.equal(box.run(NOW+7300).status,0);assert.equal(subjects(box).length,2,'running again: no further mail');
});

for(const shell of SHELLS)test(`cycle-watch (${shell}) sends one mail when the last heartbeat is a failure and one when it succeeds again; a pause is alive and changes nothing`,t=>{
  const box=watchSandbox(t,shell);
  box.put('backup.json','{"at":"x","name":"editorial-2026-10-15.tar.gz","bytes":10}\n',H,NOW);
  box.put('heartbeat.json',beat(),H,NOW);
  assert.equal(box.run(NOW).status,0);assert.deepEqual(subjects(box),[]);
  box.put('heartbeat.json',failedBeat(),H,NOW);
  assert.equal(box.run(NOW).status,1);
  assert.deepEqual(subjects(box),['Minitandem editorial: cycle failed']);
  const [mail]=box.mail.mails();
  assert.match(mail,/Exit code: 1/);assert.match(mail,/Reason: exit: the cycle exited with a non-zero code/);
  assert.match(mail,/Failed steps: sync,batch/);assert.match(mail,/Needs the owner: failed steps: sync, batch; attention: card-x/);
  assert.equal(box.run(NOW+1800).status,1);assert.equal(subjects(box).length,1,'still failing: no second mail');
  box.put('heartbeat.json',pausedBeat(),H,NOW+3600);
  assert.equal(box.run(NOW+3600).status,1);assert.equal(subjects(box).length,1,'a pause neither mails nor clears the open failure');
  box.put('heartbeat.json',beat(),H,NOW+7200);
  assert.equal(box.run(NOW+7200).status,0);
  assert.deepEqual(subjects(box),['Minitandem editorial: cycle failed','Minitandem editorial: cycle works again']);
  // a cycle that exits with 0 but says it needs the owner (a lost batch) is reported with its reason, and the exit code is named as it was
  box.put('heartbeat.json',JSON.stringify(buildHeartbeat({exit:0,runId:RUN,startedMs:Date.now()-1000,record:{runId:RUN,startedAt:new Date().toISOString(),failedSteps:[],
    batch:{stopReason:'worker-login-unavailable',jobs:[]},changes:{attention:[],circuitOpened:[],loginUnavailable:['x']}}}))+'\n',H,NOW+7250);
  assert.equal(box.run(NOW+7250).status,1);
  assert.equal(subjects(box).at(-1),'Minitandem editorial: cycle failed');
  assert.match(box.mail.mails().at(-1),/Exit code: 0/);assert.match(box.mail.mails().at(-1),/Needs the owner: Claude login unavailable; batch stopped: worker-login-unavailable/);
  assert.match(box.mail.mails().at(-1),/Reason: needs-owner: the cycle finished and says itself/);
  // a run skipped because another cycle is running is neither success nor failure: an open failure stays open
  box.put('heartbeat.json',failedBeat(),H,NOW+7260);
  assert.equal(box.run(NOW+7260).status,1);assert.equal(subjects(box).at(-1),'Minitandem editorial: cycle failed');
  const opened=subjects(box).length;
  box.put('heartbeat.json',busyBeat(),H,NOW+7270);
  assert.equal(box.run(NOW+7270).status,1);assert.equal(subjects(box).length,opened,'a skipped run does not clear the failure');
  // a pause that begins from a healthy state sends nothing at all
  box.put('heartbeat.json',beat(),H,NOW+7300);
  assert.equal(box.run(NOW+7300).status,0);assert.equal(subjects(box).at(-1),'Minitandem editorial: cycle works again');
  const count=subjects(box).length;
  box.put('heartbeat.json',pausedBeat(),H,NOW+7400);
  assert.equal(box.run(NOW+7400).status,0);assert.equal(subjects(box).length,count);
  box.put('heartbeat.json',busyBeat(),H,NOW+7500);
  assert.equal(box.run(NOW+7500).status,0);assert.equal(subjects(box).length,count,'nor does a skipped run from a healthy state');
});

for(const shell of SHELLS)test(`cycle-watch (${shell}) names the reason when a cycle exits with 0 but left no receipt of its own run, and treats it like any other failure`,t=>{
  const box=watchSandbox(t,shell);
  box.put('backup.json','{"at":"x","name":"editorial-2026-10-15.tar.gz","bytes":10}\n',H,NOW);
  box.put('heartbeat.json',beat(),H,NOW);
  assert.equal(box.run(NOW).status,0);assert.deepEqual(subjects(box),[]);
  box.put('heartbeat.json',noReceiptBeat(),H,NOW);
  assert.equal(box.run(NOW).status,1);
  assert.deepEqual(subjects(box),['Minitandem editorial: cycle failed']);
  const [mail]=box.mail.mails();
  assert.match(mail,/^Exit code: 0$/m);
  assert.match(mail,/^Reason: no-receipt: the cycle exited with 0 but left no receipt of this run \(editorial\/workflow-state\/cycle\/latest\.json /m);
  assert.match(mail,/^Failed steps: none named$/m);assert.match(mail,/^Needs the owner: nothing named$/m);
  assert.equal(box.run(NOW+1800).status,1);assert.equal(subjects(box).length,1,'still failing: no second mail');
  // a pause is not a missing receipt; it does not clear the failure either
  box.put('heartbeat.json',pausedBeat(),H,NOW+3600);
  assert.equal(box.run(NOW+3600).status,1);assert.equal(subjects(box).length,1);
  box.put('heartbeat.json',beat(),H,NOW+7200);
  assert.equal(box.run(NOW+7200).status,0);
  assert.deepEqual(subjects(box),['Minitandem editorial: cycle failed','Minitandem editorial: cycle works again']);
  // a heartbeat of the older format (no reason field) is still reported, and says so
  box.put('heartbeat.json','{"at":"x","exit":1,"ok":false,"paused":false,"failedSteps":[],"needsOwner":{"count":0,"text":""},"record":false}\n',H,NOW+7300);
  assert.equal(box.run(NOW+7300).status,1);
  assert.match(box.mail.mails().at(-1),/^Reason: not stated \(heartbeat from an older version\)$/m);
  // whatever the field holds, only letters and hyphens reach the mail
  box.put('heartbeat.json',beat(),H,NOW+7350);assert.equal(box.run(NOW+7350).status,0);
  box.put('heartbeat.json','{"at":"x","exit":1,"ok":false,"reason":"x\u001b[31my; rm -rf","failedSteps":[],"needsOwner":{"count":0,"text":""}}\n',H,NOW+7400);
  assert.equal(box.run(NOW+7400).status,1);
  const last=box.mail.mails().at(-1);
  assert.doesNotMatch(last,/\u001b/);assert.match(last,/^Reason: xmyrm-rf$/m);
});

for(const shell of SHELLS)test(`cycle-watch (${shell}) sends one mail when the off-site copy is missing for more than 36 hours and one when it is back`,t=>{
  const box=watchSandbox(t,shell);
  box.put('heartbeat.json',beat(),H,NOW);
  box.put('backup.json','{"at":"2026-10-14T04:50:00Z","name":"editorial-2026-10-14.tar.gz","bytes":123456}\n',30*H,NOW);
  assert.equal(box.run(NOW).status,0);assert.deepEqual(subjects(box),[],'30 hours: one missed morning is tolerated');
  box.age(path.join(box.watch,'backup.json'),37*H,NOW);
  assert.equal(box.run(NOW).status,1);assert.deepEqual(subjects(box),['Minitandem editorial: off-site copy missing']);
  const [mail]=box.mail.mails();
  assert.match(mail,/for 37 hours/);assert.match(mail,/Last archive: editorial-2026-10-14\.tar\.gz \(123456 bytes\)/);
  assert.equal(box.run(NOW+1800).status,1);assert.equal(subjects(box).length,1);
  box.put('backup.json','{"at":"2026-10-16T04:50:00Z","name":"editorial-2026-10-16.tar.gz","bytes":123999}\n',0,NOW+7200);
  box.put('heartbeat.json',beat(),0,NOW+7200);
  assert.equal(box.run(NOW+7200).status,0);
  assert.deepEqual(subjects(box),['Minitandem editorial: off-site copy missing','Minitandem editorial: off-site copy is back']);
});

for(const shell of SHELLS)test(`cycle-watch (${shell}) counts a file that never arrived from its own first run, so installing it early stays quiet until the period has passed`,t=>{
  const box=watchSandbox(t,shell);
  assert.equal(box.run(NOW).status,0);assert.deepEqual(subjects(box),[],'first run, nothing there yet: quiet');
  assert.equal(box.run(NOW+9*H).status,0);assert.deepEqual(subjects(box),[],'nine hours after the first run: still quiet');
  assert.equal(box.run(NOW+10*H+60).status,1);
  assert.deepEqual(subjects(box),['Minitandem editorial: cycle silent'],'ten hours: the cycle is silent, the backup period (36 h) is not over');
  assert.match(box.mail.mails()[0],/No heartbeat has arrived since the watcher started/);
  assert.equal(box.run(NOW+36*H+60).status,1);
  assert.deepEqual(subjects(box),['Minitandem editorial: cycle silent','Minitandem editorial: off-site copy missing']);
  assert.equal(box.run(NOW+40*H).status,1);assert.equal(subjects(box).length,2,'one mail each');
});

for(const shell of SHELLS)test(`cycle-watch (${shell}) does not remember a mail that could not be sent and tries again on the next run; its limits come from the environment`,t=>{
  const box=watchSandbox(t,shell);
  box.put('heartbeat.json',beat(),20*H,NOW);box.put('backup.json','{"name":"a","bytes":1}\n',H,NOW);
  box.mail.fails(true);
  const first=box.run(NOW);
  assert.equal(first.status,2);assert.deepEqual(subjects(box),[]);
  box.mail.fails(false);
  const second=box.run(NOW+60);
  assert.equal(second.status,1);assert.deepEqual(subjects(box),['Minitandem editorial: cycle silent']);
  assert.equal(box.run(NOW+120).status,1);assert.equal(subjects(box).length,1);
  // a longer silent limit makes the same age fine, a shorter one makes a fresh file silent
  const other=watchSandbox(t,shell);
  other.put('heartbeat.json',beat(),20*H,NOW);other.put('backup.json','{"name":"a","bytes":1}\n',H,NOW);
  assert.equal(other.run(NOW,{WATCH_SILENT_HOURS:'24'}).status,0);assert.deepEqual(subjects(other),[]);
  assert.equal(other.run(NOW,{WATCH_SILENT_HOURS:'12'}).status,1);assert.deepEqual(subjects(other),['Minitandem editorial: cycle silent']);
});

for(const shell of SHELLS)test(`cycle-watch (${shell}) ignores what it cannot read as a heartbeat and prints no control characters from it`,t=>{
  const box=watchSandbox(t,shell);
  box.put('backup.json','{"name":"a","bytes":1}\n',H,NOW);
  box.put('heartbeat.json','garbage\n',H,NOW);
  assert.equal(box.run(NOW).status,0);assert.deepEqual(subjects(box),[]);
  box.put('heartbeat.json','{"ok":false,"exit":1,"failedSteps":["x\u001b[31my"],"needsOwner":{"count":1,"text":"bad\u001b[0m"}}\n',H,NOW);
  assert.equal(box.run(NOW).status,1);
  assert.doesNotMatch(box.mail.mails()[0],/\u001b/);
});

test('heartbeat and archive travel the real way: cycle-run and editorial-offsite call drop.sh, cycle-watch reads what it stored',t=>{
  const cycle=cycleSandbox(t),offsite=offsiteSandbox(t),server=tmp(t,'minitandem-server-');
  const shared={FAKE_SSH_MODE:'drop',WATCH_DIR:path.join(server,'watch'),DROP_BACKUP_DIR:path.join(server,'backups')};
  // a heartbeat from a failing cycle
  assert.equal(cycle.run({...shared,FAKE_CYCLE:'failed'}).status,1);
  assert.equal(fs.readFileSync(path.join(shared.WATCH_DIR,'heartbeat.json'),'utf8').trim().split('\n').length,1);
  // an archive
  const result=offsite.run(shared);
  assert.equal(result.status,0,result.stderr);
  const stored=fs.readdirSync(shared.DROP_BACKUP_DIR);
  assert.deepEqual(stored,[`editorial-${D0}.tar.gz`]);
  const unpacked=untar(path.join(shared.DROP_BACKUP_DIR,stored[0]),path.join(server,'unpacked'));
  assert.ok(fs.existsSync(path.join(unpacked,D0,'manifest.json')));
  // the same day twice with a new archive (its bytes differ) is refused by the server and reported by the Mac
  const again=offsite.run(shared);
  assert.equal(again.status,1);assert.match(again.stderr,/never overwritten/);
  assert.deepEqual(offsite.left(),[]);
  // the watcher, run later, reports the failure from that heartbeat and finds the backup fresh
  const mail=fakeSendmail(server);
  const watch=spawnSync('sh',[WATCH],{encoding:'utf8',env:{PATH:process.env.PATH,HEALTH_MAIL_TO:'owner@example.org',HEALTH_SENDMAIL:mail.program,WATCH_DIR:shared.WATCH_DIR,WATCH_STATE_DIR:path.join(server,'state')}});
  assert.equal(watch.status,1,watch.stderr);
  const sent=mail.mails();
  assert.equal(sent.length,1);
  assert.match(sent[0],/Subject: Minitandem editorial: cycle failed/);
  assert.match(sent[0],/Failed steps: sync,report/);assert.match(sent[0],/Exit code: 1/);
  assert.doesNotMatch(sent[0],/PRIVATE QUOTE/);
  assert.match(sent[0],/Reason: exit: the cycle exited with a non-zero code/);
  // a cycle that exits with 0 but leaves no receipt of its own run: the stored heartbeat says so, and so does the next mail
  const watchAgain=()=>spawnSync('sh',[WATCH],{encoding:'utf8',env:{PATH:process.env.PATH,HEALTH_MAIL_TO:'owner@example.org',HEALTH_SENDMAIL:mail.program,WATCH_DIR:shared.WATCH_DIR,WATCH_STATE_DIR:path.join(server,'state')}});
  assert.equal(cycle.run({...shared,FAKE_CYCLE:'ok'}).status,0);
  const recovered=watchAgain();
  assert.equal(recovered.status,0,recovered.stderr);assert.match(mail.mails().at(-1),/Subject: Minitandem editorial: cycle works again/);
  assert.equal(cycle.run({...shared,FAKE_CYCLE:'silent'}).status,0);
  const third=watchAgain();
  assert.equal(third.status,1,third.stderr);
  assert.match(mail.mails().at(-1),/Subject: Minitandem editorial: cycle failed/);
  assert.match(mail.mails().at(-1),/Exit code: 0/);assert.match(mail.mails().at(-1),/Reason: no-receipt: /);
});

// ---- install templates ---------------------------------------------------------------------------------------------------------------------

test('the install templates carry no secret, no personal path and no address, and have the schedules the design names',()=>{
  const plist=fs.readFileSync(path.join(root,'ops','launchd','ch.minitandem.editorial-offsite.plist'),'utf8');
  const service=fs.readFileSync(path.join(root,'ops','systemd','minitandem-cycle-watch.service'),'utf8');
  const timer=fs.readFileSync(path.join(root,'ops','systemd','minitandem-cycle-watch.timer'),'utf8');
  assert.match(plist,/<key>Label<\/key><string>ch\.minitandem\.editorial-offsite<\/string>/);
  assert.match(plist,/<string>\/usr\/local\/bin\/node<\/string>\s*<string>@REPO@\/ops\/editorial-offsite\.mjs<\/string>/);
  assert.match(plist,/<key>Hour<\/key><integer>6<\/integer><key>Minute<\/key><integer>50<\/integer>/);
  assert.match(plist,/<key>TZ<\/key><string>Europe\/Zurich<\/string>/);
  assert.match(plist,/@HOME@\/Library\/Logs\/minitandem-editorial-offsite\.log/);
  assert.doesNotMatch(plist,/\/Users\/|<string>\/bin\/sh<\/string>/);
  assert.match(service,/^ExecStart=\/opt\/minitandem\/ops\/cycle-watch\.sh$/m);
  assert.match(service,/^SuccessExitStatus=0 1$/m);
  assert.match(service,/^Environment=HEALTH_MAIL_TO=EMPFAENGER$/m);
  assert.match(timer,/^OnUnitActiveSec=30min$/m);
  for(const text of [plist,service,timer])assert.doesNotMatch(text,/[\w.+-]+@(?!minitandem\.ch)[\w-]+\.[a-z]{2,}|ssh-ed25519|BEGIN [A-Z ]*PRIVATE KEY/i);
  for(const file of ['drop.sh','cycle-watch.sh'])assert.ok(fs.statSync(path.join(root,'ops',file)).mode&0o111,file+' is executable');
});
