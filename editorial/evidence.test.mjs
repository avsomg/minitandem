import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {snapshot,validateSnapshot,locateQuote,evidenceProblem,publicUrl,captureUrl,htmlText,saveSnapshot,hash,MAX_PDF_BYTES,monitorSnapshot} from './evidence.mjs';

const now='2026-10-01T10:00:00Z';
const sample=()=>snapshot({url:'https://example.org/course',fetchedAt:now,text:'Kinder ab 3 Jahren. Teilnahme mit einer Bezugsperson. Anmeldung erforderlich.'});

test('HTML parser decodes entities and preserves table field boundaries',()=>{
  const text=htmlText(Buffer.from('<body><nav>menu</nav><script>secret()</script><p>Enfants d&egrave;s 6 mois</p><table><tr><td>PE2</td><td>2 &agrave; 4 ans</td><td>CHF 250</td></tr></table></body>'));
  assert.match(text,/Enfants dès 6 mois/);
  assert.match(text,/PE2\n2 à 4 ans\nCHF 250/);
  assert.doesNotMatch(text,/secret|menu/);
});
test('snapshots bind exact content, URL, project and retrieval instant',()=>{
  const evidence=sample();assert.equal(validateSnapshot(evidence),evidence);
  assert.throws(()=>validateSnapshot({...evidence,text:evidence.text+' change'}));
  assert.throws(()=>validateSnapshot({...evidence,url:'https://example.org/other'}));
  assert.throws(()=>validateSnapshot({...evidence,project:'angeline'}));
  assert.throws(()=>snapshot({...evidence,fetchedAt:'2026-10-01'}));
});
test('quote validation tolerates whitespace, not invented or paraphrased words',()=>{
  assert.ok(locateQuote(sample(),'Kinder  ab\n3 Jahren.'));
  assert.equal(locateQuote(sample(),'Kinder ab 2 Jahren.'),null);
  assert.equal(locateQuote(sample(),''),null);
});
test('stale and future evidence cannot be presented as a current check',()=>{
  assert.equal(evidenceProblem(sample(),'2026-10-02T10:00:00Z',7),null);
  assert.equal(evidenceProblem(sample(),'2026-10-09T10:00:00Z',7),'stale-evidence');
  assert.equal(evidenceProblem(sample(),'2026-09-30T10:00:00Z',7),'future-evidence');
});
test('source fetches reject credentials, local addresses and unsafe redirects',async()=>{
  for(const url of ['http://example.org','https://localhost','https://127.0.0.1','https://[::1]','https://x.local','https://user:pass@example.org'])assert.throws(()=>publicUrl(url));
  let calls=0;
  await assert.rejects(captureUrl('https://example.org',{lookupImpl:async()=>[{address:'10.0.0.4'}],fetchImpl:async()=>{calls++;}}),/non-public/);
  assert.equal(calls,0);
  await assert.rejects(captureUrl('https://example.org',{lookupImpl:async()=>[{address:'93.184.216.34'}],fetchImpl:async()=>new Response('',{status:302,headers:{location:'https://localhost/private'}})}),/Non-public/);
});
test('capture keeps provenance and blocks unsupported or oversized responses',async()=>{
  const options={now,lookupImpl:async()=>[{address:'93.184.216.34'}]};
  const evidence=await captureUrl('https://example.org',{...options,fetchImpl:async()=>new Response('<body><p>Children participate with a parent.</p></body>',{headers:{'content-type':'text/html'}})});
  assert.equal(evidence.parser,'cheerio-visible-body-v1');assert.equal(evidence.textHash,hash(evidence.text));
  await assert.rejects(captureUrl('https://example.org',{...options,fetchImpl:async()=>new Response('image',{headers:{'content-type':'image/gif'}})}),/Unsupported/);
  await assert.rejects(captureUrl('https://example.org',{...options,maxBytes:10,fetchImpl:async()=>new Response('a'.repeat(20),{headers:{'content-type':'text/plain'}})}),/byte limit/);
});
test('evidence snapshots are immutable',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'minitandem-evidence-test-'));
  try{const file=await saveSnapshot(directory,sample());await saveSnapshot(directory,sample());assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),sample());}
  finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('large official PDFs use a bounded separate limit without relaxing HTML limits',async()=>{
  const options={now,lookupImpl:async()=>[{address:'93.184.216.34'}]};
  const bytes=Buffer.alloc(6_000_001);bytes.write('%PDF-1.7');
  const evidence=await captureUrl('https://example.org/programme.pdf',{...options,
    fetchImpl:async()=>new Response(bytes,{headers:{'content-type':'application/pdf'}}),
    pdfImpl:async input=>{assert.equal(input.length,bytes.length);return 'Full programme text: all activities are free.';}});
  assert.equal(evidence.parser,'pdftotext-layout-v1');assert.equal(evidence.rawHash,hash(bytes));
  await assert.rejects(captureUrl('https://example.org/programme.pdf',{...options,
    fetchImpl:async()=>new Response(null,{headers:{'content-type':'application/pdf','content-length':String(MAX_PDF_BYTES+1)}}),
    pdfImpl:async()=>{throw Error('Oversized PDF must never reach the parser');}}),/byte limit/);
  await assert.rejects(captureUrl('https://example.org',{...options,
    fetchImpl:async()=>new Response(null,{headers:{'content-type':'text/html','content-length':'2000001'}})}),/byte limit/);
});

test('monitor snapshots are labelled by the parser that produced the stored text',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'monitor-snap-'));
  const text='Open every Saturday from nine to noon for families.';
  const h=hash(text);
  await fs.mkdir(path.join(dir,'versions','s1'),{recursive:true});
  await fs.writeFile(path.join(dir,'versions','s1',h.slice(0,12)+'.txt'),text+'\n');
  const source={id:'s1',url:'https://example.org/p'};
  const entry={hash:h,lastSuccess:'2026-10-01T10:00:00.000Z'};
  assert.equal((await monitorSnapshot(source,entry,dir)).parser,'monitor-text-v1');
  assert.equal((await monitorSnapshot(source,{...entry,parser:'v2'},dir)).parser,'monitor-text-v2');
});
