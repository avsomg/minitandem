import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {releaseSummary,staleTranslations} from './release-summary.mjs';
import {loadCatalog} from './quality.mjs';

const baseRecord={id:'meeting',name:'Family meeting',format:'group',min:null,max:null,parent:'yes',languages:[],priceKind:'unknown',practical:{booking:{value:true}},research:{remaining:['Is the session in German?']}};
const journal={schema:1,project:'vmeste',updates:[{jobId:'review',approvedOn:'2026-10-15',baseRecord,approval:{verdict:'approve'},
  draft:{cardId:'meeting',patch:{min:2,max:4},practicalPatch:{booking:{value:false}},remaining:[],findings:[{text:'Published age range and no advance registration.',url:'https://example.org/meeting'}],
    snapshots:[{text:'PRIVATE ORIGINAL MUST NOT APPEAR'}],bindings:[{source:'https://example.org/meeting',quote:'PRIVATE QUOTE MUST NOT APPEAR'}]}}]};
test('the owner summary shows exact changes, evidence links, remaining unknowns and version-bound checks',()=>{
  const text=releaseSummary({journal,qa:{checks:['unit','public-audit','public-scan']},qaCurrent:true,buildInfo:{revision:'build-one',records:1},stale:{de:['meeting'],fr:[]},generatedOn:'2026-10-15'});
  assert.match(text,/minimum age: unknown → 2/);assert.match(text,/maximum age: unknown → 4/);assert.match(text,/booking: true → false/);
  assert.match(text,/Sources: https:\/\/example.org\/meeting\. Approved: 2026-10-15/);
  assert.match(text,/Still unknown: session language, price/);assert.match(text,/Is the session in German/);
  assert.match(text,/Checks passed for this version: unit, public-audit, public-scan/);
  assert.match(text,/German needs update; French current/);assert.doesNotMatch(text,/PRIVATE/);
});
test('stale or missing QA cannot be described as checks passed, and private fields and paths are omitted',()=>{
  const privatePath=['','Users','someone','private'].join('/');
  const modified=structuredClone(journal);modified.familyData='FAMILY MUST NOT APPEAR';modified.updates[0].draft.findings[0].text=privatePath;
  const text=releaseSummary({journal:modified,qa:{checks:['unit']},qaCurrent:false});
  assert.match(text,/receipt is stale or incomplete/);assert.match(text,/Checks passed for this version: none established/);
  assert.ok(!text.includes(privatePath));assert.doesNotMatch(text,/FAMILY|PRIVATE QUOTE|PRIVATE ORIGINAL/);
  assert.match(releaseSummary({journal}),/no QA receipt/);
});
test('the stale list reads the same public translation layers as the page, including missing translations',()=>{
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),record=loadCatalog().ACTIVITIES[0];
  const changed={...record,name:record.name+' updated'},stale=staleTranslations(root,[changed,{...changed,id:'new-untranslated-card'}]);
  for(const lang of ['de','fr'])assert.deepEqual([...stale[lang]].sort(),[record.id,'new-untranslated-card'].sort());
});
