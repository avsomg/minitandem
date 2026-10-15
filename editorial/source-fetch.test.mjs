import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import zlib from 'node:zlib';
import {EventEmitter} from 'node:events';
import {curlResponse,pinnedResponse} from './source-fetch.mjs';

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

// F11. The addresses were checked by the caller; the connection may use those and nothing else. No real DNS, no network: a local server
// stands in for the site, and its name (pinned.test) cannot be resolved by any resolver, so a request that works did not resolve it.
const serve=async handler=>{
  const server=http.createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {server,base:`http://pinned.test:${server.address().port}`};
};
test('pinned transport connects to the checked address only and keeps the host name in the request',async()=>{
  const {server,base}=await serve((req,res)=>{
    if(req.url==='/moved'){res.writeHead(302,{location:'https://other.example.org/'});return res.end('moved');}
    if(req.url==='/gz'){res.writeHead(200,{'content-type':'text/plain','content-encoding':'gzip'});return res.end(zlib.gzipSync('compressed page text'));}
    if(req.url==='/br'){res.writeHead(200,{'content-type':'text/plain','content-encoding':'br'});return res.end(zlib.brotliCompressSync('brotli page text'));}
    if(req.url==='/none'){res.writeHead(204);return res.end();}
    if(req.url==='/odd'){res.writeHead(200,{'content-encoding':'zstd'});return res.end('x');}
    res.writeHead(200,{'content-type':'text/plain','x-seen-host':req.headers.host,'x-seen-encoding':req.headers['accept-encoding']});res.end('plain page text');
  });
  try{
    const checked=[{address:'127.0.0.1',family:4}],request=http.request;
    const plain=await pinnedResponse(base+'/page',checked,{request});
    assert.equal(plain.status,200);assert.equal(await plain.text(),'plain page text');
    assert.equal(plain.headers.get('x-seen-host'),base.slice('http://'.length));assert.match(plain.headers.get('x-seen-encoding'),/gzip/);
    const moved=await pinnedResponse(base+'/moved',checked,{request});
    assert.equal(moved.status,302);assert.equal(moved.headers.get('location'),'https://other.example.org/');
    const gz=await pinnedResponse(base+'/gz',checked,{request});
    assert.equal(await gz.text(),'compressed page text');assert.equal(gz.headers.get('content-encoding'),null);
    assert.equal(await (await pinnedResponse(base+'/br',checked,{request})).text(),'brotli page text');
    const none=await pinnedResponse(base+'/none',checked,{request});assert.equal(none.status,204);assert.equal(none.body,null);
    await assert.rejects(pinnedResponse(base+'/odd',checked,{request}),/content-encoding/);
  }finally{server.close();}
});
test('the connection lookup answers from the checked set, for one host, and never asks a resolver',async()=>{
  let seen;
  const request=(target,options)=>{seen=options;const req=new EventEmitter();req.end=()=>{};return req;};
  const checked=[{address:'93.184.216.34',family:4},{address:'2606:2800:220:1::1',family:6}];
  pinnedResponse('https://Example.org/page',checked,{request});
  const ask=(name,options)=>new Promise(resolve=>seen.lookup(name,options,(...answer)=>resolve(answer)));
  assert.equal(seen.agent,false);assert.equal(seen.method,'GET');
  assert.deepEqual(await ask('example.org',{all:true}),[null,checked]);
  assert.deepEqual(await ask('EXAMPLE.org',{}),[null,'93.184.216.34',4]);
  assert.deepEqual(await ask('example.org',{family:6,all:true}),[null,[checked[1]]]);
  assert.deepEqual(await ask('example.org',{family:'IPv6'}),[null,'2606:2800:220:1::1',6]);
  assert.match((await ask('internal.example.org',{all:true}))[0].message,/another host/);
  await assert.rejects(pinnedResponse('https://example.org/',[],{request}),/No validated source address/);
  // Only IPv4 was checked: an IPv6 connection attempt gets no address.
  pinnedResponse('https://example.org/',[checked[0]],{request});
  assert.match((await ask('example.org',{family:6})).at(0).message,/address family/);
});
test('an aborted request fails instead of hanging',async()=>{
  const {server,base}=await serve(()=>{});
  try{await assert.rejects(pinnedResponse(base+'/slow',[{address:'127.0.0.1',family:4}],{request:http.request,signal:AbortSignal.timeout(100)}));}
  finally{server.closeAllConnections();server.close();}
});
