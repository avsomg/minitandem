import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {loadCatalog,root} from './quality.mjs';
import {readPipelineInputs,validateCorrection} from './external-pipeline.mjs';
import {readExternalReviewInputs} from './external-review.mjs';

// Private-only tests check the catalogue against records that are not in the public repository (see docs/publication-scope.md).
// On a clean clone they are skipped with this message; in the owner's workspace they run.
const hasPrivate=file=>fs.existsSync(path.join(root,'editorial',file));
const SKIP_CORRECTIONS=fs.existsSync(path.join(root,'editorial','corrections'))?false:'private-only: editorial/corrections/ is not present (clean clone)';
const SKIP_RECEIPTS=hasPrivate('external-review-receipts.json')?false:'private-only: editorial/external-review-receipts.json is not present (clean clone)';
const catalogue=loadCatalog();
const byId=new Map(catalogue.ACTIVITIES.map(a=>[a.id,a]));
const ids=['bewegungsinsel','elki-giffers','elki-heitenried','fsg-chatel-parent-remaufens',
  'fritime-piccolo-bulle','conservatoire','elki-kerzers','chatonnaye-forest-cabin',
  'enney-sarine-play','hauteville-otavela-play','thusy-pont-la-ville',
  'montsalvens-lakeside-walk','familienkonzert-kerzers-2026'];

test('all thirteen October 2 corrections match the compiled catalogue, not just their status',{skip:SKIP_CORRECTIONS},()=>{
  const corrections=[...readPipelineInputs().corrections.values()].filter(c=>ids.includes(c.id));
  assert.equal(corrections.length,13);
  for(const correction of corrections){
    assert.equal(correction.status,'applied',correction.id);
    assert.equal(correction.appliedOn,'2026-10-02');
    validateCorrection(correction,byId.get(correction.id));
    const card=byId.get(correction.id);
    assert.ok(card.research.date>='2026-10-02',correction.id); // a later approved review may have moved the date on
    assert.ok(card.research.remaining.length,correction.id+' must retain its remaining uncertainties');
  }
});

test('new-season gym schedules agree with day filters and visit conditions',()=>{
  // bewegungsinsel: the full review of 3 November 2026 writes the start date out.
  for(const [id,day,start] of [['bewegungsinsel',1,'7 September 2026'],['elki-giffers',3,'09.09.2026'],['elki-heitenried',3,'season and holiday dates not published']]){
    const card=byId.get(id);
    assert.deepEqual(Array.from(card.days),[day]);
    assert.ok(card.schedule.includes(start));
    const displayed=JSON.stringify({schedule:card.schedule,research:card.research,practical:card.practical,notes:card.notes});
    assert.doesNotMatch(displayed,/2025|season 2026\/27 (?:to be (?:confirmed|clarified)|to confirm)/i);
  }
  const remaufens=byId.get('fsg-chatel-parent-remaufens');
  assert.equal(remaufens.practical.duration.value,60);
  assert.doesNotMatch(JSON.stringify(remaufens),/15:30–16:45/);
  assert.equal(byId.get('bewegungsinsel').min,null);
  // The approved review of 1 November 2026: the offer page gives the age only as about 3 years and no single venue, so both stay unknown.
  assert.equal(byId.get('elki-heitenried').min,null);
  assert.equal(byId.get('elki-heitenried').practical.indoor.value,null);
  assert.equal(remaufens.min,null);
  assert.equal(remaufens.priceKind,'unknown');
});

test('Piccolo does not borrow Saturdays from ordinary ludotheque hours',()=>{
  const card=byId.get('fritime-piccolo-bulle');
  assert.deepEqual(Array.from(card.days),[4]);
  assert.doesNotMatch(card.schedule,/Saturday|\bSat\b|2nd/);
  assert.ok(byId.get('ludo-gruyere-bulle').days.includes(6));
  assert.equal(card.priceKind,'free');
});

test('address fixes keep the original identity source of their external review receipt',{skip:SKIP_RECEIPTS},()=>{
  const {receipts:entries}=readExternalReviewInputs();
  for(const id of ids){
    const receipt=entries.find(r=>r.id===id);
    if(receipt)assert.equal(byId.get(id).sources[0].url,receipt.identityUrl,id);
  }
});

test('address fixes retain programme and access uncertainty',()=>{
  const conservatoire=byId.get('conservatoire');
  assert.match(conservatoire.address,/Louis-Braille 8.*B1\.10/);
  assert.match(conservatoire.notes.join(' '),/approximate/);
  assert.ok(conservatoire.sources.some(s=>s.url==='https://www.fr.ch/document/595626'));
  const kerzers=byId.get('elki-kerzers');
  assert.deepEqual(Array.from(kerzers.days),[]);
  assert.equal(kerzers.price,'Price to be confirmed'); // the full review of 1 November 2026 found no fee for the new season
  assert.match(byId.get('chatonnaye-forest-cabin').schedule,/free access.*not confirmed/);
  assert.match(byId.get('hauteville-otavela-play').schedule,/not (?:stated|published)/); // 'Schedule not published' since the full review of 3 November 2026
  assert.equal(byId.get('montsalvens-lakeside-walk').status,'check');
  assert.match(byId.get('montsalvens-lakeside-walk').notes.join(' '),/left bank.*detour/);
  assert.match(byId.get('montsalvens-lakeside-walk').practical.warnings[0],/left bank.*detour/);
  assert.equal(byId.get('montsalvens-lakeside-walk').practical.indoor.checked,'2026-10-02');
});

test('Kerzers concert uses its own event source and retains its published end time',()=>{
  const card=byId.get('familienkonzert-kerzers-2026');
  assert.ok(card.sources.some(s=>s.url==='https://www.refkirche-kerzers.ch/veranstaltung/57758'));
  assert.ok(!card.sources.some(s=>s.url.includes('/veranstaltung/55076')));
  assert.equal(card.events[0].date,'2026-12-12');
  assert.equal(card.events[0].end,'17:00');
  assert.equal(card.min,null);
  assert.equal(card.priceKind,'unknown');
});
