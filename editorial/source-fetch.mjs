import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import zlib from 'node:zlib';
import {Readable,pipeline} from 'node:stream';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const runFile=promisify(execFile);
const DECODERS={gzip:zlib.createGunzip,'x-gzip':zlib.createGunzip,deflate:zlib.createInflate,br:zlib.createBrotliDecompress};
const NO_BODY=[204,205,304];
/**
 * The native transport of a capture. The addresses the controller has already checked are the only ones the socket may use: the lookup
 * of the connection answers from them and never asks the resolver again, so a name that resolves publicly for the check and privately
 * for the connection cannot move the connection. The hostname stays in the URL, so the Host header, the TLS server name and the
 * certificate check are those of the real site. Redirects are not followed (the caller checks every hop with its own lookup).
 * Returns a web Response; compressed bodies are decoded, as fetch does.
 */
export function pinnedResponse(url,addresses,{headers={},signal,request=https.request}={}){
  const target=new URL(url),host=target.hostname.toLowerCase().replace(/^\[|\]$/g,'');
  const choices=(addresses||[]).map(({address,family})=>({address,family:family||(String(address).includes(':')?6:4)}));
  if(!choices.length)return Promise.reject(Error('No validated source address'));
  const lookup=(name,options,callback)=>{
    if(typeof options==='function')[options,callback]=[{},options];
    if(String(name).toLowerCase().replace(/^\[|\]$/g,'')!==host)return callback(Error('Pinned lookup refused another host'));
    const want=options?.family==='IPv4'?4:options?.family==='IPv6'?6:Number(options?.family)||0;
    const list=choices.filter(item=>!want||item.family===want);
    if(!list.length)return callback(Error('No validated address for this address family'));
    return options?.all?callback(null,list.map(item=>({...item}))):callback(null,list[0].address,list[0].family);
  };
  return new Promise((resolve,reject)=>{
    const req=request(target,{method:'GET',headers:{'accept-encoding':'gzip, deflate, br',...headers},lookup,agent:false,signal},res=>{
      const encoding=String(res.headers['content-encoding']||'').toLowerCase().trim();
      const decoder=Object.hasOwn(DECODERS,encoding)?DECODERS[encoding]:null;
      if(encoding&&encoding!=='identity'&&!decoder){res.destroy();return reject(Error('Unsupported content-encoding'));}
      const list=new Headers();
      for(const [name,value] of Object.entries(res.headers)){
        if(decoder&&['content-encoding','content-length'].includes(name))continue;
        for(const item of Array.isArray(value)?value:[value])list.append(name,item);
      }
      if(NO_BODY.includes(res.statusCode)){res.resume();return resolve(new Response(null,{status:res.statusCode,statusText:res.statusMessage,headers:list}));}
      const body=decoder?pipeline(res,decoder(),()=>{}):res;
      resolve(new Response(Readable.toWeb(body),{status:res.statusCode,statusText:res.statusMessage,headers:list}));
    });
    req.on('error',reject);
    req.end();
  });
}
export async function curlResponse(url,addresses,{timeoutMs,maxBytes,run=runFile}={}){
  const address=addresses.find(item=>item.family===4)?.address;
  if(!address)throw Error('No validated IPv4 source address for fallback');
  const host=new URL(url).hostname,directory=await fs.mkdtemp(path.join(os.tmpdir(),'minitandem-source-'));
  try{
    const file=path.join(directory,'body');
    const env=Object.fromEntries(['PATH','TMPDIR','LANG','LC_ALL'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
    const {stdout}=await run('curl',['--disable','--silent','--show-error','--ipv4','--noproxy','*','--proto','=https',
      '--resolve',host+':443:'+address,'--max-time',String(timeoutMs/1000),'--max-filesize',String(maxBytes),
      '--user-agent','MinitandemEvidence/1.0 (editorial verification)','--output',file,'--write-out','%{json}',url],
    {timeout:timeoutMs+1000,maxBuffer:100000,env});
    const metadata=JSON.parse(stdout);
    if(metadata.url_effective!==url||!Number.isInteger(metadata.http_code)||metadata.http_code<100||metadata.http_code>599)throw Error('Invalid fallback response provenance');
    const bytes=await fs.readFile(file);if(bytes.length>maxBytes)throw Error('Source exceeds byte limit');
    return {response:new Response([204,205,304].includes(metadata.http_code)?null:bytes,{status:metadata.http_code,
      headers:{'content-type':metadata.content_type||'',...(metadata.redirect_url?{location:metadata.redirect_url}:{})}}),method:'curl-pinned-ipv4'};
  }finally{await fs.rm(directory,{recursive:true,force:true});}
}
