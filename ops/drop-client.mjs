// How the editorial Mac talks to the drop on the server (ops/drop.sh, installed there as /usr/local/sbin/minitandem-drop).
// Shared by cycle-run.mjs (heartbeat) and editorial-offsite.mjs (daily archive). The Mac side is plain Node on purpose:
// a launchd job that starts /bin/sh from ~/Documents can be blocked by macOS privacy protection, a node process is not.
//
// Environment (all optional):
//   MINITANDEM_DROP_HOST    default 179.237.77.144
//   MINITANDEM_DROP_USER    default ubuntu
//   MINITANDEM_DROP_KEY     default ~/.ssh/minitandem_drop_ed25519 (a key without passphrase that the server allows to run the drop and nothing else)
//   MINITANDEM_DROP_SSH     default /usr/bin/ssh
//   MINITANDEM_DROP_RETRY_DELAYS_MS   comma list of waits before each further attempt, default "15000,45000" ("0,0" in tests)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export function dropSettings(env=process.env){
  const home=env.HOME||os.homedir();
  const exists=file=>{try{return fs.existsSync(file);}catch{return false;}};
  return {
    host:env.MINITANDEM_DROP_HOST||'179.237.77.144',
    user:env.MINITANDEM_DROP_USER||'ubuntu',
    key:env.MINITANDEM_DROP_KEY||path.join(home,'.ssh','minitandem_drop_ed25519'),
    ssh:env.MINITANDEM_DROP_SSH||(exists('/usr/bin/ssh')?'/usr/bin/ssh':'ssh')
  };
}

// -F /dev/null: the owner's own ssh configuration (other keys, proxies, shared connections) must not change which key is offered.
// StrictHostKeyChecking=yes with BatchMode: an unknown or changed server key fails instead of asking, so nothing is sent to an impostor.
export function sshArguments(settings,remoteCommand){
  return ['-F','/dev/null','-i',settings.key,'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=20',
    '-o','ServerAliveInterval=30','-o','ServerAliveCountMax=4','-o','StrictHostKeyChecking=yes',
    `${settings.user}@${settings.host}`,remoteCommand];
}

const tail=(text,n=300)=>String(text||'').trim().split('\n').slice(-3).join(' | ').slice(-n);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const retryDelays=(env,fallback)=>{
  const raw=env.MINITANDEM_DROP_RETRY_DELAYS_MS;
  if(raw===undefined||raw==='')return fallback;
  return raw.split(',').map(Number).filter(n=>Number.isFinite(n)&&n>=0);
};

// One ssh call. `input` is a string for stdin; `inputFile` is streamed from disk. Returns {ok,status,stdout,stderr}.
export function runDrop(remoteCommand,{input,inputFile,timeoutMs=60000,env=process.env}={}){
  const settings=dropSettings(env);
  let fd=null;
  try{
    if(inputFile)fd=fs.openSync(inputFile,'r');
    const run=spawnSync(settings.ssh,sshArguments(settings,remoteCommand),{
      encoding:'utf8',timeout:timeoutMs,maxBuffer:1_000_000,
      ...(inputFile?{stdio:[fd,'pipe','pipe']}:{input:input??''})});
    const status=run.error?null:run.status;
    return {ok:status===0,status,stdout:run.stdout||'',
      stderr:tail(run.error?`${run.error.message}${run.stderr?` | ${run.stderr}`:''}`:run.stderr)};
  }catch(error){
    return {ok:false,status:null,stdout:'',stderr:tail(error.message)};
  }finally{if(fd!==null)fs.closeSync(fd);}
}

// A connection that did not come up (ssh status 255, a timeout, a signal) is tried again; an answer from the drop itself
// (status 1: it looked at the request and refused it) is final, because the same request would be refused again.
export async function runDropWithRetry(remoteCommand,options={},fallbackDelays=[15000,45000]){
  const env=options.env||process.env;
  const delays=retryDelays(env,fallbackDelays);
  let result;
  for(let attempt=0;attempt<=delays.length;attempt++){
    result=runDrop(remoteCommand,options);
    result.attempts=attempt+1;
    if(result.ok||(result.status!==null&&result.status!==255))return result;
    if(attempt<delays.length)await sleep(delays[attempt]);
  }
  return result;
}
