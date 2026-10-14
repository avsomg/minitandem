import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const runFile=promisify(execFile);
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
