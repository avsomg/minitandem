import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {auditText,auditDirectory,auditWorkspace,groupOf,PRIVATE,privateContactsReport,readReviewedContacts,REVIEWED_CONTACTS,UNREVIEWED_ADVICE} from './public-audit.mjs';
import {CONTACT_RULE,contactDigest} from './contact-rule.mjs';

// Cyrillic is written as escapes so that this file passes its own audit.
const WORKING_TITLE='\u0412\u043c\u0435\u0441\u0442\u0435';
const MOTHER='\u043c\u0430\u043c\u044b';
const AGE='2,5 \u0433\u043e\u0434\u0430';

test('the audit finds one family\'s wording and the working title, and leaves agreed identifiers alone',()=>{
  assert.deepEqual(auditText('Admission under 3 is not confirmed. Parents stay with the child.'),{referenceChildAge:0,motherWording:0,workingTitle:0,cyrillicWords:0});
  const personal=auditText(`Admission at ${AGE} to be agreed; the presence of ${MOTHER} is required. <title>${WORKING_TITLE}</title>`);
  assert.equal(personal.referenceChildAge,1);assert.equal(personal.motherWording,1);assert.equal(personal.workingTitle,1);assert.ok(personal.cyrillicWords>=3);
  assert.equal(auditText('children aged 2.5 years and older').referenceChildAge,1);
  assert.equal(auditText('ab 2,5 Jahren').referenceChildAge,1);
  assert.equal(auditText('\u043c\u0430\u043c\u043e\u043d\u0442 and a programme').motherWording,0);
  assert.equal(auditText("type='vmeste-plan',kind='vmeste-correction';").workingTitle,0);
  assert.equal(auditText('window.VmestePlanning=1;').workingTitle,1);
});
test('the earlier storage key names are exempt in the migration file only',()=>{
  const text="const KEY='vmeste-family-v1',SYNC='vmeste-sync-v1',QUEUE='vmeste-pending-corrections-v1',FILTERS='vmeste-family-v1-filters';";
  assert.equal(auditText(text).workingTitle,4);
  assert.equal(auditText(text,'app.js').workingTitle,4);
  assert.equal(auditText(text,'storage-migration.js').workingTitle,0);
  assert.equal(auditText(text,'sub/storage-migration.js').workingTitle,0);
  assert.equal(auditText(text+" const NAME='The Vmeste app';",'storage-migration.js').workingTitle,1,'anything else in the migration file still counts');
});
test('the project identifier is exempt only as a stored value, not as a name',()=>{
  assert.equal(auditText("const PROJECT_ID='vmeste';").workingTitle,0);
  assert.equal(auditText('{"project": "vmeste"}').workingTitle,0);
  assert.equal(auditText("os.tmpdir(),'vmeste-source-'").workingTitle,1);
  assert.equal(auditText('The vmeste catalogue').workingTitle,1);
  assert.equal(auditText('https://vmeste-sense.vercel.app').workingTitle,1);
});
test('the directory report totals readable files and skips hidden folders',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-audit-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  fs.mkdirSync(path.join(directory,'places'));fs.mkdirSync(path.join(directory,'.vercel'));
  fs.writeFileSync(path.join(directory,'index.html'),`<title>${WORKING_TITLE}</title>`);
  fs.writeFileSync(path.join(directory,'places','a.html'),`Admission at ${AGE}`);
  fs.writeFileSync(path.join(directory,'.vercel','project.json'),'{"name":"vmeste-sense"}');
  fs.writeFileSync(path.join(directory,'photo.jpg'),WORKING_TITLE);
  const report=auditDirectory(directory);
  assert.equal(report.totals.workingTitle,1);assert.equal(report.totals.referenceChildAge,1);
  assert.deepEqual(report.files.map(row=>row.file).sort(),['index.html',path.join('places','a.html')]);
});
test('the workspace audit sorts files into groups and never reads private state',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-audit-workspace-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const write=(file,text)=>{fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),text);};
  write('data.js',`window.ACTIVITIES=[{name:'${WORKING_TITLE}'}];`);
  write('editorial/jobs.mjs',"const PROJECT_ID='vmeste';");
  write('editorial/workflow.mjs',"const UA='VmesteEvidence';");
  write('app.js',WORKING_TITLE);
  write('storage-migration.js',"const OLD='vmeste-family-v1';");
  write('editorial/OPERATIONS.md',WORKING_TITLE);
  write('editorial/external-review-receipts.json',`["${WORKING_TITLE}"]`);
  write('archive-ru/data.js',WORKING_TITLE);
  write('.gitignore',PRIVATE.join('\n'));
  const report=auditWorkspace(root);
  assert.deepEqual(report.groups.data.files.map(row=>row.file),['data.js']);
  assert.deepEqual(report.groups.editorial.files.map(row=>row.file),['editorial/workflow.mjs']);
  assert.deepEqual(report.groups.ui.files.map(row=>row.file),['app.js'],'the migration file may hold the old key names');
  assert.deepEqual(report.groups.docs.files.map(row=>row.file),['editorial/OPERATIONS.md']);
  assert.deepEqual(report.privateNotIgnored,[]);
  fs.writeFileSync(path.join(root,'.gitignore'),'node_modules/\n');
  assert.ok(auditWorkspace(root).privateNotIgnored.includes('archive-ru/'));
  assert.ok(auditWorkspace(root).privateNotIgnored.includes('editorial/external-review-receipts.json'));
});
test('groups: interface files, data files and pipeline code are told apart',()=>{
  for(const [file,group] of [['app.js','ui'],['i18n.js','ui'],['strings-de.js','ui'],['storage-migration.js','ui'],['i18n.test.mjs','ui'],['test-support.mjs','ui'],['views.js','ui'],['index.html','ui'],['verify-mobile.mjs','ui'],['catalog.test.mjs','ui'],['editorial/admin.js','ui'],['server.mjs','ui'],
    ['data.js','data'],['regions.js','data'],['editorial/geocode-candidates.json','data'],['editorial/approved-updates.json','data'],
    ['editorial/workflow.mjs','editorial'],['editorial/workflow.test.mjs','editorial'],['build.mjs','editorial'],['editorial/agent-policy.json','data'],
    ['editorial/OPERATIONS.md','docs'],['editorial/external-candidates/a.json','private'],['archive-ru/data.js','private']])
    assert.equal(groupOf(file),group,file);
});

test('code and documentation are checked for Cyrillic and the old name only; the audit does not audit itself',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-audit-groups-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const write=(file,text)=>{fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),text);};
  write('editorial/calibration-cases.mjs',"check('min',2.5,'approve','ab 2.5 Jahren');");
  write('editorial/public-audit.mjs',`const NAME='${WORKING_TITLE}';`);
  write('data.js','window.ACTIVITIES = [\n'+
    '    {"id":"a","name":"Own bound","min":2.5,"max":null,"age":"From 2.5 years"},\n'+
    '    {"route":"x","id":"b","name":"Also own bound","min":null,"max":2.5,"age":"Up to 2.5 years"},\n'+
    '    {"id":"c","name":"Leak","min":3,"max":null,"age":"For a child of 2.5 years"}\n  ];\n');
  write('research.md','# Catalogue\n\n## Own bound\n\n- Age: From 2.5 years\n\n## Leak\n\n- Age: For a child of 2.5 years\n');
  write('.gitignore',PRIVATE.join('\n'));
  const report=auditWorkspace(root);
  assert.deepEqual(report.groups.editorial.files,[]);
  assert.deepEqual(report.groups.data.files.map(row=>[row.file,row.referenceChildAge]),[['data.js',1],['research.md',1]]);
});

// Private contacts (decision of 14 October 2026). The numbers are invented and joined at run time, so that no line of this file holds one.
const mobile=(separator=' ')=>['079','000','00','00'].join(separator);
test('private contacts: a mobile number in a catalogue file or the built site fails, digits in web addresses and third-party bundles do not',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-audit-contacts-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const write=(file,text)=>{fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),text);};
  const office={name:'Office',phone:'026 000 00 00',email:'info@example.org'};
  const reviewed={reviewedOn:'2026-10-14',rule:CONTACT_RULE,digests:[contactDigest(office)]};
  write('data.js',`window.ACTIVITIES=[{"id":"a","contacts":[{"name":"Office","phone":"026 000 00 00","email":"info@example.org"}],"sources":[{"url":"https://example.org/${mobile('')}"}]}];`);
  write('research.md','## A\n\n- Contact: Office; 026 000 00 00\n- [Source](https://example.org/p/'+mobile('-')+')\n');
  write('.publish/places/a/index.html','<p>Office</p>');
  write('.publish/assets/leaflet.js','var x="'+mobile('')+'";');
  write('notes.md','A note that is not a catalogue file: '+mobile());
  const clean=privateContactsReport(root,{records:[{id:'a',contacts:[office]}],reviewed});
  assert.deepEqual(clean,{contacts:1,mobileNumbers:[],unreviewed:[],failing:false});
  write('research.md','## A\n\n- Contact: Office; '+mobile()+'\n- Ask for '+mobile('')+' at the desk.\n');
  write('.publish/places/a/index.html','<p>Office '+mobile('.')+'</p>');
  write('data-reviewed.js','window.APPROVED_UPDATES=[{"note":"+41 '+mobile().slice(1)+'"}];');
  const failing=privateContactsReport(root,{records:[{id:'a',contacts:[office]}],reviewed});
  assert.equal(failing.failing,true);
  assert.deepEqual(failing.mobileNumbers,[{file:'data-reviewed.js',mobileNumbers:1},{file:'research.md',mobileNumbers:2},{file:'.publish/places/a/index.html',mobileNumbers:1}]);
  assert.equal(JSON.stringify(failing).includes('000 00'),false,'the report names files and counts, never a number');
});
test('private contacts: every contact of the assembled catalogue must be on the reviewed list, reported by card and position only',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-audit-reviewed-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const office={name:'Office',phone:'026 000 00 00',email:'info@example.org'},desk={name:'Desk',email:'desk@example.org'};
  const records=[{id:'a',contacts:[office]},{id:'b',contacts:[office,desk]},{id:'c',contacts:[]}];
  // No list yet: every contact is unreviewed.
  assert.deepEqual(readReviewedContacts(path.join(root,REVIEWED_CONTACTS)).digests,[]);
  assert.deepEqual(privateContactsReport(root,{records}).unreviewed,[{card:'a',position:'contacts[0]'},{card:'b',position:'contacts[0]'},{card:'b',position:'contacts[1]'}]);
  fs.mkdirSync(path.join(root,'editorial'));
  fs.writeFileSync(path.join(root,REVIEWED_CONTACTS),JSON.stringify({reviewedOn:'2026-10-14',rule:CONTACT_RULE,digests:[contactDigest(office)]}));
  const report=privateContactsReport(root,{records});
  assert.deepEqual(report.unreviewed,[{card:'b',position:'contacts[1]'}]);assert.equal(report.failing,true);assert.equal(report.contacts,3);
  assert.equal(JSON.stringify(report).includes('Desk')||JSON.stringify(report).includes('desk@'),false,'no contact value in the report');
  // A missing field counts as empty: the same contact written with phone '' is the reviewed one.
  fs.writeFileSync(path.join(root,REVIEWED_CONTACTS),JSON.stringify({reviewedOn:'2026-10-14',rule:CONTACT_RULE,digests:[contactDigest(office),contactDigest({...desk,phone:''})]}));
  assert.equal(privateContactsReport(root,{records}).failing,false);
  assert.match(UNREVIEWED_ADVICE,/check that it is an organisation contact first/);assert.match(UNREVIEWED_ADVICE,/Only the main chat or the owner records it, with --accept/);
  fs.writeFileSync(path.join(root,REVIEWED_CONTACTS),JSON.stringify({digests:['Office']}));
  assert.throws(()=>readReviewedContacts(path.join(root,REVIEWED_CONTACTS)),/must hold/);
});

