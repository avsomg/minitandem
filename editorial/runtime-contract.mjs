import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {digest} from './jobs.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
export function runtimeContractRevision(base=here){
  const files={};
  for(const name of fs.readdirSync(base).sort()){
    if(name.endsWith('.mjs')&&!name.endsWith('.test.mjs')||
      ['agent-policy.json','agent-output.schema.json','package.json','package-lock.json'].includes(name)){
      files[name]=digest(fs.readFileSync(path.join(base,name)).toString('base64'));
    }
  }
  return digest(files);
}
export function assertRuntimeCurrent(expected,base=here){
  if(runtimeContractRevision(base)!==expected)throw Error('Editorial runtime changed; restart the controller');
}
