// Built-site checks. BROWSER_ENGINE defaults to WebKit for the owner's existing local setup.
import {spawn} from 'node:child_process';
import path from 'node:path';
import {root,serveSite,engineName} from './browser-support.mjs';

const engine=engineName(),fixture=await serveSite();
let failed=false;
try{
  // Layout shift needs Chromium: WebKit has no layout-shift entries.
  for(const file of ['verify-age.mjs','verify-mobile.mjs','verify-accessibility.mjs','verify-text-spacing.mjs','verify-pages.mjs',...engine==='chromium'?['scripts/layout-shift.mjs']:[]]){
    console.log(`\n== ${engine}: ${file}`);
    const status=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[path.join(root,file)],{cwd:root,stdio:'inherit',env:{...process.env,APP_URL:fixture.url},timeout:300000});
      child.once('error',reject);
      child.once('exit',(code,signal)=>resolve({code,signal}));
    });
    if(status.code!==0){console.error(`${file} failed (exit ${status.code}, signal ${status.signal}).`);failed=true;}
  }
}finally{await fixture.close();}
process.exitCode=failed?1:0;
console.log(failed?'\nBrowser checks failed.':'\nBrowser checks passed.');
