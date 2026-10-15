import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {writeRecord,readRecord,hasRecord,recordFile,RAW_STORE_MAX} from './page-record.mjs';

const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
// Invented page, invented times.
const body=Buffer.from('<html><body><p>Fixture offer every Wednesday.</p></body></html>');
const info=(over={})=>{const hash=sha('watch text one');return {version:hash.slice(0,12),hash,fetchedAt:'2026-10-14T05:00:00.000Z',finalUrl:'https://fixture.example.org/a',
  contentType:'text/html',status:200,parser:'v2',rawHash:sha(body),rawBytes:body.length,raw:body,full:{parser:'cheerio-visible-body-v1',text:'Fixture offer every Wednesday.'},alarm:['Notice line'],...over};};
const withDir=async run=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'page-record-'));try{return await run(dir);}finally{await fs.rm(dir,{recursive:true,force:true});}};

test('a record keeps the provenance, the full view and the raw bytes, and reads back what was written',()=>withDir(async dir=>{
  const written=await writeRecord(dir,'src',info());
  assert.equal(await hasRecord(dir,'src',written.version),true);assert.equal(await hasRecord(dir,'src','000000000000'),false);
  const record=await readRecord(dir,'src',written.version,{raw:true});
  assert.deepEqual(record.problems,[]);assert.equal(record.full,'Fixture offer every Wednesday.');assert.deepEqual(record.raw,body);
  assert.deepEqual({...record.meta},{schema:1,source:'src',version:written.version,hash:info().hash,firstFetchedAt:'2026-10-14T05:00:00.000Z',fetchedAt:'2026-10-14T05:00:00.000Z',
    finalUrl:'https://fixture.example.org/a',contentType:'text/html',status:200,parser:'v2',watchParser:'monitor-text-v2',viewParser:'monitor-view-v2',rawHash:sha(body),rawBytes:body.length,
    raw:{file:written.version+'.raw.gz'},full:{parser:'cheerio-visible-body-v1',hash:sha('Fixture offer every Wednesday.'),chars:30},alarm:['Notice line']});
  // Raw bytes are only read on request.
  assert.equal((await readRecord(dir,'src',written.version)).raw,null);
}));
test('the same version fetched again replaces the files of that version and keeps the first fetch time',()=>withDir(async dir=>{
  const first=await writeRecord(dir,'src',info());
  const later=await writeRecord(dir,'src',info({fetchedAt:'2026-10-21T05:00:00.000Z',full:{parser:'cheerio-visible-body-v1',text:'Fixture offer every Wednesday, now with a banner.'},alarm:[]}));
  assert.equal(later.firstFetchedAt,'2026-10-14T05:00:00.000Z');assert.equal(later.fetchedAt,'2026-10-21T05:00:00.000Z');
  assert.match((await readRecord(dir,'src',first.version)).full,/banner/);
  assert.equal((await fs.readdir(path.join(dir,'page-records','src'))).length,3);
}));
test('a different version is a record of its own and leaves the earlier one alone',()=>withDir(async dir=>{
  const a=await writeRecord(dir,'src',info()),other=sha('watch text two');
  const b=await writeRecord(dir,'src',info({version:other.slice(0,12),hash:other,full:{parser:'cheerio-visible-body-v1',text:'Second version text'}}));
  assert.notEqual(a.version,b.version);assert.equal((await readRecord(dir,'src',a.version)).full,'Fixture offer every Wednesday.');
  assert.equal((await readRecord(dir,'src',b.version)).full,'Second version text');
}));
test('raw bytes of a non-HTML page or above the limit are not kept, and an old copy is removed',()=>withDir(async dir=>{
  const first=await writeRecord(dir,'src',info());
  const second=await writeRecord(dir,'src',info({raw:null}));
  assert.equal(second.raw,null);await assert.rejects(fs.access(recordFile(dir,'src',first.version,'raw.gz')));
  const big=await writeRecord(dir,'src',info({raw:Buffer.alloc(RAW_STORE_MAX+1)}));
  assert.equal(big.raw,null);assert.equal(big.rawBytes,body.length);
  const none=await writeRecord(dir,'src',info({full:null}));
  assert.equal(none.full,null);assert.equal((await readRecord(dir,'src',none.version)).full,null);
}));
test('a copy that does not match its recorded hash is dropped and named',()=>withDir(async dir=>{
  const {version}=await writeRecord(dir,'src',info());
  await fs.writeFile(recordFile(dir,'src',version,'full.txt.gz'),zlib.gzipSync('tampered'));
  await fs.writeFile(recordFile(dir,'src',version,'raw.gz'),zlib.gzipSync('tampered'));
  const record=await readRecord(dir,'src',version,{raw:true});
  assert.equal(record.full,null);assert.equal(record.raw,null);assert.deepEqual(record.problems,['full-hash-mismatch','raw-hash-mismatch']);
  await fs.rm(recordFile(dir,'src',version,'full.txt.gz'));
  assert.deepEqual((await readRecord(dir,'src',version)).problems,['full-missing']);
}));
test('an unreadable or foreign record is no record, and a wrong version cannot be written',()=>withDir(async dir=>{
  assert.equal(await readRecord(dir,'src','abcdefabcdef'),null);
  await fs.mkdir(path.join(dir,'page-records','src'),{recursive:true});
  await fs.writeFile(recordFile(dir,'src','abcdefabcdef'),'not json');assert.equal(await readRecord(dir,'src','abcdefabcdef'),null);
  await fs.writeFile(recordFile(dir,'src','abcdefabcdef'),JSON.stringify({schema:2,version:'abcdefabcdef'}));assert.equal(await readRecord(dir,'src','abcdefabcdef'),null);
  await assert.rejects(writeRecord(dir,'src',info({version:'short'})),/Invalid page record/);
  await assert.rejects(writeRecord(dir,'src',info({version:'ffffffffffff'})),/Invalid page record/);
}));
