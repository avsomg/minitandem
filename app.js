/* Minitandem: page wiring. The logic lives in catalogue.js, store.js, sync.js, exports.js and planning.js, the markup in views.js and
   the words in the strings-*.js dictionaries. This file connects them to the page: state, events, dialogs, history and the language. */
(() => {
  'use strict';
  const W = window;
  const I = W.MinitandemI18n, t = I.t, P = W.MinitandemPlanning, X = W.MinitandemExchange, K = W.MinitandemCatalogue;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  /* ---------- storage, language, modules ---------- */
  const memory = new Map();
  const storageOf = name => { try { const s = W[name]; s.getItem('minitandem-probe'); return s; } catch { return {getItem: key => memory.get(name + key) ?? null, setItem: (key, value) => { memory.set(name + key, String(value)); }, removeItem: key => { memory.delete(name + key); }}; } };
  const local = storageOf('localStorage'), session = storageOf('sessionStorage');
  try { W.MinitandemMigration.run(local, session); } catch {}
  I.init();
  // A shared link may name its language (?lang=de): it applies to this visit, is not remembered, and leaves the address.
  { const params = new URLSearchParams(location.search), linkLang = params.get('lang');
    if (linkLang) { if (I.LANGS.includes(linkLang)) I.setLang(linkLang, {persist: false}); params.delete('lang'); const rest = params.toString(); try { history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + location.hash); } catch {} } }
  const ALL = W.ACTIVITIES;
  const C = K.create({activities: ALL, venues: W.ACTIVITY_VENUES || [], regions: W.CATALOG_REGIONS, towns: W.CATALOG_TOWNS || {}, coverage: W.CATALOG_COVERAGE, planning: P, t});
  const F = W.MinitandemFormat.create({t, locale: I.locale});
  /* Card texts in German or French: data-de.js or data-fr.js, loaded from this site only when that language is chosen. A card is shown
     translated while its English still matches the translation; otherwise, and until the file is loaded, it is shown in English. */
  const CI = W.MinitandemCatalogueI18n;
  // failed: languages whose file could not be loaded; it is tried again when the browser is back online and on later renders (at most
  // every 20 seconds), and until then the cards are shown in English with a note that says so.
  const cardText = {lang: 'en', overlay: null, loading: '', failed: new Set(), triedAt: 0}, overlays = {};
  function cardLanguage(lang) {
    cardText.lang = CI.LANGS.includes(lang) ? lang : 'en';
    cardText.overlay = null;
    if (cardText.lang === 'en') return;
    const data = W.MINITANDEM_CARDS?.[lang];
    if (data) { overlays[lang] ||= CI.overlay(ALL, data, W.MinitandemViews.PRACTICAL_ORDER); cardText.overlay = overlays[lang]; return; }
    if (cardText.loading === lang || cardText.failed.has(lang)) return;
    cardText.loading = lang; cardText.triedAt = Date.now();
    const script = document.createElement('script');
    script.src = `data-${lang}.js`;
    script.onload = () => { cardText.loading = ''; if (!W.MINITANDEM_CARDS?.[lang]) cardText.failed.add(lang); if (I.lang() === lang) { cardLanguage(lang); refreshCards(); } };
    script.onerror = () => { cardText.loading = ''; cardText.failed.add(lang); script.remove(); if (I.lang() === lang) refreshCards(); };
    document.head.append(script);
  }
  function retryCardText() {
    const lang = cardText.lang;
    if (!cardText.failed.has(lang) || Date.now() - cardText.triedAt < 20000) return;
    cardText.failed.delete(lang); cardLanguage(lang);
  }
  const shown = a => cardText.overlay ? cardText.overlay.card(a) : a;
  // Why a card is shown in English although another language is chosen: 'failed' (the language file could not be loaded) or 'stale'
  // (no current translation of this card); '' when it is shown in the chosen language or while its file is still loading.
  const inEnglish = a => cardText.lang === 'en' || cardText.loading === cardText.lang ? '' : cardText.failed.has(cardText.lang) ? 'failed' : cardText.overlay?.translated(a) ? '' : 'stale';
  C.setLocalText(a => cardText.overlay ? cardText.overlay.text(a) : '');
  let sync = null;
  const store = W.MinitandemStore.create({storage: local, byId: C.byId, P, today: C.today, statusKeys: K.PERSONAL_KEYS, canonicalId: K.canonicalId, onSaved: () => sync?.queue()});
  // near: the point distances are measured from, {kind: 'town', name, lat, lon} or {kind: 'geo', lat, lon}; nearStatus: '', 'locating'
  // or 'failed'. weekOpen: the days of the week view whose regular offers are unfolded.
  const state = {view: 'catalog', venueId: '', sharedIds: [], f: K.defaultFilters(), limit: 24, openId: null, outingDate: '', opener: null, returnId: null,
    near: null, nearStatus: '', weekOpen: new Set()};
  const V = W.MinitandemViews.create({t, C, P, X, F, store, state: () => state, shown, inEnglish, lang: I.lang, origin: location.origin, syncConnected: () => Boolean(sync?.config)});
  const EX = W.MinitandemExports.create({t, lang: I.lang, P, byId: C.byId, regions: W.CATALOG_REGIONS, today: C.today, format: F});
  const PAGE = 24;
  const SESSION_FILTERS = store.KEYS.filters;
  try { state.f = C.restoreFilters(JSON.parse(session.getItem(SESSION_FILTERS) || 'null')); } catch {}
  // A remembered town comes back; a position from the browser never does, so "nearest first" without a point falls back.
  { const name = store.loadNear(), centre = name && C.townCentre(name); if (centre) state.near = {kind: 'town', name, lat: centre.lat, lon: centre.lon}; }
  if (state.f.sort === 'near' && !state.near) state.f.sort = 'default';
  if (!state.near) state.f.radius = 0;
  state.outingDate = Object.values(store.personal.visits).map(v => v.date).filter(date => date >= C.today()).sort()[0] || C.today();

  const els = {};
  for (const id of ['q', 'qClear', 'fbar', 'fpAge', 'fpAgeV', 'fpPlace', 'fpPlaceV', 'fpMore', 'count', 'countNote', 'whenNote', 'barR', 'fcount', 'list', 'listhead', 'empty', 'endnav', 'endNote', 'toFilters', 'more', 'moreBtn', 'fchips', 'fchipList',
    'sheet', 'sheetBody', 'sheetDone', 'sheetClose', 'colBody', 'detail', 'utility', 'utilityTitle', 'utilityBody', 'panel', 'toast', 'viewTitle', 'viewTools', 'savedBox', 'mapBox', 'updates',
    'syncState', 'contentNote', 'importFile', 'planImportFile', 'results', 'tabSaved', 'nearNote', 'nearText', 'nearOpen', 'resetTop', 'weekBox'])
    els[id] = document.getElementById(id);
  const toast = W.MinitandemToast.create({node: els.toast, document});
  const wide = W.matchMedia('(min-width: 1000px)');
  const esc = V.esc;

  /* ---------- parsing the address hash ---------- */
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const view = K.VIEWS.includes(p.get('view')) ? p.get('view') : 'catalog';
    return {view, venueId: p.get('venue') || '', sharedIds: P.shareIds(p.get('list'), C.byId), activity: C.byId.has(p.get('activity')) ? p.get('activity') : null};
  }
  function setHash(id = null, push = false) {
    const next = V.hashFor(id);
    if (location.hash === next) return;
    try { history[push ? 'pushState' : 'replaceState']({minitandemDetail: push && !!id}, '', next); } catch {}
  }
  const first = readHash();
  state.view = first.view; state.venueId = first.venueId; state.sharedIds = first.sharedIds;

  /* ---------- language ---------- */
  function applyStatic() {
    for (const node of $$('[data-i18n]')) node.textContent = t(node.dataset.i18n);
    for (const [attr, target] of [['i18nLabel', 'aria-label'], ['i18nPlaceholder', 'placeholder'], ['i18nTitle', 'title']])
      for (const node of $$(`[data-${attr.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}]`)) node.setAttribute(target, t(node.dataset[attr]));
    for (const node of $$('[data-legal]')) node.href = '/' + node.dataset.legal + '/' + (I.lang() === 'de' ? '' : I.lang() + '/');
    for (const node of $$('[data-places]')) node.href = I.plainPage(I.lang());
    document.title = t('meta.title');
    $('meta[name="description"]')?.setAttribute('content', t('meta.description'));
    for (const b of $$('#langSeg button')) b.setAttribute('aria-pressed', String(b.dataset.lang === I.lang()));
  }
  function buildPanel() {
    els.panel.innerHTML = V.panel();
    els.panel.hidden = false;
    placePanel();
  }
  function switchLanguage(lang) {
    if (lang === I.lang()) return;
    I.setLang(lang);
    cardText.failed.delete(lang); cardLanguage(lang);
    applyStatic(); buildPanel(); refreshCards();
  }
  // Everything that shows card text, again: after a language switch and when a language's card texts arrive.
  function refreshCards() {
    render();
    if (state.openId && els.detail.open) { const body = $('.d-body', els.detail), top = body?.scrollTop || 0; els.detail.innerHTML = V.detail(C.byId.get(state.openId)); const next = $('.d-body', els.detail); if (next) next.scrollTop = top; }
    if (els.utility.open && utilityRebuild) utilityRebuild();
  }

  /* ---------- rendering ---------- */
  let disposeMap = null, resultKey = '', lastItems = [], renderToken = 0, lastDays = [];
  const age = () => store.personal.age;
  const filterCount = () => C.activeCount(state.f, age());
  const placeName = () => {
    const place = state.f.place;
    if (!place) return t('place.anywhere.short');
    return place.startsWith('d:') ? C.regions[place.slice(2)] : C.localityByKey.get(place.slice(2))?.name || '';
  };
  // The filters that are on, each with the words of its chip and how to remove it ('kind:value'). The search text has its own field.
  function activeFilters() {
    const f = state.f, a0 = age(), out = [];
    if (Number.isFinite(a0)) out.push({key: 'age', label: F.ageLabel(a0)});
    if (f.place) out.push({key: 'place', label: placeName()});
    if (f.indoor) out.push({key: 'indoor', label: t('filter.indoor')});
    for (const [kind, set, prefix] of [['cat', f.categories, 'category'], ['fmt', f.formats, 'format'], ['lang', f.languages, 'langFilter'], ['day', f.days, 'weekday'], ['need', f.needs, 'needs']])
      for (const value of set) out.push({key: kind + ':' + value, label: t(prefix + '.' + value)});
    for (const [kind, prefix] of [['when', 'when'], ['price', 'priceFilter'], ['status', 'statusFilter'], ['preset', 'preset']]) if (f[kind]) out.push({key: kind, label: t(prefix + '.' + f[kind])});
    if (f.parentMatch) out.push({key: 'adult', label: t('filter.withAdult')});
    if (f.radius && state.near) out.push({key: 'radius', label: t('near.radiusKm', {km: f.radius})});
    return out;
  }
  function removeFilter(key) {
    const f = state.f, [kind, ...rest] = key.split(':'), value = rest.join(':');
    const sets = {cat: f.categories, fmt: f.formats, lang: f.languages, day: f.days, need: f.needs};
    if (kind === 'age') { setAge(null); return; }
    if (sets[kind]) sets[kind].delete(kind === 'day' ? Number(value) : value);
    else if (kind === 'place') f.place = '';
    else if (kind === 'indoor') f.indoor = false;
    else if (kind === 'adult') f.parentMatch = false;
    else if (kind === 'radius') f.radius = 0;
    else if (['when', 'price', 'status', 'preset'].includes(kind)) f[kind] = '';
    state.limit = PAGE; render();
  }
  function items() { return C.filter(state.f, {age: age(), view: state.view, personal: store.personal, venueId: state.venueId, sharedIds: state.sharedIds, near: state.near}); }
  const publicView = () => ['shared', 'venue'].includes(state.view);
  function render() {
    if (disposeMap) { disposeMap(); disposeMap = null; }
    renderToken++;
    try { session.setItem(SESSION_FILTERS, JSON.stringify(C.serializeFilters(state.f))); } catch {}
    const list = lastItems = items();
    const key = list.map(a => a.id).join('|');
    if (key !== resultKey) { state.limit = PAGE; resultKey = key; }
    const view = state.view, isMap = view === 'map', isWeek = view === 'week';
    // The week view counts the filtered cards that have something on one of the seven days.
    const days = isWeek ? C.week(list, state.f, {age: age(), near: state.near}) : null, cards = isWeek ? C.weekCards(days) : list;
    const n = cards.length, a0 = age(), af = filterCount(), total = C.activities.filter(a => !C.isArchive(a)).length;
    document.body.dataset.view = view;
    // tabs and titles
    for (const b of $$('[data-view].tab')) { const on = b.dataset.view === view; b.setAttribute('aria-pressed', String(on)); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
    els.tabSaved.querySelector('.tabn').textContent = String(store.personal.favorites.filter(id => C.byId.has(id)).length);
    const heading = {saved: t('view.saved'), map: t('view.map'), week: t('view.week'), shared: t('view.shared'), archive: t('view.archive'), venue: C.venues.find(v => v.id === state.venueId)?.name || t('view.venue')}[view];
    els.viewTitle.textContent = heading || ''; els.viewTitle.hidden = !heading || view === 'map';
    // search, pills, count bar
    els.q.value !== state.f.query && (els.q.value = state.f.query);
    els.qClear.hidden = !state.f.query;
    $('.search').hidden = publicView(); els.fbar.hidden = publicView();
    els.fpAgeV.textContent = F.ageLabel(a0); els.fpPlaceV.textContent = placeName();
    els.fpAge.classList.toggle('on', Number.isFinite(a0)); els.fpPlace.classList.toggle('on', !!state.f.place); els.fpMore.classList.toggle('on', af > 0);
    els.fpMore.setAttribute('aria-label', af ? t('filters.buttonActive', {n: af}) : t('filters.button'));
    els.count.innerHTML = (n === total && !C.anyFilter(state.f, a0) && view === 'catalog') || view !== 'catalog' ? `<b>${n}</b> ${esc(t('count.label', {n}))}` : `<b>${n}</b> ${esc(t('count.of', {n: total, total}))}`;
    // The count bar holds the count and the way to distances (until a point is set). Below it, in the page flow: how many filters are on,
    // each of them as a chip that removes it, the rainy-day switch while it is off, and Reset.
    els.barR.hidden = publicView(); els.nearOpen.hidden = !!state.near || isMap;
    els.fchips.hidden = publicView(); els.resetTop.hidden = !C.anyFilter(state.f, a0);
    els.fcount.textContent = af ? t('filters.active', {n: af}) : ''; els.fcount.hidden = !af;
    els.fchipList.innerHTML = V.filterChips(activeFilters());
    els.sheetDone.textContent = n ? t('filters.show', {n}) : t('filters.none');
    if (Number.isFinite(a0) && n && !publicView()) {
      // Two counts in one sentence: n, the one the word "card" follows, chooses between "1 card" and "2 cards".
      const s = C.ageSummary(cards, a0);
      els.countNote.textContent = t('note.age', {age: F.ageBare(a0), fits: s.fits, unknown: s.unknown, n: s.fits}); els.countNote.hidden = false;
    } else els.countNote.hidden = true;
    // Said only when some of the cards listed here are shown in English although another language is chosen.
    retryCardText();
    const english = cards.filter(inEnglish).length;
    els.contentNote.hidden = !english;
    els.contentNote.textContent = !english ? '' : cardText.failed.has(cardText.lang) ? t('cards.notLoaded') : t('cards.english', {n: english});
    els.nearNote.hidden = !state.near || isMap || !n;
    // With a distance limit the line also says how many cards it leaves out because their distance is unknown.
    const unknownLeftOut = state.near && state.f.radius ? C.filter({...state.f, radius: 0}, {age: a0, view, personal: store.personal, venueId: state.venueId, sharedIds: state.sharedIds}).filter(a => !C.distanceOf(a, state.near)).length : 0;
    els.nearText.textContent = !state.near ? '' : (state.near.kind === 'town' ? t('near.listFromTown', {town: state.near.name}) : t('near.listFromLocation')) +
      (unknownLeftOut ? ' ' + t('near.radiusUnknown', {n: unknownLeftOut}) : '');
    // Today, this weekend, the next 7 days: weekly hours count, and the line says that holidays are not in the data.
    els.whenNote.hidden = !K.DAY_WHEN.includes(state.f.when) || !n; els.whenNote.textContent = els.whenNote.hidden ? '' : t('note.whenRegular');
    // body of the results
    const shown = list.slice(0, state.limit);
    els.listhead.hidden = isMap || isWeek || !n;
    els.list.innerHTML = isMap || isWeek ? '' : V.rows(shown);
    els.list.hidden = isMap || isWeek || !n;
    els.mapBox.hidden = !isMap; els.mapBox.innerHTML = isMap ? V.mapBox(list) : '';
    lastDays = days || [];
    els.weekBox.hidden = !isWeek || !n; els.weekBox.innerHTML = isWeek && n ? V.week(days) : '';
    const emptyKind = view === 'saved' && !store.personal.favorites.length ? 'saved' : view === 'catalog' && Number.isFinite(a0) && !state.f.includeUnknownAge ? 'unknown' : '';
    els.empty.hidden = !!n; els.empty.innerHTML = n ? '' : K.DAY_WHEN.includes(state.f.when) && view !== 'saved' ? V.empty('when', whenAlternative()) : V.empty(emptyKind);
    if (isMap && !n) els.mapBox.hidden = true;
    const more = !isMap && !isWeek && shown.length < n;
    els.more.hidden = !more; els.moreBtn.textContent = more ? t('list.more', {shown: shown.length, total: n}) : '';
    els.endnav.hidden = isMap || !n || publicView();
    els.endNote.textContent = af ? t('end.filtered', {shown: shown.length, total: n, n: af}) : t('end.all', {shown: shown.length, n: total}); els.endNote.hidden = isWeek;
    // saved overview, tools, updates banner
    els.viewTools.innerHTML = V.viewTools(view, store.personal.favorites.length > 0, n); els.viewTools.hidden = !els.viewTools.innerHTML;
    const overview = view === 'saved' ? V.saved() : null;
    els.savedBox.innerHTML = overview ? overview.html : ''; els.savedBox.hidden = !overview;
    const changed = pendingChangeCount();
    els.updates.hidden = !changed || view === 'saved'; els.updates.innerHTML = changed ? `<button type="button" class="linkbtn" data-action="open-updates">${esc(t('saved.banner', {n: changed}))}</button>` : '';
    syncPanel();
    if (isMap && n) mountMap(list);
  }
  // Nothing found for "today", "this weekend" or "next 7 days": what the same day filter finds without the other filters (with the child's
  // age if that still finds something, else without it), so that the visitor is offered a way on instead of a dead end.
  function whenAlternative() {
    const only = {...K.defaultFilters(), when: state.f.when}, context = {view: 'catalog', near: state.near};
    const withAge = Number.isFinite(age()) ? C.filter(only, {...context, age: age()}).length : 0;
    return withAge ? {n: withAge, when: state.f.when, keepsAge: true} : {n: C.filter(only, {...context, age: null}).length, when: state.f.when, keepsAge: false};
  }
  function pendingChangeCount() { return store.personal.favorites.filter(id => C.byId.has(id) && P.changes(C.byId.get(id), store.personal.tracked[id]).length).length; }

  /* ---------- map (Leaflet is loaded only when the map is opened) ---------- */
  let mapLibs = null;
  function loadMapLibs() {
    if (W.L && W.L.markerClusterGroup) return Promise.resolve();
    mapLibs ||= new Promise((resolve, reject) => {
      for (const href of ['assets/leaflet.css', 'assets/MarkerCluster.css']) { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href; document.head.append(link); }
      const load = src => new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = fail; document.head.append(s); });
      load('assets/leaflet.js').then(() => load('assets/leaflet.markercluster.js')).then(resolve, error => { mapLibs = null; reject(error); });
    });
    return mapLibs;
  }
  function mountMap(list) {
    const token = renderToken;
    loadMapLibs().then(() => { if (token === renderToken && $('#places-map')) disposeMap = W.MinitandemMap.mount($('#places-map'), list.map(V.shown), t); })
      .catch(() => { const note = $('#map-error'); if (note) note.hidden = false; });
  }

  /* ---------- filter panel ---------- */
  function syncPanel() {
    const f = state.f, a0 = age(), panel = els.panel;
    const ageIn = $('#age', panel); if (!ageIn) return;
    if (document.activeElement !== ageIn) ageIn.value = Number.isFinite(a0) ? a0 : '';
    for (const b of $$('.chip.age', panel)) b.setAttribute('aria-pressed', String(a0 === Number(b.dataset.age)));
    $('#unkRow', panel).hidden = !Number.isFinite(a0);
    $('#unk', panel).setAttribute('aria-checked', String(f.includeUnknownAge));
    $('#place', panel).value = f.place;
    const sets = {cat: f.categories, fmt: f.formats, lang: f.languages, day: f.days, need: f.needs};
    for (const b of $$('.chip[data-kind]', panel)) {
      const kind = b.dataset.kind, val = b.dataset.val;
      let on = false;
      if (sets[kind]) on = sets[kind].has(kind === 'day' ? Number(val) : val);
      else if (kind === 'when') on = f.when === val;
      else if (kind === 'preset') on = f.preset === val;
      else if (kind === 'price') on = f.price === val;
      else if (kind === 'status') on = f.status === val;
      else if (kind === 'indoor') on = f.indoor;
      b.setAttribute('aria-pressed', String(on));
    }
    $('#adult', panel).setAttribute('aria-checked', String(f.parentMatch));
    $('#sort option[value="near"]', panel).disabled = !state.near;
    $('#sort', panel).value = f.sort;
    const town = $('#nearTown', panel), note = $('#nearState', panel);
    if (document.activeElement !== town) town.value = state.near?.kind === 'town' ? state.near.name : '';
    note.textContent = state.nearStatus === 'locating' ? t('near.locating') : state.nearStatus === 'failed' ? t('near.failed')
      : !state.near ? '' : state.near.kind === 'town' ? t('near.fromTown', {town: state.near.name}) : t('near.fromLocation');
    note.classList.toggle('err', state.nearStatus === 'failed');
    $('#nearGeo', panel).disabled = state.nearStatus === 'locating';
    $('#nearClear', panel).hidden = !state.near;
    const radius = $('#nearRadius', panel); radius.disabled = !state.near; radius.value = String(state.near ? state.f.radius : 0);
  }
  function togglePanelValue(kind, val) {
    const f = state.f, toggle = (set, v) => set.has(v) ? set.delete(v) : set.add(v);
    if (kind === 'cat') toggle(f.categories, val); else if (kind === 'fmt') toggle(f.formats, val); else if (kind === 'lang') toggle(f.languages, val);
    else if (kind === 'day') toggle(f.days, Number(val)); else if (kind === 'need') toggle(f.needs, val);
    else if (kind === 'when') f.when = f.when === val ? '' : val;
    else if (kind === 'preset') f.preset = f.preset === val ? '' : val;
    else if (kind === 'price') f.price = f.price === val ? '' : val;
    else if (kind === 'status') f.status = f.status === val ? '' : val;
    else if (kind === 'indoor') f.indoor = !f.indoor;
    state.limit = PAGE; render();
  }
  function setAge(n) {
    if (n === store.personal.age) return;
    store.personal.age = n;
    if (!store.persist()) toast(t('storage.failed'));
    state.limit = PAGE; render();
  }
  function wirePanel() {
    const panel = els.panel;
    panel.addEventListener('input', e => {
      if (e.target.id !== 'age') return;
      const hint = $('#ageHint', panel), v = e.target.value.trim();
      if (v === '') { hint.textContent = hint.dataset.text; hint.classList.remove('err'); setAge(null); }
      else if (/^[0-6]$/.test(v)) { hint.textContent = hint.dataset.text; hint.classList.remove('err'); setAge(Number(v)); }
      else { hint.textContent = t('filter.ageError'); hint.classList.add('err'); }
    });
    panel.addEventListener('change', e => {
      if (e.target.id === 'age') { const hint = $('#ageHint', panel); hint.textContent = hint.dataset.text; hint.classList.remove('err'); syncPanel(); }
      else if (e.target.id === 'place') { state.f.place = e.target.value; if (state.f.place && state.f.radius) { state.f.radius = 0; toast(t('near.radiusCleared')); } state.limit = PAGE; render(); }
      else if (e.target.id === 'nearRadius') setRadius(Number(e.target.value));
      else if (e.target.id === 'sort') { state.f.sort = e.target.value; render(); }
      else if (e.target.id === 'nearTown') chooseTown(e.target.value);
    });
    panel.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.age !== undefined) { const n = Number(b.dataset.age); $('#ageHint', panel).classList.remove('err'); setAge(age() === n ? null : n); }
      else if (b.dataset.kind) togglePanelValue(b.dataset.kind, b.dataset.val);
      else if (b.id === 'unk') { state.f.includeUnknownAge = !state.f.includeUnknownAge; render(); }
      else if (b.id === 'adult') { state.f.parentMatch = !state.f.parentMatch; render(); }
      else if (b.id === 'nearGeo') locate();
      else if (b.id === 'nearClear') { store.saveNear(''); setNear(null); $('#nearGeo', panel).focus(); }
    });
  }
  /* ---------- distances from a point the visitor sets ---------- */
  // A chosen town is remembered in this browser. The browser's location is asked for once per press, coarse, and kept only in this
  // page's memory: it is never stored, never put in the address and never sent anywhere. Setting a point sorts nearest first.
  // A distance limit and a district or town do not stack silently: setting a limit removes the district or town (and says so); choosing
  // a district or town removes the limit. The limit shows as a chip that removes it.
  function setRadius(km) {
    state.f.radius = K.RADIUS_KEYS.includes(km) && state.near ? km : 0;
    if (state.f.radius && state.f.place) { state.f.place = ''; toast(t('near.placeCleared')); }
    state.limit = PAGE; render();
  }
  function setNear(near) {
    state.near = near; state.nearStatus = '';
    if (near) state.f.sort = 'near'; else { if (state.f.sort === 'near') state.f.sort = 'default'; state.f.radius = 0; }
    state.limit = PAGE; render();
  }
  function chooseTown(name) {
    const centre = name ? C.townCentre(name) : null;
    store.saveNear(centre ? name : '');
    if (centre) setNear({kind: 'town', name, lat: centre.lat, lon: centre.lon});
    else if (state.near?.kind === 'town') setNear(null);
  }
  function locate() {
    const failed = () => { state.nearStatus = 'failed'; syncPanel(); $('#nearTown', els.panel)?.focus(); };
    if (!navigator.geolocation) { failed(); return; }
    state.nearStatus = 'locating'; syncPanel();
    // A position or a refusal that arrives after a town was chosen (or the distances were turned off) meanwhile is ignored.
    navigator.geolocation.getCurrentPosition(position => { if (state.nearStatus !== 'locating') return; store.saveNear(''); setNear({kind: 'geo', lat: position.coords.latitude, lon: position.coords.longitude}); },
      () => { if (state.nearStatus === 'locating') failed(); }, {enableHighAccuracy: false, timeout: 20000, maximumAge: 600000});
  }
  function placePanel() {
    if (wide.matches) { if (els.sheet.open) els.sheet.close(); els.colBody.appendChild(els.panel); }
    else els.sheetBody.appendChild(els.panel);
  }
  function openSheet(which) {
    if (wide.matches) return;
    els.sheet.showModal();
    const body = els.sheetBody, g = {age: $('#g-age'), place: $('#g-place'), near: $('#g-near')}[which] || null;
    body.scrollTop = 0;
    if (g) body.scrollTop = g.getBoundingClientRect().top - body.getBoundingClientRect().top - 20;
  }
  // "Near me" and "Change": the distance controls at the top of the filters, in the sheet on a phone, in the left column on a wide screen.
  function openNear() {
    if (!wide.matches) { openSheet('near'); return; }
    els.colBody.closest('.col').scrollTop = 0;
    $('#nearGeo', els.panel).focus();
  }
  function toFilters() {
    const reduce = W.matchMedia('(prefers-reduced-motion: reduce)').matches;
    W.scrollTo({top: Math.max(0, $('.search').getBoundingClientRect().top + W.pageYOffset - 12), behavior: reduce ? 'auto' : 'smooth'});
    els.fpAge.focus({preventScroll: true});
  }
  function reset() {
    state.f = K.defaultFilters(); state.limit = PAGE;
    store.personal.age = null; if (!store.persist()) toast(t('storage.failed'));
    els.q.value = ''; render();
  }

  /* ---------- card page ---------- */
  function openDetail(id, push = true) {
    const a = C.byId.get(id); if (!a) return;
    if (!els.detail.open) { state.opener = document.activeElement; state.returnId = id; }
    if (push) setHash(id, !state.openId);
    state.openId = id;
    els.detail.innerHTML = V.detail(a);
    if (!els.detail.open) els.detail.showModal();
    $('.d-body', els.detail).scrollTop = 0;
  }
  function closeDetail() {
    if (history.state?.minitandemDetail) { history.back(); return; }
    state.openId = null; setHash(); els.detail.close();
  }
  els.detail.addEventListener('cancel', e => { e.preventDefault(); closeDetail(); });
  els.detail.addEventListener('close', () => {
    state.openId = null; render();
    // After whatever closed the dialog has finished: Chromium fires 'close' inside dialog.close(), so the hashchange handler that
    // called it renders the list again afterwards and would drop the focus from the row it replaces.
    queueMicrotask(() => {
      const restored = state.returnId && $(`#list [data-id="${CSS.escape(state.returnId)}"]`);
      (restored || (state.opener?.isConnected ? state.opener : els.results)).focus({preventScroll: true});
    });
  });

  /* ---------- dialogs ---------- */
  let utilityRebuild = null;
  function utility(dialog, rebuild = null) {
    utilityRebuild = rebuild;
    els.utilityTitle.textContent = dialog.title; els.utilityBody.innerHTML = dialog.body;
    if (!els.utility.open) els.utility.showModal();
    $('.sheet-body', els.utility).scrollTop = 0;
  }
  els.utility.addEventListener('close', () => { utilityRebuild = null; });
  for (const dialog of [els.detail, els.utility, els.sheet]) dialog.addEventListener('click', e => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) { if (dialog === els.detail) closeDetail(); else dialog.close(); }
  });
  function download(file) {
    if (!file) return;
    const url = URL.createObjectURL(new Blob([file.text], {type: file.type}));
    const a = document.createElement('a'); a.href = url; a.download = file.name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  async function copy(text, done = t('toast.copied')) {
    try { await navigator.clipboard.writeText(text); toast(done); }
    catch { utility(V.copyFallback(text)); $('.copy-fallback')?.select(); }
  }
  const errorText = error => error?.code && t('error.' + error.code) !== 'error.' + error.code ? t('error.' + error.code) : (error?.message || t('error.generic'));

  /* ---------- records: favourites, notes, visits ---------- */
  function toggleSave(id) {
    const focused = document.activeElement?.dataset.save === id;
    const p = store.personal;
    if (p.favorites.includes(id)) p.favorites = p.favorites.filter(x => x !== id);
    else { p.favorites.push(id); p.tracked[id] = P.snapshot(C.byId.get(id), C.today()); }
    if (!store.persist()) toast(t('storage.failed'));
    render();
    if (state.openId === id) $('#detail-save').innerHTML = V.saveButton(C.byId.get(id));
    if (focused) (document.querySelector(`${state.openId ? '#detail-save' : '#list'} [data-save="${CSS.escape(id)}"]`) || els.results).focus({preventScroll: true});
  }
  let editingVisit = null;
  function editVisit(activity, id = null, eventIndex = null) {
    const a = C.byId.get(activity); if (!a) return;
    if (!id && Object.keys(store.personal.visits).length >= P.maxVisits) { toast(t('visit.limit')); return; }
    const event = Number.isInteger(eventIndex) ? a.events[eventIndex] : null;
    const key = id || 'v-' + crypto.randomUUID();
    const draft = store.personal.visits[key] || P.validateVisits({[key]: {activity, date: event?.date || '', time: event?.start || ''}}, C.byId)[key];
    editingVisit = {id: key, activity, baseline: structuredClone(draft), isNew: !store.personal.visits[key]};
    utility(V.visitForm(a, draft, !!id), () => editVisit(activity, id, eventIndex));
  }
  function saveVisit(form) {
    if (!editingVisit) return;
    const {id, activity, baseline} = editingVisit;
    const values = Object.fromEntries(new FormData(form));
    if ((values.date && !P.validDate(values.date)) || (values.time && !P.validTime(values.time))) { toast(t('visit.invalid')); return; }
    for (let i = 0; i < 20; i++) values['pack' + i] = values.bring.split('\n')[i] === baseline.bring.split('\n')[i] && values['pack' + i] === 'on';
    const draft = P.validateVisits({[id]: {...values, activity}}, C.byId);
    const p = store.personal;
    p.visits = P.mergeVisits(p.visits, draft, editingVisit.isNew ? {} : {[id]: baseline});
    if (!p.favorites.includes(activity)) { p.favorites.push(activity); p.tracked[activity] = P.snapshot(C.byId.get(activity), C.today()); }
    const saved = store.persist(); editingVisit = null; els.utility.close(); render();
    if (state.openId === activity) { const box = $('#detail .visit-plans'); if (box) box.outerHTML = V.visitPlans(C.byId.get(activity)); }
    toast(t(saved ? 'visit.saved' : 'visit.savedMemory'));
  }
  function chosenPlan() {
    const ids = $$('[name="plan-visit"]:checked').map(el => el.value);
    return X.plan({type: 'vmeste-plan', version: 1, visits: Object.fromEntries(ids.filter(id => store.personal.visits[id]).map(id => [id, store.personal.visits[id]]))}, C.byId);
  }
  function exportPlan(calendar) {
    try { const plan = chosenPlan(); download(calendar ? EX.planFile(plan) : EX.planJson(plan)); toast(t('plan.prepared')); } catch (error) { toast(errorText(error)); }
  }
  function updateFamilyPrice() {
    const input = $('#family-adults'), total = $('#family-total');
    if (!state.openId || !input || !total) return;
    const ages = $$('#family-children .family-child-age').map(field => field.value.trim() === '' ? NaN : Number(field.value));
    const result = P.familyPrice(C.byId.get(state.openId), ages, Number(input.value));
    total.textContent = result ? 'CHF ' + F.amount(result.total) : t('cost.invalid');
    $('#family-breakdown').textContent = result ? t('cost.breakdown', {adults: F.amount(result.adultTotal), children: result.childTotals.map(F.amount).join(' + ')}) : '';
  }

  /* ---------- optional family service ---------- */
  const syncLabel = code => {
    els.syncState.hidden = !code; els.syncState.textContent = code ? t('sync.' + code) : '';
  };
  let syncLast = '';
  sync = W.MinitandemSync.create({store, onStatus: code => { syncLast = code; syncLabel(code); },
    onConflict: remote => utility(V.conflict(remote), () => utility(V.conflict(remote))),
    onApplied: () => { render(); if (state.openId) els.detail.innerHTML = V.detail(C.byId.get(state.openId)); },
    onCorrectionsSent: n => toast(t('sync.correctionsSent', {n}))});
  function submitReport(form) {
    const a = C.byId.get(form.dataset.id), message = $('#report-text').value.trim();
    if (!message) { $('#report-text').setCustomValidity(t('report.required')); $('#report-text').reportValidity(); return; }
    try {
      const report = X.report({type: 'vmeste-correction', version: 1, activity: a.id, topic: $('#report-topic').value, message, source: $('#report-source').value.trim(), date: C.today()}, C.byId);
      if (sync.config) {
        const queue = store.pendingCorrections();
        if (queue.length >= 20) throw Object.assign(Error('Queue full'), {code: 'report.queueFull'});
        queue.push(report); store.setPendingCorrections(queue); els.utility.close(); toast(t('report.queued')); sync.flushCorrections();
      } else { download(EX.correctionFile(report)); toast(t('report.prepared')); }
    } catch (error) { toast(errorText(error)); }
  }

  /* ---------- events ---------- */
  function switchView(view) {
    if (state.view === view) return;
    state.view = view; state.limit = PAGE; setHash(null, true); render(); W.scrollTo(0, 0);
  }
  const actions = {
    'copy-link': () => copy(location.href),
    'when-only': () => { const alt = whenAlternative(); state.f = {...K.defaultFilters(), when: state.f.when, sort: state.f.sort}; state.limit = PAGE; if (!alt.keepsAge && Number.isFinite(age())) setAge(null); else render(); },
    // The phone's share sheet with the card's name, next date (or its schedule), price and a link that opens it in this language.
    'share-card': async () => {
      const a = V.shown(C.byId.get(state.openId)); if (!a) return;
      const upcoming = C.upcoming(a), url = location.origin + location.pathname + (I.lang() === 'en' ? '' : '?lang=' + I.lang()) + V.hashFor(a.id, 'catalog');
      const text = [a.name, upcoming.length ? F.nextText(a, upcoming, []) : V.hoursLine(a), F.priceShort(a)].filter(Boolean).join('\n');
      if (navigator.share) { try { await navigator.share({title: a.name, text, url}); return; } catch (error) { if (error?.name === 'AbortError') return; } }
      await copy(text + '\n' + url, t('share.cardCopied'));
    },
    'copy-questions': () => { const a = V.shown(C.byId.get(state.openId)); copy([a.name, t('card.toConfirm') + F.colon(), ...(a.research?.remaining || []).map(q => '- ' + q)].join('\n\n')); },
    'report-change': () => { const a = C.byId.get(state.openId); if (a) utility(V.report(a, !!sync.config)); },
    'more': () => { const firstNew = state.limit; state.limit += PAGE; render(); $$('#list .row')[firstNew]?.focus(); },
    'open-updates': () => { switchView('saved'); $('#saved-changes')?.focus(); },
    'backup-export': () => { download(EX.backupFile(store.personal)); toast(t('toast.backupExported')); },
    'backup-import': () => els.importFile.click(),
    'csv': () => { download(EX.csvFile(lastItems.length ? lastItems : items(), a => C.statusOf(a, age()))); toast(t('toast.csvExported')); },
    'offline-addresses': () => { const list = store.personal.favorites.map(id => C.byId.get(id)).filter(Boolean); if (list.length) { download(EX.addressesFile(list)); toast(t('toast.addressesExported')); } },
    'share-list': () => utility(V.shareList(), () => utility(V.shareList())),
    'share-send': () => sendShare(true), 'share-copy': () => sendShare(false),
    'save-shared': () => { const p = store.personal; for (const id of state.sharedIds) if (!p.favorites.includes(id)) { p.favorites.push(id); p.tracked[id] = P.snapshot(C.byId.get(id), C.today()); } const saved = store.persist(); render(); toast(t(saved ? 'shared.saved' : 'shared.savedMemory')); },
    'plan-exchange': () => utility(V.planExchange()),
    'plan-import': () => els.planImportFile.click(),
    'plan-download': () => exportPlan(false), 'plan-calendar': () => exportPlan(true),
    'pilot-summary': () => utility(V.pilot()),
    'pilot-download': () => { download(EX.pilotFile(X.metrics(store.personal.visits))); toast(t('toast.pilotExported')); },
    'sync-now': () => sync.retry(),
    'sync-disconnect': () => { sync.disconnect(); els.utility.close(); toast(t('sync.disconnected')); },
    'sync-use-remote': () => sync.takeRemote().then(r => { if (r === 'applied') els.utility.close(); }).catch(error => toast(syncError(error))),
    'sync-use-local': () => sync.keepLocal().then(r => { if (r === 'applied') els.utility.close(); }).catch(error => toast(syncError(error))),
    'include-unknown': () => { state.f.includeUnknownAge = true; render(); },
    'add-child': () => {
      const host = $('#family-children'); if (!host || host.children.length >= 6) return;
      host.insertAdjacentHTML('beforeend', `<label class="costl">${esc(t('cost.childAge'))}<input class="field short family-child-age" type="number" min="0" max="15" step="0.5" value=""></label>`);
      host.lastElementChild.querySelector('input').focus(); updateFamilyPrice();
    }
  };
  const syncError = error => error.status === 401 ? t('sync.badKey') : t('sync.offline');
  async function sendShare(native) {
    const ids = $$('[name="share-place"]:checked').map(el => el.value);
    if (!ids.length || ids.length > 50) { toast(t('share.choose')); return; }
    const url = P.shareURL(location.href, ids, C.byId);
    if (native && navigator.share) { try { await navigator.share({title: t('share.shareTitle'), url}); } catch (error) { if (error.name !== 'AbortError') await copy(url); } }
    else await copy(url);
  }
  document.addEventListener('click', e => {
    const el = e.target.closest('button, a');
    if (!el) return;
    const d = el.dataset;
    if (d.lang) { switchLanguage(d.lang); return; }
    if (el.id === 'brand') { e.preventDefault(); state.f = K.defaultFilters(); state.view = 'catalog'; setHash(null, true); render(); W.scrollTo(0, 0); return; }
    if (el.hasAttribute('data-reset')) { reset(); return; }
    if (d.view) { if (els.utility.open) els.utility.close(); if (els.detail.open) els.detail.close(); switchView(d.view); return; }
    if (d.venue && C.venues.some(v => v.id === d.venue)) { state.venueId = d.venue; state.view = 'venue'; setHash(null, true); if (els.detail.open) els.detail.close(); render(); W.scrollTo(0, 0); return; }
    if (d.plan) { editVisit(d.plan, null, el.hasAttribute('data-plan-event') ? Number(d.planEvent) : null); return; }
    if (d.editVisit && store.personal.visits[d.editVisit]) { editVisit(store.personal.visits[d.editVisit].activity, d.editVisit); return; }
    if (d.ack && C.byId.has(d.ack)) { store.personal.tracked[d.ack] = P.snapshot(C.byId.get(d.ack), C.today()); store.persist(); render(); $('#saved-changes')?.focus(); return; }
    if (d.ics) { download(EX.eventFile(d.ics, Number(d.event))); return; }
    if (d.open) { if (els.utility.open) els.utility.close(); openDetail(d.open); return; }
    if (d.save) { toggleSave(d.save); return; }
    if (el.hasAttribute('data-close')) { closeDetail(); return; }
    if (el.hasAttribute('data-close-utility')) { els.utility.close(); return; }
    if (d.remove !== undefined) { removeFilter(d.remove); ($('button', els.fchips) || els.results).focus({preventScroll: true}); return; }
    if (d.quick === 'indoor') { state.f.indoor = true; state.limit = PAGE; render(); $('[data-remove="indoor"]', els.fchips)?.focus({preventScroll: true}); return; }
    if (d.jump) { const h = document.getElementById('wd-' + d.jump); if (h) { h.scrollIntoView({block: 'start', behavior: W.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'}); h.focus({preventScroll: true}); } return; }
    if (d.action && actions[d.action]) { actions[d.action](); return; }
    if (el.id === 'openAbout') { utility(V.about(), () => utility(V.about())); return; }
    if (el.id === 'openData') { utility(dataDialog(), () => utility(dataDialog())); return; }
  });
  const dataDialog = () => V.data(sync.config, store.personal.favorites.length > 0, store.storageAvailable);
  for (const box of [els.list, els.weekBox]) box.addEventListener('click', e => {
    const a = e.target.closest('a.row'); if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    e.preventDefault(); openDetail(a.dataset.id, true);
  });
  // A folded list of the week view (a day's regular groups or its places) is built when it is opened and dropped when it is closed;
  // the week view is rebuilt on every change and keeps what is unfolded.
  els.weekBox.addEventListener('toggle', e => {
    const box = e.target, day = box.dataset?.day, kind = box.dataset?.kind; if (!day || !kind) return;
    const key = day + '|' + kind, body = $('.wfold-body', box);
    if (box.open) { state.weekOpen.add(key); const d = lastDays.find(x => x.date === day); if (d && body && !body.innerHTML) body.innerHTML = V.weekGroup(d, kind); }
    else { state.weekOpen.delete(key); if (body) body.innerHTML = ''; }
  }, true);
  document.addEventListener('change', e => {
    const el = e.target;
    if (el.id === 'outing-date' && P.validDate(el.value)) { state.outingDate = el.value; render(); }
    else if (el.id === 'plan-status') { state.f.planStatus = el.value; render(); }
    else if (el.id === 'family-adults' || el.matches?.('.family-child-age')) updateFamilyPrice();
    else if (el.id === 'personal-status' && state.openId) { store.personal.statuses[state.openId] = el.value; store.persist(); render(); }
    else if (el.id === 'detail-origin') { store.personal.origin = store.cleanOrigin(el.value); el.value = store.personal.origin; toast(t(store.persist() ? 'data.startSaved' : 'storage.failed')); }
  });
  document.addEventListener('input', e => {
    const el = e.target;
    if (el.id === 'personal-note' && state.openId) { store.personal.notes[state.openId] = el.value; const saved = store.persist(); $('#note-state').textContent = t(saved ? 'mine.saved' : 'mine.notSaved'); }
    else if (el.id === 'family-adults' || el.matches?.('.family-child-age')) updateFamilyPrice();
    else if (el.id === 'report-text') el.setCustomValidity('');
  });
  document.addEventListener('submit', e => {
    const form = e.target;
    if (form.id === 'visit-form') { e.preventDefault(); saveVisit(form); }
    else if (form.id === 'change-report') { e.preventDefault(); submitReport(form); }
    else if (form.id === 'sync-form') {
      e.preventDefault();
      try { sync.connect($('#sync-url').value, $('#sync-key').value); els.utility.close(); } catch (error) { toast(errorText(error)); }
    }
  });
  els.panel.addEventListener('submit', e => e.preventDefault());
  els.q.addEventListener('input', e => { state.f.query = e.target.value; state.limit = PAGE; render(); });
  els.qClear.addEventListener('click', () => { els.q.value = ''; state.f.query = ''; state.limit = PAGE; render(); els.q.focus(); });
  els.moreBtn.addEventListener('click', actions.more);
  els.toFilters.addEventListener('click', toFilters);
  for (const b of [els.nearOpen, $('#nearChange')]) b.addEventListener('click', openNear);
  $('#nearOff').addEventListener('click', () => { store.saveNear(''); setNear(null); (els.nearOpen.hidden ? els.results : els.nearOpen).focus({preventScroll: true}); });
  for (const b of $$('.fp')) b.addEventListener('click', () => openSheet(b.dataset.open));
  els.sheetClose.addEventListener('click', () => els.sheet.close());
  els.sheetDone.addEventListener('click', () => { els.sheet.close(); W.scrollTo({top: 0}); });
  if (wide.addEventListener) wide.addEventListener('change', placePanel); else wide.addListener(placePanel);

  /* ---------- importing files ---------- */
  els.importFile.addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    try {
      if (file.size > 10e6) throw Object.assign(Error('File too large'), {code: 'file.tooLarge'});
      const imported = store.validateBackup(JSON.parse(await file.text()), store.personal.origin);
      if (new Set([...Object.keys(store.personal.visits), ...Object.keys(imported.visits)]).size > P.maxVisits) throw P.fail('visits.merge', 'More than 200 visits after merging.');
      utility(V.importConfirm(imported));
      $('#confirm-import').addEventListener('click', () => {
        const p = store.personal;
        store.personal = {...p, favorites: [...new Set([...p.favorites, ...imported.favorites])], notes: {...p.notes, ...imported.notes}, statuses: {...p.statuses, ...imported.statuses}, visits: {...p.visits, ...imported.visits}, tracked: {...p.tracked, ...imported.tracked}, age: imported.age, origin: imported.origin};
        const saved = store.persist(imported); els.utility.close(); render(); toast(t(saved ? 'import.done' : 'import.memory'));
      });
    } catch (error) { toast(error instanceof SyntaxError ? t('import.unreadable') : errorText(error)); }
  });
  els.planImportFile.addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    try {
      if (file.size > 250000) throw Object.assign(Error('File too large'), {code: 'file.planTooLarge'});
      const preview = X.planSummary(JSON.parse(await file.text()), C.byId, store.personal.visits);
      utility(V.planImportConfirm(preview));
      $('#confirm-plan-import').addEventListener('click', () => {
        try {
          const {clean} = X.planSummary(preview.clean, C.byId, store.personal.visits), p = store.personal;
          for (const [id, v] of Object.entries(clean.visits)) { p.visits[id] = {...(p.visits[id] || P.validateVisits({[id]: v}, C.byId)[id]), ...v}; if (!p.favorites.includes(v.activity)) p.favorites.push(v.activity); }
          const saved = store.persist(); els.utility.close(); state.view = 'saved'; setHash(null, true); render(); toast(t(saved ? 'planImport.done' : 'planImport.memory'));
        } catch (error) { toast(errorText(error)); }
      });
    } catch (error) { toast(error instanceof SyntaxError ? t('planImport.unreadable') : errorText(error)); }
  });

  /* ---------- history, other tabs, start ---------- */
  W.addEventListener('hashchange', () => {
    const h = readHash();
    state.view = h.view; state.venueId = h.venueId; state.sharedIds = h.sharedIds;
    if (h.activity) openDetail(h.activity, false); else if (els.detail.open) els.detail.close();
    render();
  });
  W.addEventListener('storage', e => {
    if (e.key !== store.KEYS.family || !store.storageAvailable) return;
    try {
      const id = state.openId, noteBefore = id ? store.personal.notes[id] : undefined;
      store.reload(); render();
      if (!id) return;
      const a = C.byId.get(id), note = $('#personal-note');
      updateFamilyPrice();
      const fit = $('#detail-age-fit'); if (fit) fit.outerHTML = V.ageFitNote(a) || '<span id="detail-age-fit"></span>';
      $('#detail-save').innerHTML = V.saveButton(a);
      const plans = $('#detail .visit-plans'); if (plans) plans.outerHTML = V.visitPlans(a);
      if (note && store.personal.notes[id] !== noteBefore && document.activeElement !== note) { note.value = store.personal.notes[id] || ''; toast(t('mine.updatedElsewhere')); }
      const sel = $('#personal-status'); if (sel) sel.value = store.personal.statuses[id] || '';
    } catch { toast(t('storage.otherTab')); }
  });
  W.addEventListener('online', () => { sync.now(); if (cardText.failed.has(cardText.lang)) { cardText.triedAt = 0; retryCardText(); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync.now(); });

  cardLanguage(I.lang());
  // The variant of the category icons (category-icons.js, VARIANT) for styles.css.
  document.body.dataset.icons = W.MinitandemCategoryIcons?.VARIANT || 'E';
  applyStatic(); buildPanel(); wirePanel();
  if (store.storageAvailable && store.personal.favorites.some(id => !store.personal.tracked[id])) store.persist();
  // The footer stays out of the page until the list is there (styles.css), so the list never pushes it down.
  try { render(); } finally { document.body.classList.add('ready'); }
  if (first.activity) openDetail(first.activity, false);
  if (!store.storageAvailable) setTimeout(() => toast(t('storage.unavailable')), 100);
  sync.init();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) W.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
})();
