import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('./admin.js',import.meta.url),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setup(){
  const nodes=new Map(),storage=new Map([['minitandem-editor-key','test-key']]),requests=[];
  const node=selector=>{
    if(!nodes.has(selector))nodes.set(selector,{hidden:selector==='#dashboard',disabled:false,value:'',textContent:'',
      handlers:{},addEventListener(kind,handler){this.handlers[kind]=handler;},focus(){}});
    return nodes.get(selector);
  };
  vm.runInNewContext(source,{document:{querySelector:node},window:{},Intl,Date,DOMException,AbortSignal,
    sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    fetch:()=>new Promise((resolve,reject)=>requests.push({resolve,reject}))});
  return {node,storage,requests};
}
test('a late authenticated response cannot restore the dashboard or key after logout',async()=>{
  const {node,storage,requests}=setup();assert.equal(requests.length,1);
  node('#logout').handlers.click();
  requests[0].resolve({ok:true,json:async()=>({})});await flush();
  assert.equal(node('#dashboard').hidden,true);assert.equal(node('#access').hidden,false);
  assert.equal(storage.has('minitandem-editor-key'),false);assert.equal(node('#message').textContent,'');
});
test('an old failed request cannot overwrite a new sign-in state',async()=>{
  const {node,requests}=setup();node('#logout').handlers.click();
  node('#key').value='new-test-key';node('#access').handlers.submit({preventDefault(){}});
  assert.equal(requests.length,2);assert.equal(node('#access button').disabled,true);
  requests[0].reject(Error('Old failure'));await flush();
  assert.equal(node('#access button').disabled,true);assert.notEqual(node('#message').textContent,'Old failure');
  requests[1].resolve({ok:false,json:async()=>({error:'New failure'})});await flush();
  assert.equal(node('#message').textContent,'New failure');assert.equal(node('#access button').disabled,false);
});
