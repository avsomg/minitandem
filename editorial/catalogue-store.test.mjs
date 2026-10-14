import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {buildCatalogueSnapshot,inspectCatalogueSnapshot,exportCatalogue} from './catalogue-store.mjs';
import {digest} from './jobs.mjs';

const card={id:'one',name:'Family meeting',town:'Fribourg',category:'play',format:'event',status:'check',min:null,max:null,
  age:'Age to be confirmed',parent:'unknown',address:'Main 1',priceKind:'unknown',price:'Price not published',amount:null,
  events:[{date:'2026-10-03',start:'09:00',end:'10:00',address:'Other entrance 2'}],sources:[{url:'https://example.org/course',label:'Organiser'}],
  practical:{booking:{value:null,text:'Booking to be confirmed'}},research:{remaining:['Language?'],findings:[]},customPublicField:{nested:[0,false,'Details']}};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-catalogue-db-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'snapshot.sqlite');}
test('staging preserves all public record fields and date-specific venues without elevating unknown facts',t=>{
  const file=fixture(t),records=[card,{...card,id:'two',status:'closed'}],registry={schema:1,groups:[{id:'venue',label:'Venue',cardIds:['one','two']}]};
  const report=buildCatalogueSnapshot(records,registry,file);assert.equal(report.explicitVenueGroups,1);assert.equal(report.publicRecords,1);
  assert.equal(report.factVerificationUpgraded,false);assert.equal(report.tariffUnitsParsed,false);
  const db=new DatabaseSync(file,{readOnly:true});try{assert.equal(digest(exportCatalogue(db)),digest(records));}finally{db.close();}
  assert.throws(()=>buildCatalogueSnapshot(records,registry,file),/immutable/);
});
test('staging does not guess venue grouping and rejects stale or corrupted indexes',t=>{
  const file=fixture(t),records=[card,{...card,id:'two'}];buildCatalogueSnapshot(records,{schema:1,groups:[]},file);
  assert.equal(inspectCatalogueSnapshot(file).unlinkedOffers,2);
  assert.throws(()=>inspectCatalogueSnapshot(file,{expectedRevision:'other'}),/revision mismatch/);
  const db=new DatabaseSync(file);db.prepare('UPDATE offers SET min_age=? WHERE id=?').run(3,'one');db.close();
  assert.throws(()=>inspectCatalogueSnapshot(file),/index mismatch/);
});
