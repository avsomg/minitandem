// A button that cannot be pressed yet looks it, and the "Your data and backup" dialog says why the addresses button is off.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {loadStack,root} from './test-support.mjs';

const clock={today:'2026-10-17',nowHm:'10:00'};

test('a button that cannot be pressed yet looks it, and the data dialog says why next to the addresses button',()=>{
  const css=fs.readFileSync(path.join(root,'styles.css'),'utf8');
  const rule=css.match(/(?:^|\n)(\.ghost:disabled[^{]*\{[^}]*\})/)?.[1]||'';
  assert.match(rule,/\.go:disabled/);assert.match(rule,/background: transparent/);assert.match(rule,/dashed/);assert.match(rule,/cursor: not-allowed/);
  const WHY={en:'Available once you have saved an activity.',de:'Verfügbar, sobald Sie ein Angebot gemerkt haben.',fr:'Disponible dès que vous avez enregistré une activité.'};
  for(const lang of ['en','de','fr']){
    const S=loadStack({...clock,lang}),empty=S.V.data(null,false,true).body,saved=S.V.data(null,true,true).body;
    assert.match(empty,/data-action="offline-addresses" disabled aria-describedby="trip-why"/,lang);
    assert.ok(empty.includes(`<p class="hint why" id="trip-why">${WHY[lang]}</p>`),lang);
    assert.doesNotMatch(saved,/trip-why|offline-addresses" disabled/,lang+': with a saved activity the button is active and says nothing');
    assert.ok(empty.indexOf('trip-why">')>empty.indexOf('offline-addresses'),lang+': the reason follows the button');
  }
});
