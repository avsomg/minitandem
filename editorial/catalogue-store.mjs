import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {root,loadCatalog} from './quality.mjs';
import {digest} from './jobs.mjs';
import {venueGroups} from './external-pipeline.mjs';
import {writeJsonAtomic} from './evidence.mjs';
import {PROJECT_ID} from './project-id.mjs';

// A lossless staging projection. The production compiler still reads the reviewed catalogue.
export function buildCatalogueSnapshot(records,registry,destination){
  if(!Array.isArray(records)||records.some(r=>!r.id)||new Set(records.map(r=>r.id)).size!==records.length)throw Error('Invalid catalogue identities');
  if(fs.existsSync(destination))throw Error('Catalogue snapshot is immutable; use a new destination');
  const groups=venueGroups(records,registry),byId=new Map(records.map(r=>[r.id,r])),temporary=destination+'.tmp-'+randomUUID();
  fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
  const db=new DatabaseSync(temporary);fs.chmodSync(temporary,0o600);let verified=false;
  try{
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
      CREATE TABLE venues(id TEXT PRIMARY KEY,label TEXT NOT NULL,address TEXT NOT NULL,identity_kind TEXT NOT NULL CHECK(identity_kind IN ('explicit-group','unlinked-offer'))) STRICT;
      CREATE TABLE offers(id TEXT PRIMARY KEY,ordinal INTEGER UNIQUE NOT NULL,name TEXT NOT NULL,town TEXT NOT NULL,category TEXT NOT NULL,format TEXT NOT NULL,status TEXT NOT NULL,min_age REAL,max_age REAL,body TEXT NOT NULL CHECK(json_valid(body))) STRICT;
      CREATE TABLE offer_venues(offer_id TEXT PRIMARY KEY REFERENCES offers(id),venue_id TEXT NOT NULL REFERENCES venues(id)) STRICT;
      CREATE TABLE occurrences(offer_id TEXT NOT NULL REFERENCES offers(id),ordinal INTEGER NOT NULL,date TEXT NOT NULL,start TEXT,end TEXT,body TEXT NOT NULL CHECK(json_valid(body)),PRIMARY KEY(offer_id,ordinal)) STRICT;
      CREATE TABLE tariffs(offer_id TEXT PRIMARY KEY REFERENCES offers(id),kind TEXT NOT NULL,amount REAL,description TEXT NOT NULL,unit_status TEXT NOT NULL CHECK(unit_status='unparsed-published-text')) STRICT;
      CREATE TABLE sources(id TEXT PRIMARY KEY,url TEXT UNIQUE NOT NULL) STRICT;
      CREATE TABLE offer_sources(offer_id TEXT NOT NULL REFERENCES offers(id),ordinal INTEGER NOT NULL,source_id TEXT NOT NULL REFERENCES sources(id),label TEXT NOT NULL,PRIMARY KEY(offer_id,ordinal)) STRICT;
      CREATE TABLE catalogue_facts(offer_id TEXT NOT NULL REFERENCES offers(id),field TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),verification_state TEXT NOT NULL CHECK(verification_state='inherited-catalogue-value'),PRIMARY KEY(offer_id,field)) STRICT;
      CREATE INDEX offers_filter ON offers(status,category,format,town);
      CREATE INDEX occurrences_date ON occurrences(date,start);
      CREATE INDEX sources_offer ON offer_sources(source_id);
      BEGIN IMMEDIATE;`);
    const meta=db.prepare('INSERT INTO metadata VALUES (?,?)');
    for(const [key,value] of Object.entries({project:PROJECT_ID,schema:'1',purpose:'staging-only',revision:digest(records),registryRevision:digest(registry)}))meta.run(key,value);
    const venue=db.prepare('INSERT INTO venues VALUES (?,?,?,?)');
    for(const group of registry.groups)venue.run(group.id,group.label,byId.get(group.cardIds[0]).address,'explicit-group');
    const offer=db.prepare('INSERT INTO offers VALUES (?,?,?,?,?,?,?,?,?,?)'),link=db.prepare('INSERT INTO offer_venues VALUES (?,?)');
    const occurrence=db.prepare('INSERT INTO occurrences VALUES (?,?,?,?,?,?)'),tariff=db.prepare('INSERT INTO tariffs VALUES (?,?,?,?,?)');
    const source=db.prepare('INSERT OR IGNORE INTO sources VALUES (?,?)'),reference=db.prepare('INSERT INTO offer_sources VALUES (?,?,?,?)');
    const fact=db.prepare('INSERT INTO catalogue_facts VALUES (?,?,?,?)');
    records.forEach((r,index)=>{
      offer.run(r.id,index,r.name,r.town,r.category,r.format,r.status,r.min??null,r.max??null,JSON.stringify(r));
      const venueId=groups.get(r.id)||'unlinked:'+r.id;
      if(!groups.has(r.id))venue.run(venueId,r.name,r.address||'','unlinked-offer');
      link.run(r.id,venueId);
      (r.events||[]).forEach((e,n)=>occurrence.run(r.id,n,e.date,e.start||null,e.end||null,JSON.stringify(e)));
      tariff.run(r.id,r.priceKind,r.amount??null,r.price,'unparsed-published-text');
      (r.sources||[]).forEach((s,n)=>{const id=digest(s.url);source.run(id,s.url);reference.run(r.id,n,id,s.label||'');});
      for(const [key,value] of Object.entries(r.practical||{}))fact.run(r.id,key,JSON.stringify(value),'inherited-catalogue-value');
    });
    db.exec('COMMIT');verifyCatalogueDatabase(db,{expectedRevision:digest(records)});verified=true;
  }finally{db.close();if(!verified)fs.rmSync(temporary,{force:true});}
  try{fs.renameSync(temporary,destination);}finally{fs.rmSync(temporary,{force:true});}
  return inspectCatalogueSnapshot(destination);
}
export function exportCatalogue(db){return db.prepare('SELECT body FROM offers ORDER BY ordinal').all().map(r=>JSON.parse(r.body));}
export function verifyCatalogueDatabase(db,{expectedRevision=null}={}){
  const metadata=Object.fromEntries(db.prepare('SELECT * FROM metadata').all().map(r=>[r.key,r.value]));
  if(metadata.project!==PROJECT_ID||metadata.schema!=='1'||metadata.purpose!=='staging-only')throw Error('Wrong catalogue database identity or purpose');
  if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Catalogue database integrity failed');
  const records=exportCatalogue(db),revision=digest(records);
  if(revision!==metadata.revision||expectedRevision&&revision!==expectedRevision)throw Error('Catalogue round-trip revision mismatch');
  for(const r of records){
    const row=db.prepare('SELECT * FROM offers WHERE id=?').get(r.id);
    if(digest([row.name,row.town,row.category,row.format,row.status,row.min_age,row.max_age])!==digest([r.name,r.town,r.category,r.format,r.status,r.min??null,r.max??null]))throw Error('Catalogue filter index mismatch');
    const eventRows=db.prepare('SELECT * FROM occurrences WHERE offer_id=? ORDER BY ordinal').all(r.id);
    const dates=eventRows.map(e=>JSON.parse(e.body));
    if(digest(dates)!==digest(r.events||[]))throw Error('Catalogue occurrence mismatch');
    for(const e of eventRows){const value=JSON.parse(e.body);if(digest([e.date,e.start,e.end])!==digest([value.date,value.start||null,value.end||null]))throw Error('Catalogue occurrence index mismatch');}
    const tariff=db.prepare('SELECT kind,amount,description FROM tariffs WHERE offer_id=?').get(r.id);
    if(digest(tariff)!==digest({kind:r.priceKind,amount:r.amount??null,description:r.price}))throw Error('Catalogue tariff mismatch');
    const facts=Object.fromEntries(db.prepare('SELECT field,body FROM catalogue_facts WHERE offer_id=? ORDER BY field').all(r.id).map(f=>[f.field,JSON.parse(f.body)]));
    const expectedFacts=Object.fromEntries(Object.entries(r.practical||{}).sort(([a],[b])=>a.localeCompare(b)));
    if(digest(facts)!==digest(expectedFacts))throw Error('Catalogue practical fact mismatch');
    const sources=db.prepare('SELECT s.url,r.label FROM offer_sources r JOIN sources s ON s.id=r.source_id WHERE r.offer_id=? ORDER BY ordinal').all(r.id);
    if(digest(sources)!==digest((r.sources||[]).map(s=>({url:s.url,label:s.label||''}))))throw Error('Catalogue source mismatch');
  }
  return {metadata,records};
}
export function inspectCatalogueSnapshot(file,{expectedRevision=null}={}){
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    const {metadata,records}=verifyCatalogueDatabase(db,{expectedRevision});
    return {project:PROJECT_ID,file,revision:metadata.revision,records:records.length,
      publicRecords:records.filter(r=>!['closed','excluded'].includes(r.status)).length,
      explicitVenueGroups:db.prepare("SELECT count(*) AS n FROM venues WHERE identity_kind='explicit-group'").get().n,
      unlinkedOffers:db.prepare("SELECT count(*) AS n FROM venues WHERE identity_kind='unlinked-offer'").get().n,
      occurrences:db.prepare('SELECT count(*) AS n FROM occurrences').get().n,
      sources:db.prepare('SELECT count(*) AS n FROM sources').get().n,
      productionSourceChanged:false,tariffUnitsParsed:false,factVerificationUpgraded:false};
  }finally{db.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const directory=path.join(root,'editorial/catalogue-runtime'),records=loadCatalog().ACTIVITIES,revision=digest(records),file=path.join(directory,revision+'.sqlite');
  if(process.argv[2]==='stage'){
    const registry=JSON.parse(fs.readFileSync(path.join(root,'editorial/external-venues.json'),'utf8'));
    const report=fs.existsSync(file)?inspectCatalogueSnapshot(file,{expectedRevision:revision}):buildCatalogueSnapshot(records,registry,file);
    await writeJsonAtomic(path.join(directory,'latest.json'),{...report,generatedAt:new Date().toISOString()});console.log(JSON.stringify(report,null,2));
  }else if(process.argv[2]==='compare')console.log(JSON.stringify(inspectCatalogueSnapshot(file,{expectedRevision:revision}),null,2));
  else throw Error('Use stage or compare; this database is not the production source');
}
