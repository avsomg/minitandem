import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const context={window:{},structuredClone};
for(const file of ['data.js','data-reviewed.js','data-practical.js','regions.js'])vm.runInNewContext(fs.readFileSync(path.join(root,file),'utf8'),context);
const cache=JSON.parse(fs.readFileSync(path.join(root,'editorial/geocode-candidates.json'),'utf8'));
const normal=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\brte\b/g,'route').replace(/\bimp\b/g,'impasse');
const contains=(text,part)=>(' '+normal(text)+' ').includes(' '+normal(part)+' ');
const matches=[];
for(const a of context.window.ACTIVITIES){
  if(['closed','excluded'].includes(a.status))continue;
  const candidate=cache[a.address];if(!candidate)continue;
  // Require an exact street-and-number sequence, postcode and town, not the search score.
  const hits=candidate.results.filter(r=>{
    const parts=r.label.match(/^(.*?)\s+(\d{4})\s+(.+)$/);
    const town=parts?.[3].replace(/\s*\([^)]*\)\s*$/,'').replace(/\s+FR$/i,'');
    const postcode=a.address.match(/\b\d{4}\b/)?.[0];
    return parts&&/\d+[a-z]?(?:\.\d+)?$/i.test(parts[1])&&contains(a.address,parts[1])&&(!postcode||postcode===parts[2])&&contains(a.address,town)&&r.lat>45.8&&r.lat<47.2&&r.lon>6.5&&r.lon<7.8;
  });
  if(hits.length!==1)continue;
  matches.push({id:a.id,address:a.address,geo:{...hits[0],source:candidate.source,checked:candidate.checked,precision:'address'}});
}
const code='/* Generated from exact public-address matches; not entrance coordinates. */\n(() => {\n  const data='+JSON.stringify(matches,null,2)+';\n  const byId=new Map(window.ACTIVITIES.map(a=>[a.id,a]));\n  for(const item of data){const a=byId.get(item.id);if(a&&a.address===item.address)a.geo=item.geo;}\n})();\n';
fs.writeFileSync(path.join(root,'data-geo.js'),code);
console.log(JSON.stringify(matches.map(r=>({id:r.id,address:r.geo.label})),null,2));
