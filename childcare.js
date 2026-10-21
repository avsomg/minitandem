/* The Daycare tab as the interface sees it: the preschool places and commune rules of data-childcare.js, their filters, the child's age,
   distances, the order of the list and the dates of an application. No DOM and no interface text (like catalogue.js), so it can be tested on
   its own. app.js loads data-childcare.js the first time the tab is opened and then calls create() again with it. */
(() => {
  'use strict';
  const TYPE_KEYS = ['creche', 'garderie', 'family-day-care', 'playgroup', 'nature-playgroup', 'maternelle'];
  const SUBSIDY_KEYS = ['yes', 'convention', 'no'];
  const LANGUAGE_KEYS = ['fr', 'de', 'en'];
  const APPROACH_KEYS = ['montessori', 'montessoriElements', 'nature', 'bilingual'];
  // "Opens by" and "open until at least": the times a family needs, compared with the opening and closing time a place states.
  const OPENS_KEYS = ['06:30', '07:00', '07:30', '08:00'];
  const CLOSES_KEYS = ['12:00', '16:00', '18:00', '18:30'];
  // What a family marks under "My application"; no status is ''.
  const APPLICATION_KEYS = ['interested', 'registered', 'waiting', 'offered', 'accepted', 'declined'];
  // The parts of the tab: the list, the map and the family's own applications.
  const VIEW_KEYS = ['list', 'map', 'mine'];
  // The rows of a place's page, in the order of the preview the owner accepted, and the rules of a commune.
  const DETAIL_ROWS = ['age', 'hours', 'closures', 'price', 'registration', 'availability', 'meals', 'settlingIn', 'trialPeriod', 'pedagogy', 'languages'];
  const RULE_KEYS = ['registration', 'registrationFrom', 'renewal', 'residency', 'registrationFee', 'tariff', 'privateSupport', 'subsidisedPlaces', 'calculator'];
  const defaultFilters = () => ({query: '', types: new Set(), subsidy: new Set(), languages: new Set(), approaches: new Set(), opensBy: '', closesAfter: ''});
  // A published fact's value (null when the place or commune does not publish it) and the pages it rests on.
  const value = (record, key) => record?.facts?.[key]?.value ?? null;
  const sources = (record, key) => (record?.facts?.[key]?.sources || []).map(i => record.pages?.[i]).filter(Boolean);
  const pending = (record, key) => Boolean(record?.pending?.includes(key));
  // The minimum age in months, for comparing only: a page that counts in weeks keeps its weeks on the screen.
  function minMonths(p) {
    const v = value(p, 'ageFrom');
    if (Number.isFinite(v?.months)) return v.months;
    if (Number.isFinite(v?.weeks)) return v.weeks * 7 / 30.44;
    return null;
  }
  const maxYears = p => { const v = value(p, 'ageTo'); return Number.isFinite(v?.years) ? v.years : null; };
  // As for the activities (catalogue.js ageFit): true when the published limits include the age, false when they exclude it, null when no
  // minimum is published. A whole age stands for that birthday, 0 for the first year: every minimum under 12 months is reached.
  function ageFit(p, age) {
    if (!Number.isFinite(age)) return null;
    const min = minMonths(p), max = maxYears(p);
    if ((min !== null && !(age === 0 ? min < 12 : min <= age * 12)) || (max !== null && age > max)) return false;
    return min === null ? null : true;
  }
  function approaches(p) {
    const v = value(p, 'pedagogy');
    return v ? [v.montessori === 'full' && 'montessori', v.montessori === 'partial' && 'montessoriElements', v.nature === true && 'nature', v.bilingual === true && 'bilingual'].filter(Boolean) : [];
  }
  // Dates as 'YYYY-MM-DD'. A month later keeps the day or takes the month's last day (31 January and one month is the end of February).
  function addMonths(date, n) {
    const [y, m, d] = date.split('-').map(Number), total = y * 12 + m - 1 + n, year = Math.floor(total / 12), month = total % 12 + 1;
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
  }
  // The next date by which a registration has to be renewed: every `months` counted from the day of registration, the first one from today on.
  function nextRenewal(registered, months, today) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(registered || '') || !Number.isInteger(months) || months < 1) return '';
    let next = addMonths(registered, months);
    for (let k = 2; next < today && k < 600; k++) next = addMonths(registered, months * k);
    return next;
  }
  const emptyApplication = () => ({status: '', registered: '', renewBy: '', note: ''});
  const isEmptyApplication = a => !a || !(a.status || a.registered || a.renewBy || a.note);

  // data: window.CHILDCARE (or nothing while it is loading); K: catalogue.js for distances and text matching; clock.today(); t only makes
  // the kinds of care searchable in the interface language, as catalogue.js does with the categories.
  function create({data = null, K, clock, t = key => key}) {
    const places = data?.places || [], communes = data?.communes || [];
    const byId = new Map(places.map(p => [p.id, p])), communeById = new Map(communes.map(c => [c.id, c]));
    const today = () => clock.today();
    // Straight-line distance in km from the point the visitor set to the place's point in the canton's list.
    const distance = (p, from) => from ? K.distanceKm(from, {lat: p.lat, lon: p.lon}) : null;
    const searchText = p => K.norm([p.name, p.town, p.address, p.postcode, t('childcare.type.' + p.type), K.ALIASES[p.town] || ''].join(' '));
    function matches(p, f, {age = null, near = null, radius = 0} = {}) {
      if (f.types.size && !f.types.has(p.type)) return false;
      if (f.subsidy.size && !f.subsidy.has(value(p, 'subsidised')?.value)) return false;
      if (f.languages.size && ![...f.languages].some(l => (value(p, 'languages') || []).includes(l))) return false;
      if (f.approaches.size && ![...f.approaches].some(a => approaches(p).includes(a))) return false;
      const hours = value(p, 'hours');
      if (f.opensBy && !(hours?.opensAt && hours.opensAt <= f.opensBy)) return false;
      if (f.closesAfter && !(hours?.closesAt && hours.closesAt >= f.closesAfter)) return false;
      if (ageFit(p, age) === false) return false;
      if (radius && near && distance(p, near) > radius) return false;
      if (f.query.trim() && !K.norm(f.query.trim()).split(/\s+/).every(q => searchText(p).includes(q))) return false;
      return true;
    }
    // Nearest first once a point is set; otherwise the places whose published age fits first (with an age chosen), then by town and name,
    // a place the canton lists without a town last.
    function sort(list, {age = null, near = null} = {}) {
      const byName = (a, b) => Number(!a.town) - Number(!b.town) || a.town.localeCompare(b.town, 'de-CH') || a.name.localeCompare(b.name, 'de-CH');
      if (near) { const d = new Map(list.map(p => [p.id, distance(p, near)])); return list.sort((a, b) => d.get(a.id) - d.get(b.id) || byName(a, b)); }
      const rank = p => { const fit = ageFit(p, age); return fit === true ? 0 : fit === null ? 1 : 2; };
      return list.sort((a, b) => (Number.isFinite(age) ? rank(a) - rank(b) : 0) || byName(a, b));
    }
    const filter = (f, context = {}) => sort(places.filter(p => matches(p, f, context)), context);
    // The filters that are on, each as {key, kind, value}; the key is what removing it takes ('type:creche', 'opens').
    const SETS = {type: 'types', subsidy: 'subsidy', lang: 'languages', approach: 'approaches'};
    function active(f) {
      return [...Object.entries(SETS).flatMap(([kind, set]) => [...f[set]].map(v => ({key: kind + ':' + v, kind, value: v}))),
        ...(f.opensBy ? [{key: 'opens', kind: 'opens', value: f.opensBy}] : []), ...(f.closesAfter ? [{key: 'closes', kind: 'closes', value: f.closesAfter}] : [])];
    }
    const ALLOWED = {type: TYPE_KEYS, subsidy: SUBSIDY_KEYS, lang: LANGUAGE_KEYS, approach: APPROACH_KEYS};
    function toggle(f, kind, v) {
      if (SETS[kind] && ALLOWED[kind].includes(v)) { const set = f[SETS[kind]]; if (set.has(v)) set.delete(v); else set.add(v); }
      else if (kind === 'opens') f.opensBy = OPENS_KEYS.includes(v) ? v : '';
      else if (kind === 'closes') f.closesAfter = CLOSES_KEYS.includes(v) ? v : '';
    }
    function remove(f, key) {
      const [kind, ...rest] = key.split(':'), v = rest.join(':');
      if (SETS[kind]) f[SETS[kind]].delete(v); else if (kind === 'opens') f.opensBy = ''; else if (kind === 'closes') f.closesAfter = '';
    }
    const anyFilter = f => Boolean(f.query.trim()) || active(f).length > 0;
    const typeCounts = () => Object.fromEntries(TYPE_KEYS.map(k => [k, places.filter(p => p.type === k).length]));
    // "Where do you live?": the communes and, apart, the regional bodies and associations, each by name.
    function communeOptions() {
      const byName = (a, b) => a.name.localeCompare(b.name, 'de-CH');
      return {communes: communes.filter(c => c.kind !== 'region').sort(byName), regions: communes.filter(c => c.kind === 'region').sort(byName)};
    }
    // The renewal interval a commune's confirmed rule states, in months, else null.
    const renewMonths = id => communeById.get(id)?.renewMonths ?? null;
    // A place in the shape map.js plots (catalogue.js onMap): its point from the canton's list, the address as the popup's label.
    const addressLine = p => [p.address, [p.postcode, p.town].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const mapItem = p => ({id: p.id, name: p.name, geo: {lat: p.lat, lon: p.lon, label: addressLine(p) || p.name}, events: [], addressPrecision: ''});
    // The latest date a place or a commune was checked, said once at the top of the tab.
    const checkedOn = () => [...places, ...communes].reduce((d, r) => r.checked > d ? r.checked : d, '');
    return {places, communes, byId, communeById, loaded: Boolean(data), today, distance, matches, sort, filter, active, toggle, remove, anyFilter, typeCounts,
      communeOptions, renewMonths, addressLine, mapItem, checkedOn, ageFit, approaches, value, sources, pending};
  }
  window.MinitandemChildcare = {create, defaultFilters, value, sources, pending, ageFit, approaches, minMonths, maxYears, addMonths, nextRenewal, emptyApplication, isEmptyApplication,
    TYPE_KEYS, SUBSIDY_KEYS, LANGUAGE_KEYS, APPROACH_KEYS, OPENS_KEYS, CLOSES_KEYS, APPLICATION_KEYS, VIEW_KEYS, DETAIL_ROWS, RULE_KEYS};
})();
