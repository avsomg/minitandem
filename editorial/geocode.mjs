import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// A venue name, a building letter or a floor in front of the street makes the address
// search return nothing. When one part ends in a house number, the query starts there
// and keeps only the postcode part after it; the map generator still accepts nothing
// but a single exact match.
export function addressQuery(address){
  const parts=address.split(',').map(part=>part.trim()),street=parts.findIndex(part=>/\s\d+\s?[a-z]?$/i.test(part));
  const chosen=street>=0?parts.slice(street).filter((part,index)=>index===0||/^(?:CH[- ])?\d{4}\s/i.test(part)):
    parts.filter(part=>!/^(Primarschulhaus|Maison de|Centre |Sport|Hallenbad|Bibliothek|Gemeinde|OS |Aloha |Turnhalle|Halle de|Salle polyvalente)/i.test(part));
  return chosen.join(' ').replace(/[()]/g,' ').split(/\s+/).filter(Boolean).slice(0,10).join(' ');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
const context={window:{},structuredClone};
for(const file of ['data.js','data-reviewed.js','data-practical.js','regions.js'])vm.runInNewContext(fs.readFileSync(path.join(root,file),'utf8'),context);
const cardArgument=process.argv.find(value=>value.startsWith('--card='));
const cardId=cardArgument?.slice(7),refresh=process.argv.includes('--refresh');
if(cardArgument&&!/^[a-z0-9][a-z0-9-]*$/.test(cardId))throw Error('Invalid geocode card');
if(refresh&&!cardArgument)throw Error('Refresh one named card at a time');
const records=context.window.ACTIVITIES.filter(a=>!['closed','excluded'].includes(a.status)&&(!cardId||a.id===cardId));
if(cardId&&!records.length)throw Error('Unknown or archived geocode card');
const cachePath=path.join(root,'editorial/geocode-candidates.json');
const cache=fs.existsSync(cachePath)?JSON.parse(fs.readFileSync(cachePath,'utf8')):{};
for(const a of records){
  if(!a.address||cache[a.address]&&!refresh)continue;
  const query=addressQuery(a.address);
  const url=new URL('https://api3.geo.admin.ch/rest/services/ech/SearchServer');
  url.search=new URLSearchParams({searchText:query,type:'locations',origins:'address',limit:'5',sr:'4326'});
  try{
    const response=await fetch(url,{signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw Error(response.status);
    const json=await response.json();cache[a.address]={query,source:url.href,checked:new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Zurich'}),results:json.results.map(r=>({label:r.attrs.label.replace(/<[^>]*>/g,''),lat:r.attrs.lat,lon:r.attrs.lon}))};
    fs.writeFileSync(cachePath,JSON.stringify(cache,null,2)+'\n');
    console.log(a.id+': '+cache[a.address].results.map(r=>r.label).join(' | '));
  }catch(error){console.log(a.id+': FAILED '+error.message);}
  await new Promise(resolve=>setTimeout(resolve,300));
}
}
