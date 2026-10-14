import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadCatalog,qualityReport,root} from './quality.mjs';
import {readPolicy,runShadow,semanticPackets,readExternalCandidates} from './typesafe.mjs';
import {writeJsonAtomic} from './evidence.mjs';
import {validDate} from './field-contract.mjs';

export function workPackets(records,sources,monitor,coverage,date,discoveryReport=null,externalReport=null,semanticReport=null,externalCandidates=null){
  const report=qualityReport(records,sources,date,monitor);
  const byId=new Map(records.map(record=>[record.id,record]));
  const bySource=new Map(sources.map(source=>[source.id,source]));
  const horizon=new Date(Date.parse(`${date}T12:00:00Z`)+14*86400000).toISOString().slice(0,10);
  const needsResearch=row=>row.stale||row.sourceIssues.length||byId.get(row.id).status==='check'||
    row.nextEvent&&row.nextEvent<=horizon&&row.critical.length;
  const candidates=report.queue.filter(needsResearch);
  const review=candidates.map(row=>{
    const record=byId.get(row.id);
    return {id:row.id,priority:row.priority,region:row.region,nextEvent:row.nextEvent,
      checked:row.checked,reviewAfter:row.reviewAfter,critical:row.critical,
      sourceIssues:row.sourceIssues,sourceUrls:record.sources.map(source=>source.url),
      openQuestions:record.research?.remaining||[],decision:'research-only'};
  });
  const sourceFailures=(monitor?.queue||[]).filter(task=>task.status==='open').map(task=>({
    id:task.id,kind:task.kind,recordIds:task.recordIds||[],sourceUrl:bySource.get(task.sourceId)?.url||task.details?.url||null,
    firstSeen:task.firstSeen,lastSeen:task.lastSeen,error:task.details?.error||null,decision:'research-only'
  }));
  const coverageCurrent=coverage?.catalogueCards===report.records;
  const municipalities=coverageCurrent?coverage.municipalitiesList||[]:[];
  const categories=Object.keys(coverage?.categoryPresence||{});
  const discovery=coverageCurrent?Object.keys(coverage.districts||{}).sort().map(region=>{
    const local=municipalities.filter(place=>place.region===region);
    const sparse=local.filter(place=>place.recordIds.length<=1).sort((a,b)=>a.recordIds.length-b.recordIds.length||a.name.localeCompare(b.name));
    const unrepresentedCategories=categories.filter(category=>local.every(place=>!place.categoryCounts[category]));
    return {region,sparseTotal:sparse.length,municipalities:sparse.map(place=>({name:place.name,ofs:place.ofs,knownCardIds:place.recordIds})),
      unrepresentedCategories,officialMunicipalitySource:coverage.officialSource,decision:'candidate-research-only'};
  }):[];
  const discoveryCurrent=discoveryReport?.generatedFor===date;
  const externalCurrent=externalReport?.generatedFor===date&&externalReport.records===report.records;
  const externalReview=externalCurrent?externalReport.queue:[];
  const semanticReview=semanticPackets(semanticReport,records,date,externalCandidates);
  const semanticStatus=!semanticReport?'not-requested':semanticReport.unavailable?'unavailable':
    semanticReport.busy?'busy':semanticReport.enabled===false?'disabled':
      semanticReport.generatedFor===date?'completed':'outdated';
  const eventDiscovery=discoveryCurrent?(discoveryReport.series||[]).map(series=>({
    title:series.title,feedId:series.feedId,url:series.url,dates:series.dates,
    matchedRecordIds:series.matchedRecordIds,familyHint:series.familyHint,
    recurrenceUnexpanded:!!series.recurrenceUnexpanded,status:series.status,
    priority:series.familyHint&&series.dates[0]<=horizon?'near-term-family':series.familyHint?'family':'other',
    decision:'candidate-research-only'
  })).sort((a,b)=>{
    const order={'near-term-family':0,family:1,other:2};
    return order[a.priority]-order[b.priority]||a.dates[0].localeCompare(b.dates[0]);
  }):[];
  return {generatedFor:date,catalogueCards:report.records,coverageCurrent,
    discoveryCurrent,discoveryFeedErrors:discoveryCurrent?discoveryReport.errors||[]:[],
    summary:{reviewCandidates:candidates.length,
      reviewIncluded:review.length,openSourceTasks:sourceFailures.length,sparseMunicipalities:discovery.reduce((sum,packet)=>sum+packet.sparseTotal,0),
      eventSeries:eventDiscovery.length,nearTermFamilySeries:eventDiscovery.filter(item=>item.priority==='near-term-family').length,
      externalReviewBacklog:externalCurrent?externalReview.length:null,semanticReview:semanticReview.length},
    semanticMode:'shadow',semanticStatus,semanticRun:semanticReport?.summary||null,
    semanticReview,review,sourceFailures,eventDiscovery,externalReview,discovery};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const date=process.argv.find(arg=>arg.startsWith('--date='))?.slice(7)||new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Zurich'});
  const catalog=loadCatalog();
  if(!validDate(date))throw Error('Use --date=YYYY-MM-DD');
  const sources=JSON.parse(fs.readFileSync(path.join(root,'editorial/source-watch.json'),'utf8')).sources;
  const monitor=JSON.parse(fs.readFileSync(path.join(root,'editorial/monitor-state.json'),'utf8'));
  const coverage=JSON.parse(fs.readFileSync(path.join(root,'editorial/canton-coverage.generated.json'),'utf8'));
  const discoveryReportFile=path.join(root,'editorial/discovery-report.json');
  const discoveryReport=fs.existsSync(discoveryReportFile)?JSON.parse(fs.readFileSync(discoveryReportFile,'utf8')):null;
  const externalReportFile=path.join(root,'editorial/external-review-report.json');
  const externalReport=fs.existsSync(externalReportFile)?JSON.parse(fs.readFileSync(externalReportFile,'utf8')):null;
  let semanticReport=null,externalCandidates=null;
  if(!process.argv.includes('--no-semantic')){
    try{
      const policy=await readPolicy();
      externalCandidates=await readExternalCandidates();
      if(process.argv.includes('--reuse-semantic')){
        semanticReport=JSON.parse(fs.readFileSync(path.join(root,'editorial/typesafe-runtime/latest.json'),'utf8'));
        if(semanticReport.model!==policy.model||semanticReport.rubricVersion!==policy.rubricVersion||semanticReport.generatedFor!==date)
          semanticReport={generatedFor:null};
      // Historical packet generation must not run a present-day external check.
      }else if(date===new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Zurich'}))
        semanticReport=await runShadow({records:catalog.ACTIVITIES,sources,monitor,policy,externalCandidates});
    }catch{semanticReport={unavailable:true};console.error('Semantic worker unavailable; existing research queues remain active.');}
  }
  const packets=workPackets(catalog.ACTIVITIES,sources,monitor,coverage,date,discoveryReport,externalReport,semanticReport,externalCandidates);
  const output=path.join(root,'editorial/work-packets.json');
  await writeJsonAtomic(output,packets);
  console.log(JSON.stringify({output,...packets.summary,coverageCurrent:packets.coverageCurrent,semanticStatus:packets.semanticStatus},null,2));
}
