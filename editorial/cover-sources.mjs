import fs from 'node:fs';
import path from 'node:path';
import {root,loadCatalog,qualityReport} from './quality.mjs';

const file=path.join(root,'editorial/source-watch.json');
const config=JSON.parse(fs.readFileSync(file,'utf8'));
const records=loadCatalog().ACTIVITIES;
const before=qualityReport(records,config.sources,new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Zurich'}));
const byUrl=new Map(config.sources.map(source=>[source.url,source]));
let added=0,linked=0,unavailable=[];
for(const row of before.queue.filter(row=>!row.watched.length)){
  const record=records.find(item=>item.id===row.id);
  const url=record.sources.find(source=>/^https:\/\//.test(source.url))?.url;
  if(!url){unavailable.push(row.id);continue;}
  const existing=byUrl.get(url);
  if(existing){existing.recordIds=[...new Set([...existing.recordIds,row.id])];linked++;continue;}
  const id='catalog-'+row.id;
  if(config.sources.some(source=>source.id===id))throw Error('Source ID already exists: '+id);
  const source={id,url,type:/\.pdf(?:[?#]|$)/i.test(url)?'pdf':'html',recordIds:[row.id],intervalDays:record.format==='event'?14:30};
  config.sources.push(source);byUrl.set(url,source);added++;
}
fs.writeFileSync(file,JSON.stringify(config,null,2)+'\n');
const after=qualityReport(records,config.sources,new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Zurich'}));
console.log(JSON.stringify({sourcesBefore:config.sources.length-added,sourcesAfter:config.sources.length,newSources:added,linkedToExisting:linked,withoutMonitorBefore:before.withoutMonitor,withoutMonitorAfter:after.withoutMonitor,noHttpsSource:unavailable},null,2));
