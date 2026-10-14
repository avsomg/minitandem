import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {addressQuery} from './geocode.mjs';

test('an empty, unknown or archived geocode selector never falls back to all cards',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-geocode-cli-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  fs.mkdirSync(path.join(directory,'editorial'));
  fs.copyFileSync(fileURLToPath(new URL('./geocode.mjs',import.meta.url)),path.join(directory,'editorial/geocode.mjs'));
  fs.writeFileSync(path.join(directory,'data.js'),'window.ACTIVITIES=[{id:"known",status:"active",address:"Cached address"},{id:"archived",status:"closed",address:"Cached address"}];');
  for(const name of ['data-reviewed.js','data-practical.js','regions.js'])fs.writeFileSync(path.join(directory,name),'');
  // Cached fixture addresses ensure even a regressed selector cannot make a network request.
  fs.writeFileSync(path.join(directory,'editorial/geocode-candidates.json'),JSON.stringify({'Cached address':{results:[]}}));
  for(const id of ['','missing','../other','archived']){
    const result=spawnSync(process.execPath,['editorial/geocode.mjs','--card='+id],{cwd:directory,encoding:'utf8',timeout:5000});
    assert.equal(result.status,1);assert.match(result.stderr,/(Invalid|Unknown or archived) geocode card/);
  }
  assert.equal(spawnSync(process.execPath,['editorial/geocode.mjs','--card=known'],{cwd:directory,timeout:5000}).status,0);
});
test('the search query starts at the street, without the venue name, floor or country',()=>{
  for(const [address,query] of [
    ['École enfantine du Jura, bâtiment C, Avenue du Général-Guisan 59, 1700 Fribourg','Avenue du Général-Guisan 59 1700 Fribourg'],
    ['Fribourg Centre – Restaurant Coop (4e étage), Avenue de la Gare 10, 1700 Fribourg','Avenue de la Gare 10 1700 Fribourg'],
    ['Salle communale de Farvagny, dans la salle de la scène, Rte de Fribourg 5, 1726 Farvagny, Switzerland','Rte de Fribourg 5 1726 Farvagny'],
    ['Maison de la Petite Enfance, Route des Arsenaux 23A, 1700 Fribourg','Route des Arsenaux 23A 1700 Fribourg'],
    ['Conservatoire Fribourg, Route Louis-Braille 8, 1763 Granges-Paccot, hall B1.10','Route Louis-Braille 8 1763 Granges-Paccot'],
    ['Avenue de la Gare 12, 1701 Fribourg','Avenue de la Gare 12 1701 Fribourg'],
    // Without a house number the earlier rule still applies: only known venue prefixes are dropped.
    ['Turnhalle Dorf, Plaffeien','Plaffeien'],['Dorfplatz, 1716 Plaffeien','Dorfplatz 1716 Plaffeien']
  ])assert.equal(addressQuery(address),query);
});
test('a refresh is only ever for one named card',()=>{
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./geocode.mjs',import.meta.url)),'--refresh'],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,1);assert.match(result.stderr,/one named card/);
});
