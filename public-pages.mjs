// One plain, script-free page per published card in German, French and English, a directory page in each language and the sitemap.
// Addresses: English where these pages have always been (/places/<id>/), German and French beside it (/places/<id>/de/, /places/<id>/fr/),
// the scheme of i18n.js (plainPage) that the app's own links use. Every page names its three versions (hreflang, language switch).
// The words, dates, ages and card texts are the app's: place-languages.mjs runs its dictionaries, formatting functions and checked
// translations; a card whose translation is out of date is shown in English with the app's note.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {SITE_ORIGIN} from './site.mjs';
import {CASE_STUDY_URLS} from './case-study.mjs';
import {GUIDE_URLS} from './daycare-guides.mjs';
import {LEGAL_URLS,LEGAL_LABELS,LANGUAGE_NAMES,legalLinks} from './legal-pages.mjs';
import {PAGE_LANGS,ROOT_LANG,PAGE_TEXT,languageLayer,placeURL,directoryURL,sentences} from './place-languages.mjs';

export const site=SITE_ORIGIN;
// The app's own rule for notices that are over (planning.js current), so that a page does not show "Closed 3–10 October 2026" after the 10th.
const planning=(()=>{const context={window:{}};vm.runInNewContext(fs.readFileSync(new URL('./planning.js',import.meta.url),'utf8'),context,{filename:'planning.js'});return context.window.MinitandemPlanning;})();
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const link=(url,text)=>/^https:\/\//i.test(url)?`<a href="${esc(url)}" rel="noopener noreferrer">${esc(text)}</a>`:esc(text);
const active=a=>!['closed','excluded'].includes(a.status);
const NBSP=String.fromCharCode(160);
// The colon after a label: French sets a no-break space before it.
const colon=lang=>(lang==='fr'?NBSP:'')+':';
// A text cut at a word, for a description of about a search result's length.
const clip=(text,max)=>text.length<=max?text:text.slice(0,max-1).replace(/\s+\S*$/,'')+'…';
// A search in Google Maps, as the app's links to a map are.
const googleSearch=query=>'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(query);
// The three versions of a page: {de, fr, en} -> address. id undefined: the directory.
const versions=id=>Object.fromEntries(PAGE_LANGS.map(lang=>[lang,id===undefined?directoryURL(lang):placeURL(id,lang)]));

function documentPage({lang,title,description,urls,body}){
  const {t}=languageLayer(lang),own=urls[lang],labels=LEGAL_LABELS[lang];
  const alternates=PAGE_LANGS.map(code=>`<link rel="alternate" hreflang="${code}" href="${site}${urls[code]}">`).join('')+`<link rel="alternate" hreflang="x-default" href="${site}${urls[ROOT_LANG]}">`;
  const switcher=`<nav class="langnav" aria-label="${esc(labels.language)}">${PAGE_LANGS.map(code=>`<a href="${urls[code]}" hreflang="${code}" lang="${code}"${code===lang?' aria-current="page"':''}>${LANGUAGE_NAMES[code]}</a>`).join('')}</nav>`;
  // The footer note of the app without its last sentence, which is about the notes and plans kept in the browser.
  const note=sentences(t('foot.note')).slice(0,-1).join(' ');
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light"><title>${esc(title)}</title><meta name="description" content="${esc(description)}"><meta name="robots" content="index, follow"><link rel="canonical" href="${site}${own}">${alternates}<meta property="og:site_name" content="Minitandem"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${site}${own}"><meta property="og:type" content="website"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}"><meta name="theme-color" content="#ffffff"><link rel="icon" href="/assets/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/assets/apple-touch-icon.png"><link rel="stylesheet" href="/styles.css"></head><body class="public-page"><a class="skip" href="#content">${esc(labels.skip)}</a><div class="topwrap"><header class="wrap top"><a class="mark" href="/" aria-label="Minitandem">Mini<span>tandem</span></a>${switcher}</header></div><main id="content" class="public-content">${body}</main><footer class="public-footer"><p><a href="/">${esc(labels.app)}</a> · ${legalLinks(lang)}</p><p><a href="${directoryURL(lang)}">${esc(t('foot.places'))}</a> · <a href="/research.md">${esc(t('foot.catalogue'))}</a></p><p>${esc(note)}</p></footer></body></html>\n`;
}

// text: the cards of a language as languageLayer(lang).cards(all English cards) gives them. The build makes it once per language; alone,
// a card is matched against its own translation.
export function placePage(card,regions,date,lang='en',text=languageLayer(lang).cards([card])){
  const layer=languageLayer(lang),{t,F}=layer,words=PAGE_TEXT[lang],P=planning;
  const fallback=text.fallback(card),en=fallback?' lang="en"':'';
  // The card as the app shows it: translated first, then without the notices that are over.
  const a=P.current(text.shown(card),date);
  // Card text that is English although the page is not carries lang="en" (the app marks it the same way).
  const own=value=>fallback?`<span lang="en">${esc(value)}</span>`:esc(value);
  const tbc=t('common.addressTbc');
  const varyingAddress=a.events.some(e=>e.address&&e.address!==a.address);
  const addressHtml=varyingAddress?a.events.map(e=>{const where=e.address||a.address;return `${esc(F.dateLabel(e.date))}${colon(lang)} ${where?own(where):esc(tbc)}`;}).join('<br>'):a.address?own(a.address):esc(tbc);
  const bounded=F.bounds(a),limits=bounded?F.ageShort(a):'';
  const sameAge=limits.normalize('NFC').toLowerCase()===String(a.age).normalize('NFC').toLowerCase();
  const langs=F.langText(a);
  const facts=[[t('fact.age'),own(a.age)+(bounded&&!sameAge?`<br><span class="field-note">${esc(t('fact.publishedLimits',{value:limits}))}</span>`:'')],
    [t('fact.parent'),a.parentDetails?own(a.parentDetails):esc(F.parentLong(a))],
    [t('fact.languages'),langs?esc(langs):esc(t('common.notStated'))],
    [t('fact.schedule'),own(a.schedule)],[t('fact.price'),own(a.price)],[t('fact.address'),addressHtml]];
  const conditions=layer.practicalOrder.filter(key=>a.practical?.[key]?.text).map(key=>{const f=a.practical[key];return `<div><dt>${esc(t('practical.'+key))}</dt><dd>${own(f.text)}${/^https:\/\//i.test(f.source||'')?' '+link(f.source,t('card.source')):''}</dd></div>`;}).join('')
    +(a.notes.length?`<div><dt>${esc(t('card.goodToKnow'))}</dt><dd><ul${en}>${a.notes.map(note=>`<li>${esc(note)}</li>`).join('')}</ul></dd></div>`:'');
  // The warnings the page has always shown: the card's own and the two about dates that are over or details that are due for a new check.
  const warnings=P.warnings(a,date).filter(w=>w.text||['scheduleExpired','datesPassed','reviewDue'].includes(w.code)).map(w=>w.text?`<li${en}>${esc(w.text)}</li>`:`<li>${esc(t('warning.'+w.code))}</li>`);
  const future=a.events.filter(e=>e.date>=date).sort((x,y)=>(x.date+(x.start||'')).localeCompare(y.date+(y.start||'')));
  const admission=P.admission(a);
  const datesMarkup=future.map(e=>{const where=e.address||a.address;return `<li><time datetime="${esc(e.date)}">${esc(F.dateLabel(e.date))}</time> · ${esc(F.clockLabel(e))}${e.title?` · <span${en}>${esc(e.title)}</span>`:''}${varyingAddress?`<br>${where?own(where):esc(tbc)}`:''}</li>`;}).join('');
  // Map searches use the English address, as the app's do: a translation may be worded for reading.
  const mapLink=a.addressPrecision==='area'?(a.areas||[]).map(area=>link(googleSearch(area.query),`${t('card.map')}${colon(lang)} ${area.name}`)).join(' · '):!varyingAddress&&card.address?link(googleSearch(card.address),t('card.map')):'';
  const sources=[...new Map([...a.sources.map(s=>({...s,card:true})),...Object.values(a.practical||{}).filter(f=>f?.source).map(f=>({url:f.source,label:t('card.practical')}))].map(s=>[s.url,s])).values()];
  const dated=P.validDate(a.checked);
  const timeTag=`<time datetime="${esc(a.checked)}">${esc(F.dateLabel(a.checked))}</time>`,token='{{checked}}';
  const checked=dated?esc(t('card.checked',{date:token})).replace(token,timeTag):'';
  const sourceNote=dated?t('card.sourceNote',{date:F.dateLabel(a.checked)}):t('card.sourceNoteUndated');
  const description=clip([`${a.name}, ${a.town}.`,bounded?`${t('fact.age')}${colon(lang)} ${limits}.`:'',F.priceShort(a).replace(/[.\s]+$/,'')+'.',words.tail].filter(Boolean).join(' '),240);
  const body=`<nav class="public-breadcrumbs" aria-label="${esc(words.breadcrumb)}"><a href="${directoryURL(lang)}">${esc(words.places)}</a><span>${esc(regions[a.region])}</span></nav><article itemscope itemtype="https://schema.org/Article"><h1 itemprop="headline"${en}>${esc(a.name)}</h1><p class="activity-place">${esc(a.town)} · ${esc(regions[a.region])}</p>`
    +(fallback?`<p class="field-note">${esc(t('card.inEnglish'))}</p>`:'')
    +(checked?`<p class="field-note">${checked}</p>`:'')
    +(a.intro?`<p class="public-intro" itemprop="description"${en}>${esc(a.intro)}</p>`:'')
    +(warnings.length?`<ul class="visit-warnings">${warnings.join('')}</ul>`:'')
    +`<dl class="public-facts">${facts.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`).join('')}</dl>`
    +`<div class="public-actions"><a class="go" href="/?lang=${lang}#view=catalog&amp;activity=${esc(a.id)}">${esc(t('saved.openCard'))}</a>${mapLink}</div>`
    +(conditions?`<section><h2>${esc(t('card.practical'))}</h2><dl class="visit-conditions">${conditions}</dl></section>`:'')
    +(future.length?`<section><h2>${esc(t('dates.title'))}</h2><p class="field-note">${esc(t('admission.'+admission)+(admission==='course'?'. '+t('admission.courseJoin'):''))}</p><ul class="public-dates">${datesMarkup}</ul></section>`:'')
    +(a.research?.remaining.length?`<section><h2>${esc(t('card.toConfirm'))}</h2><ul${en}>${a.research.remaining.map(q=>`<li>${esc(q)}</li>`).join('')}</ul></section>`:'')
    +`<section><h2>${esc(t('card.contacts'))}</h2>${a.contacts.length?a.contacts.map(c=>`<p>${c.name?own(c.name):''}${c.phone?`${c.name?'<br>':''}<a href="tel:${esc(c.phone.replace(/[^+\d]/g,'').replace(/^0(?=\d{9}$)/,'+41'))}">${esc(c.phone)}</a>`:''}${c.email?`<br><a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`:''}</p>`).join(''):`<p>${esc(t('card.noContact'))}</p>`}</section>`
    +`<section><h2>${esc(t('card.sources'))}</h2>${sources.length?`<ul>${sources.map(s=>`<li>${s.card&&fallback?`<span lang="en">${link(s.url,s.label)}</span>`:link(s.url,s.label)}</li>`).join('')}</ul><p class="field-note">${esc(sourceNote)}</p>`:`<p>${esc(t('card.noSources'))}</p>`}</section></article>`;
  return documentPage({lang,title:`${a.name} · ${a.town} | Minitandem`,description,urls:versions(a.id),body});
}

function directoryPage(items,regions,lang,text){
  const {t,F}=languageLayer(lang),words=PAGE_TEXT[lang];
  const cards=items.map(a=>({card:a,shown:text.shown(a),fallback:text.fallback(a)}));
  const groups=Object.entries(regions).filter(([region])=>items.some(a=>a.region===region));
  const english=cards.filter(c=>c.fallback).length;
  const intro=sentences(t('about.intro')).slice(0,2).join(' ');
  const body=`<h1>${esc(words.places)}</h1><p>${esc(intro)}</p><p class="field-note">${items.length} ${esc(t('count.label',{n:items.length}))}</p>${english?`<p class="field-note">${esc(t('cards.english',{n:english}))}</p>`:''}<nav class="public-regions" aria-label="${esc(t('place.districts'))}">${groups.map(([id,label])=>`<a href="#${id}">${esc(label)}</a>`).join('')}</nav>`
    +groups.map(([id,label])=>`<section id="${id}"><h2>${esc(label)}</h2><ul class="place-directory">${cards.filter(c=>c.card.region===id).sort((x,y)=>x.shown.name.localeCompare(y.shown.name,lang)).map(c=>`<li><a href="${placeURL(c.card.id,lang)}"${c.fallback?' lang="en"':''}>${esc(c.shown.name)}</a><span>${esc(c.shown.town)} · ${esc(F.bounds(c.shown)?F.ageShort(c.shown):t('age.notPublished'))}</span></li>`).join('')}</ul></section>`).join('');
  return documentPage({lang,title:`${words.placesTitle} · Minitandem`,description:t('meta.description'),urls:versions(),body});
}

export function generatePublicPages(records,regions,output,date){
  const items=records.filter(active);
  // A card named like a language would share its folder with that language's directory.
  if(items.some(a=>!/^[a-z0-9-]+$/.test(a.id)||PAGE_LANGS.includes(a.id)))throw Error('Invalid public page ID');
  const directory=path.join(output,'places');
  // This directory is entirely generated. Never clean the deployment linkage or private files.
  fs.rmSync(directory,{recursive:true,force:true});
  const write=(url,html)=>{const dir=path.join(output,url);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'index.html'),html);};
  for(const lang of PAGE_LANGS){
    // The translations are matched against every card, as the app does, so that one page never differs from the card in the app.
    const text=languageLayer(lang).cards(records);
    for(const a of items)write(placeURL(a.id,lang),placePage(a,regions,date,lang,text));
    write(directoryURL(lang),directoryPage(items,regions,lang,text));
  }
  const urls=[`${site}/`,...PAGE_LANGS.map(lang=>site+directoryURL(lang)),...[...CASE_STUDY_URLS,...LEGAL_URLS,...GUIDE_URLS].map(url=>site+url),...items.flatMap(a=>PAGE_LANGS.map(lang=>site+placeURL(a.id,lang)))];
  fs.writeFileSync(path.join(output,'sitemap.xml'),'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+urls.map(url=>`<url><loc>${esc(url)}</loc></url>`).join('')+'</urlset>\n');
  return items.length;
}
