import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadCatalog,root} from './quality.mjs';

export const CHANNELS=['reviews','ratings','photos','community'];
const RESULTS=new Set(['found','no-usable-evidence','blocked']);
const OUTCOMES=new Set(['card-supported','venue-context-only','no-usable-external-evidence']);
const dateValue=value=>{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return false;
  const date=new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.valueOf())&&date.toISOString().slice(0,10)===value;
};
const https=value=>{try{return new URL(value).protocol==='https:';}catch{return false;}};
const active=records=>records.filter(record=>!['closed','excluded'].includes(record.status));

export function validateReceipt(receipt,record){
  if(!record||receipt?.id!==record.id)throw Error(`Unknown external review ID: ${receipt?.id}`);
  if(!dateValue(receipt.checkedOn)||!dateValue(receipt.reviewAfter)||receipt.reviewAfter<=receipt.checkedOn)
    throw Error(`Invalid external review dates: ${record.id}`);
  if(!receipt.identityUrl||record.sources?.[0]?.url!==receipt.identityUrl)
    throw Error(`External review lacks a matching primary source: ${record.id}`);
  if(!receipt.conclusion?.trim())throw Error(`External review lacks conclusion: ${record.id}`);
  if(!OUTCOMES.has(receipt.evidenceOutcome))throw Error(`Invalid external evidence outcome: ${record.id}`);
  if(!Array.isArray(receipt.conflicts))throw Error(`External review lacks conflicts list: ${record.id}`);
  for(const name of CHANNELS){
    const channel=receipt.channels?.[name];
    if(!RESULTS.has(channel?.result)||!channel.note?.trim()||
      !Array.isArray(channel.queries)||!channel.queries.length||channel.queries.some(query=>!query.trim())||
      !Array.isArray(channel.urls)||channel.urls.some(url=>!https(url))||
      channel.result==='found'&&!channel.urls.length)
      throw Error(`Incomplete ${name} check: ${record.id}`);
    if(channel.result==='found'&&['reviews','ratings','community'].includes(name)&&
      !channel.urls.some(url=>new URL(url).hostname!==new URL(receipt.identityUrl).hostname))
      throw Error(`Independent ${name} source required: ${record.id}`);
  }
  if(receipt.evidenceOutcome==='card-supported'&&!['reviews','community'].some(name=>receipt.channels[name].result==='found'))
    throw Error(`Card support needs independent testimony: ${record.id}`);
  return receipt;
}

export function externalReviewReport(records,receipts,legacyRecords,baseline,date){
  if(!dateValue(date))throw Error('Use YYYY-MM-DD for external review date');
  const published=active(records),byId=new Map(records.map(record=>[record.id,record]));
  if(byId.size!==records.length)throw Error('Duplicate catalogue ID');
  const baselineIds=new Set(baseline.grandfatheredIds||[]);
  if(baselineIds.size!==(baseline.grandfatheredIds||[]).length)throw Error('Duplicate grandfathered ID');
  const reviewed=new Map();
  for(const receipt of receipts){
    if(reviewed.has(receipt.id))throw Error(`Duplicate external review: ${receipt.id}`);
    validateReceipt(receipt,byId.get(receipt.id));
    if(receipt.checkedOn>date)throw Error(`Future-dated external review: ${receipt.id}`);
    reviewed.set(receipt.id,receipt);
  }
  const legacy=new Map();
  for(const item of legacyRecords){
    if(!byId.has(item.id)||legacy.has(item.id))throw Error(`Invalid legacy external review: ${item.id}`);
    legacy.set(item.id,item);
  }
  const rows=published.map(record=>{
    const receipt=reviewed.get(record.id),old=legacy.get(record.id);
    const blocked=receipt&&CHANNELS.some(name=>receipt.channels[name].result==='blocked');
    const status=receipt?(blocked?'blocked':receipt.reviewAfter<=date?'stale':'complete'):
      old?'legacy-partial':'pending';
    const nextEvent=(record.events||[]).map(event=>event.date).filter(value=>value>=date).sort()[0]||null;
    const imminent=nextEvent&&nextEvent<=new Date(Date.parse(`${date}T12:00:00Z`)+14*86400000).toISOString().slice(0,10);
    return {id:record.id,name:record.name,region:record.region,category:record.category,status,
      nextEvent,checkedOn:receipt?.checkedOn||old?.checked||null,reviewAfter:receipt?.reviewAfter||null,
      evidenceOutcome:receipt?.evidenceOutcome||null,
      legacySource:old?'editorial/family-venues-visitor-check-2026-09-27.json':null,
      sourceUrls:(record.sources||[]).map(source=>source.url),
      suggestedQueries:[`${record.name} ${record.town} avis Erfahrungen reviews`,
        `${record.name} ${record.town} Google Maps local.ch Tripadvisor rating`,
        `${record.name} ${record.town} photos Spielbereich aire de jeux`,
        `${record.name} ${record.town} parents Eltern forum`],
      priority:imminent?'near-term':record.status==='check'?'needs-confirmation':'routine',
      decision:'research-only'};
  });
  const order={'near-term':0,'needs-confirmation':1,routine:2};
  rows.sort((a,b)=>order[a.priority]-order[b.priority]||
    (a.nextEvent||'9999').localeCompare(b.nextEvent||'9999')||a.id.localeCompare(b.id));
  const counts=Object.fromEntries(['complete','stale','blocked','legacy-partial','pending'].map(status=>
    [status,rows.filter(row=>row.status===status).length]));
  const evidence=Object.fromEntries([...OUTCOMES].map(outcome=>
    [outcome,rows.filter(row=>row.status==='complete'&&row.evidenceOutcome===outcome).length]));
  return {generatedFor:date,records:published.length,summary:{...counts,backlog:published.length-counts.complete,evidence},
    rows,queue:rows.filter(row=>row.status!=='complete'),newIds:rows.filter(row=>!baselineIds.has(row.id)).map(row=>row.id)};
}

export function assertPublicationReviewed(report){
  const unreviewed=report.rows.filter(row=>report.newIds.includes(row.id)&&row.status!=='complete');
  if(unreviewed.length)throw Error(`External review required before publishing new cards: ${unreviewed.map(row=>row.id).join(', ')}`);
}

export function readExternalReviewInputs(){
  const read=file=>JSON.parse(fs.readFileSync(path.join(root,'editorial',file),'utf8'));
  const receiptFile=read('external-review-receipts.json');
  const baseline=read('external-review-baseline.json');
  const legacy=read('family-venues-visitor-check-2026-09-27.json');
  if(receiptFile.schema!==1||!Array.isArray(receiptFile.receipts)||
    baseline.schema!==1||!Array.isArray(baseline.grandfatheredIds)||!Array.isArray(legacy.records))
    throw Error('Invalid external review registry');
  return {receipts:receiptFile.receipts,baseline,legacyRecords:legacy.records};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const date=process.argv.find(arg=>arg.startsWith('--date='))?.slice(7)||
    new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Zurich'});
  const {receipts,legacyRecords,baseline}=readExternalReviewInputs();
  const report=externalReviewReport(loadCatalog().ACTIVITIES,receipts,legacyRecords,baseline,date);
  const output=path.join(root,'editorial/external-review-report.json');
  const temp=`${output}.tmp-${process.pid}`;
  fs.writeFileSync(temp,JSON.stringify(report,null,2)+'\n');fs.renameSync(temp,output);
  console.log(JSON.stringify({output,records:report.records,...report.summary,newIds:report.newIds},null,2));
}
