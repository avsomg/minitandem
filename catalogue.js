/* The catalogue as the interface sees it: derived facts, filtering, search and sorting. No DOM and no interface text, so it
   can be tested on its own. create() takes the cards, the districts and the planning helpers; the clock and the translator
   (used only to make category names searchable) can be replaced in tests. */
(() => {
  'use strict';
  const CATEGORY_KEYS = ['play', 'dining', 'movement', 'water', 'horses', 'music', 'creative', 'nature', 'books', 'events'];
  const FORMAT_KEYS = ['group', 'individual', 'event', 'self'];
  const LANGUAGE_KEYS = ['DE', 'DE/FR', 'FR', 'none', 'unknown'];
  const PRICE_KEYS = ['free', 'visit', 'course', 'year', 'unknown'];
  const STATUS_FILTER_KEYS = ['active', 'check', 'future'];
  const PERSONAL_KEYS = ['', 'discuss', 'contact', 'waiting', 'booked', 'visited', 'skip'];
  const WHEN_KEYS = ['', 'upcoming', 'today', 'weekend', 'week'];
  const PRESET_KEYS = ['', 'indoor', 'walkin', 'short'];
  const SCENARIO_KEYS = ['', 'visit', 'event', 'course'];
  const SORT_KEYS = ['default', 'name', 'town', 'date'];
  const DAY_KEYS = [1, 2, 3, 4, 5, 6, 7];
  const VIEWS = ['catalog', 'map', 'saved', 'archive', 'shared', 'venue'];
  const MAX_AGE = 18;
  // Places have a German and a French name; a visitor may type either.
  const ALIASES = {Fribourg: 'Freiburg', Murten: 'Morat', 'Düdingen': 'Guin', Tafers: 'Tavel', Plaffeien: 'Planfayon', Kerzers: 'Chiètres', Meyriez: 'Merlach',
    Schwarzsee: 'Lac Noir', Giffers: 'Chevrilles', Tentlingen: 'Tinterin', Rechthalten: 'Dirlaret', 'St. Ursen': 'Saint-Ours', 'St. Antoni': 'Saint-Antoine',
    'Estavayer-le-Lac': 'Stäffis am See', 'Gruyères': 'Greyerz', Romont: 'Remund'};
  const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const swissNow = () => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(new Date()).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const defaultClock = () => ({today: () => {const p = swissNow(); return `${p.year}-${p.month}-${p.day}`;}, nowHm: () => {const p = swissNow(); return `${p.hour}:${p.minute}`;}});
  const canonicalId = id => id === 'memo-musik' ? 'memo-musik-entdecken-2026-09-29' : id;
  const isArchive = a => ['closed', 'excluded'].includes(a.status);
  const placeNames = a => a.town.split(/\s+\/\s+/).map(name => name.trim()).filter(Boolean);
  const placeKey = (region, name) => `${region}|${name}`;
  // Only a real bound counts as a published age limit; 'from 0 years' with no upper limit says nothing about who may come.
  const bounded = a => (a.min !== null && a.min > 0) || a.max !== null;
  function defaultFilters() {
    return {query: '', place: '', categories: new Set(), formats: new Set(), languages: new Set(), days: new Set(), needs: new Set(), when: '', price: '', status: '',
      scenario: '', preset: '', parentMatch: false, includeUnknownAge: true, planStatus: '', sort: 'default'};
  }

  function create({activities, venues = [], regions, coverage = {}, planning: P, clock = defaultClock(), t = key => key}) {
    const byId = new Map(activities.map(a => [a.id, a]));
    const localities = [...new Map(activities.flatMap(a => placeNames(a).map(name => {
      const key = placeKey(a.region, name);
      return [key, {key, name, region: a.region}];
    }))).values()].sort((a, b) => a.name.localeCompare(b.name, 'de-CH'));
    const localityByKey = new Map(localities.map(place => [place.key, place]));
    const today = () => clock.today();
    const inFuture = e => e.date > today() || (e.date === today() && (!e.end || e.end >= clock.nowHm()));
    const upcoming = a => a.events.filter(inFuture).sort((x, y) => (x.date + (x.start || '')).localeCompare(y.date + (y.start || '')));
    const past = a => a.events.filter(e => !inFuture(e));
    const venueFor = a => venues.find(v => v.members.includes(a.id));

    // true: the published limits include this age; false: they exclude it; null: nothing published that decides it.
    function ageFit(a, age) {
      if (!Number.isFinite(age)) return null;
      if ((a.min !== null && age < a.min) || (a.max !== null && age > a.max)) return false;
      if (a.ageUpperUncertainFrom !== undefined && age >= a.ageUpperUncertainFrom) return null;
      if (a.ageException) return true;
      if (a.min === null) return null;
      return true;
    }
    const ageRank = (a, age) => { const fit = ageFit(a, age); return fit === true ? 0 : fit === null ? 1 : 2; };
    const needsReview = a => Boolean((a.reviewAfter && a.reviewAfter < today()) || (a.scheduleValidThrough && a.scheduleValidThrough < today()) || (a.events.length && a.events.every(e => e.date < today())));
    // The status a visitor sees. A card for older children is 'future' until the chosen age reaches its minimum; from then on it
    // needs checking until the season is confirmed. (With an age below the minimum the age filter hides the card.)
    const statusOf = (a, age) => isArchive(a) ? a.status
      : a.status === 'future' ? (Number.isFinite(age) && a.min !== null && age >= a.min ? 'check' : 'future')
      : needsReview(a) ? 'check' : a.status;

    const searchText = (a, note = '') => norm([a.name, a.town, regions[a.region], a.address, a.age, a.schedule, a.price, a.intro || '', a.parentDetails || '',
      /ludo/i.test(a.name) ? 'toy library ludothek ludotheque' : '', /elki|muki|vaki/i.test(a.name) ? 'parent child eltern kind' : '',
      a.category === 'music' ? 'music musik rhythmique chansons' : '', ...a.notes, ...(a.research?.findings || []).map(f => f.text), ...(a.research?.remaining || []),
      ...Object.values(a.practical || {}).map(f => f?.text).filter(Boolean),
      t('category.' + a.category), ALIASES[a.town] || '', note].join(' '));
    const matchesSearch = (text, query) => norm(query.trim()).split(/\s+/).every(q => text.includes(q));

    function matches(a, f, {age = null, view = 'catalog', personal = null, venueId = '', sharedIds = []} = {}) {
      if (view === 'venue') return Boolean(venues.find(v => v.id === venueId)?.members.includes(a.id));
      if (view === 'shared') return sharedIds.includes(a.id);
      if (f.place) {
        const kind = f.place.slice(0, 2), value = f.place.slice(2);
        if (kind === 'd:' && a.region !== value) return false;
        if (kind === 't:' && !placeNames(a).some(name => placeKey(a.region, name) === value)) return false;
      }
      if (view === 'archive' && !isArchive(a)) return false;
      if (!['archive', 'saved'].includes(view) && isArchive(a)) return false;
      if (view === 'saved' && !personal?.favorites.includes(a.id)) return false;
      if (view === 'saved' && f.planStatus && (personal.statuses[a.id] || 'none') !== f.planStatus) return false;
      if (f.scenario && P.scenario(a) !== f.scenario) return false;
      if (!P.matches(a, f.preset)) return false;
      if (!P.matchesNeeds(a, f.needs)) return false;
      if (f.when) { const now = clock.nowHm(); if (!P.matchesWhen(a, f.when, today(), now)) return false; }
      if (f.categories.size && !f.categories.has(a.category)) return false;
      if (f.formats.size && !f.formats.has(a.format)) return false;
      if (f.languages.size && !Array.from(f.languages).some(l => l === 'unknown' ? !a.languages.length : ['DE', 'FR'].includes(l) ? a.languages.includes(l) || a.languages.includes('DE/FR') : a.languages.includes(l))) return false;
      if (f.days.size && !a.days.some(d => f.days.has(d)) && !a.events.some(e => f.days.has(new Date(e.date + 'T12:00:00Z').getUTCDay() || 7))) return false;
      if (f.price && (f.price === 'free' ? !['free', 'donation'].includes(a.priceKind) : a.priceKind !== f.price)) return false;
      if (f.status && view !== 'archive' && statusOf(a, age) !== f.status) return false;
      if (Number.isFinite(age)) { const fit = ageFit(a, age); if (fit === false || (fit === null && !f.includeUnknownAge)) return false; }
      if (f.parentMatch && a.parent !== 'yes') return false;
      if (f.query.trim()) {
        const text = searchText(a, personal?.notes?.[a.id] || '');
        if (!matchesSearch(text, f.query) && !a.events.some(e => matchesSearch(text + ' ' + norm(e.title || ''), f.query))) return false;
      }
      return true;
    }
    function sortItems(items, f, {age = null, view = 'catalog'} = {}) {
      const byName = (a, b) => a.name.localeCompare(b.name, 'en');
      return items.sort((a, b) => {
        if (f.sort === 'name') return byName(a, b);
        if (f.sort === 'town') return a.town.localeCompare(b.town, 'de-CH') || byName(a, b);
        if (f.sort === 'date') {
          const da = upcoming(a)[0]?.date || '9999', db = upcoming(b)[0]?.date || '9999';
          return da.localeCompare(db) || byName(a, b);
        }
        return view === 'archive' ? 0 : ageRank(a, age) - ageRank(b, age) || byName(a, b);
      });
    }
    function filter(f, context = {}) {
      return sortItems(activities.filter(a => matches(a, f, context)), f, context);
    }
    // Filters shown as active: every option chosen in the panel counts once; the search text has its own field.
    function activeCount(f, age) {
      return (Number.isFinite(age) ? 1 : 0) + (f.place ? 1 : 0) + f.categories.size + f.formats.size + f.languages.size + f.days.size + f.needs.size
        + (f.when ? 1 : 0) + (f.price ? 1 : 0) + (f.status ? 1 : 0) + (f.scenario ? 1 : 0) + (f.preset ? 1 : 0) + (f.parentMatch ? 1 : 0);
    }
    const anyFilter = (f, age) => Boolean(f.query.trim()) || activeCount(f, age) > 0;
    function ageSummary(items, age) {
      const fits = items.filter(a => ageFit(a, age) === true).length;
      return {fits, unknown: items.length - fits};
    }

    // Filters kept for the session: only values that exist are restored.
    function restoreFilters(saved) {
      const f = defaultFilters();
      if (!saved || typeof saved !== 'object') return f;
      const places = (saved.place || '').toString();
      if ((places.startsWith('d:') && Object.hasOwn(regions, places.slice(2))) || (places.startsWith('t:') && localityByKey.has(places.slice(2)))) f.place = places;
      const set = (key, allowed, number = false) => { f[key] = new Set((Array.isArray(saved[key]) ? saved[key] : []).map(x => number ? Number(x) : x).filter(x => allowed.includes(x))); };
      set('categories', CATEGORY_KEYS); set('formats', FORMAT_KEYS); set('languages', LANGUAGE_KEYS); set('days', DAY_KEYS, true); set('needs', P.needKeys);
      const one = (key, allowed) => { if (allowed.includes(saved[key])) f[key] = saved[key]; };
      one('when', WHEN_KEYS); one('price', ['', ...PRICE_KEYS]); one('status', ['', ...STATUS_FILTER_KEYS]); one('scenario', SCENARIO_KEYS); one('preset', PRESET_KEYS);
      one('sort', SORT_KEYS); one('planStatus', ['', 'none', ...PERSONAL_KEYS.filter(Boolean)]);
      if (typeof saved.query === 'string') f.query = saved.query.slice(0, 500);
      f.parentMatch = saved.parentMatch === true;
      f.includeUnknownAge = saved.includeUnknownAge !== false;
      return f;
    }
    const serializeFilters = f => ({...f, categories: [...f.categories], formats: [...f.formats], languages: [...f.languages], days: [...f.days], needs: [...f.needs]});

    // Options of the district-or-town menu: {value, name, count}. A district value is 'd:id', a town value 't:id|name'.
    function placeOptions() {
      const items = activities.filter(a => !isArchive(a));
      const districts = Object.keys(regions).map(id => ({value: 'd:' + id, id, name: regions[id], count: items.filter(a => a.region === id).length})).filter(o => o.count);
      const towns = localities.map(place => ({value: 't:' + place.key, id: place.key, name: place.name, region: place.region, count: items.filter(a => placeNames(a).some(n => placeKey(a.region, n) === place.key)).length})).filter(o => o.count);
      return {districts, towns};
    }
    return {PERSONAL: PERSONAL_KEYS, norm, isArchive, byId, localities, localityByKey, today, inFuture, upcoming, past, venueFor, ageFit, ageRank, bounded, needsReview, statusOf, searchText, matchesSearch, matches, filter,
      sortItems, activeCount, anyFilter, ageSummary, restoreFilters, serializeFilters, placeOptions, regions, coverage, venues, activities};
  }
  window.MinitandemCatalogue = {create, defaultFilters, swissNow, norm, canonicalId, isArchive, placeNames, placeKey, bounded, ALIASES, MAX_AGE,
    CATEGORY_KEYS, FORMAT_KEYS, LANGUAGE_KEYS, PRICE_KEYS, STATUS_FILTER_KEYS, PERSONAL_KEYS, WHEN_KEYS, PRESET_KEYS, SCENARIO_KEYS, SORT_KEYS, DAY_KEYS, VIEWS};
})();
