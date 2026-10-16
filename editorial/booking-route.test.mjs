import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {snapshot} from './evidence.mjs';
import {PRIVATE} from './public-audit.mjs';
import {loadInputs,selectSample,compose,decide,proseConflicts,admission,extractPrompt,checkPrompt,mutations,metrics,planRun,runExperiment,argumentsFor,PHRASES} from './experiments/booking-route.mjs';
const hash=text=>createHash('sha256').update(text).digest('hex');
const answer=(value,id='s0')=>({status:value===null?'unknown':'supported',value,sourceId:id,scope:'exact-card',quote:value===null?'':value?'Registration is required for Little Oaks.':'No registration required for Little Oaks.',note:''});
const usage={input_tokens:100,output_tokens:20};
function fixture(t,count=40){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'booking-route-test-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const cards=[],sources=[],labels=[],baseline=[],answers=[];
  for(let i=0;i<count;i++){
    const value=i%3===2?null:i%3===0,quote=value===null?'':value?`Registration is required for Little Oaks ${i}.`:`No registration required for Little Oaks ${i}.`;
    const card={id:`oaks-${i}`,name:`Little Oaks ${i}`,status:'active',format:'event',practical:{booking:{value:i===0?false:value}},notes:i===3?['No registration required for this offer.']:[],research:{findings:[]}};
    const text=`Little Oaks ${i}\n${quote||'Booking conditions are not published.'}\nSessions for families.`,file=path.join(dir,`source-${i}.txt`);fs.writeFileSync(file,text);
    cards.push(card);sources.push({id:`s${i}`,cardId:card.id,path:file,origin:'monitor-copy',kind:'official',scope:'exact-card',url:`https://example.org/oaks-${i}`});
    labels.push({cardId:card.id,value,quote,sourceId:`s${i}`,proseConflict:i===3});
    baseline.push({cardId:card.id,value,verdict:value===null||i===3?'await-source':'approve',tokens:100000,seconds:120});
    answers.push({status:value===null?'unknown':'supported',value,sourceId:`s${i}`,scope:'exact-card',quote,note:''});
  }
  const write=(file,data)=>{fs.writeFileSync(path.join(dir,file),JSON.stringify(data));return path.join(dir,file);};
  const files={cards:write('cards.json',cards),sources:write('sources.json',sources),labels:write('labels.json',labels),baseline:write('baseline.json',baseline)};
  return {dir,files,answers,input:loadInputs(files)};
}
function recorded(f,{rubberStamp=false}={}){
  return async request=>{
    const extract=request.model==='haiku',id=JSON.parse(request.prompt.split(extract?'CARD IDENTITY: ':'CARD: ')[1].split('\n')[0]).id,index=Number(id.split('-')[1]);
    let result;
    if(extract)result=f.answers[index];
    else if(rubberStamp)result={verdict:'approve',reason:'recorded rubber stamp',quoteSeen:true};
    else {
      const pkg=JSON.parse(request.prompt.split('PACKAGE: ')[1].split('\nSAVED TEXTS:')[0]);
      const original=f.answers[index],invalid=pkg.after!==original.value||pkg.quote!==original.quote||!pkg.quote||pkg.proseConflicts.length;
      result={verdict:invalid?'reject':'approve',reason:'recorded fixture verdict',quoteSeen:Boolean(pkg.quote)&&pkg.quote===original.quote};
      if(!pkg.quote&&pkg.after===null)result={verdict:'await-source',reason:'not published',quoteSeen:false};
    }
    return {answer:structuredClone(result),usage:{...usage},seconds:0.2};
  };
}
test('sample is stable across input order; baselines and calibration are pinned, holdouts stay out',t=>{
  const {input}=fixture(t,45);input.baseline=input.baseline.slice(0,2);input.includeIds=['oaks-2'];input.holdoutIds=['oaks-3'];
  const one=selectSample(input,{seed:'test'}).map(c=>c.id),two=selectSample({...input,cards:[...input.cards].reverse(),sources:[...input.sources].reverse()},{seed:'test'}).map(c=>c.id);
  assert.equal(one.length,40);assert.deepEqual(one,two);assert.deepEqual(one.slice(0,3),['oaks-0','oaks-1','oaks-2']);assert.ok(!one.includes('oaks-3'));
  assert.notDeepEqual(one,selectSample(input,{seed:'other'}).map(c=>c.id));
  assert.throws(()=>selectSample({...input,holdoutIds:['oaks-0']}),/holdouts/);
});
test('capture identity and hash are validated; plain text retains monitor provenance',t=>{
  const f=fixture(t,1),source=f.input.sources[0];assert.equal(source.snapshotId,null);assert.equal(source.textHash,hash(source.text));
  const captured=snapshot({url:source.url,fetchedAt:'2026-10-15T12:00:00Z',text:source.text});
  fs.writeFileSync(source.path,JSON.stringify(captured));fs.writeFileSync(f.files.sources,JSON.stringify([{...source,origin:'controller-capture'}]));
  const loaded=loadInputs(f.files).sources[0];assert.equal(loaded.snapshotId,captured.id);assert.equal(loaded.text,captured.text);
  fs.writeFileSync(source.path,JSON.stringify({...captured,text:'Changed content without a new hash.'}));assert.throws(()=>loadInputs(f.files),/hash/);
});
test('compose uses fixed phrases and planning admission rules without changing the card',t=>{
  const f=fixture(t,2),card=f.input.cards[0],original=structuredClone(card),pkg=compose(card,f.input.sources,f.answers[0],{day:'2026-10-16'});
  assert.equal(pkg.after,true);assert.deepEqual(pkg.phrases,PHRASES.yes);assert.equal(pkg.derived.admission,'reservation');assert.deepEqual(pkg.derived.warnings,['bookingRequired']);
  assert.equal(pkg.patch.practical.booking.checked,'2026-10-16');assert.equal(pkg.origin,'monitor-copy');assert.equal(pkg.shadowOnly,true);assert.deepEqual(card,original);
  assert.equal(admission({...card,priceKind:'course'},false),'course');assert.equal(admission({...card,format:'group'},true),'unknown');assert.equal(admission(card,false),'dropin');
  assert.equal(admission({...card,practical:{commitment:{value:true}}},null),'course');
  const no=compose(f.input.cards[1],f.input.sources,f.answers[1]);assert.deepEqual(no.phrases,PHRASES.no);assert.equal(no.derived.admission,'dropin');
});
test('silence, conflicting extraction, quote mismatch and venue scope never approve',t=>{
  const f=fixture(t,1),card=f.input.cards[0];
  for(const change of [{status:'unknown',value:null},{status:'conflicting'},{scope:'venue-only'},{sourceId:'foreign'},{quote:'A fabricated quotation that is not saved.'},{quote:''}]){
    const pkg=compose(card,f.input.sources,{...f.answers[0],...change});assert.equal(pkg.after,null);assert.deepEqual(pkg.phrases,PHRASES.unknown);
    assert.equal(decide(pkg,{verdict:'approve',reason:'rubber stamp',quoteSeen:true}).approved,false);
  }
  const visitor=compose(card,f.input.sources.map(s=>({...s,kind:'visitor'})),f.answers[0]);assert.equal(visitor.after,null);assert.ok(visitor.gateReasons.includes('not-official-source'));
  const exact=compose(card,f.input.sources,f.answers[0]);assert.equal(decide(exact,{verdict:'approve',reason:'yes',quoteSeen:false}).approved,false);
  assert.throws(()=>compose(card,f.input.sources,{...f.answers[0],value:'true'}),/schema/);
});
test('contradiction gate covers EN, DE, FR, notes, findings, intro and ambiguous wording',()=>{
  const card={notes:['Sans inscription','Ohne Anmeldung am Mittwoch','Keine Anmeldung nötig'],intro:'No registration required.',parentDetails:'Nur mit Anmeldung.',research:{findings:[{text:'Inscription obligatoire',url:'https://example.org/registration'},{text:'Ask about registration.'}]}};
  const conflicts=proseConflicts(card,true);assert.ok(conflicts.some(row=>row.path==='intro'));assert.ok(conflicts.some(row=>row.path==='notes.1'));
  assert.ok(conflicts.some(row=>row.path==='research.findings.1.text'));assert.ok(!conflicts.some(row=>row.path==='parentDetails'));
  assert.ok(proseConflicts(card,false).some(row=>row.path==='research.findings.0.text'));
  assert.ok(proseConflicts({notes:['Anmeldung ist nicht nötig.']},true).length);
});
test('both prompts contain the complete captured text, including its final line',t=>{
  const f=fixture(t,1),source=f.input.sources[0];source.text='Booking page.\n'+'Complete text. '.repeat(3000)+'\nLAST LINE: another group requires registration.';
  for(const prompt of [extractPrompt(f.input.cards[0],[source]),checkPrompt(f.input.cards[0],[source],compose(f.input.cards[0],[source],f.answers[0]))]){
    assert.ok(prompt.includes(JSON.stringify(source.text)));assert.match(prompt,/LAST LINE/);
  }
});
test('dry run makes no calls or writes; oversized text stays visible and real run refuses it',async t=>{
  const f=fixture(t),out=path.join(f.dir,'dry');let calls=0;
  const plan=await runExperiment(f.input,{dryRun:true,out},{askImpl:async()=>{calls++;throw Error('must not call');}});
  assert.equal(calls,0);assert.equal(fs.existsSync(out),false);assert.equal(plan.sample.length,40);assert.ok(plan.estimatedTokens>0);assert.ok(plan.estimatedMutationTokens>0);
  f.input.sources[0].text='Registration '.repeat(6000);const big=planRun(f.input);assert.ok(big.sample.some(row=>row.overBudget));
  await assert.rejects(runExperiment(f.input,{out},{askImpl:async()=>{calls++;}}),/not truncated/);assert.equal(calls,0);
  const cli=execFileSync(process.execPath,['editorial/experiments/booking-route.mjs',`--cards=${f.files.cards}`,`--sources=${f.files.sources}`,'--dry-run'],{encoding:'utf8'});
  assert.equal(JSON.parse(cli).sample.length,40);
});
test('four mutation packages reach the independent checker and a rubber stamp fails the metric',async t=>{
  const f=fixture(t),out=path.join(f.dir,'recorded');const report=await runExperiment(f.input,{out},{askImpl:recorded(f)});
  assert.equal(report.mutations.length,4);assert.deepEqual(report.mutations.map(r=>r.kind),['wrong-value','other-group-quote','missing-quote','contradicting-note']);
  assert.ok(report.mutations.every(row=>row.check.verdict==='reject'));assert.equal(report.metrics.passed,true);
  assert.equal(report.metrics.comparison.length,40);assert.ok(report.metrics.tokens>40*2*120);assert.equal(report.rows[3].decision.approved,false);
  assert.ok(fs.existsSync(path.join(out,'metrics.md')));assert.ok(JSON.parse(fs.readFileSync(path.join(out,'metrics.json'))).metrics.passed);
  const rubber=await runExperiment(f.input,{out:path.join(f.dir,'rubber')},{askImpl:recorded(f,{rubberStamp:true})});
  assert.equal(rubber.metrics.passed,false);assert.equal(rubber.metrics.table.find(m=>m.name==='mutation rejections').status,'fail');
});
test('writes stay in output; catalogue, journal, queue and source bytes stay unchanged',async t=>{
  const f=fixture(t),out=path.join(f.dir,'shadow');
  const protectedFiles=['data.js','data-reviewed.js','editorial/approved-updates.json','editorial/workflow-state/jobs.sqlite'];
  for(const file of protectedFiles){const full=path.join(f.dir,file);fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,'untouched '+file);}
  const before=new Map([...protectedFiles.map(file=>path.join(f.dir,file)),...f.input.inputPaths].map(file=>[file,hash(fs.readFileSync(file))]));
  const writes=[],write=fs.writeFileSync,mkdir=fs.mkdirSync;
  fs.writeFileSync=(file,...args)=>{writes.push(path.resolve(file));return write(file,...args);};
  fs.mkdirSync=(file,...args)=>{writes.push(path.resolve(file));return mkdir(file,...args);};
  try{await runExperiment(f.input,{out},{askImpl:recorded(f)});}finally{fs.writeFileSync=write;fs.mkdirSync=mkdir;}
  assert.ok(writes.length>40);assert.ok(writes.every(file=>file===out||file.startsWith(out+path.sep)));
  for(const [file,digest] of before)assert.equal(hash(fs.readFileSync(file)),digest,file);
  assert.ok(PRIVATE.includes('editorial/experiments/out/'));
});
test('existing directories, symlinks and repository state paths cannot be output folders',async t=>{
  const f=fixture(t,2),opts={size:2};
  await assert.rejects(runExperiment(f.input,{...opts,out:f.dir},{askImpl:recorded(f)}),/must be new/);
  const link=path.join(f.dir,'linked');fs.symlinkSync(f.dir,link,'dir');
  await assert.rejects(runExperiment(f.input,{...opts,out:path.join(link,'new')},{askImpl:recorded(f)}),/symlink/);
  await assert.rejects(runExperiment(f.input,{...opts,out:path.resolve('editorial/workflow-state/new-experiment')},{askImpl:recorded(f)}),/Repository output/);
});
test('metrics fail on any false approval, missed change, lost unknown or exceeded resource threshold',()=>{
  const labels=[{cardId:'a',value:true},{cardId:'b',value:null}],rows=[
    {cardId:'a',before:false,package:{after:false,gateReasons:[],proseConflicts:[]},decision:{approved:true,verdict:'approve'},calls:[{usage,seconds:31},{usage,seconds:31}]},
    {cardId:'b',before:null,package:{after:false,gateReasons:[],proseConflicts:[]},decision:{approved:true,verdict:'approve'},calls:[{usage,seconds:0},{usage,seconds:0}]}];
  const result=metrics({rows,labels,baseline:rows.map(r=>({cardId:r.cardId,value:null,verdict:'await-source',tokens:100})),requestedSize:2});
  for(const name of ['false approvals','missed changes','unknown kept','tokens / baseline','model seconds per card','mutation rejections'])assert.equal(result.table.find(r=>r.name===name).status,'fail',name);
  const missing=metrics({rows:rows.map(r=>({...r,calls:[]})),labels:[],baseline:[],requestedSize:2});
  for(const name of ['false approvals','missed changes','unknown kept','tokens / baseline','model seconds per card'])assert.equal(missing.table.find(r=>r.name===name).status,'unmeasured',name);
});
test('bad recorded responses fail the card and cannot manufacture a complete run',async t=>{
  const f=fixture(t,2),result=await runExperiment(f.input,{size:2,out:path.join(f.dir,'bad')},{askImpl:async()=>({answer:{value:'yes'},usage,seconds:0})});
  assert.ok(result.rows.every(r=>r.error));assert.equal(result.metrics.passed,false);assert.equal(result.mutations.length,0);
  assert.throws(()=>argumentsFor(['--cards=a','--sources=b']),/Choose/);
  assert.throws(()=>argumentsFor(['--cards=a','--sources=b','--dry-run','--typo']),/Unknown/);
});
test('an oversized composed quote refuses the checker call without truncation',async t=>{
  const f=fixture(t,1),source=f.input.sources[0];source.text='Registration is required for Little Oaks. '+ 'Full evidence sentence. '.repeat(1500);
  const full={...f.answers[0],quote:source.text};let calls=0;
  assert.equal(planRun(f.input,{size:1}).sample[0].overBudget,false);
  const result=await runExperiment(f.input,{size:1,out:path.join(f.dir,'long-package')},{askImpl:async()=>{calls++;return {answer:full,usage,seconds:1};}});
  assert.equal(calls,1);assert.match(result.rows[0].error,/not truncated/);assert.equal(result.rows[0].package.quote,source.text);assert.equal(result.metrics.tokens,null);
});
test('baseline comparisons retain verdict disagreements and distinguish estimates from measurements',t=>{
  const f=fixture(t,3),rows=f.input.cards.map((card,i)=>({cardId:card.id,before:null,package:{after:f.answers[i].value,gateReasons:[],proseConflicts:[]},decision:{approved:i!==2,verdict:i===2?'await-source':'approve'},calls:[{usage,seconds:1},{usage,seconds:1}]}));
  const baseline=[{cardId:'oaks-0',verdict:'reject',value:true,tokens:100000}];
  const result=metrics({rows,labels:f.input.labels,baseline,requestedSize:3});
  assert.equal(result.estimatedBaselineCards,2);assert.equal(result.baselineTokens,100000+2*638000);assert.equal(result.comparison[0].agreement,false);
  assert.equal(result.table.find(row=>row.name==='sample').status,'fail');
});
