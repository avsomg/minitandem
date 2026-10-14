import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {imageMetadata,recognizeImage,imageFile} from './image-evidence.mjs';
import {captureUrl,saveSnapshot,validateSnapshot} from './evidence.mjs';
import {copyWorkerImages,promptFor} from './agent-run.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9sAAAAASUVORK5CYII=','base64');
const options={now:'2026-10-02T14:00:00Z',lookupImpl:async()=>[{address:'93.184.216.34'}],
  fetchImpl:async()=>new Response(png,{headers:{'content-type':'image/png'}}),
  ocrImpl:async(bytes,type)=>({image:imageMetadata(bytes,type),text:'Fixture OCR: Thursday 5 November 2026, 10:00-10:30.'})};

test('image capture records OCR provenance and binds metadata without serializing bytes',async()=>{
  const evidence=await captureUrl('https://example.org/poster.png',options);
  assert.equal(validateSnapshot(evidence),evidence);assert.equal(evidence.parser,'tesseract-eng-poster-v1');
  assert.equal(evidence.image.visualReviewRequired,true);assert.equal(evidence.image.languages,'eng');
  assert.equal(evidence.image.hash,evidence.rawHash);assert.equal(JSON.stringify(evidence).includes(png.toString('base64')),false);
  assert.throws(()=>validateSnapshot({...evidence,image:{...evidence.image,width:2}}),/identity/);
});
test('image headers enforce MIME, format and pixel bounds before OCR',async()=>{
  assert.throws(()=>imageMetadata(png,'image/jpeg'),/MIME mismatch/);
  const huge=Buffer.from(png);huge.writeUInt32BE(10001,16);
  assert.throws(()=>imageMetadata(huge,'image/png'),/pixel limit/);
  let calls=0;
  await assert.rejects(recognizeImage(huge,'image/png',{run:async()=>{calls++;}}),/pixel limit/);assert.equal(calls,0);
});
test('OCR is bounded and cleans its temporary input after failure',async()=>{
  let input;
  await assert.rejects(recognizeImage(png,'image/png',{run:async(command,args,settings)=>{
    assert.equal(command,'tesseract');assert.equal(settings.timeout,20000);assert.equal(settings.env.OMP_THREAD_LIMIT,'1');
    input=args[0];assert.deepEqual(await fs.readFile(input),png);throw Error('OCR unavailable');
  }}),/OCR unavailable/);
  await assert.rejects(fs.stat(input),{code:'ENOENT'});
});
test('original image is immutable, included for independent workers, and checked before reuse',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'minitandem-image-test-')),worker=path.join(directory,'worker');
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));await fs.mkdir(worker);
  const evidence=await captureUrl('https://example.org/poster.png',options);
  await saveSnapshot(directory,evidence);
  const persisted=JSON.parse(JSON.stringify(evidence));await saveSnapshot(directory,persisted);
  const job={id:'job',kind:'verify-facts',input_revision:'revision',payload:{bundle:{claims:[],snapshots:[persisted]},preparedEvidence:[persisted]}};
  const files=copyWorkerImages(job,worker,directory);assert.equal(files.length,1);assert.deepEqual(await fs.readFile(files[0]),png);
  assert.match(promptFor(job),/Inspect the original visually/);
  await fs.writeFile(imageFile(directory,evidence.image),'changed');
  assert.throws(()=>copyWorkerImages(job,worker,directory),/Source image changed/);
  await assert.rejects(saveSnapshot(directory,persisted),/hash mismatch/);
});
