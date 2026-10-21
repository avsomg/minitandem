/* Markup of the Daycare tab: the list rows, the filter panel, the map shell, a place's page with the rules of the family's commune and the
   family's own application, and the list of applications. As in views.js: HTML strings built from the data (escaped) and words from the
   dictionaries, no DOM access and no events; app.js puts them into the page and wires them.
   ctx = {t, F, V, K, CH, store, state, lang}: V is views.js (escaping, icons, the age and distance controls, addresses), CH the places
   (childcare.js). The texts of the places and communes are written in English; in German or French each is shown in its current
   translation where there is one (CH.factText, ruleText, communeName), otherwise in English with lang="en". */
(() => {
  'use strict';
  const M = () => window.MinitandemChildcare;
  // One outline icon per kind of care, drawn like the interface icons (24 grid, 1.8 stroke). aria-hidden: the word is written next to it.
  const HOUSE = '<path d="M4 11.5L12 5l8 6.5"/><path d="M6 10v9.5h12V10"/>';
  const SHAPES = {
    creche: HOUSE + '<path d="M10 19.5v-5h4v5"/>',
    garderie: HOUSE + '<circle cx="12" cy="14.6" r="2.7"/><path d="M12 13.3v1.4h1.1"/>',
    'family-day-care': HOUSE + '<path d="M12 18s-3-1.7-3-3.5a1.5 1.5 0 0 1 3-.5 1.5 1.5 0 0 1 3 .5c0 1.8-3 3.5-3 3.5z"/>',
    playgroup: '<rect x="4" y="13" width="7" height="7" rx="1.2"/><rect x="13" y="13" width="7" height="7" rx="1.2"/><rect x="8.5" y="4" width="7" height="7" rx="1.2"/>',
    'nature-playgroup': '<path d="M12 3.5l5 7h-2.6l3.6 5H6l3.6-5H7z"/><path d="M12 15.5V21"/>',
    maternelle: '<circle cx="7.5" cy="7.5" r="3.3"/><path d="M16.5 4l3.8 6.6h-7.6z"/><rect x="4.2" y="13.8" width="6.6" height="6.6" rx="1.2"/><path d="M13.5 17.1h6.6M16.8 13.8v6.6"/>'
  };
  const icon = type => `<span class="cat-icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${SHAPES[type] || HOUSE}</svg></span>`;

  function create(ctx) {
    const {t, F, V, K, store} = ctx, esc = V.esc, ICON = V.ICON;
    const CH = () => ctx.CH(), state = () => ctx.state();
    const today = () => CH().today();
    // A text shown in English while the interface is German or French says so to the browser and to screen readers.
    const foreign = () => Boolean(ctx.lang && ctx.lang() !== 'en');
    const mark = shown => shown.english && foreign() ? ' lang="en"' : '';
    const textSpan = shown => `<span${mark(shown)}>${esc(shown.text)}</span>`;
    // Said on a place's page when one of its texts is English: none of the texts is translated yet, or this one is not.
    const englishNote = () => t(CH().coverage().translated ? 'childcare.englishSome' : 'childcare.english');
    const value = (record, key) => M().value(record, key);
    const application = id => store.childcare.applications[id] || null;
    const link = (url, label, cls = '') => /^https:\/\//i.test(url || '') ? `<a${cls ? ` class="${cls}"` : ''} href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : '';
    // A source as the family reads it: the site and the last part of the address ("crechelaprovidence.ch › tarifs").
    function sourceLabel(url) {
      try {
        const u = new URL(url), last = decodeURIComponent(u.pathname.split('/').filter(Boolean).at(-1) || '').replace(/\.(pdf|html?|php|aspx?)$/i, '').slice(0, 40);
        return u.hostname.replace(/^www\./, '') + (last ? ' › ' + last : '');
      } catch { return url; }
    }
    const sourceLine = urls => urls.length ? `<span class="sub cc-src">${esc(t('card.sources'))}${esc(F.colon())} ${urls.map(url => link(url, esc(sourceLabel(url)))).join(' · ')}</span>` : '';
    const fr = (label, body) => `<div class="fr"><dt>${esc(label)}</dt><dd>${body}</dd></div>`;

    /* ---------- labels ---------- */
    // The published age in a few words: "3 months–4 years", "From 12 weeks", "2–4 years". The place's page keeps the place's own wording.
    function ageShort(p) {
      const from = value(p, 'ageFrom'), to = value(p, 'ageTo');
      const months = Number.isFinite(from?.months) ? from.months : null, weeks = Number.isFinite(from?.weeks) ? from.weeks : null, years = Number.isFinite(to?.years) ? to.years : null;
      const inYears = months !== null && months >= 24 && months % 12 === 0;
      if (years !== null) {
        if (weeks !== null) return t('childcare.age.weeksYears', {min: weeks, max: years, n: years});
        if (inYears) return t('age.range', {min: months / 12, max: years});
        if (months !== null && months > 0) return t('age.rangeMonthsYears', {min: months, max: years, n: years});
        return t('age.upTo', {n: years});
      }
      if (weeks !== null) return t('childcare.age.fromWeeks', {n: weeks});
      if (months === 0) return t('childcare.age.fromBirth');
      if (months !== null) return inYears ? t('age.from', {n: months / 12}) : t('age.fromMonths', {n: months});
      return t('age.notPublished');
    }
    const ageKnown = p => Boolean(value(p, 'ageFrom') || value(p, 'ageTo'));
    // The date of a price as the place gives it: a day, a month, a year or a school year ("2025-2026", "2026-27").
    function priceDate(v) {
      const year = String(v).match(/^(\d{4})[-/](\d{4}|\d{2})$/);
      if (year && Number(year[2].slice(-2)) === (Number(year[1]) + 1) % 100) return t('childcare.priceYear', {years: year[1] + '–' + year[2]});
      const month = /^\d{4}-(?:0[1-9]|1[0-2])$/.test(v) && new Intl.DateTimeFormat(window.MinitandemI18n.locale(), {month: 'long', year: 'numeric', timeZone: 'UTC'}).format(new Date(v + '-15T12:00:00Z'));
      const day = /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + 'T12:00:00Z'));
      return t('childcare.priceFrom', {date: day ? F.dateLabel(v) : month || v});
    }
    const times = p => { const h = value(p, 'hours'); return h?.opensAt && h?.closesAt ? `${h.opensAt}–${h.closesAt}` : ''; };
    const typeLabel = p => t('childcare.type.' + p.type);
    // Subsidy and approach in the interface language; languages too on the place's page.
    function marks(p, {languages = false} = {}) {
      const s = value(p, 'subsidised')?.value, out = [];
      if (M().SUBSIDY_KEYS.includes(s)) out.push(t('childcare.subsidy.' + s));
      for (const a of M().approaches(p)) out.push(t('childcare.approach.' + a));
      if (languages) out.push(...(value(p, 'languages') || []).filter(l => M().LANGUAGE_KEYS.includes(l)).map(l => t('childcare.lang.' + l)));
      return out;
    }
    function distanceText(p) {
      const from = state().near;
      return from ? t('near.km', {km: K.roundKm(CH().distance(p, from))}) : '';
    }
    const statusLabel = status => t('childcare.status.' + (status || 'none'));

    /* ---------- list ---------- */
    // A row in the shape of the activity rows (styles.css .row): kind of care and distance, name, town, age, hours, subsidy and approach,
    // and the family's own status of an application.
    function row(p) {
      const a0 = store.personal.age, fit = Number.isFinite(a0) && CH().ageFit(p, a0) === true, d = distanceText(p), mine = application(p.id), hours = times(p);
      return `<li><a class="row c-childcare" href="${esc(V.hashFor(p.id, 'childcare'))}" data-place="${esc(p.id)}">${icon(p.type)}` +
        `<span class="r-main"><span class="r-cat"><span class="r-catname">${esc(typeLabel(p))}</span>${d ? `<span class="r-dist">${esc(d)}</span>` : ''}</span>` +
        `<span class="r-name"><span>${V.nm(p.name)}</span></span>${p.town ? `<span class="r-town-d">${esc(p.town)}</span>` : ''}</span>` +
        `<span class="r-facts">${p.town ? `<span class="r-town-m">${esc(p.town)}</span>` : ''}<span class="r-age${ageKnown(p) ? ' known' : ''}">${fit ? ICON.tick(14) + `<span class="sr">${esc(t('fit.sr', {age: F.ageBare(a0)}))}</span>` : ''}${esc(ageShort(p))}</span>` +
        `<span class="r-price${hours ? ' known' : ''}">${esc(hours || t('childcare.hoursUnknown'))}</span></span>` +
        `<span class="r-l3"><span class="r-when">${esc(marks(p).join(' · '))}</span>${mine?.status ? `<span class="r-status st">${ICON.pencil(14)}<span class="sr">${esc(t('childcare.row.mine', {status: statusLabel(mine.status)}))}</span><span aria-hidden="true">${esc(statusLabel(mine.status))}</span></span>` : ''}</span></a></li>`;
    }
    const listHead = () => `<div class="listhead" aria-hidden="true"><span></span><span>${esc(t('childcare.listhead.place'))}</span><span>${esc(t('listhead.age'))}</span><span>${esc(t('childcare.listhead.hours'))}</span><span>${esc(t('childcare.listhead.marks'))}</span><span>${esc(t('childcare.listhead.mine'))}</span></div>`;
    function list(items, limit) {
      if (!items.length) return `<div class="empty"><p class="tt">${esc(t('childcare.empty.title'))}</p><p class="hint">${esc(t('childcare.empty.text'))}</p><button type="button" class="ghost" data-reset>${esc(t('empty.reset'))}</button></div>`;
      const shown = items.slice(0, limit);
      return listHead() + `<ul class="list cc-list">${shown.map(row).join('')}</ul>` +
        (shown.length < items.length ? `<div class="morebox"><button type="button" class="ghost" data-action="cc-more">${esc(t('list.more', {shown: shown.length, total: items.length}))}</button></div>` : '');
    }
    // The map of the filtered places: one point each from the canton's list (map.js), the places also as a list under it.
    function mapBox(items) {
      return `<div class="map-shell"><p class="hint">${esc(t('childcare.map.caption', {n: items.length}))}</p>` +
        (items.length ? `<div id="places-map" class="places-map" role="region" aria-label="${esc(t('childcare.map.label'))}"></div><p id="map-error" role="status" hidden>${esc(t('map.tilesFailed'))}</p>` : '') +
        `<p class="hint">${esc(t('childcare.map.credit'))}</p><details class="more"><summary>${esc(t('childcare.map.list', {n: items.length}))}</summary>` +
        items.map(p => `<div class="map-list-row"><button type="button" class="linkbtn" data-place="${esc(p.id)}">${esc(p.name)}</button><p>${esc(CH().addressLine(p) || p.town)}</p></div>`).join('') + '</details></div>';
    }
    // The three parts of the tab, as a switch like the language switch.
    function parts(view) {
      const count = Object.keys(store.childcare.applications).filter(id => CH().byId.has(id)).length;
      return `<div class="seg cc-parts" role="group" aria-label="${esc(t('childcare.views'))}">` + M().VIEW_KEYS.map(k => `<button type="button" data-cview="${k}" aria-pressed="${k === view}">${esc(t('childcare.show.' + k))}${k === 'mine' && count ? ` <b>${count}</b>` : ''}</button>`).join('') + '</div>';
    }
    // The tab below the filters: the list, the map or the applications, and where the list of places comes from (its parts are switched
    // above the search, parts()). status: '' once the places are there, 'loading' or 'failed' before.
    function box(items, {view = 'list', limit = 24, status = ''} = {}) {
      if (status) return `<div class="empty cc-status" role="status"><p class="hint">${esc(t(status === 'loading' ? 'childcare.loading' : 'childcare.failed'))}</p>${status === 'failed' ? `<button type="button" class="ghost" data-action="cc-retry">${esc(t('childcare.retry'))}</button>` : ''}</div>`;
      const body = view === 'map' ? mapBox(items) : view === 'mine' ? mine() : list(items, limit);
      return body + `<p class="hint cc-source">${esc(t('childcare.source'))}</p>`;
    }

    /* ---------- filter panel ---------- */
    const chip = (kind, val, label, count) => `<button type="button" class="chip" data-ckind="${kind}" data-val="${esc(val)}" aria-pressed="false">${esc(label)}${count !== undefined ? ` <span class="num">${count}</span>` : ''}</button>`;
    const group = (id, label, body) => `<fieldset class="group" id="${id}"><legend class="glabel">${esc(label)}</legend>${body}</fieldset>`;
    const timeSelect = (id, label, keys) => `<label class="near-or" for="${id}">${esc(label)}</label><span class="select"><select class="field" id="${id}"><option value="">${esc(t('childcare.anyTime'))}</option>${keys.map(k => `<option value="${k}">${k}</option>`).join('')}</select></span>`;
    // Distance and age as in the activity list (the same controls, one choice for both), then what only the Daycare tab filters on.
    function panel() {
      const counts = CH().typeCounts(), m = M();
      return V.nearGroup() + V.ageGroup(t('childcare.filter.ageHint')) +
        group('g-cctype', t('childcare.filter.type'), `<div class="chips">${m.TYPE_KEYS.map(k => chip('type', k, t('childcare.type.' + k), counts[k])).join('')}</div>`) +
        group('g-ccsub', t('childcare.filter.subsidy'), `<div class="chips">${m.SUBSIDY_KEYS.map(k => chip('subsidy', k, t('childcare.subsidy.' + k))).join('')}</div><p class="hint">${esc(t('childcare.filter.subsidyHint'))}</p>`) +
        `<div class="group" id="g-cchours" role="group" aria-labelledby="ccHoursL"><span class="glabel" id="ccHoursL">${esc(t('childcare.filter.hours'))}</span>${timeSelect('ccOpens', t('childcare.opensBy'), m.OPENS_KEYS)}${timeSelect('ccCloses', t('childcare.closesAfter'), m.CLOSES_KEYS)}<p class="hint">${esc(t('childcare.filter.hoursHint'))}</p></div>` +
        group('g-cclang', t('childcare.filter.language'), `<div class="chips">${m.LANGUAGE_KEYS.map(k => chip('lang', k, t('childcare.lang.' + k))).join('')}</div>`) +
        group('g-ccapproach', t('childcare.filter.approach'), `<div class="chips">${m.APPROACH_KEYS.map(k => chip('approach', k, t('childcare.approach.' + k))).join('')}</div><p class="hint">${esc(t('childcare.filter.statedHint'))}</p>`);
    }
    // A filter that is on, in words (childcare.js active()).
    function filterLabel(f) {
      const prefix = {type: 'childcare.type.', subsidy: 'childcare.subsidy.', lang: 'childcare.lang.', approach: 'childcare.approach.'}[f.kind];
      return prefix ? t(prefix + f.value) : t(f.kind === 'opens' ? 'childcare.opensByValue' : 'childcare.closesAfterValue', {time: f.value});
    }
    // The chips that name the filters that are on, as in the activity list, without the rainy-day switch.
    const filterChips = active => active.map(f => `<button type="button" class="chip fchip" data-remove="${esc(f.key)}" aria-label="${esc(t('filters.remove', {name: f.label}))}">${esc(f.label)}${ICON.x(14)}</button>`).join('');

    /* ---------- a place's page ---------- */
    // A row of a place's page: its texts ({text, english}, each in its own language), what goes under them, and the pages they rest on.
    // english records whether a text of the page stayed English.
    let english = false;
    const factRow = (p, label, keys, parts, sub = () => '') => {
      const hit = keys.filter(k => value(p, k) !== null);
      if (!hit.length) return fr(label, `<span class="np">${esc(t(keys.some(k => M().pending(p, k)) ? 'childcare.pending' : 'childcare.notPublished'))}</span>`);
      const shown = parts().filter(x => x.text);
      if (shown.some(x => x.english)) english = true;
      return fr(label, `${shown.map(textSpan).join(', ')}${sub()}${sourceLine([...new Set(hit.flatMap(k => M().sources(p, k)))])}`);
    };
    // The age as the place words it; a minimum given only as a number is said in the interface language. An English upper limit follows in
    // lower case when the two read as one English sentence.
    function ageText(p) {
      const from = value(p, 'ageFrom'), to = value(p, 'ageTo');
      const first = from?.text ? CH().factText(p, 'ageFrom') : !from ? null : {english: false, text: Number.isFinite(from.weeks) ? t('childcare.age.fromWeeks', {n: from.weeks})
        : from.months === 0 ? t('childcare.age.fromBirth') : t('age.fromMonths', {n: from.months})};
      const last = to?.text ? CH().factText(p, 'ageTo') : null;
      if (first && last?.english && (first.english || !foreign())) last.text = last.text.charAt(0).toLowerCase() + last.text.slice(1);
      return [first, last].filter(Boolean);
    }
    const dayRange = days => { const s = [...days].sort((a, b) => a - b); return s.length > 1 && s.every((d, i) => !i || d === s[i - 1] + 1) ? `${t('weekday.' + s[0])}–${t('weekday.' + s.at(-1))}` : s.map(d => t('weekday.' + d)).join(', '); };
    function facts(p) {
      const v = key => value(p, key), sub = text => `<span class="sub">${esc(text)}</span>`, one = key => () => [CH().factText(p, key)];
      const rows = {
        age: () => factRow(p, t('childcare.fact.age'), ['ageFrom', 'ageTo'], () => ageText(p)),
        hours: () => v('hours') ? factRow(p, t('childcare.fact.hours'), ['hours'], one('hours')) :
          v('days') ? fr(t('childcare.fact.hours'), esc(dayRange(v('days'))) + sourceLine(M().sources(p, 'days'))) : factRow(p, t('childcare.fact.hours'), ['hours', 'days'], () => []),
        closures: () => factRow(p, t('childcare.fact.closures'), ['closures'], one('closures')),
        price: () => factRow(p, t('childcare.fact.price'), ['price'], one('price'), () => v('price').validFrom ? sub(priceDate(v('price').validFrom)) : ''),
        registration: () => factRow(p, t('childcare.fact.registration'), ['registration'], one('registration')),
        availability: () => factRow(p, t('childcare.fact.availability'), ['availability'], one('availability'), () => v('availability').statedOn ? sub(t('childcare.statedOn', {date: F.dateLabel(v('availability').statedOn)})) : ''),
        meals: () => factRow(p, t('childcare.fact.meals'), ['meals'], one('meals')),
        settlingIn: () => factRow(p, t('childcare.fact.settlingIn'), ['settlingIn'], one('settlingIn')),
        trialPeriod: () => factRow(p, t('childcare.fact.trialPeriod'), ['trialPeriod'], one('trialPeriod')),
        pedagogy: () => factRow(p, t('childcare.fact.pedagogy'), ['pedagogy'], one('pedagogy')),
        languages: () => v('languages') ? fr(t('childcare.fact.languages'), esc(v('languages').map(l => M().LANGUAGE_KEYS.includes(l) ? t('childcare.lang.' + l) : l.toUpperCase()).join(' · ')) + sourceLine(M().sources(p, 'languages'))) : factRow(p, t('childcare.fact.languages'), ['languages'], () => [])
      };
      return `<dl class="facts cc-facts">${M().DETAIL_ROWS.map(k => rows[k]()).join('')}</dl>`;
    }
    // "Where do you live?": one choice for every place, remembered in this browser (store.js). id differs on a place's page and in the
    // list of applications, which can both be in the page at once.
    function communeSelect(id) {
      const {communes, regions} = CH().communeOptions(), chosen = store.childcare.commune;
      const option = c => { const name = CH().communeName(c); return `<option value="${esc(c.id)}"${mark(name)}${c.id === chosen ? ' selected' : ''}>${esc(name.text)}</option>`; };
      return `<label class="glabel" for="${id}">${esc(t('childcare.commune.choose'))}</label><span class="select"><select class="field" id="${id}" data-commune-select><option value="">${esc(t('childcare.commune.none'))}</option>` +
        `<optgroup label="${esc(t('childcare.commune.communes'))}">${communes.map(option).join('')}</optgroup><optgroup label="${esc(t('childcare.commune.regions'))}">${regions.map(option).join('')}</optgroup></select></span>` +
        `<p class="hint">${esc(t('childcare.commune.hint'))}</p>`;
    }
    // The confirmed rules of the chosen commune or regional body, each with its sources, as "Getting a place in <commune>".
    function rules(communeId = store.childcare.commune) {
      const c = CH().communeById.get(communeId);
      if (!c) return `<p class="hint">${esc(t('childcare.commune.missing'))}</p>`;
      const name = CH().communeName(c).text;
      // The names of subsidised crèches are proper names: they are not translated and not marked as English.
      const rows = M().RULE_KEYS.map(k => {
        const v = value(c, k); if (!v) return '';
        if (k === 'calculator') return fr(t('childcare.rule.calculator'), link(v.url, esc(t('childcare.calculatorLink')) + ICON.out(14), 'inline-link') + sourceLine(M().sources(c, k)));
        return fr(t('childcare.rule.' + k), (v.text ? textSpan(CH().ruleText(c, k)) : esc((v.names || []).join(', '))) + sourceLine(M().sources(c, k)));
      }).join('');
      return `<h4 class="cc-rules-title">${esc(t('childcare.commune.rules', {name}))}</h4>` +
        (rows ? `<dl class="pr cc-rules">${rows}</dl>` : `<p class="hint">${esc(t('childcare.commune.nothing', {name}))}</p>`) +
        (c.pending?.length ? `<p class="hint">${esc(t('childcare.commune.pending'))}</p>` : '') + `<p class="hint">${esc(t('childcare.commune.checked', {date: F.dateLabel(c.checked)}))}</p>`;
    }
    // Next to the date of registration: the renewal interval of the chosen commune, when its confirmed rule states one, and the next date.
    function renewal(id) {
      const c = CH().communeById.get(store.childcare.commune), months = c?.renewMonths, registered = application(id)?.registered || '';
      if (!c) return t('childcare.mine.noCommune');
      const name = CH().communeName(c).text;
      if (!months) return t('childcare.mine.noInterval', {name});
      const next = M().nextRenewal(registered, months, today());
      return t('childcare.mine.interval', {name, n: months}) + (next ? ' ' + t('childcare.mine.next', {date: F.dateLabel(next)}) : '');
    }
    function applicationBox(p) {
      const a = application(p.id) || M().emptyApplication(), field = (id, label, value) => `<div><label class="glabel" for="${id}">${esc(label)}</label><input class="field" id="${id}" type="date" min="2000-01-01" max="2099-12-31" value="${esc(value)}"></div>`;
      return `<section class="dsec mine cc-mine" id="cc-mine" data-app="${esc(p.id)}"><h3>${esc(t('childcare.mine.title'))}</h3>` +
        `<label class="glabel" for="cc-status">${esc(t('childcare.mine.status'))}</label><span class="select"><select class="field" id="cc-status">${['', ...M().APPLICATION_KEYS].map(k => `<option value="${k}"${a.status === k ? ' selected' : ''}>${esc(statusLabel(k))}</option>`).join('')}</select></span>` +
        `<div class="cc-two">${field('cc-registered', t('childcare.mine.registered'), a.registered)}${field('cc-renew', t('childcare.mine.renewBy'), a.renewBy)}</div>` +
        `<p class="hint" id="cc-renewal" aria-live="polite">${esc(renewal(p.id))}</p>` +
        `<label class="glabel" for="cc-note">${esc(t('childcare.mine.note'))}</label><textarea class="field area" id="cc-note" maxlength="2000" placeholder="${esc(t('childcare.mine.notePlaceholder'))}">${esc(a.note)}</textarea>` +
        `<p class="hint" id="cc-note-state">${esc(t(store.storageAvailable ? 'childcare.mine.private' : 'mine.notStored'))}</p></section>`;
    }
    // Directions to the address (or to the point, for a group that meets in the woods), from the saved starting point as for the activities.
    function directions(p) {
      const address = CH().addressLine(p);
      return address ? V.routeURL({address, town: p.town}) : `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`;
    }
    function detail(p) {
      const where = [CH().addressLine(p) || p.town, t('card.canton')].filter(Boolean).join(' · '), badges = marks(p, {languages: true});
      english = false;
      const rows = facts(p);
      return `<div class="d-top"><button type="button" class="ghost" data-close>${ICON.back(18)}${esc(t('card.back'))}</button><span class="d-actions"><button type="button" class="iconbtn" data-action="copy-link" aria-label="${esc(t('card.copyLink'))}" title="${esc(t('card.copyLink'))}">${ICON.link(20)}</button></span></div>` +
        `<div class="d-body" tabindex="-1" autofocus><p class="d-kicker">${esc(typeLabel(p))}</p><h2 class="d-name" id="dTitle">${V.nm(p.name)}</h2><p class="d-where">${esc(where)}</p>` +
        (badges.length ? `<p class="cc-badges">${badges.map(b => `<span>${esc(b)}</span>`).join('')}</p>` : '') +
        `<p class="d-checked">${esc(t('childcare.checked', {date: F.dateLabel(p.checked)}))}</p>` + (english && foreign() ? `<p class="hint d-english">${esc(englishNote())}</p>` : '') +
        rows + `<div class="d-second">${link(directions(p), ICON.route(18) + esc(t('card.directions')), 'ghost')}</div>` +
        `<section class="dsec cc-commune"><h3>${esc(t('childcare.commune.title'))}</h3>${communeSelect('cc-commune')}<div id="cc-rules">${rules()}</div></section>` +
        applicationBox(p) +
        `<section class="dsec cc-about"><h3>${esc(t('foot.about'))}</h3><p class="hint">${esc(t('childcare.lead', {date: F.dateLabel(p.checked)}))}</p><p class="hint">${esc(t('childcare.source'))}</p></section></div>` +
        `<div class="d-foot">${p.website ? `<a class="go" href="${esc(p.website)}" target="_blank" rel="noopener noreferrer">${esc(t('childcare.website'))}${ICON.out(18)}</a><p class="fine">${esc(t('childcare.websiteNote'))}</p>` : `<p class="fine">${esc(t('childcare.noWebsite'))}</p>`}</div>`;
    }

    /* ---------- my applications ---------- */
    // The family's applications, the one to renew first on top: its own "renew by" date, else the next date of the commune's rule.
    function mine() {
      const months = CH().renewMonths(store.childcare.commune);
      const items = Object.entries(store.childcare.applications).map(([id, a]) => ({p: CH().byId.get(id), a})).filter(x => x.p)
        .map(x => ({...x, due: x.a.renewBy || M().nextRenewal(x.a.registered, months, today())}))
        .sort((x, y) => (x.due || '9999').localeCompare(y.due || '9999') || x.p.name.localeCompare(y.p.name, 'de-CH'));
      const item = ({p, a, due}) => `<article class="cc-app"><div class="cc-app-head"><button type="button" class="linkbtn cc-app-name" data-place="${esc(p.id)}">${esc(p.name)}</button><span class="cc-app-status">${esc(statusLabel(a.status))}</span></div>` +
        `<p class="hint">${esc(typeLabel(p))} · ${esc(p.town)}</p><dl class="pr">` +
        (a.registered ? fr(t('childcare.mine.registered'), esc(F.dateLabel(a.registered))) : '') +
        (due ? fr(t('childcare.mine.renewBy'), esc(F.dateLabel(due)) + (due < today() ? ` <b class="cc-overdue">${esc(t('childcare.mine.overdue'))}</b>` : '') + (a.renewBy ? '' : `<span class="sub">${esc(t('childcare.mine.fromRule'))}</span>`)) : '') +
        (a.note ? fr(t('childcare.mine.note'), esc(a.note)) : '') + '</dl></article>';
      return `<section class="dsec cc-mine-list"><div class="group">${communeSelect('cc-commune-mine')}</div>` +
        (items.length ? items.map(item).join('') : `<p class="hint cc-empty">${esc(t('childcare.mine.empty'))}</p>`) + `<p class="hint">${esc(t('childcare.mine.private'))}</p></section>`;
    }
    return {icon, ageShort, priceDate, englishNote, marks, row, list, mapBox, parts, box, panel, filterLabel, filterChips, facts, communeSelect, rules, renewal, applicationBox, detail, mine, sourceLabel, distanceText};
  }
  window.MinitandemChildcareViews = {create};
})();
