import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash,snapshot,validateSnapshot,saveSnapshot,writeJsonAtomic} from './evidence.mjs';
import {readPolicy,createClient,acquireEvidence,judgeBatch,evaluationReport} from './typesafe.mjs';
import {evaluationGroups} from './typesafe-eval-cases.mjs';
import {PROJECT_ID} from './project-id.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
export async function evaluate({groups=evaluationGroups,policy,client,now=new Date().toISOString(),directory=path.join(here,'typesafe-runtime'),sources=[],monitor={}}){
  const datasetHash=hash(JSON.stringify(groups));
  const lockFile=path.join(directory,'evaluations',datasetHash,'sources.json');
  let sourceLock={schema:1,datasetHash,sources:{}};
  try{sourceLock=JSON.parse(await fs.readFile(lockFile,'utf8'));if(sourceLock.datasetHash!==datasetHash)throw Error('Evaluation dataset mismatch');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const rows=[];let requests=0,inputTokens=0,estimatedCostUsd=0;
  const started=performance.now();
  for(const group of groups){
    const jobs=group.checks.map(([field,claim,expected,childAge],index)=>({id:group.id+'-'+index,target:group.target,field,claim,
      expected,childAge,provenance:group.provenance,language:group.language,quote:'',kind:'official'}));
    let evidence;
    try{
      if(group.provenance==='synthetic'){
        evidence=snapshot({url:'https://example.org/'+group.id,fetchedAt:now,parser:'synthetic-fixture-v1',text:group.text});
      }else if(sourceLock.sources[group.url]){
        const id=sourceLock.sources[group.url];
        if(!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid evaluation snapshot ID');
        evidence=validateSnapshot(JSON.parse(await fs.readFile(path.join(directory,'snapshots',id+'.json'),'utf8')));
        if(evidence.url!==group.url)throw Error('Evaluation source mismatch');
      }else{
        const source=sources.find(item=>item.url===group.url&&item.recordIds?.includes(group.recordId));
        evidence=await acquireEvidence(group.url,{directory,source,monitorEntry:source&&monitor.sources?.[source.id],now});
        sourceLock.sources[group.url]=evidence.id;await writeJsonAtomic(lockFile,sourceLock);
      }
      await saveSnapshot(directory,evidence);
      // Frozen-source evaluation measures semantic support, not present-day freshness.
      const result=await judgeBatch({evidence,jobs,policy:{...policy,evidenceMaxAgeDays:36500},client,now,cacheDirectory:path.join(directory,'evaluation-cache')});
      rows.push(...result.rows);requests+=result.requests;inputTokens+=result.usage?.input_tokens||0;estimatedCostUsd+=result.estimatedCostUsd||0;
    }catch{rows.push(...jobs.map(job=>({...job,status:'source-unavailable',decision:'research-only'})));}
  }
  const report={schema:1,project:PROJECT_ID,mode:'shadow',generatedAt:now,datasetHash,model:policy.model,rubricVersion:policy.rubricVersion,
    scope:'semantic support in frozen sources; not current availability or calibrated production accuracy',
    groups:groups.length,uniqueRealSourceUrls:new Set(groups.filter(group=>group.provenance==='real-source').map(group=>group.url)).size,
    requests,inputTokens,estimatedCostUsd,elapsedMs:Math.round(performance.now()-started),...evaluationReport(rows),rows};
  await writeJsonAtomic(path.join(directory,'evaluation-latest.json'),report);
  return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const policy=await readPolicy(),client=await createClient();
    const {sources}=JSON.parse(await fs.readFile(path.join(here,'source-watch.json'),'utf8'));
    const monitor=JSON.parse(await fs.readFile(path.join(here,'monitor-state.json'),'utf8'));
    const report=await evaluate({policy,client,sources,monitor});
    console.log(JSON.stringify({model:report.model,groups:report.groups,uniqueRealSourceUrls:report.uniqueRealSourceUrls,
      overall:report.overall,byProvenance:report.byProvenance,byCohort:report.byCohort,byLanguage:report.byLanguage,
      requests:report.requests,inputTokens:report.inputTokens,estimatedCostUsd:report.estimatedCostUsd,elapsedMs:report.elapsedMs},null,2));
  }catch{console.error('Evaluation failed; no raw credential or API error is logged.');process.exitCode=1;}
}
