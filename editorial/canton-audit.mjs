import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadCatalog} from './quality.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const official=JSON.parse(fs.readFileSync(path.join(here,'municipalities-2026.json'),'utf8'));
const records=loadCatalog().ACTIVITIES.filter(a=>!['closed','excluded'].includes(a.status));
const normalize=value=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s*\(FR\)/gi,'').replace(/[^a-z0-9]/gi,'').toLowerCase();

// Only documented locality-to-municipality identities belong here; leave other towns unmatched.
const aliases={
  'Estavayer-le-Lac':'Estavayer',Font:'Estavayer',Forel:'Estavayer',Murist:'Estavayer',
  'Montagny-les-Monts':'Montagny (FR)',
  'Grangettes-près-Romont':'Grangettes',
  Pringy:'Gruyères',Epagny:'Gruyères','Moléson-sur-Gruyères':'Gruyères',
  Albeuve:'Haut-Intyamon',Enney:'Bas-Intyamon',
  Charmey:'Val-de-Charmey',Cerniat:'Val-de-Charmey',
  'Châtel-St-Denis':'Châtel-Saint-Denis','Les Paccots':'Châtel-Saint-Denis',Rathvel:'Châtel-Saint-Denis',Fruence:'Châtel-Saint-Denis',
  Schwarzsee:'Plaffeien',Oberschrot:'Plaffeien',Alterswil:'Tafers',
  Nant:'Mont-Vully',Môtier:'Mont-Vully',Praz:'Mont-Vully',Sugiez:'Mont-Vully',
  Jeuss:'Murten / Morat',Morat:'Murten / Morat',Murten:'Murten / Morat',
  Fribourg:'Fribourg / Freiburg',Lossy:'La Sonnaz','Avry-sur-Matran':'Avry',Bonnefontaine:'Le Mouret',
  Villarlod:'Gibloux',Farvagny:'Gibloux',Grolley:'Grolley-Ponthaux',Pont:'Le Flon',Bouloz:'Le Flon','Montet (Broye)':'Les Montets',
  'Fétigny':'Fétigny-Ménières','Villaz-Saint-Pierre':'Villaz',Besencens:'Saint-Martin (FR)',
  Onnens:'La Brillaz','Prez-vers-Noréaz':'Prez',Arconciel:"Bois-d'Amont",Middes:'Torny',
  Misery:'Misery-Courtion','Chapelle (Glâne)':'Rue',Domdidier:'Belmont-Broye',Gumefens:'Pont-en-Ogoz'
};
const byRegion=new Map();
for(const municipality of official.municipalities){
  if(!byRegion.has(municipality.region))byRegion.set(municipality.region,new Map());
  byRegion.get(municipality.region).set(normalize(municipality.name),municipality);
}
const byOfs=new Map(official.municipalities.map(m=>[m.ofs,[]]));
const unmatched=[];
for(const record of records){
  const name=aliases[record.town]||record.town;
  const municipality=byRegion.get(record.region)?.get(normalize(name));
  if(municipality)byOfs.get(municipality.ofs).push(record.id);
  else unmatched.push({id:record.id,town:record.town,region:record.region});
}
const recordsById=new Map(records.map(record=>[record.id,record]));
const categories=[...new Set(records.map(record=>record.category))].sort();
const municipalities=official.municipalities.map(m=>{
  const recordIds=byOfs.get(m.ofs);
  const categoryCounts=Object.fromEntries(categories.map(category=>[category,
    recordIds.filter(id=>recordsById.get(id).category===category).length]));
  return {...m,recordIds,categoryCounts,
    coverage:recordIds.length?'at-least-one-card':'no-mapped-card'};
});
const districts=Object.fromEntries([...byRegion].map(([region,items])=>[region,{
  municipalities:items.size,
  withMappedCard:municipalities.filter(m=>m.region===region&&m.recordIds.length).length,
  catalogCards:records.filter(a=>a.region===region).length
}]));
const report={checked:'2026-09-28',officialSource:official.source,officialYear:official.year,
  catalogueCards:records.length,municipalities:municipalities.length,districts,
  categoryPresence:Object.fromEntries(categories.map(category=>[category,{
    cards:records.filter(record=>record.category===category).length,
    municipalities:municipalities.filter(m=>m.categoryCounts[category]>0).length
  }])),
  caution:'A mapped card proves only one known venue, not exhaustive research. Unmapped localities may belong to a municipality already in this list. Tourism POI sitemaps also include nearby Vaud.',
  municipalitiesList:municipalities,unmatched};
if(!process.argv.includes('--stdout'))fs.writeFileSync(path.join(here,'canton-coverage.generated.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(process.argv.includes('--stdout')?report:{catalogueCards:report.catalogueCards,municipalities:report.municipalities,districts,unmatched:unmatched.length},null,2));
