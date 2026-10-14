import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const app=path.dirname(here),c={window:{},structuredClone};
for(const f of ['data.js','data-reviewed.js','data-practical.js','regions.js','data-geo.js'])vm.runInNewContext(fs.readFileSync(path.join(app,f),'utf8'),c);
const all=c.window.ACTIVITIES;
const records=all.filter(a=>!['closed','excluded'].includes(a.status));
const counts=key=>Object.fromEntries([...new Set(records.map(a=>a[key]))].map(value=>[value,records.filter(a=>a[key]===value).length]));
const sourceMap=new Map();
for(const a of records)for(const s of a.sources){
  if(!sourceMap.has(s.url))sourceMap.set(s.url,{id:'source-'+crypto.createHash('sha256').update(s.url).digest('hex').slice(0,12),url:s.url,recordIds:[],regions:[],labels:[],monitoring:'not-configured'});
  const source=sourceMap.get(s.url);source.recordIds.push(a.id);source.regions.push(a.region);source.labels.push(s.label);
}
const sources=[...sourceMap.values()].map(s=>({...s,recordIds:[...new Set(s.recordIds)],regions:[...new Set(s.regions)],labels:[...new Set(s.labels)]}));
const located=records.filter(a=>a.geo);
const report={generatedAt:new Date().toISOString(),grain:'One published catalogue card; formats include groups, individual offers, events and self-guided visits.',total:all.length,catalog:records.length,archive:all.length-records.length,geocodedCards:located.length,uniqueAddressPoints:new Set(located.map(a=>`${a.geo.lat},${a.geo.lon}`)).size,byRegion:counts('region'),byFormat:counts('format'),storedStatus:counts('status'),checkedDates:[...new Set(records.map(a=>a.checked))],unknownFields:{minAge:records.filter(a=>a.min===null).length,parent:records.filter(a=>a.parent==='unknown').length,language:records.filter(a=>!a.languages.length).length,price:records.filter(a=>a.priceKind==='unknown').length,address:records.filter(a=>!a.address).length},sources:sources.length,explicitScheduleEnd:records.filter(a=>a.scheduleValidThrough).length,seeLocalities:[...new Set(records.filter(a=>a.region==='see').map(a=>a.town))],limitations:['Unknown values are not automatically errors.','Stored active status is not a count of fully confirmed bookable offers.','Locality presence does not measure completed research.','No completeness rate or market total can be inferred.']};
fs.writeFileSync(path.join(here,'profile.json'),JSON.stringify(report,null,2)+'\n');
fs.writeFileSync(path.join(here,'source-inventory.generated.json'),JSON.stringify({generatedAt:report.generatedAt,sources},null,2)+'\n');
console.log(JSON.stringify(report,null,2));
