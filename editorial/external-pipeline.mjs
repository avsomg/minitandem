import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {loadCatalog,root} from './quality.mjs';
import {CHANNELS,externalReviewReport,readExternalReviewInputs} from './external-review.mjs';
import {CORRECTION_FORMAT} from './project-id.mjs';

const editorial=path.join(root,'editorial');
const CHANNEL_STATES=new Set(['searched','limited','blocked']);
const SCOPES=new Set(['exact-card','venue-only','uncertain']);
const TOPICS=new Set(['identity','address','date','age','price','booking','language','reviews','ratings','photos','community','other']);
const VERDICTS=new Set(['resolved','unresolved']);
const ADDRESS_OUTCOMES=new Set(['same-place','correction-needed']);
const CORRECTION_STATES=new Set(['proposed','applied','rejected']);
const dateValue=value=>{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return false;
  const date=new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.valueOf())&&date.toISOString().slice(0,10)===value;
};
const https=value=>{try{return new URL(value).protocol==='https:';}catch{return false;}};
const nonempty=value=>typeof value==='string'&&Boolean(value.trim());
const loadFile=file=>JSON.parse(fs.readFileSync(path.join(editorial,file),'utf8'));
const loadDirectory=name=>{
  const directory=path.join(editorial,name);
  if(!fs.existsSync(directory))return new Map();
  const entries=new Map();
  for(const filename of fs.readdirSync(directory).filter(file=>file.endsWith('.json'))){
    const id=filename.slice(0,-'.json'.length);
    if(entries.has(id))throw Error(`Duplicate pipeline file: ${name}/${filename}`);
    const value=JSON.parse(fs.readFileSync(path.join(directory,filename),'utf8'));
    if(value===null&&name==='external-decisions')continue;
    entries.set(id,value);
  }
  return entries;
};

export function venueAddressSignature(address){
  const parts=(address||'').normalize('NFC').replace(/[\u2018\u2019]/g,"'").toLocaleLowerCase()
    .split(',').map(part=>part.trim().replace(/\s+/g,' '));
  const last=parts.length-1,postal=parts.length>1&&parts[last].match(/^(?:ch[- ])?([1-9]\d{3})\s+(.+)$/);
  if(postal)parts[last]=postal[2];
  return {address:parts.join(', '),postalCode:postal?postal[1]:null};
}
export function venueGroups(records,registry){
  if(registry.schema!==1||!Array.isArray(registry.groups))throw Error('Invalid venue registry');
  const byId=new Map(records.map(record=>[record.id,record]));
  const cardGroup=new Map();
  const groupIds=new Set();
  for(const group of registry.groups){
    if(!nonempty(group.id)||groupIds.has(group.id)||!nonempty(group.label)||
      !Array.isArray(group.cardIds)||group.cardIds.length<2)
      throw Error(`Invalid venue group: ${group.id}`);
    groupIds.add(group.id);
    const addresses=new Set(),postalCodes=new Set();
    for(const id of group.cardIds){
      const record=byId.get(id);
      if(!record||cardGroup.has(id))throw Error(`Invalid or repeated venue card: ${id}`);
      cardGroup.set(id,group.id);
      const signature=venueAddressSignature(record.address);
      addresses.add(signature.address);
      if(signature.postalCode)postalCodes.add(signature.postalCode);
    }
    if(addresses.size!==1||addresses.has('')||postalCodes.size>1)throw Error(`Venue group spans addresses: ${group.id}`);
  }
  return cardGroup;
}

export function validateCandidate(candidate,record,groups){
  if(candidate?.schema!==1||candidate.id!==record?.id||
    !nonempty(candidate.revision)||
    !dateValue(candidate.collectedOn)||!dateValue(candidate.reviewAfter)||
    candidate.reviewAfter<=candidate.collectedOn||!https(candidate.identityUrl)||
    !nonempty(candidate.name)||!nonempty(candidate.town)||!nonempty(candidate.address))
    throw Error(`Invalid external candidate: ${candidate?.id}`);
  if(candidate.venueContextFrom){
    if(candidate.venueContextFrom===candidate.id||!groups.get(candidate.id)||
      groups.get(candidate.id)!==groups.get(candidate.venueContextFrom))
      throw Error(`Unsafe shared venue context: ${candidate.id}`);
  }
  for(const name of CHANNELS){
    const channel=candidate.channels?.[name];
    if(!CHANNEL_STATES.has(channel?.status)||!nonempty(channel.note)||
      !Array.isArray(channel.queries)||!channel.queries.length||
      channel.queries.some(query=>!nonempty(query))||!Array.isArray(channel.results))
      throw Error(`Invalid candidate ${name}: ${candidate.id}`);
    for(const result of channel.results){
      if(!https(result.url)||!nonempty(result.query)||!channel.queries.includes(result.query)||
        !SCOPES.has(result.suspectedScope)||
        !(nonempty(result.title)||nonempty(result.snippet)))
        throw Error(`Invalid candidate result ${name}: ${candidate.id}`);
    }
  }
  return candidate;
}

export function validateDispute(dispute,record){
  if(dispute?.schema!==1||dispute.id!==record?.id||!dateValue(dispute.openedOn)||
    !nonempty(dispute.candidateRevision)||
    !Array.isArray(dispute.questions)||!dispute.questions.length)
    throw Error(`Invalid external dispute: ${dispute?.id}`);
  const keys=new Set();
  for(const question of dispute.questions){
    if(!nonempty(question.key)||keys.has(question.key)||!TOPICS.has(question.topic)||
      !nonempty(question.issue)||!Array.isArray(question.urls)||
      question.urls.some(url=>!https(url)))throw Error(`Invalid dispute question: ${dispute.id}`);
    keys.add(question.key);
  }
  return dispute;
}

export function validateDecision(decision,dispute){
  if(decision?.schema!==1||decision.id!==dispute?.id||
    !dateValue(decision.decidedOn)||decision.decidedOn<dispute.openedOn||
    decision.disputeOpenedOn!==dispute.openedOn||
    decision.candidateRevision!==dispute.candidateRevision||
    !Array.isArray(decision.rulings)||decision.rulings.length!==dispute.questions.length)
    throw Error(`Invalid external decision: ${decision?.id}`);
  const keys=new Set(dispute.questions.map(question=>question.key));
  for(const ruling of decision.rulings){
    if(!keys.delete(ruling.key)||!VERDICTS.has(ruling.verdict)||!nonempty(ruling.reason)||
      !Array.isArray(ruling.urls)||ruling.urls.some(url=>!https(url))||
      ruling.verdict==='resolved'&&!ruling.urls.length)
      throw Error(`Invalid external ruling: ${decision.id}`);
  }
  if(keys.size)throw Error(`Missing external ruling: ${decision.id}`);
  if(decision.rulings.some(ruling=>ruling.verdict==='unresolved')&&
    (!dateValue(decision.reviewAfter)||decision.reviewAfter<=decision.decidedOn))
    throw Error(`Unresolved decision needs review date: ${decision.id}`);
  return decision;
}

export const recordRevision=record=>createHash('sha256').update(JSON.stringify(record)).digest('hex');

export function validateCorrection(correction,record,{readVersion=revision=>
  JSON.parse(fs.readFileSync(path.join(editorial,'correction-versions',revision+'.json'),'utf8'))}={}){
  if(correction?.schema!==1||correction.id!==record?.id||
    !dateValue(correction.proposedOn)||!CORRECTION_STATES.has(correction.status)||
    !https(correction.source)||!nonempty(correction.issue)||!nonempty(correction.proposal))
    throw Error(`Invalid editorial correction: ${correction?.id}`);
  if(correction.status==='applied'&&
    (!dateValue(correction.appliedOn)||correction.appliedOn<correction.proposedOn))
    throw Error(`Applied correction lacks date: ${correction.id}`);
  if(correction.status==='applied'){
    if(correction.appliedRecordRevision){
      if(!/^[a-f0-9]{64}$/.test(correction.appliedRecordRevision))throw Error(`Invalid correction revision: ${correction.id}`);
      const frozen=readVersion(correction.appliedRecordRevision);
      if(frozen.id!==record.id||recordRevision(frozen)!==correction.appliedRecordRevision)
        throw Error(`Invalid correction snapshot: ${correction.id}`);
      record=frozen;
    }
    if(!Array.isArray(correction.checks)||!correction.checks.length)
      throw Error(`Applied correction lacks checks: ${correction.id}`);
    for(const check of correction.checks){
      if(!Array.isArray(check.path)||!check.path.length||
        !['name','status','min','max','age','ageUpperUncertainFrom','parent','parentDetails','languages','schedule','scheduleValidThrough','days','events','address','addressPrecision','areas','price','priceKind','amount','contacts','sources','practical','checked','reviewAfter','intro','notes'].includes(check.path[0])||
        check.path.some(part=>!(typeof part==='string'&&/^[a-zA-Z][a-zA-Z0-9]*$/.test(part)&&!['constructor','prototype','__proto__'].includes(part)||Number.isInteger(part)&&part>=0)))
        throw Error(`Invalid correction check path: ${correction.id}`);
      const actual=check.path.reduce((value,key)=>value?.[key],record);
      if(actual===undefined||!isDeepStrictEqual(JSON.parse(JSON.stringify(actual)),check.value))
        throw Error(`Applied correction differs from catalogue: ${correction.id}`);
    }
  }
  if(correction.status==='rejected'&&
    (!dateValue(correction.decidedOn)||!nonempty(correction.reason)))
    throw Error(`Rejected correction lacks decision: ${correction.id}`);
  return correction;
}

// A receipt is written against the card as it stood. When a later independently
// approved update moves the card's address away from the candidate that receipt
// reviewed, the receipt is stale, not a bypass: the card returns to external
// verification, where the address review is required again.
const addressMovedSince=(receipt,candidate,approvedUpdates)=>approvedUpdates.some(update=>
  update.draft?.cardId===receipt.id&&dateValue(update.approvedOn)&&update.approvedOn>=receipt.checkedOn&&
  update.baseRecord?.address===candidate.address&&nonempty(update.draft.patch?.address)&&
  update.draft.patch.address!==candidate.address);

export function pipelineReport(records,receipts,receiptBaseline,registry,candidates,disputes,decisions,date,corrections=new Map(),approvedUpdates=[]){
  if(!dateValue(date)||receiptBaseline.schema!==1||!dateValue(receiptBaseline.cutoffOn)||
    !Array.isArray(receiptBaseline.ids))
    throw Error('Invalid external pipeline baseline or date');
  const published=records.filter(record=>!['closed','excluded'].includes(record.status));
  const byId=new Map(records.map(record=>[record.id,record]));
  if(byId.size!==records.length)throw Error('Duplicate catalogue card ID');
  const groups=venueGroups(records,registry);
  const baseline=new Set(receiptBaseline.ids);
  if(baseline.size!==receiptBaseline.ids.length)throw Error('Duplicate pipeline baseline ID');
  if([...baseline].some(id=>!byId.has(id)))throw Error('Unknown pipeline baseline ID');
  const verified=new Map(receipts.map(receipt=>[receipt.id,receipt]));
  if(verified.size!==receipts.length)throw Error('Duplicate receipt ID');
  const correctionsById=new Map();
  for(const [filename,correction] of corrections){
    validateCorrection(correction,byId.get(correction.id));
    if(correction.proposedOn>date||correction.appliedOn>date||correction.decidedOn>date)
      throw Error(`Future editorial correction: ${filename}`);
    if(!correctionsById.has(correction.id))correctionsById.set(correction.id,[]);
    correctionsById.get(correction.id).push({filename,correction});
  }
  for(const [id,candidate] of candidates){
    if(!byId.has(id)||candidate.id!==id)throw Error(`Orphan external candidate: ${id}`);
    validateCandidate(candidate,byId.get(id),groups);
    if(candidate.collectedOn>date)throw Error(`Future external candidate: ${id}`);
  }
  for(const [id,dispute] of disputes){
    if(!byId.has(id)||!candidates.has(id)||dispute.id!==id)throw Error(`Orphan external dispute: ${id}`);
    validateDispute(dispute,byId.get(id));
    if(dispute.openedOn>date)throw Error(`Future external dispute: ${id}`);
  }
  for(const [id,decision] of decisions){
    if(!disputes.has(id)||decision.id!==id)throw Error(`Orphan external decision: ${id}`);
    validateDecision(decision,disputes.get(id));
    if(decision.decidedOn>date)throw Error(`Future external decision: ${id}`);
  }
  const staleAddress=new Set(),renamed=new Set();
  for(const receipt of receipts){
    if(!published.some(record=>record.id===receipt.id))continue;
    if(baseline.has(receipt.id)&&receipt.checkedOn<=receiptBaseline.cutoffOn)continue;
    const candidate=candidates.get(receipt.id);
    if(!candidate||!nonempty(receipt.candidateRevision))
      throw Error(`Receipt bypasses search or adjudication: ${receipt.id}`);
    if(candidate.revision!==receipt.candidateRevision){
      if(candidate.collectedOn<receipt.checkedOn)
        throw Error(`Candidate revision predates receipt: ${receipt.id}`);
      continue;
    }
    const record=byId.get(receipt.id);
    // A card renamed after its external review goes back to external search under its present name. Until 22 October 2026 the rename
    // stopped the whole pipeline as a bypassed search (nine cards got English names in the wording review of 21 October).
    if(candidate.name!==record.name||candidate.town!==record.town){renamed.add(receipt.id);continue;}
    const dispute=disputes.get(receipt.id)?.candidateRevision===candidate?.revision?
      disputes.get(receipt.id):null;
    const decision=dispute&&decisions.get(receipt.id)?.candidateRevision===candidate?.revision?
      decisions.get(receipt.id):null;
    const addressChanged=candidate.address!==record.address;
    const addressReview=receipt.addressReview;
    if(addressChanged&&(
      !ADDRESS_OUTCOMES.has(addressReview?.outcome)||!nonempty(addressReview.reason)||
      !Array.isArray(addressReview.urls)||!addressReview.urls.length||
      addressReview.urls.some(url=>!https(url))||
      addressReview.outcome==='same-place'&&!record.address||
      addressReview.outcome==='correction-needed'&&
        !correctionsById.get(receipt.id)?.some(({correction})=>correction.status!=='rejected')
    )){
      if(!addressMovedSince(receipt,candidate,approvedUpdates))throw Error(`Unreviewed candidate address: ${receipt.id}`);
      staleAddress.add(receipt.id);
    }
    if(candidate.collectedOn>receipt.checkedOn||candidate.reviewAfter<=receipt.checkedOn||
      candidate.identityUrl!==receipt.identityUrl||
      CHANNELS.some(name=>!candidate.channels[name].queries.some(query=>
        receipt.channels[name].queries.includes(query)))||
      dispute&&(!decision||decision.rulings.some(ruling=>ruling.verdict==='unresolved')))
      throw Error(`Receipt bypasses search or adjudication: ${receipt.id}`);
  }
  const external=externalReviewReport(records,receipts,[],{grandfatheredIds:[]},date);
  const statusById=new Map(external.rows.map(row=>[row.id,row.status]));
  for(const candidate of candidates.values()){
    if(!published.some(record=>record.id===candidate.id))continue;
    if(candidate.venueContextFrom&&statusById.get(candidate.venueContextFrom)!=='complete')
      throw Error(`Unverified shared venue context: ${candidate.id}`);
  }
  const rows=published.map(record=>{
    const id=record.id,candidate=candidates.get(id);
    const receipt=verified.get(id),externalStatus=statusById.get(id);
    const dispute=disputes.get(id)?.candidateRevision===candidate?.revision?disputes.get(id):null;
    const decision=dispute&&decisions.get(id)?.candidateRevision===candidate?.revision?
      decisions.get(id):null;
    const stale=staleAddress.has(id);
    const newCandidate=candidate&&(!receipt||receipt.candidateRevision!==candidate.revision||
      candidate.collectedOn>receipt.checkedOn||stale);
    let researchStage;
    if(renamed.has(id))researchStage='search';
    else if(newCandidate&&candidate.reviewAfter>date){
      if(dispute&&!decision)researchStage='adjudicate';
      else if(decision?.rulings.some(ruling=>ruling.verdict==='unresolved'))
        researchStage=decision.reviewAfter<=date?'search':'await-source';
      else researchStage='verify';
    }
    else if(externalStatus==='complete'&&!stale)researchStage='verified';
    else if(externalStatus==='blocked'&&receipt.reviewAfter>date)researchStage='await-source';
    else researchStage='search';
    const editorialStatus=correctionsById.get(id)?.some(({correction})=>correction.status==='proposed')?'required':'clear';
    const stage=editorialStatus==='required'?'editorial':researchStage;
    return {id,name:record.name,stage,researchStage,editorialStatus,
      publicationEligible:editorialStatus==='clear',externalStatus:statusById.get(id),
      venueGroup:groups.get(id)||null,venueContextFrom:candidate?.venueContextFrom||null,
      candidateFile:candidate?`editorial/external-candidates/${id}.json`:null,
      disputeFile:dispute?`editorial/external-disputes/${id}.json`:null,
      decisionFile:decision?`editorial/external-decisions/${id}.json`:null,
      correctionFiles:(correctionsById.get(id)||[]).map(({filename})=>`editorial/corrections/${filename}.json`)};
  });
  const priority=new Map(external.rows.map((row,index)=>[row.id,index]));
  rows.sort((a,b)=>priority.get(a.id)-priority.get(b.id));
  const stages=['search','verify','adjudicate','await-source','editorial','verified'];
  return {generatedFor:date,records:rows.length,
    summary:Object.fromEntries(stages.map(stage=>[stage,rows.filter(row=>row.stage===stage).length])),
    researchSummary:Object.fromEntries(stages.filter(stage=>stage!=='editorial').map(stage=>
      [stage,rows.filter(row=>row.researchStage===stage).length])),
    publication:{blockedIds:rows.filter(row=>!row.publicationEligible).map(row=>row.id)},
    staleAddressReceipts:[...staleAddress],renamedReceipts:[...renamed],
    queues:Object.fromEntries(stages.filter(stage=>stage!=='verified').map(stage=>
      [stage,rows.filter(row=>stage==='editorial'?row.editorialStatus==='required':row.researchStage===stage).map(row=>row.id)])),rows};
}

export function assertEditorialReady(report){
  if(report.publication.blockedIds.length)
    throw Error(`Editorial corrections required before publishing: ${report.publication.blockedIds.join(', ')}`);
}

export function readPipelineInputs(){
  const allCorrections=loadDirectory('corrections');
  const intakeReports=new Map([...allCorrections].filter(([,value])=>value.report?.type===CORRECTION_FORMAT));
  return {receiptBaseline:loadFile('external-pipeline-baseline.json'),
    registry:loadFile('external-venues.json'),
    candidates:loadDirectory('external-candidates'),
    disputes:loadDirectory('external-disputes'),
    decisions:loadDirectory('external-decisions'),
    corrections:new Map([...allCorrections].filter(([id])=>!intakeReports.has(id))),intakeReports,
    approvedUpdates:fs.existsSync(path.join(editorial,'approved-updates.json'))?loadFile('approved-updates.json').updates:[]};
}

// The report on the current private state, approval journal included. The build and the command line both use this one call, so no
// caller can leave the journal out (until 20 October 2026 the build did, and an approved address change then failed QA).
export function currentPipelineReport(records,receipts,date){
  const {receiptBaseline,registry,candidates,disputes,decisions,corrections,approvedUpdates}=readPipelineInputs();
  return pipelineReport(records,receipts,receiptBaseline,registry,candidates,disputes,decisions,date,corrections,approvedUpdates);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const date=process.argv.find(arg=>arg.startsWith('--date='))?.slice(7)||
    new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Zurich'});
  const records=loadCatalog().ACTIVITIES,{receipts}=readExternalReviewInputs();
  const report=currentPipelineReport(records,receipts,date);
  const output=path.join(editorial,'external-pipeline-report.json');
  const temp=`${output}.tmp-${process.pid}`;
  fs.writeFileSync(temp,JSON.stringify(report,null,2)+'\n');fs.renameSync(temp,output);
  console.log(JSON.stringify({output,records:report.records,...report.summary},null,2));
}
