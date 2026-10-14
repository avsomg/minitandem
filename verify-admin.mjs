import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

import {loadPlaywright} from './playwright-loader.mjs';
const {webkit}=loadPlaywright();
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-admin-ui-'));
process.env.MINITANDEM_STATE_DIR=path.join(temp,'state');process.env.MINITANDEM_CORRECTION_DIR=path.join(temp,'intake');
const issued=spawnSync(process.execPath,['server.mjs','new-admin'],{encoding:'utf8',env:process.env});assert.equal(issued.status,0,issued.stderr);
const key=issued.stdout.trim(),{createServer}=await import('./server.mjs?admin-ui='+Date.now()),server=createServer();
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port,browser=await webkit.launch();
const directory=path.resolve('editorial/typesafe-runtime');fs.mkdirSync(directory,{recursive:true});
const baseline=process.argv.includes('--baseline');
try{
  for(const [name,viewport,isMobile] of [['iphone15',{width:393,height:852},true],['desktop',{width:1440,height:1000},false]]){
    const context=await browser.newContext({viewport,isMobile,hasTouch:isMobile}),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/admin');await page.locator('#key').fill(key);await page.locator('#access button').click();
    await page.waitForFunction(()=>!document.querySelector('#dashboard').hidden);
    if(!baseline){
      await page.waitForFunction(()=>document.querySelector('#operations-summary').textContent.includes('updated'));
      assert.equal(await page.locator('#logout').isVisible(),true);
      await page.locator('#refresh').click();await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);
      await page.route('**/api/v1/admin/operations',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'The queue is temporarily unavailable'})}));
      await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('#operations-message').textContent.includes('unavailable'));
      assert.equal(await page.locator('#quality article').count()>0,true,'Optional operations failure must not hide catalogue quality');
      await page.unroute('**/api/v1/admin/operations');await page.locator('#refresh').click();
      await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(directory,`${name}-admin-${baseline?'before':'after'}.png`)});
    if(!baseline){
      await page.locator('#logout').click();assert.equal(await page.locator('#dashboard').isVisible(),false);
      assert.equal(await page.evaluate(()=>sessionStorage.getItem('minitandem-editor-key')),null);
      await page.locator('#key').fill('invalid-editor-key');await page.locator('#access button').click();
      await page.waitForFunction(()=>document.querySelector('#message').textContent.length>0);assert.equal(await page.locator('#dashboard').isVisible(),false);
    }
    await context.close();
  }
  console.log(JSON.stringify({result:'PASS',engine:'WebKit',viewports:['iPhone 15 emulation','desktop'],baseline,screenshots:directory}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}
