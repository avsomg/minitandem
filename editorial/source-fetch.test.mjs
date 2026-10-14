import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {curlResponse} from './source-fetch.mjs';

const url='https://example.org/poster.png',addresses=[{address:'93.184.216.34',family:4}];
test('network fallback pins the checked address, disables proxy and does not follow redirects',async()=>{
  let file;
  const result=await curlResponse(url,addresses,{timeoutMs:1000,maxBytes:100,run:async(command,args,options)=>{
    assert.equal(command,'curl');assert.ok(args.includes('example.org:443:93.184.216.34'));
    assert.equal(args[0],'--disable');assert.ok(Object.keys(options.env).every(key=>['PATH','TMPDIR','LANG','LC_ALL'].includes(key)));
    assert.equal(args[args.indexOf('--noproxy')+1],'*');assert.equal(args.includes('--location'),false);assert.equal(options.timeout,2000);
    file=args[args.indexOf('--output')+1];await fs.writeFile(file,'redirect');
    return {stdout:JSON.stringify({url_effective:url,http_code:302,content_type:'text/plain',redirect_url:'https://other.example.org/poster.png'})};
  }});
  assert.equal(result.method,'curl-pinned-ipv4');assert.equal(result.response.status,302);
  assert.equal(result.response.headers.get('location'),'https://other.example.org/poster.png');
  await assert.rejects(fs.stat(file),{code:'ENOENT'});
});
test('fallback does not fetch without a checked IPv4 address and rejects oversized or substituted responses',async()=>{
  await assert.rejects(curlResponse(url,[{address:'2001:4860::1',family:6}],{timeoutMs:1000,maxBytes:10}),/validated IPv4/);
  for(const bad of ['size','url'])await assert.rejects(curlResponse(url,addresses,{timeoutMs:1000,maxBytes:10,run:async(_,args)=>{
    await fs.writeFile(args[args.indexOf('--output')+1],'x'.repeat(11));
    return {stdout:JSON.stringify({url_effective:bad==='url'?'https://other.example.org/':url,http_code:200,content_type:'text/plain'})};
  }}),bad==='size'?/byte limit/:/provenance/);
});
