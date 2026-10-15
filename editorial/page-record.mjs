// The record of a monitor fetch: where it came from and the other texts of the same bytes (editorial/page-records/<source>/<version>.*).
// versions/<source>/<version>.txt stays what it was, the change text whose hash is the version. Beside it, for the fetch that last showed
// that version, the record keeps: fetchedAt, finalUrl, content type, parser, the hash of the raw bytes, the full view (the visible body a
// controller capture of the same page holds; gzip), the alarm lines, and for HTML pages the raw bytes themselves (gzip, at most RAW_STORE_MAX).
// Raw bytes are kept only for HTML: a calendar's full view is its raw text, and a PDF is large and incompressible while its text is the
// evidence. A page whose text changes gets a new version and so a new record; a fetch that shows the same version replaces the files of
// that version, so the disk grows by one record per version and not per run. Private, like versions/ (gitignored, in the audit list).
// Everything here is additive: a source without a record is read as before, from its version text alone.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

export const RECORD_DIR='page-records';
export const RAW_STORE_MAX=1_500_000;
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
export const recordFile=(editorial,id,version,extension='json')=>path.join(editorial,RECORD_DIR,id,`${version}.${extension}`);

async function writeAtomic(file,data){
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temp=`${file}.tmp-${process.pid}`;
  try{await fs.writeFile(temp,data);await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}
}
const readJson=async file=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch{return null;}};

/**
 * Writes the record of one fetch. `info`: {version, hash, fetchedAt, finalUrl, contentType, status, parser:'v1'|'v2', rawHash, rawBytes,
 * raw: Buffer|null, full: {parser,text}|null, alarm: [text]}. The data files go first and the json last, so a json that exists is complete.
 */
export async function writeRecord(editorial,id,info){
  const {version}=info;
  if(!/^[0-9a-f]{12}$/.test(version)||!/^[0-9a-f]{64}$/.test(info.hash??'')||!info.hash.startsWith(version))throw Error('Invalid page record version');
  const earlier=await readJson(recordFile(editorial,id,version));
  const meta={schema:1,source:id,version,hash:info.hash,firstFetchedAt:earlier?.firstFetchedAt??info.fetchedAt,fetchedAt:info.fetchedAt,
    finalUrl:info.finalUrl,contentType:info.contentType,status:info.status,parser:info.parser,
    watchParser:info.parser==='v2'?'monitor-text-v2':'monitor-text-v1',viewParser:info.parser==='v2'?'monitor-view-v2':'monitor-view-v1',
    rawHash:info.rawHash,rawBytes:info.rawBytes,raw:null,full:null,alarm:(info.alarm??[]).slice(0,50)};
  if(info.full?.text){
    await writeAtomic(recordFile(editorial,id,version,'full.txt.gz'),zlib.gzipSync(info.full.text,{level:9}));
    meta.full={parser:info.full.parser,hash:sha(info.full.text),chars:info.full.text.length};
  }else await fs.rm(recordFile(editorial,id,version,'full.txt.gz'),{force:true});
  if(info.raw&&info.raw.length<=RAW_STORE_MAX){
    await writeAtomic(recordFile(editorial,id,version,'raw.gz'),zlib.gzipSync(info.raw,{level:9}));
    meta.raw={file:`${version}.raw.gz`};
  }else await fs.rm(recordFile(editorial,id,version,'raw.gz'),{force:true});
  await writeAtomic(recordFile(editorial,id,version),JSON.stringify(meta,null,2)+'\n');
  return meta;
}

export async function hasRecord(editorial,id,version){
  try{await fs.access(recordFile(editorial,id,version));return true;}catch{return false;}
}

/**
 * Reads a record back: {meta, full: string|null, raw: Buffer|null (only with {raw:true})}. A full view or raw copy that does not match
 * its recorded hash is dropped and named in `problems`; a record that cannot be read at all is null.
 */
export async function readRecord(editorial,id,version,{raw=false}={}){
  const meta=await readJson(recordFile(editorial,id,version));
  if(meta?.schema!==1||meta.version!==version)return null;
  const problems=[];
  let full=null,bytes=null;
  if(meta.full){
    try{full=zlib.gunzipSync(await fs.readFile(recordFile(editorial,id,version,'full.txt.gz'))).toString('utf8');}catch{problems.push('full-missing');}
    if(full!=null&&sha(full)!==meta.full.hash){full=null;problems.push('full-hash-mismatch');}
  }
  if(raw&&meta.raw){
    try{bytes=zlib.gunzipSync(await fs.readFile(recordFile(editorial,id,version,'raw.gz')));}catch{problems.push('raw-missing');}
    if(bytes&&sha(bytes)!==meta.rawHash){bytes=null;problems.push('raw-hash-mismatch');}
  }
  return {meta,full,raw:bytes,problems};
}
