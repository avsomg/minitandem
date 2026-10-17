// Mobile flow on an iPhone 15 (393 x 852) in the selected engine: the release check "mobile-flow".
// It drives the real interface: the list and its bounded batches, the filter sheet, the way back to the filters, the card page,
// saved records and their merge between tabs, downloads, the map, the three languages, and the layout from 320 px to desktop.
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {loadPlaywright} from './playwright-loader.mjs';
import {engineName,artifactDirectory,serveSite,prepareContext,contextOptions,targets,expectFocus} from './scripts/browser-support.mjs';
const engine=engineName(),playwright=loadPlaywright();
const screenshots=artifactDirectory('mobile');
const fixture=await serveSite(),url=fixture.url;
const FAMILY='minitandem-family-v1';
let browser;
try{
  browser=await playwright[engine].launch({headless:true});
  const context=await browser.newContext(contextOptions(targets[0]));
  const errors=await prepareContext(context,url);
  const page=await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(url);
  await page.waitForSelector('#list .row');
  const noOverflow=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'horizontal overflow');
  const rows=()=>page.locator('#list .row').count();
  const catalogTotal=await page.evaluate(()=>ACTIVITIES.filter(a=>!['closed','excluded'].includes(a.status)).length);

  // First screen: a bounded batch, "show more", and no filter control stays fixed while the list scrolls.
  assert.equal(await rows(),24);
  assert.equal(await page.evaluate(()=>document.documentElement.lang),'en');
  assert.match(await page.locator('#moreBtn').textContent(),new RegExp(`24 of ${catalogTotal}`));
  assert.match(await page.locator('#count').textContent(),new RegExp(`${catalogTotal} activities`));
  const sticky=await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(el=>['fixed','sticky'].includes(getComputedStyle(el).position)&&el.getClientRects().length).map(el=>el.tagName+'#'+el.id+'.'+el.className));
  assert.deepEqual(sticky,[],'Nothing may be fixed or sticky on a phone');
  await page.screenshot({path:path.join(screenshots,'iphone15-list.png')});
  await page.evaluate(()=>window.scrollTo(0,1400));
  assert.equal(await page.locator('#fbar').evaluate(el=>el.getBoundingClientRect().bottom<0),true,'The filter row scrolls away with the page');
  await page.evaluate(()=>window.scrollTo(0,0));
  assert.equal(await page.locator('#search').count()+await page.locator('#q').count(),1);
  assert.equal(await page.locator('#q').evaluate(el=>getComputedStyle(el).fontSize),'16px');

  // Tap targets of at least 44 px for everything pressed with a thumb on the first screen.
  for(const selector of ['#langSeg button','.tab','.fp','#moreBtn']){
    for(const el of await page.locator(selector).all()){
      const box=await el.boundingBox();assert(box.width>=44&&box.height>=44,'Tap target below 44px: '+selector);assert(box.x>=0&&box.x+box.width<=393,'Off screen: '+selector);
    }
  }
  for(const el of (await page.locator('#list .row').all()).slice(0,5))assert((await el.boundingBox()).height>=44,'Row below 44px');

  // The bounded batch and the way back to the filters, also at the end of a long list.
  await page.locator('#moreBtn').click();
  assert.equal(await rows(),48);
  await noOverflow();
  assert.equal(await page.locator('#endnav').isVisible(),true);
  await page.locator('#toFilters').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#toFilters').evaluate(el=>getComputedStyle(el.closest('#endnav')).position),'static','Back to filters is a plain block, never floating');
  await page.locator('#toFilters').click();
  await expectFocus(page,'#fpAge','Back to the filters moves focus to the age control');
  assert.equal(await page.locator('#q').evaluate(el=>el.getBoundingClientRect().top>=0&&el.getBoundingClientRect().top<400),true,'The search field is back in view');

  // Filter sheet: district, then the count and the reset.
  await page.locator('#fpMore').click();
  assert.equal(await page.locator('#sheet').evaluate(el=>el.open),true);
  for(const el of await page.locator('#sheet .chip,#sheet #sheetDone,#sheet #sheetClose,#sheet .switch').all()){
    if(!await el.isVisible())continue;
    const box=await el.boundingBox();assert(box.height>=44,'Sheet control below 44px');
  }
  for(const el of await page.locator('#sheet select.field').all())assert((await el.boundingBox()).height>=44,'Select below 44px');
  await page.screenshot({path:path.join(screenshots,'iphone15-sheet.png')});
  await page.locator('#place').selectOption('d:gruyere');
  await page.locator('#sheetDone').click();
  assert.equal(await rows(),24,'The district filter uses the same bounded batches');
  assert.match(await page.locator('#fpPlaceV').textContent(),/Gruy/);
  assert.match(await page.locator('#fcount').textContent(),/1 filter active/);
  await page.locator('[data-open="fritime-piccolo-bulle"]').first().waitFor().catch(()=>{});
  await page.locator('#q').fill('Fritime Piccolo');
  await page.locator('#list .row[data-id="fritime-piccolo-bulle"]').click();
  assert.equal(await page.locator('#detail').evaluate(el=>el.open),true);
  assert.equal(await page.locator('#detail a.go').count(),1,'One primary action: open the organiser\'s page');
  assert.equal(await page.locator('#detail a[href="https://ludothequegruyere.ch/fritime-piccolo/"]').count()>0,true);
  await page.screenshot({path:path.join(screenshots,'iphone15-card.png')});
  await page.locator('#detail [data-close]').click();
  await page.waitForFunction(()=>!document.querySelector('#detail').open);

  // Filters survive a reload; browser back and forward move between the list and the card.
  await page.locator('#q').fill('');
  await page.reload();await page.waitForSelector('#list .row');
  assert.equal(await page.locator('#place').inputValue(),'d:gruyere','District filter must survive reload');
  await page.locator('#q').fill('Hostellerie');
  assert.equal(await page.locator('#list .row[data-id="hostellerie"]').count(),0,'The Sense card is outside the Gruyère filter');
  await page.locator('#fpMore').click();await page.locator('#place').selectOption('d:sense');await page.locator('#sheetDone').click();
  await page.locator('#list .row[data-id="hostellerie"]').click();
  assert.equal(await page.locator('#detail').evaluate(el=>el.open),true);
  await page.goBack();
  await page.waitForFunction(()=>!document.querySelector('#detail').open);
  assert.equal(await page.locator('#place').inputValue(),'d:sense','Back must preserve filters');
  await page.goForward();
  await page.waitForFunction(()=>document.querySelector('#detail').open);
  await page.locator('#detail [data-close]').click();
  await page.waitForFunction(()=>!document.querySelector('#detail').open);
  await page.locator('[data-reset]').first().click().catch(()=>{});
  await page.locator('#resetTop').click();
  assert.equal(await page.locator('#place').inputValue(),'');

  // Notes, status, favourites and the calendar entry on a card; a stale second tab must not erase them.
  await page.locator('#q').fill('krabbel');
  await page.locator('#list .row[data-id="krabbel-plaffeien"]').click();
  await page.locator('#personal-status').selectOption('contact');
  await page.locator('#personal-note').fill('Check: ask the organiser a question.');
  await page.locator('#detail-save [data-save]').focus();
  await page.locator('#detail-save [data-save]').press('Enter');
  assert.equal(await page.locator('#detail-save [data-save]').evaluate(el=>el===document.activeElement),true,'Focus stays on the save button');
  assert.equal(await page.locator('#detail-save [data-save]').getAttribute('aria-pressed'),'true');
  const expectedStart=await page.locator('#detail [data-ics]').first().evaluate(button=>{
    const a=ACTIVITIES.find(a=>a.id===button.dataset.ics),event=a.events[Number(button.dataset.event)];
    return event.date.replaceAll('-','')+'T'+event.start.replace(':','')+'00';
  });
  const icsPromise=page.waitForEvent('download');
  await page.locator('#detail [data-ics]').first().click();
  const ics=await icsPromise;const icsText=fs.readFileSync(await ics.path(),'utf8');
  assert.match(icsText,/BEGIN:VTIMEZONE/);assert(icsText.includes('DTSTART;TZID=Europe/Zurich:'+expectedStart));assert.match(icsText,/PRODID:-\/\/Minitandem\/\//);
  assert.doesNotMatch(icsText,/Check: ask the organiser/);
  await page.locator('#detail [data-close]').click();
  await page.waitForFunction(()=>!document.querySelector('#detail').open);
  const stale=await context.newPage();
  await stale.addInitScript(()=>window.addEventListener('storage',event=>event.stopImmediatePropagation(),true));
  await stale.goto(url);await stale.waitForSelector('#list .row');
  await page.locator('#list .row[data-id="krabbel-plaffeien"]').click();
  await page.locator('#personal-note').fill('New note from tab A.');
  await stale.locator('#q').fill('hostellerie');
  await stale.locator('#list .row[data-id="hostellerie"]').click();
  await stale.locator('#detail-save [data-save]').click();
  const stored=await stale.evaluate(key=>JSON.parse(localStorage.getItem(key)),FAMILY);
  assert.equal(stored.notes['krabbel-plaffeien'],'New note from tab A.','A stale tab must not erase newer notes');
  assert(stored.favorites.includes('hostellerie')&&stored.favorites.includes('krabbel-plaffeien'));
  await stale.close();
  await page.locator('#detail [data-close]').click();
  await page.waitForFunction(()=>!document.querySelector('#detail').open);
  await page.locator('#q').fill('');
  await page.locator('.tab[data-view="saved"]').click();
  assert.equal(await rows(),2);
  assert.match(await page.locator('.tab[data-view="saved"]').textContent(),/2/);
  await page.screenshot({path:path.join(screenshots,'iphone15-saved.png')});
  await page.locator('.tab[data-view="catalog"]').click();

  // Visit planning from a card, and the plan in the saved view.
  await page.locator('#q').fill('krabbel');
  await page.locator('#list .row[data-id="krabbel-plaffeien"]').click();
  await page.locator('#detail [data-plan]').first().click();
  assert.equal(await page.locator('#utility').evaluate(el=>el.open),true);
  await page.locator('#visit-date').fill('2027-01-20');await page.locator('#visit-time').fill('09:30');
  await page.locator('#visit-form button[type="submit"]').click();
  await page.waitForFunction(()=>!document.querySelector('#utility').open);
  assert.match(await page.locator('#detail .visit-plans').textContent(),/20 Jan 2027/);
  await page.locator('#detail [data-close]').click();
  await page.waitForFunction(()=>!document.querySelector('#detail').open);
  assert.equal(JSON.parse(await page.evaluate(key=>localStorage.getItem(key),FAMILY)).visits&&Object.keys(JSON.parse(await page.evaluate(key=>localStorage.getItem(key),FAMILY)).visits).length,1);
  await page.locator('#q').fill('');

  // Age: set from the filter sheet; cards for older ages and unknown ages.
  await page.locator('#fpMore').click();
  await page.locator('#age').fill('8');
  assert.match(await page.locator('#ageHint').textContent(),/whole number/);
  await page.locator('#age').fill('6');
  await page.locator('#sheetDone').click();
  assert.equal(await page.locator('#fpAgeV').textContent(),'6 years');
  await page.locator('#q').fill('museum');
  assert.equal(await page.locator('#list .row[data-id="museum"]').count(),1,'The museum age is a recommendation, not a limit');
  await page.locator('#q').fill('Snowli');
  assert.equal(await page.locator('#list .row[data-id="snowli"]').count(),0,'An over-age child does not grow into Snowli');
  await page.locator('#q').fill('ElKi Plaffeien');
  assert.equal(await page.locator('#list .row[data-id="elki-plaffeien"]').count(),1,'An uncertain upper bound stays visible while unknown ages are included');
  await page.locator('#fpMore').click();await page.locator('#unk').click();await page.locator('#sheetDone').click();
  assert.equal(await page.locator('#list .row[data-id="elki-plaffeien"]').count(),0,'...and leaves when only confirmed ages are wanted');
  assert.equal(await page.locator('#empty').isVisible(),true);
  await page.locator('#empty [data-action="include-unknown"]').click();
  assert.equal(await page.locator('#list .row[data-id="elki-plaffeien"]').count(),1);
  await page.locator('#q').fill('no-matches-xyz');
  assert.equal(await page.locator('#empty').isVisible(),true);
  await page.locator('#empty [data-reset]').click();
  assert.equal(await page.locator('#fpAgeV').textContent(),'Any');
  assert.equal(JSON.parse(await page.evaluate(key=>localStorage.getItem(key),FAMILY)).age,null);

  // Map.
  await page.locator('.tab[data-view="map"]').click();
  await page.waitForSelector('#places-map .place-marker, #places-map .place-cluster',{timeout:15000});
  assert((await page.locator('#places-map .place-marker, #places-map .place-cluster').count())>0);
  await noOverflow();
  await page.locator('.tab[data-view="catalog"]').click();

  // Languages: switch, remember, default from the browser; card texts in the chosen language where a current translation exists.
  // In every language the search placeholder and the two filter pills must be readable in full on the first screen.
  const labelsFit=async label=>{
    const result=await page.evaluate(()=>{
      const input=document.querySelector('#q'),style=getComputedStyle(input),context=document.createElement('canvas').getContext('2d');context.font=style.font;
      const placeholder=context.measureText(input.placeholder).width<=input.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
      const pills=[...document.querySelectorAll('.fp small,.fp b')].filter(el=>el.scrollWidth>el.clientWidth+1||el.scrollHeight>el.clientHeight+1).map(el=>el.textContent);
      return {placeholder,pills};
    });
    assert.equal(result.placeholder,true,label+': search placeholder is clipped');
    assert.deepEqual(result.pills,[],label+': a filter pill label is clipped');
  };
  await labelsFit('en');
  await page.locator('#langSeg [data-lang="de"]').click();
  await labelsFit('de');
  assert.equal(await page.evaluate(()=>document.documentElement.lang),'de');
  assert.notEqual(await page.locator('#fpAge small').textContent(),'Child’s age');
  // The German card texts arrive from data-de.js; every card is current, so nothing is said about English.
  await page.waitForFunction(()=>window.MINITANDEM_CARDS?.de);
  assert.equal(await page.locator('#contentNote').isVisible(),false,'No card falls back to English, so no note');
  const firstId=await page.locator('#list .row').first().getAttribute('data-id');
  await page.locator('#list .row').first().click();
  assert.notEqual(await page.locator('#detail a.go').textContent(),'Open organiser’s page');
  const cardName=(await page.locator('#detail .d-name').textContent()).replace(/\u00a0/g,' ');
  assert.equal(cardName,await page.evaluate(id=>window.MINITANDEM_CARDS.de[id].strings.name,firstId),'The card shows its German name');
  assert.equal(await page.locator('#detail .d-english').count(),0);
  await page.locator('#detail [data-close]').click();
  await page.waitForFunction(()=>!document.querySelector('#detail').open);
  // French, with one card whose English changed after it was translated (a different digest): that card alone stays English and is counted.
  await page.evaluate(async id=>{const text=await (await fetch('data-fr.js')).text();const data=JSON.parse(text.slice(text.indexOf('= {')+2,text.lastIndexOf('};')+1));
    data[id].rev='0'.repeat(64);window.MINITANDEM_CARDS={...window.MINITANDEM_CARDS,fr:data};},firstId);
  await page.locator('#langSeg [data-lang="fr"]').click();
  assert.equal(await page.evaluate(()=>document.documentElement.lang),'fr');
  assert.match(await page.locator('#contentNote').textContent(),/^1 activité est affichée ici en anglais/);
  const names=await page.evaluate(()=>[...document.querySelectorAll('#list .row')].slice(0,2).map(row=>({id:row.dataset.id,name:row.querySelector('.r-name').firstChild.textContent.replace(/\u00a0/g,' ')})));
  assert.equal(names[0].id,firstId);
  assert.equal(names[0].name,await page.evaluate(id=>ACTIVITIES.find(a=>a.id===id).name,names[0].id),'The changed card is shown in English');
  assert.equal(names[1].name,await page.evaluate(id=>window.MINITANDEM_CARDS.fr[id].strings.name,names[1].id),'The next card is shown in French');
  await page.locator('#list .row').first().click();
  assert.equal(await page.locator('#detail .d-english').count(),1,'Its card page says it is shown in English');
  await page.locator('#detail [data-close]').click();
  await page.waitForFunction(()=>!document.querySelector('#detail').open);
  await labelsFit('fr');
  await noOverflow();
  await page.reload();await page.waitForSelector('#list .row');
  assert.equal(await page.evaluate(()=>document.documentElement.lang),'fr','The chosen language is remembered');
  assert.equal(await page.evaluate(()=>localStorage.getItem('minitandem-lang-v1')),'fr');
  await page.locator('#langSeg [data-lang="en"]').click();
  for(const [locale,expected] of [['de-CH','de'],['fr-FR','fr'],['ru-RU','en'],['pt-BR','en']]){
    const other=await browser.newContext({viewport:{width:393,height:852},locale});
    const p=await other.newPage();await p.goto(url);await p.waitForSelector('#list .row');
    assert.equal(await p.evaluate(()=>document.documentElement.lang),expected,'Default language for '+locale);
    await other.close();
  }

  // Near me: a position that arrives after a town was chosen meanwhile is ignored; the town stays.
  await page.evaluate(()=>{navigator.geolocation.getCurrentPosition=ok=>setTimeout(()=>ok({coords:{latitude:46.8,longitude:7.15,accuracy:1000}}),400);});
  await page.locator('#nearOpen').click();
  await page.locator('#nearGeo').click();
  await page.locator('#nearTown').selectOption('Plaffeien');
  await page.waitForTimeout(700);
  assert.match(await page.locator('#nearText').textContent(),/Plaffeien/,'The town chosen while locating stays');
  await page.locator('#sheetClose').click();
  await page.locator('#nearOff').click();
  assert.equal(await page.locator('#nearNote').isVisible(),false);

  // Backup download, and a storage failure must be reported, not hidden.
  await page.locator('#openData').click();
  const backupPromise=page.waitForEvent('download');await page.locator('[data-action="backup-export"]').click();
  const backup=await backupPromise;
  const backupData=JSON.parse(fs.readFileSync(await backup.path(),'utf8'));
  assert(backupData.favorites.includes('hostellerie'));assert.match(backup.suggestedFilename(),/^minitandem-backup-/);
  await page.locator('#utility [data-close-utility]').first().click();
  await page.evaluate(()=>{Storage.prototype.setItem=function(){throw new DOMException('Quota','QuotaExceededError');};});
  await page.locator('#importFile').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({version:1,favorites:['museum'],notes:{museum:'Temporary import'},statuses:{},age:2}))});
  await page.locator('#confirm-import').click();
  assert.match(await page.locator('#toast').textContent(),/only in memory/);
  await page.reload();
  await page.setViewportSize({width:320,height:740});await noOverflow();
  await page.setViewportSize({width:852,height:393});await noOverflow();
  await page.setViewportSize({width:1440,height:1000});await noOverflow();
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',engine,target:'iPhone 15, 393x852 @3x',url,checks:['bounded batch and show more','nothing fixed on a phone','44px tap targets','16px inputs','way back to the filters','district filter and reload','browser back and forward','notes, status and favourites','ICS timezone','cross-tab merge','saved view','visit planning','age boundaries and unknown ages','empty state and reset','map','three languages and defaults','backup download','storage failure warning','320px, landscape and desktop overflow','no JavaScript errors']},null,2));
}finally{if(browser)await browser.close();await fixture.close();}
