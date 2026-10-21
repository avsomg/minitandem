/* The catalogue as the interface sees it: derived facts, filtering, search, sorting, distances and the week agenda. No DOM and
   no interface text, so it can be tested on its own. create() takes the cards, the districts, the town centres and the planning
   helpers; the clock and the translator (used only to make category names searchable) can be replaced in tests. */
(() => {
  'use strict';
  const CATEGORY_KEYS = ['play', 'dining', 'movement', 'water', 'horses', 'music', 'creative', 'nature', 'books', 'events'];
  const FORMAT_KEYS = ['group', 'individual', 'event', 'self'];
  const LANGUAGE_KEYS = ['DE', 'DE/FR', 'FR', 'none', 'unknown'];
  const PRICE_KEYS = ['free', 'visit', 'course', 'year', 'unknown'];
  const STATUS_FILTER_KEYS = ['active', 'check', 'future'];
  const PERSONAL_KEYS = ['', 'discuss', 'contact', 'waiting', 'booked', 'visited', 'skip'];
  const WHEN_KEYS = ['', 'upcoming', 'today', 'weekend', 'week'];
  // 'indoor' used to be a preset; it is its own switch now (f.indoor) so that it combines with the others.
  const PRESET_KEYS = ['', 'walkin', 'short'];
  const SCENARIO_KEYS = ['', 'visit', 'event', 'course'];
  const SORT_KEYS = ['default', 'name', 'town', 'date', 'near'];
  // A distance limit in km around the point the visitor set (0: none). It needs a point; without one it has no effect.
  const RADIUS_KEYS = [0, 5, 10, 20, 30];
  // The "when" choices that mean days (as opposed to "has upcoming dates"): they count regular groups and opening hours as well.
  const DAY_WHEN = ['today', 'weekend', 'week'];
  const DAY_KEYS = [1, 2, 3, 4, 5, 6, 7];
  // 'childcare' is the Daycare tab (childcare.js); the address names it like the other views.
  const VIEWS = ['catalog', 'week', 'map', 'saved', 'archive', 'shared', 'venue', 'childcare'];
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
  // A card the map plots: one confirmed address point, not a descriptive area, and no date with an address of its own. The map (map.js)
  // and its caption and address lists (views.js mapBox) use this one rule, so that the counts match the points.
  const onMap = a => Boolean(a.geo) && a.addressPrecision !== 'area' && !a.events.some(e => e.address && e.address !== a.address);
  function defaultFilters() {
    return {query: '', place: '', categories: new Set(), formats: new Set(), languages: new Set(), days: new Set(), needs: new Set(), when: '', price: '', status: '',
      scenario: '', preset: '', indoor: false, radius: 0, parentMatch: false, includeUnknownAge: true, planStatus: '', sort: 'default'};
  }
  // Swiss calendar dates as 'YYYY-MM-DD'; weekdays as on the cards and in the day filter: 1 = Monday ... 7 = Sunday.
  const addDays = (date, n) => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const weekdayOf = date => new Date(date + 'T12:00:00Z').getUTCDay() || 7;
  // Straight-line (great-circle) distance in km between two {lat, lon} points. Not a travel distance.
  function distanceKm(from, to) {
    const rad = x => x * Math.PI / 180, dLat = rad(to.lat - from.lat), dLon = rad(to.lon - from.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  // The time a schedule gives for one weekday (1 = Monday ... 7 = Sunday), read from the English text: "Mon–Fri 09–22, Sat–Sun 09–20" gives
  // "09–20" for Saturday. Each time is read with the day words right before it. Nothing is guessed: null when the part that names the day
  // also has a rule a weekday cannot express ("2nd and 4th Saturday", "by arrangement", a season, holidays), ends before the date or starts
  // after it ("until 30.09"), when the day has no time, or when it appears in more than one part.
  const DAY_WORDS = [['mon', 'monday', 'mondays'], ['tue', 'tues', 'tuesday', 'tuesdays'], ['wed', 'wednesday', 'wednesdays'], ['thu', 'thur', 'thurs', 'thursday', 'thursdays'],
    ['fri', 'friday', 'fridays'], ['sat', 'saturday', 'saturdays'], ['sun', 'sunday', 'sundays']];
  const dayOfWord = word => DAY_WORDS.findIndex(words => words.includes(String(word).toLowerCase())) + 1;
  const CONNECTORS = ['–', '-', ',', '/', '&', 'and', 'to'];
  // The days a run of day words stands for: "Sat–Sun" is 6 and 7, "Tue, Thu" is 2 and 4.
  function expandDays(spec) {
    const days = new Set();
    for (let i = 0; i < spec.length; i++) {
      const day = dayOfWord(spec[i]); if (!day) continue;
      const next = (spec[i + 1] || '').toLowerCase(), end = ['–', '-', 'to'].includes(next) && dayOfWord(spec[i + 2] || '');
      if (end) { for (let d = day; ; d = d % 7 + 1) { days.add(d); if (d === end) break; } i += 2; } else days.add(day);
    }
    return days;
  }
  // The days named just before a time: "Sat–Sun", "Tue, Thu, Fri", "Monday to Saturday", "Daily".
  function daysBefore(head) {
    const tokens = head.match(/[A-Za-z]+|[–\-,/&]/g) || [];
    let start = tokens.length;
    while (start > 0 && (dayOfWord(tokens[start - 1]) || CONNECTORS.includes(tokens[start - 1].toLowerCase()))) start--;
    const spec = tokens.slice(start);
    if (!spec.some(dayOfWord)) return /\b(?:daily|every day)\s*$/i.test(head) ? new Set(DAY_KEYS) : null;
    return expandDays(spec);
  }
  const TIME = String.raw`\d{1,2}(?::\d{2})?\s*[–-]\s*\d{1,2}(?::\d{2})?`;
  const TIMES = new RegExp(String.raw`(?<![\d.:])${TIME}(?:\s*(?:,|and|&|or|/)\s*${TIME})*(?![\d:]|\.\d)`, 'g');
  // A day and month in the text ("until 31.10", "from 01.11.2026") as a date of the given year.
  const dayMonth = (match, year) => `${match[3] || year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  // A schedule in its parts: "Sat 09:30–11:00 · first Tue 17:30–18:30; except holidays" is three.
  const clausesOf = schedule => String(schedule || '').split(/\s*(?:;|·|\.\s|\n)\s*/);
  function scheduleSlot(schedule, weekday, date = '') {
    const hits = [];
    for (const clause of clausesOf(schedule)) {
      let last = 0;
      for (const match of clause.matchAll(TIMES)) {
        const days = daysBefore(clause.slice(last, match.index));
        last = match.index + match[0].length;
        if (!days || !days.has(weekday)) continue;
        if (/\b(?:1st|2nd|3rd|4th|5th|first|second|third|fourth|last|every other|alternate|once a month|monthly|fortnightly|on request|arrangement|winter|summer|spring|autumn|season|holidays?|vacation|closed)\b/i.test(clause)) return null;
        if (date) {
          const until = clause.match(/\buntil (\d{1,2})\.(\d{1,2})\.?(\d{4})?/i), from = clause.match(/\bfrom (\d{1,2})\.(\d{1,2})\.?(\d{4})?/i);
          if ((until && dayMonth(until, date.slice(0, 4)) < date) || (from && dayMonth(from, date.slice(0, 4)) > date)) return null;
        }
        hits.push(match[0].replace(/\s*[–-]\s*(?=\d)/g, '–').replace(/\s*(?:,|and|&|or|\/)\s*(?=\d)/g, ', '));
      }
    }
    return hits.length === 1 ? hits[0] : null;
  }
  // Whether a schedule goes on after its first ";" with more days or times ("Mon 14:00–21:00; Tue 06:00–21:00"), not just with a remark
  // ("; except holidays"). A row that shows only the first part uses it to say that there is more.
  const moreTimes = schedule => { const rest = String(schedule || '').split(';').slice(1).join(';'); return Boolean(rest.match(TIMES)) || clauseDays(rest).size > 0; };
  // Every weekday one clause names: "Mon, Wed 09:00–18:00", "Sat–Sun", "1st and 3rd Fridays", "Daily".
  function clauseDays(clause) {
    const tokens = clause.match(/[A-Za-z]+|[–\-,/&]/g) || [], days = new Set();
    for (let i = 0; i < tokens.length; i++) {
      if (!dayOfWord(tokens[i])) continue;
      let end = i;
      while (end + 1 < tokens.length && (dayOfWord(tokens[end + 1]) || CONNECTORS.includes(tokens[end + 1].toLowerCase()))) end++;
      expandDays(tokens.slice(i, end + 1)).forEach(day => days.add(day));
      i = end;
    }
    if (/\b(?:daily|every day)\b/i.test(clause)) DAY_KEYS.forEach(day => days.add(day));
    return days;
  }
  // The days of the week are a search facet, not a recurrence rule (editorial/field-contract.mjs), so a card counts as meeting every week on a
  // weekday only when its schedule does not say otherwise. Otherwise: "first Tue", "1st and 3rd Thu", "every other Friday", "once a month", a
  // listed date ("Sat 10.10.") or dates that are not confirmed. Nothing is turned into dates; such a card is simply not claimed for a given day.
  const ORDINAL = String.raw`(?:1st|2nd|3rd|4th|5th|first|second|third|fourth|fifth|last)`, WEEKDAY_WORD = DAY_WORDS.flat().join('|');
  const ORDINAL_DAY = new RegExp(String.raw`\b${ORDINAL}(?:\s*(?:,|and|&|or|/|–|-|to)\s*${ORDINAL})*\s+(${WEEKDAY_WORD})\b`, 'gi');
  // A weekday followed by a day and month ("Sat 10.10."), not a range ("Sat 03.10.–28.11.") and not a time written with a dot ("Sat 09.30").
  const DATED_DAY = new RegExp(String.raw`\b(${WEEKDAY_WORD})\b\.?,?\s+(\d{1,2})\.(\d{1,2})(?:\.(?:\d{4})?)?`, 'gi');
  const datedDays = clause => [...clause.matchAll(DATED_DAY)].filter(m => +m[2] >= 1 && +m[2] <= 31 && +m[3] >= 1 && +m[3] <= 12 && !/^\s*[–-]\s*\d/.test(clause.slice(m.index + m[0].length))).map(m => dayOfWord(m[1]));
  const OTHER_RHYTHM = /\b(?:every (?:other|second|2nd|two weeks|2 weeks)|alternate|alternating|fortnightly|bi-?weekly|monthly|(?:once|twice) (?:a|per) month)\b/i;
  const DATES_UNCONFIRMED = /\b(?:(?:on )?(?:the )?(?:published|listed|announced) dates|dates?\b[^.;·]{0,30}?\b(?:not (?:yet )?(?:confirmed|published|set|known)|to be (?:confirmed|announced)|have not been published))\b/i;
  // true: the schedule gives this weekday only in such wording (or says its dates are unconfirmed), so it is no weekly opening.
  // false: a weekly slot, or the weekday is not mentioned at all (open places keep all seven days). A plain mention beats a restricted one.
  function restrictedOn(schedule, weekday) {
    if (DATES_UNCONFIRMED.test(String(schedule || ''))) return true;
    let named = false, plain = false;
    for (const clause of clausesOf(schedule)) {
      if (!clauseDays(clause).has(weekday)) continue;
      const restricted = new Set([...[...clause.matchAll(ORDINAL_DAY)].map(m => dayOfWord(m[1])), ...datedDays(clause)]);
      if (OTHER_RHYTHM.test(clause)) clauseDays(clause).forEach(day => restricted.add(day));
      named = true; if (!restricted.has(weekday)) plain = true;
    }
    return named && !plain;
  }
  // What a row shows: one decimal under 1 km, whole kilometres above.
  const roundKm = km => km < 1 ? Math.max(0.1, Math.round(km * 10) / 10) : Math.round(km);

  function create({activities, venues = [], regions, towns = {}, coverage = {}, planning: P, clock = defaultClock(), t = key => key}) {
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
    // Town centres (data-towns.js): {lat, lon, ...} or null when the town could not be matched.
    const townCentre = name => { const c = Object.hasOwn(towns, name) ? towns[name] : null; return c && Number.isFinite(c.lat) && Number.isFinite(c.lon) ? c : null; };
    // The point a card is measured to: its checked address point (the same rule as the map: not an area, not an address that
    // changes by date), else the centre of its town, approximate. null: no point at all, the distance is unknown.
    const exactPoint = a => a.geo && a.addressPrecision !== 'area' && !a.events.some(e => e.address && e.address !== a.address) ? a.geo : null;
    // A date counts for a card when a dated session falls on it (today: one not over yet), or when the card has no dated sessions, names
    // that weekday, its schedule has not run out by then and does not limit that weekday (restrictedOn: "first Tue", every other week,
    // listed or unconfirmed dates). Such a card stays findable through the weekday filter but is not claimed for a particular day.
    // The week view and the day filters use the same two tests.
    const sessionsOn = (a, date) => a.events.filter(e => e.date === date && inFuture(e));
    const repeatsOn = (a, date) => !isArchive(a) && !a.events.length && a.days.includes(weekdayOf(date)) && (!a.scheduleValidThrough || a.scheduleValidThrough >= date)
      && !restrictedOn((a.english || a).schedule, weekdayOf(date));
    function whenDates(mode) {
      if (!DAY_WHEN.includes(mode)) return null;
      const [from, to] = P.range(mode, today()), dates = [];
      for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
      return dates;
    }
    // How a card meets a day filter: {date, kind} with kind 'session', 'regular' (a group or course) or 'place' (visited on one's own);
    // null when it does not, or when no day filter is on.
    // The date named is a chosen weekday when there is one (days first): a row under "next 7 days" and "Sun" says Sunday, not today.
    function whenInfo(a, f) {
      const all = whenDates(f.when);
      if (!all) return null;
      const dates = f.days?.size ? [...all.filter(d => f.days.has(weekdayOf(d))), ...all.filter(d => !f.days.has(weekdayOf(d)))] : all;
      for (const date of dates) if (sessionsOn(a, date).length) return {date, kind: 'session'};
      for (const date of dates) if (repeatsOn(a, date)) return {date, kind: a.format === 'self' ? 'place' : 'regular'};
      return null;
    }
    function distanceOf(a, from) {
      if (!from) return null;
      const exact = exactPoint(a);
      if (exact) return {km: distanceKm(from, exact), exact: true};
      // A card in "Giffers / Tentlingen" takes the nearer of its two towns.
      const centres = placeNames(a).map(townCentre).filter(Boolean);
      return centres.length ? {km: Math.min(...centres.map(c => distanceKm(from, c))), exact: false} : null;
    }

    // true: the published limits include this age; false: they exclude it; null: nothing published that decides it.
    function ageFit(a, age) {
      if (!Number.isFinite(age)) return null;
      if ((a.min !== null && !P.ageFrom(a, age)) || (a.max !== null && age > a.max)) return false;
      if (P.ageUncertain(a, age)) return null;
      if (a.ageException) return true;
      if (a.min === null) return null;
      return true;
    }
    const ageRank = (a, age) => { const fit = ageFit(a, age); return fit === true ? 0 : fit === null ? 1 : 2; };
    const needsReview = a => Boolean((a.reviewAfter && a.reviewAfter < today()) || (a.scheduleValidThrough && a.scheduleValidThrough < today()) || (a.events.length && a.events.every(e => e.date < today())));
    // The status a visitor sees. A card for older children is 'future' until the chosen age reaches its minimum; from then on it
    // needs checking until the season is confirmed. (With an age below the minimum the age filter hides the card.)
    const statusOf = (a, age) => isArchive(a) ? a.status
      : a.status === 'future' ? (Number.isFinite(age) && P.ageFrom(a, age) ? 'check' : 'future')
      : needsReview(a) ? 'check' : a.status;

    // The card's text in the interface language, when a translation is shown (set by app.js): search finds both it and the English.
    let localText = () => '';
    const setLocalText = fn => { localText = typeof fn === 'function' ? fn : () => ''; };
    const searchText = (a, note = '') => norm([localText(a), a.name, a.town, regions[a.region], a.address, a.age, a.schedule, a.price, a.intro || '', a.parentDetails || '',
      /ludo/i.test(a.name) ? 'toy library ludothek ludotheque' : '', /elki|muki|vaki/i.test(a.name) ? 'parent child eltern kind' : '',
      a.category === 'music' ? 'music musik rhythmique chansons' : '', ...a.notes, ...(a.research?.findings || []).map(f => f.text), ...(a.research?.remaining || []),
      ...Object.values(a.practical || {}).map(f => f?.text).filter(Boolean),
      t('category.' + a.category), ALIASES[a.town] || '', note].join(' '));
    const matchesSearch = (text, query) => norm(query.trim()).split(/\s+/).every(q => text.includes(q));

    function matches(a, f, {age = null, view = 'catalog', personal = null, venueId = '', sharedIds = [], near = null} = {}) {
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
      // Rainy day: only cards whose organiser states the activity is indoors; unknown and outdoor cards are left out.
      if (f.indoor && !P.matches(a, 'indoor')) return false;
      if (!P.matchesNeeds(a, f.needs)) return false;
      if (f.when) {
        if (DAY_WHEN.includes(f.when)) { if (!whenInfo(a, f)) return false; }
        else if (!P.matchesWhen(a, f.when, today(), clock.nowHm())) return false;
      }
      // A distance limit: only cards with a known distance within it (unknown distances are left out while it is on).
      if (f.radius && near) { const d = distanceOf(a, near); if (!d || d.km > f.radius) return false; }
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
    function sortItems(items, f, {age = null, view = 'catalog', near = null} = {}) {
      const byName = (a, b) => a.name.localeCompare(b.name, 'en');
      // Nearest first needs a point; without one the default order applies. Cards are ordered by the kilometre a row shows (under 1 km
      // counts as 0), within one kilometre a checked address before a town-centre estimate, then by distance; no distance comes last.
      const key = a => { const d = distanceOf(a, near); return d ? [d.km < 1 ? 0 : Math.round(d.km), d.exact ? 0 : 1, d.km] : [Infinity, 1, Infinity]; };
      const keys = f.sort === 'near' && near ? new Map(items.map(a => [a.id, key(a)])) : null;
      const cmp = (x, y) => x === y ? 0 : x < y ? -1 : 1;
      return items.sort((a, b) => {
        if (keys) { const x = keys.get(a.id), y = keys.get(b.id); return cmp(x[0], y[0]) || cmp(x[1], y[1]) || cmp(x[2], y[2]) || byName(a, b); }
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
    // This week: today and the next six days, for cards that already passed the filters. Each day lists the dated sessions on it
    // (today only those not yet over) and, apart, what repeats on that weekday: cards without dated sessions whose weekdays include
    // the day, whose schedule has not run out by then (scheduleValidThrough) and does not limit that weekday (repeatsOn). These are cards of the list, with the same
    // status on each row, so "check details" and "for later" stay visible as such. They are split into regular groups, courses and
    // individual offers (regular) and places to visit on your own during their hours (places, format 'self'). Weekly times are never
    // turned into dates, so holidays and breaks are unknown. A day outside a chosen weekday or "when" filter is left out.
    function week(items, f, {age = null, near = null} = {}) {
      const start = today(), [from, to] = f.when ? P.range(f.when, start) : [start, '9999-12-31'];
      const byTime = (x, y) => (x.e.start || '99:99').localeCompare(y.e.start || '99:99') || x.a.name.localeCompare(y.a.name, 'en');
      const days = [];
      for (let offset = 0; offset < 7; offset++) {
        const date = addDays(start, offset), weekday = weekdayOf(date);
        if ((f.days.size && !f.days.has(weekday)) || date < from || date > to) continue;
        const sessions = items.flatMap(a => a.events.map((e, index) => ({a, e, index}))).filter(({e}) => e.date === date && inFuture(e)).sort(byTime);
        const repeating = items.filter(a => repeatsOn(a, date));
        days.push({date, weekday, offset, sessions, regular: sortItems(repeating.filter(a => a.format !== 'self'), f, {age, near}),
          places: sortItems(repeating.filter(a => a.format === 'self'), f, {age, near})});
      }
      return days;
    }
    // The cards a week lists, each once.
    const weekCards = days => [...new Map(days.flatMap(d => [...d.sessions.map(s => s.a), ...d.regular, ...d.places]).map(a => [a.id, a])).values()];
    // Filters shown as active: every option chosen in the panel counts once; the search text has its own field.
    function activeCount(f, age) {
      return (Number.isFinite(age) ? 1 : 0) + (f.place ? 1 : 0) + f.categories.size + f.formats.size + f.languages.size + f.days.size + f.needs.size
        + (f.when ? 1 : 0) + (f.price ? 1 : 0) + (f.status ? 1 : 0) + (f.scenario ? 1 : 0) + (f.preset ? 1 : 0) + (f.indoor ? 1 : 0) + (f.radius ? 1 : 0) + (f.parentMatch ? 1 : 0);
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
      one('when', WHEN_KEYS); if (RADIUS_KEYS.includes(Number(saved.radius))) f.radius = Number(saved.radius); one('price', ['', ...PRICE_KEYS]); one('status', ['', ...STATUS_FILTER_KEYS]); one('scenario', SCENARIO_KEYS); one('preset', PRESET_KEYS);
      one('sort', SORT_KEYS); one('planStatus', ['', 'none', ...PERSONAL_KEYS.filter(Boolean)]);
      if (typeof saved.query === 'string') f.query = saved.query.slice(0, 500);
      f.parentMatch = saved.parentMatch === true;
      // A session saved while "indoors" was a preset keeps the filter on.
      f.indoor = saved.indoor === true || saved.preset === 'indoor';
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
    // Towns a visitor can measure from: those with a centre, by name.
    const centreTowns = () => [...new Set(localities.map(place => place.name))].filter(townCentre).sort((a, b) => a.localeCompare(b, 'de-CH'));
    return {PERSONAL: PERSONAL_KEYS, norm, isArchive, byId, localities, localityByKey, today, inFuture, upcoming, past, venueFor, ageFit, ageRank, bounded, needsReview, statusOf, searchText, setLocalText, matchesSearch, matches, filter,
      sortItems, activeCount, anyFilter, ageSummary, restoreFilters, serializeFilters, placeOptions, townCentre, centreTowns, distanceOf, week, weekCards, whenDates, whenInfo, sessionsOn, repeatsOn, regions, coverage, venues, activities};
  }
  window.MinitandemCatalogue = {create, defaultFilters, swissNow, norm, canonicalId, isArchive, placeNames, placeKey, bounded, onMap, addDays, weekdayOf, distanceKm, roundKm, scheduleSlot, moreTimes, restrictedOn, RADIUS_KEYS, DAY_WHEN, ALIASES, MAX_AGE,
    CATEGORY_KEYS, FORMAT_KEYS, LANGUAGE_KEYS, PRICE_KEYS, STATUS_FILTER_KEYS, PERSONAL_KEYS, WHEN_KEYS, PRESET_KEYS, SCENARIO_KEYS, SORT_KEYS, DAY_KEYS, VIEWS};
})();
