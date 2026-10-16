import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn, spawnSync} from 'node:child_process';
import test from 'node:test';
import {loadStack} from './test-support.mjs';
import {familySyncEnabled} from './features.mjs';

const offEnv = () => { const env = {...process.env}; delete env.MINITANDEM_FAMILY_SYNC; return env; };

test('only an explicit 1 enables family sync', () => {
  for (const value of [undefined, '', '0', 'false', 'true']) assert.equal(familySyncEnabled({MINITANDEM_FAMILY_SYNC:value}), false);
  assert.equal(familySyncEnabled({MINITANDEM_FAMILY_SYNC:'1'}), true);
});
test('default UI has no sync form in any language and stored credentials cause no requests', async () => {
  for (const lang of ['de','fr','en']) {
    const stack = loadStack({lang,local:{'minitandem-sync-v1':{url:'https://family.example.ch',token:'x'.repeat(43),dirty:true}}});
    assert.doesNotMatch(stack.V.data({url:'https://family.example.ch'},true,true).body, /sync-form|sync-key|sync-url|sync-now|sync-disconnect/);
    let calls=0;
    const sync=stack.window.MinitandemSync.create({store:stack.store,fetchFn:async()=>{calls++;throw Error('Unexpected request');},setTimer:()=>{throw Error('Unexpected timer');}});
    sync.init(); sync.queue(); await sync.now(); await sync.flushCorrections();
    assert.equal(sync.config,null);
    assert.throws(()=>sync.connect('https://family.example.ch','x'.repeat(43)),/disabled/);
    await assert.rejects(sync.request('/api/v1/family'),/disabled/);
    assert.equal(calls,0);
    stack.window.MINITANDEM_FEATURES={familySync:true};
    assert.match(stack.V.data(null,true,true).body,/sync-form/);
  }
});

test('default entrypoint creates no family and refuses existing family reads, writes and corrections without changing state', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-off-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const env={...offEnv(),MINITANDEM_STATE_DIR:dir,MINITANDEM_CORRECTION_DIR:path.join(dir,'corrections'),MINITANDEM_HOST:'127.0.0.1'};
  const refused=spawnSync(process.execPath,['server.mjs','new-family'],{env,encoding:'utf8'});
  assert.equal(refused.status,1);assert.match(refused.stderr,/Family sync is disabled/);
  assert.equal(fs.existsSync(path.join(dir,'families.json')),false);
  const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  env.MINITANDEM_PORT=String(listener.address().port);await new Promise(resolve=>listener.close(resolve));
  const base='http://127.0.0.1:'+env.MINITANDEM_PORT;
  async function start() {
    const child=spawn('sh',['docker/entrypoint.sh'],{env,stdio:'ignore'});
    t.after(()=>child.kill());
    for(let i=0;i<200;i++) {try {if((await fetch(base+'/healthz')).ok)return child;}catch{} await new Promise(resolve=>setTimeout(resolve,50));}
    child.kill();throw Error('Entrypoint did not start');
  }
  async function stop(child){const closed=new Promise(resolve=>child.once('close',resolve));child.kill();await closed;}
  let child=await start();
  assert.equal(fs.existsSync(path.join(dir,'families.json')),false);
  assert.equal(fs.existsSync(path.join(dir,'demo-family-key.txt')),false);
  for(const [route,method] of [['family','GET'],['family','PUT'],['family','POST'],['corrections','POST']]){
    const response=await fetch(base+'/api/v1/'+route,{method,headers:{'Content-Type':'application/json'},...(method!=='GET'?{body:'{"profile":{"notes":{"mpe":"private"}}}'}:{})});
    assert.equal(response.status,503);assert.equal((await response.json()).code,'sync.disabled');
  }
  assert.equal(fs.existsSync(path.join(dir,'families.json')),false);
  assert.deepEqual(fs.readdirSync(path.join(dir,'corrections')),[]);
  await stop(child);
  // An existing or damaged family DB must not even be read when sync is off.
  const original='existing family data, deliberately invalid JSON';
  fs.writeFileSync(path.join(dir,'families.json'),original);
  child=await start();
  assert.equal((await fetch(base+'/api/v1/family',{method:'PUT',body:'private'})).status,503);
  assert.equal(fs.readFileSync(path.join(dir,'families.json'),'utf8'),original);
  assert.equal(fs.existsSync(path.join(dir,'demo-family-key.txt')),false);
  await stop(child);
});
