/* Markup of the interface: list rows, the filter panel, the week view, the card page, the saved view and the dialogs. Every function returns an
   HTML string built from card content (escaped) and words from the dictionaries (through t). No DOM access, no events:
   app.js puts the markup into the page and wires it. ctx = {t, C, P, X, F, store, state, shown, inEnglish} (see app.js): shown(card) is the
   card as the visitor reads it (its German or French translation where one is current), inEnglish(card) says that a card falls back to English.
   Logic, links to maps and the comparison of saved cards keep the English card. */
(() => {
  'use strict';
  const NBSP = String.fromCharCode(160);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const svg = (size, body, extra = '') => `<svg ${extra} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICON = {
    search: size => svg(size, '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>', 'class="si"'),
    x: size => svg(size, '<path d="M6 6l12 12M18 6L6 18"/>'),
    sliders: size => svg(size, '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
    chev: size => svg(size, '<path d="M9 6l6 6-6 6"/>', 'class="chev"'),
    tick: size => svg(size, '<path d="M5 12.5l4.5 4.5L19 7.5"/>', 'class="tick"'),
    back: size => svg(size, '<path d="M15 6l-6 6 6 6"/>'),
    out: size => svg(size, '<path d="M7 17L17 7M8.5 7H17v8.5"/>'),
    up: size => svg(size, '<path d="M12 19V6M6.5 11.5L12 6l5.5 5.5"/>'),
    bookmark: size => svg(size, '<path d="M7 4h10v16l-5-3.5L7 20z"/>'),
    bookmarkOn: size => svg(size, '<path d="M7 4h10v16l-5-3.5L7 20z" fill="currentColor"/>'),
    link: size => svg(size, '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
    plus: size => svg(size, '<path d="M12 5v14M5 12h14"/>'),
    calPlus: size => svg(size, '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4M12 13v5M9.5 15.5h5"/>'),
    download: size => svg(size, '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>'),
    upload: size => svg(size, '<path d="M12 16V5M7 9l5-5 5 5M5 20h14"/>'),
    copy: size => svg(size, '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>'),
    pencil: size => svg(size, '<path d="M4 20l4-1 11-11-3-3L5 16z"/>'),
    flag: size => svg(size, '<path d="M6 21V4M6 5h11l-2 4 2 4H6"/>'),
    share: size => svg(size, '<circle cx="6" cy="12" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="18" cy="18" r="2.2"/><path d="M8 11l8-4M8 13l8 4"/>'),
    pin: size => svg(size, '<path d="M12 21s6-5.5 6-11a6 6 0 0 0-12 0c0 5.5 6 11 6 11z"/><circle cx="12" cy="10" r="2.2"/>'),
    route: size => svg(size, '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h6a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h6"/>'),
    phone: size => svg(size, '<path d="M6 4h3l2 5-2 1.5a11 11 0 0 0 5 5L15.500 13.500 20 15v3a2 2 0 0 1-2 2A14 14 0 0 1 4 6a2 2 0 0 1 2-2z"/>'),
    mail: size => svg(size, '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>'),
    check: size => svg(size, '<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    refresh: size => svg(size, '<path d="M20 11a8 8 0 0 0-14-4M4 5v4h4M4 13a8 8 0 0 0 14 4M20 19v-4h-4"/>'),
    umbrella: size => svg(size, '<path d="M3 12a9 9 0 0 1 18 0z"/><path d="M12 12v6a2 2 0 0 0 4 0"/>')
  };
  // The category icon of a row (category-icons.js: Phosphor, in the weight of the chosen variant). aria-hidden: the word is written next to it.
  const categoryIcon = category => `<span class="cat-icon" aria-hidden="true">${window.MinitandemCategoryIcons ? window.MinitandemCategoryIcons.svg(category) : ''}</span>`;

  // The practical facts in the order the card shows them. The translation of the cards (catalogue-i18n.js, and the translation pipeline,
  // which reads this line) uses the same order.
  const PRACTICAL_ORDER = ['indoor', 'playArea', 'changing', 'toilet', 'feeding', 'access', 'parking', 'booking', 'observe', 'duration', 'commitment', 'groupSize', 'leader', 'trial', 'leave', 'standardGerman', 'costNote'];

  function create(ctx) {
    const {t, C, P, X, F, store} = ctx;
    // The card as the visitor reads it today: in the chosen language, without the notices that are over (planning.js current).
    // One result per card and day, so that a card keeps its identity between calls.
    const fresh = new WeakMap();
    const shown = a => {
      const card = ctx.shown && a ? ctx.shown(a) : a;
      if (!card) return card;
      const day = C.today(), hit = fresh.get(card);
      if (hit?.day === day) return hit.card;
      const out = P.current(card, day);
      fresh.set(card, {day, card: out});
      return out;
    }, en = a => a.english || a;
    const age = () => store.personal.age;
    const state = () => ctx.state();
    const nm = s => esc(s).replace(/ · /g, NBSP + '· ');
    const personal = () => store.personal;
    const tick = size => ICON.tick(size);
    const keyed = (prefix, value) => t(prefix + '.' + (value === '' || value === undefined ? 'none' : value));
    const link = (url, label, cls = '') => /^https:\/\//i.test(url) ? `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : '';
    const phoneHref = phone => 'tel:' + phone.replace(/[^+\d]/g, '').replace(/^0(?=\d{9}$)/, '+41');
    const statusClass = {active: 'good', check: 'check', future: 'later', closed: 'gone', excluded: 'gone'};
    const hashFor = (id, view = state().view) => {
      const p = new URLSearchParams({view});
      if (view === 'shared') p.set('list', state().sharedIds.join(','));
      if (view === 'venue') p.set('venue', state().venueId);
      if (id) p.set('activity', id);
      return '#' + p.toString();
    };
    const warningText = w => w.code ? t('warning.' + w.code) : w.text;
    // A row has room for the first part of a schedule only. When the text goes on with more days or times, the line says so, so that
    // "Mon 14:00–21:00" never reads as the whole opening hours. The English schedule decides (a translated card keeps it in a.english);
    // a translation without a ";" is shown whole.
    const moreHours = a => String(a.schedule).includes(';') && window.MinitandemCatalogue.moreTimes(en(a).schedule);
    const hoursLine = a => F.first(a.schedule) + (moreHours(a) ? ' ' + t('time.more') : '');
    const placeLine = a => `${a.town} · ${ctx.C.regions[a.region]}`;

    /* ---------- list ---------- */
    function fitMark(a) {
      const a0 = age();
      if (!Number.isFinite(a0) || C.ageFit(a, a0) !== true) return '';
      return ICON.tick(14) + `<span class="sr">${esc(t('fit.sr', {age: F.ageBare(a0)}))}</span>`;
    }
    // Straight-line distance from the point the visitor set ('' while none is set). To a checked address point when the card has
    // one, otherwise to its town centre, which the wording says.
    function distanceText(a) {
      const from = state().near;
      if (!from) return '';
      const d = C.distanceOf(a, from);
      if (!d) return t('near.unknown');
      if (d.exact) return t('near.km', {km: window.MinitandemCatalogue.roundKm(d.km)});
      return d.km < 1 ? t('near.townUnder1') : t('near.kmTown', {km: Math.round(d.km)});
    }
    // The date of the card's last check, and after P.STALE_CHECK_DAYS a hint to confirm with the organiser. No date on the card: nothing is shown.
    function checkedLine(a) {
      if (P.checkAge(a, C.today()) === null) return '';
      return `<p class="d-checked">${esc(t('card.checked', {date: F.dateLabel(a.checked)}))}</p>` + (P.checkStale(a, C.today()) ? `<p class="d-stale">${esc(t('card.checkedOld'))}</p>` : '');
    }
    // A row of the list. opts (week view): time is a session's time, shown first; lead is a bold first part of the date line
    // ("Regular, confirm holidays", "Hours"), when replaces the rest of it. Card text that falls back to English carries lang="en".
    function row(card, {time = '', lead = '', when = null} = {}) {
      const a = shown(card), status = C.statusOf(a, age()), upcoming = C.upcoming(a), next = F.nextText(a, upcoming, C.past(a));
      const saved = personal().favorites.includes(a.id), dist = distanceText(a), en = ctx.inEnglish?.(a) ? ' lang="en"' : '';
      // The age slot holds an age: without a published bound it says so (or that the chosen age fits, "from birth" for example); the card
      // page keeps the organiser's wording.
      const a0 = age(), fits = Number.isFinite(a0) && C.ageFit(a, a0) === true;
      const ageText = F.bounds(a) ? F.ageShort(a) : fits ? t('fit.yes', {age: F.ageBare(a0)}) : t('age.notPublished');
      const ageMark = F.bounds(a) ? fitMark(a) : fits ? ICON.tick(14) : '';
      // The table's "Next date" column needs no "Next:" before each date; the phone line keeps it.
      const more = when === null && !next && moreHours(a);
      const whenHtml = when !== null ? (lead ? `<b>${esc(lead)}</b>${when ? ' · ' : ''}` : '') + `<span${en}>${esc(when)}</span>`
        : upcoming.length ? `<span class="w-full">${esc(next)}</span><span class="w-short">${esc(F.nextShort(upcoming))}</span>`
        : next ? esc(next) : `<span${en}>${esc(F.first(a.schedule))}</span>` + (more ? ' ' + esc(t('time.more')) : '');
      return `<li><a class="row c-${esc(a.category)}${time ? ' has-time' : ''}" href="${esc(hashFor(a.id))}" data-id="${esc(a.id)}">` + categoryIcon(a.category) +
        `<span class="r-main"><span class="r-cat">${time ? `<b class="r-time">${esc(time)}</b>` : ''}<span class="r-catname">${esc(t('category.' + a.category))}</span>${dist ? `<span class="r-dist">${esc(dist)}</span>` : ''}</span>` +
        `<span class="r-name"><span${en}>${nm(a.name)}</span>${saved ? `<span class="r-saved" title="${esc(t('row.saved'))}">${ICON.bookmarkOn(14)}<span class="sr">${esc(t('row.saved'))}</span></span>` : ''}</span><span class="r-town-d">${esc(placeLine(a))}</span></span>` +
        `<span class="r-facts"><span class="r-town-m">${esc(a.town)}</span><span class="r-age${F.bounds(a) || fits ? ' known' : ''}">${ageMark}${esc(ageText)}</span><span class="r-price${a.priceKind !== 'unknown' ? ' known' : ''}"${F.noPrice(a) ? '' : en}>${esc(F.priceShort(a))}</span></span>` +
        `<span class="r-l3"><span class="r-when${lead || time || more ? ' is-wrap' : ''}">${whenHtml}</span><span class="r-status st${status === 'active' ? ' is-current' : ''}">${status === 'active' ? '' : `<i class="dot ${statusClass[status]}" aria-hidden="true"></i>`}${esc(t('status.' + status + '.short'))}</span></span></a></li>`;
    }
    // Under "today", "this weekend" or "next 7 days" a card that counts through its weekly hours is marked as in the week view, with the
    // time its schedule gives for the matching weekday when the text says it plainly (scheduleSlot), else its whole schedule.
    // Without a day filter, weekdays chosen in the filter panel do the same: a card that repeats on each of them shows the time of each (for
    // its next such day, so that "until" and "from" in the text are checked) when the text gives it plainly; otherwise the row is as usual.
    function dayRow(a) {
      const f = state().f, K = window.MinitandemCatalogue, info = C.whenInfo(a, f);
      if (!info && f.days.size) {
        const slots = [...f.days].sort((x, y) => x - y).map(day => {
          const date = [0, 1, 2, 3, 4, 5, 6].map(n => K.addDays(C.today(), n)).find(d => K.weekdayOf(d) === day), slot = C.repeatsOn(a, date) && K.scheduleSlot(en(a).schedule, day, date);
          return slot ? `${t('weekday.' + day)} ${slot}` : '';
        });
        if (slots.every(Boolean)) return row(a, {when: slots.join(' · ')});
      }
      if (!info || info.kind === 'session') return row(a);
      const weekday = K.weekdayOf(info.date), slot = K.scheduleSlot((a.english || a).schedule, weekday, info.date);
      return row(a, {lead: t(info.kind === 'place' ? 'week.hoursMark' : 'week.regularMark'), when: slot ? `${t('weekday.' + weekday)} ${slot}` : shown(a).schedule});
    }
    const rows = items => items.map(dayRow).join('');
    // The line under the count: each filter that is on as a chip that removes it, then the rainy-day switch while it is off.
    // active: [{key, label}] from app.js; key is what removing it needs ('cat:music', 'age', 'indoor').
    function filterChips(active) {
      const umbrella = key => key === 'indoor' ? ICON.umbrella(16) : '';
      return active.map(f => `<button type="button" class="chip fchip" data-remove="${esc(f.key)}" aria-label="${esc(t('filters.remove', {name: f.label}))}">${umbrella(f.key)}${esc(f.label)}${ICON.x(14)}</button>`).join('') +
        (active.some(f => f.key === 'indoor') ? '' : `<button type="button" class="chip fchip-quick" data-quick="indoor" aria-pressed="false">${ICON.umbrella(16)}${esc(t('filter.indoor'))}</button>`);
    }

    /* ---------- this week ---------- */
    // days from C.week(): a row to jump to a day, then per day what happens (dated sessions, open, time first), and folded into one line
    // each what repeats (regular groups and courses) and what is open (places to visit on your own). A folded list is built only when
    // its day is opened (weekGroup, called by app.js), so the page holds a few dozen rows, not hundreds.
    const dayHeading = d => d.offset === 0 ? t('week.today', {date: F.dayLong(d.date)}) : d.offset === 1 ? t('week.tomorrow', {date: F.dayLong(d.date)})
      // A heading that starts with the weekday starts with a capital, also in French ('Vendredi 16 octobre', but 'Demain · jeudi 15 octobre').
      : F.dayLong(d.date).replace(/^\p{Ll}/u, c => c.toUpperCase());
    function weekGroup(d, kind) {
      const mark = t(kind === 'regular' ? 'week.regularMark' : 'week.hoursMark');
      return (kind === 'places' ? `<p class="hint">${esc(t('week.regularNote'))}</p>` : '') + `<ul class="list">${d[kind].map(a => row(a, {lead: mark, when: shown(a).schedule})).join('')}</ul>`;
    }
    function week(days) {
      const open = state().weekOpen || new Set();
      const folded = (d, kind) => {
        if (!d[kind].length) return '';
        const isOpen = open.has(d.date + '|' + kind);
        const summary = kind === 'regular' ? t('week.regular', {n: d.regular.length, day: t('weekly.' + d.weekday)}) : t('week.places', {n: d.places.length});
        return `<details class="more wfold" data-day="${esc(d.date)}" data-kind="${kind}"${isOpen ? ' open' : ''}><summary>${esc(summary)}</summary><div class="wfold-body">${isOpen ? weekGroup(d, kind) : ''}</div></details>`;
      };
      const jump = days.length > 1 ? `<nav class="wjump" aria-label="${esc(t('week.jump'))}">` + days.map(d => `<button type="button" class="wjump-day" data-jump="${esc(d.date)}" aria-label="${esc(dayHeading(d))}"${d.offset === 0 ? ' aria-current="date"' : ''}><small>${esc(t('weekday.' + d.weekday))}</small><b>${Number(d.date.slice(8))}</b></button>`).join('') + '</nav>' : '';
      return jump + `<p class="hint week-note">${esc(t('week.note'))}</p>` + days.map(d => {
        const sessions = d.sessions.length ? `<p class="wsub">${esc(t('week.sessions', {n: d.sessions.length}))}</p><ul class="list">` +
          d.sessions.map(({a, index}) => { const s = shown(a), e = s.events[index]; return row(a, {time: F.clockLabel(e), when: [e.title, e.address && e.address !== s.address ? e.address : ''].filter(Boolean).join(' · ')}); }).join('') + '</ul>' : '';
        const rest = folded(d, 'regular') + folded(d, 'places');
        return `<section class="wday" aria-labelledby="wd-${esc(d.date)}"><h3 id="wd-${esc(d.date)}" tabindex="-1">${esc(dayHeading(d))}</h3>` + sessions + rest +
          (sessions || rest ? '' : `<p class="hint">${esc(t('week.emptyDay'))}</p>`) + '</section>';
      }).join('');
    }

    /* ---------- filter panel ---------- */
    function placeOptionsHtml() {
      const {districts, towns} = C.placeOptions();
      return `<option value="">${esc(t('place.anywhere'))}</option><optgroup label="${esc(t('place.districts'))}">${districts.map(o => `<option value="${esc(o.value)}">${esc(o.name)} (${o.count})</option>`).join('')}</optgroup>` +
        `<optgroup label="${esc(t('place.towns'))}">${towns.map(o => `<option value="${esc(o.value)}">${esc(o.name)} (${o.count})</option>`).join('')}</optgroup>`;
    }
    const chip = (kind, val, label, count) => `<button type="button" class="chip" data-kind="${kind}" data-val="${esc(val)}" aria-pressed="false">${esc(label)}${count !== undefined ? ` <span class="num">${count}</span>` : ''}</button>`;
    const group = (id, label, body, cls = 'group') => `<fieldset class="${cls}" id="${id}"><legend class="glabel">${esc(label)}</legend>${body}</fieldset>`;
    const switchRow = (id, label, hint) => `<div class="switchrow"><div><span class="sw-t" id="${id}L">${esc(label)}</span>${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div><button type="button" class="switch" id="${id}" role="switch" aria-checked="false" aria-labelledby="${id}L"></button></div>`;
    function panel() {
      const count = key => C.activities.filter(a => !['closed', 'excluded'].includes(a.status) && a[key.field] === key.value).length;
      const ageButtons = [0, 1, 2, 3, 4, 5, 6].map(n => `<button type="button" class="chip age" data-age="${n}" aria-pressed="false" aria-label="${esc(n === 0 ? `0 (${F.ageLabel(0)})` : F.ageLabel(n))}">${n}</button>`).join('');
      return nearGroup() + `<fieldset class="group" id="g-age"><legend class="glabel">${esc(t('filter.age'))}</legend>` +
        `<div class="agebox"><input class="field" id="age" type="number" inputmode="numeric" min="0" max="6" step="1" placeholder="${esc(t('common.any'))}" aria-label="${esc(t('filter.ageInput'))}" aria-describedby="ageHint"><span class="unit">${esc(t('filter.ageUnit'))}</span></div>` +
        `<div class="chips ages" role="group" aria-label="${esc(t('filter.agePick'))}">${ageButtons}</div><p class="hint" id="ageHint" data-text="${esc(t('filter.ageHint'))}">${esc(t('filter.ageHint'))}</p>` +
        `<div id="unkRow" hidden>${switchRow('unk', t('filter.unknownAge'), t('filter.unknownAgeHint'))}</div></fieldset>` +
        `<div class="group" id="g-place"><label class="glabel" for="place">${esc(t('filter.place'))}</label><span class="select"><select class="field" id="place">${placeOptionsHtml()}</select></span></div>` +
        group('g-cat', t('filter.category'), `<div class="chips">${C_KEYS.category.map(k => chip('cat', k, t('category.' + k), count({field: 'category', value: k}))).join('')}</div>`) +
        group('g-fmt', t('filter.format'), `<div class="chips">${C_KEYS.format.map(k => chip('fmt', k, t('format.' + k), count({field: 'format', value: k}))).join('')}</div>`) +
        group('g-when', t('filter.when'), `<div class="chips">${C_KEYS.when.map(k => chip('when', k, t('when.' + k))).join('')}</div><p class="hint">${esc(t('filter.whenHint'))}</p>`) +
        group('g-days', t('filter.days'), `<div class="chips">${C_KEYS.days.map(n => chip('day', String(n), t('weekday.' + n))).join('')}</div>`) +
        group('g-lang', t('filter.language'), `<div class="chips">${C_KEYS.language.map(k => chip('lang', k, t('langFilter.' + k))).join('')}</div><p class="hint">${esc(t('filter.languageHint'))}</p>`) +
        group('g-price', t('filter.price'), `<div class="chips">${C_KEYS.price.map(k => chip('price', k, t('priceFilter.' + k))).join('')}</div>`) +
        group('g-status', t('filter.status'), `<div class="chips">${C_KEYS.status.map(k => chip('status', k, t('statusFilter.' + k))).join('')}</div>`) +
        group('g-cond', t('filter.conditions'), `<div class="chips">${chip('indoor', '1', t('filter.indoor'))}${C_KEYS.preset.map(k => chip('preset', k, t('preset.' + k))).join('')}${P.needKeys.map(k => chip('need', k, t('needs.' + k))).join('')}</div><p class="hint">${esc(t('filter.conditionsHint'))}</p>`) +
        `<div class="group" id="g-adult">${switchRow('adult', t('filter.withAdult'), t('filter.withAdultHint'))}</div>` +
        `<div class="group" id="g-sort"><label class="glabel" for="sort">${esc(t('filter.sort'))}</label><span class="select"><select class="field" id="sort">${C_KEYS.sort.map(k => `<option value="${k}"${k === 'near' && !state().near ? ' disabled' : ''}>${esc(t('sort.' + k))}</option>`).join('')}</select></span></div>`;
    }
    // Where distances are measured from: the browser's location (one request, kept in memory) or the centre of a town. The state line
    // and the clear button are filled in by app.js.
    function nearGroup() {
      const towns = C.centreTowns().map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
      return `<div class="group" id="g-near" role="group" aria-labelledby="nearL"><span class="glabel" id="nearL">${esc(t('near.title'))}</span>` +
        `<button type="button" class="ghost near-geo" id="nearGeo">${ICON.pin(18)}${esc(t('near.useLocation'))}</button>` +
        `<label class="near-or" for="nearTown">${esc(t('near.town'))}</label><span class="select"><select class="field" id="nearTown"><option value="">${esc(t('near.townNone'))}</option>${towns}</select></span>` +
        `<label class="near-or" for="nearRadius">${esc(t('near.radius'))}</label><span class="select"><select class="field" id="nearRadius">${window.MinitandemCatalogue.RADIUS_KEYS.map(km => `<option value="${km}">${esc(km ? t('near.radiusKm', {km}) : t('near.radiusAny'))}</option>`).join('')}</select></span>` +
        `<p class="hint" id="nearState" role="status" aria-live="polite"></p><button type="button" class="linkbtn near-clear" id="nearClear" hidden>${esc(t('near.clear'))}</button>` +
        `<p class="hint">${esc(t('near.hint'))}</p></div>`;
    }
    const C_KEYS = {category: window.MinitandemCatalogue.CATEGORY_KEYS, format: window.MinitandemCatalogue.FORMAT_KEYS, when: window.MinitandemCatalogue.WHEN_KEYS.filter(Boolean),
      days: window.MinitandemCatalogue.DAY_KEYS, language: window.MinitandemCatalogue.LANGUAGE_KEYS, price: window.MinitandemCatalogue.PRICE_KEYS, status: window.MinitandemCatalogue.STATUS_FILTER_KEYS,
      preset: window.MinitandemCatalogue.PRESET_KEYS.filter(Boolean), sort: window.MinitandemCatalogue.SORT_KEYS};

    /* ---------- card page ---------- */
    const fr = (label, value) => `<div class="fr"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
    const np = (value) => value ? esc(value) : `<span class="np">${esc(t('common.notPublished'))}</span>`;
    const section = (title, body, cls = '') => `<section class="dsec ${cls}"><h3>${esc(title)}</h3>${body}</section>`;
    const bullets = (items, lang = '') => `<ul class="plain"${lang}>${items.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`;
    const organiserURL = a => (a.sources.find(s => /^https:\/\//i.test(s.url)) || {}).url || '';
    const mapURL = a => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(en(a).address || en(a).town + ', Switzerland')}`;
    const routeURL = (a, address = en(a).address) => {
      const origin = personal().origin ? personal().origin + ', Switzerland' : '';
      return `https://www.google.com/maps/dir/?api=1${origin ? '&origin=' + encodeURIComponent(origin) : ''}&destination=${encodeURIComponent(address || a.town + ', Switzerland')}`;
    };
    function saveButton(card) {
      const a = shown(card), on = personal().favorites.includes(a.id);
      return `<button type="button" class="iconbtn save-button${on ? ' saved' : ''}" data-save="${esc(a.id)}" aria-pressed="${on}" aria-label="${esc(t(on ? 'card.unsave' : 'card.save'))}: ${esc(a.name)}" title="${esc(t(on ? 'card.unsave' : 'card.save'))}">${on ? ICON.bookmarkOn(20) : ICON.bookmark(20)}</button>`;
    }
    function ageFitNote(a) {
      const a0 = age();
      if (!Number.isFinite(a0)) return '';
      const fit = C.ageFit(a, a0);
      if (fit === true) return `<span class="fitnote" id="detail-age-fit">${ICON.tick(14)}${esc(t('fit.yes', {age: F.ageBare(a0)}))}</span>`;
      if (fit === false) return `<span class="fitnote mismatch" id="detail-age-fit">${esc(t('fit.no', {age: F.ageBare(a0)}))}</span>`;
      return `<span class="fitnote unknown" id="detail-age-fit">${esc(t('fit.unknown', {age: F.ageBare(a0)}))}</span>`;
    }
    function dateRows(a) {
      const byTime = (x, y) => (x.date + (x.start || '')).localeCompare(y.date + (y.start || ''));
      const events = a.events.slice().sort(byTime);
      const varying = events.some(e => e.address && e.address !== a.address);
      const line = e => {
        const future = C.inFuture(e), idx = a.events.indexOf(e);
        return `<li class="drow${future ? '' : ' past'}"><span class="dtxt"><span class="dwhen">${esc(F.dayDate(e.date))} · ${esc(F.clockLabel(e))}${future ? '' : ` <span class="sr">(${esc(t('date.passedShort'))})</span><span aria-hidden="true">· ${esc(t('date.passedShort'))}</span>`}</span>${e.title ? `<span class="dsub">${esc(e.title)}</span>` : ''}${varying ? `<span class="dsub">${esc(e.address || a.address || t('common.addressTbc'))}</span>` : ''}</span>` +
          (future ? `<span class="dacts"><button type="button" class="iconbtn" data-plan="${esc(a.id)}" data-plan-event="${idx}" aria-label="${esc(t('dates.plan', {date: F.dayDate(e.date)}))}" title="${esc(t('visit.plan'))}">${ICON.calPlus(20)}</button><button type="button" class="iconbtn" data-ics="${esc(a.id)}" data-event="${idx}" aria-label="${esc(t('dates.ics', {date: F.dayDate(e.date)}))}" title="${esc(t('dates.icsTitle'))}">${ICON.download(20)}</button></span>` : '') + '</li>';
      };
      // Upcoming dates first; dates that have passed are folded away unless they are all there is.
      const coming = events.filter(C.inFuture), gone = events.filter(e => !C.inFuture(e));
      const head = coming.slice(0, 8), rest = coming.slice(8);
      return `<p class="admission ${P.admission(a)}">${esc(t('admission.' + P.admission(a)))}${P.admission(a) === 'course' ? '. ' + esc(t('admission.courseJoin')) : ''}</p>` +
        (head.length ? `<ul class="dlist">${head.map(line).join('')}</ul>` : '') +
        (rest.length ? `<details class="more"><summary>${esc(t('dates.showAll', {n: coming.length}))}</summary><ul class="dlist">${rest.map(line).join('')}</ul></details>` : '') +
        (gone.length ? (head.length ? `<details class="more"><summary>${esc(t('dates.past', {n: gone.length}))}</summary><ul class="dlist">${gone.map(line).join('')}</ul></details>` : `<ul class="dlist">${gone.map(line).join('')}</ul>`) : '');
    }
    function cost(a) {
      const tariff = a.practical?.tariff;
      if (!tariff) return a.priceKind === 'course' ? section(t('cost.title'), `<p>${esc(t('cost.courseNote'))}</p>`, 'cost-section') : '';
      const result = P.familyPrice(a, age(), 1);
      return section(t('cost.title'), `<div class="costbox"><label class="costl" for="family-adults">${esc(t('cost.adults'))}<input class="field short" id="family-adults" type="number" min="1" max="4" step="1" value="1"></label>` +
        `<div id="family-children"><label class="costl">${esc(t('cost.childAge'))}<input class="field short family-child-age" type="number" min="0" max="15" step="0.5" value="${esc(age() ?? '')}"></label></div>` +
        `<button type="button" class="linkbtn" data-action="add-child">${esc(t('cost.addChild'))}</button>` +
        `<p id="family-total" class="family-total" role="status" aria-live="polite">${result ? 'CHF ' + result.total : esc(t('cost.unknownAge'))}</p><p id="family-breakdown" class="hint">${result ? esc(t('cost.breakdown', {adults: result.adultTotal, children: result.childTotals.join(' + ')})) : ''}</p>` +
        `<p class="hint">${esc(tariff.note)}</p>${link(tariff.source, esc(t('cost.tariffSource')) + ICON.out(14), 'inline-link')}</div>`, 'cost-section');
    }
    function visitRows(entries) {
      return entries.map(([id, v]) => {
        const a = shown(C.byId.get(v.activity)), label = visitLabel(v);
        return `<div class="visit-row"><div><strong>${esc(label)}</strong><p>${esc(a.name)}</p><p class="hint">${esc(t('booking.' + v.booking))}${v.outcome ? ' · ' + esc(t('outcome.' + v.outcome)) : ''}</p></div><button type="button" class="iconbtn" data-edit-visit="${esc(id)}" aria-label="${esc(t('visit.edit'))}: ${esc(a.name)}, ${esc(label)}" title="${esc(t('visit.edit'))}">${ICON.pencil(20)}</button></div>`;
      }).join('');
    }
    const visitLabel = v => (v.date ? F.dateLabel(v.date) : t('visit.noDate')) + (v.time ? ' · ' + v.time : '');
    const visitsFor = id => Object.entries(personal().visits).filter(([, v]) => v.activity === id).sort(([, a], [, b]) => (b.date + b.time).localeCompare(a.date + a.time));
    function visitPlans(a) {
      const entries = visitsFor(a.id);
      return `<section class="dsec visit-plans"><h3>${esc(t('visit.title'))}${entries.length ? ' · ' + entries.length : ''}</h3>${visitRows(entries)}<button type="button" class="ghost" data-plan="${esc(a.id)}">${ICON.calPlus(18)}${esc(t('visit.plan'))}</button><p class="hint">${esc(t('visit.note'))}</p></section>`;
    }
    function notesBox(a) {
      return section(t('mine.title'), `<label class="glabel" for="personal-status">${esc(t('mine.status'))}</label><span class="select"><select class="field" id="personal-status">${C.PERSONAL.map(v => `<option value="${v}" ${personal().statuses[a.id] === v ? 'selected' : ''}>${esc(keyed('personalStatus', v))}</option>`).join('')}</select></span>` +
        `<label class="glabel" for="personal-note">${esc(t('mine.note'))}</label><textarea class="field area" id="personal-note" maxlength="10000" placeholder="${esc(t('mine.notePlaceholder'))}">${esc(personal().notes[a.id] || '')}</textarea><p class="hint" id="note-state">${esc(t(store.storageAvailable ? 'mine.stored' : 'mine.notStored'))}</p>`, 'mine');
    }
    // "Report an error": an e-mail to the directory with the card's name, id and link, written by the visitor's own mail app.
    function reportMail(a) {
      const link = (ctx.origin || '') + '/' + hashFor(a.id, 'catalog');
      return 'mailto:hello@minitandem.ch?subject=' + encodeURIComponent(t('report.mailSubject', {name: a.name})) + '&body=' + encodeURIComponent(t('report.mailBody', {name: a.name, id: a.id, link}).replace(/\n/g, '\r\n'));
    }
    function detail(card) {
      // why: '' when the card is shown in the interface language, else why it is shown in English; card text then carries lang="en".
      const a = shown(card), status = C.statusOf(a, age()), seen = new Set(), why = ctx.inEnglish?.(a) || '', en = why ? ' lang="en"' : '';
      const cardText = text => `<span${en}>${esc(text)}</span>`;
      const key = text => C.norm(text).replace(/\s+/g, ' ').trim();
      const take = text => { if (!text) return false; const k = key(text); if (seen.has(k)) return false; seen.add(k); return true; };
      take(a.intro); take(a.parentDetails);
      const warnings = P.warnings(a, C.today()).map(w => ({text: warningText(w), card: !w.code})).filter(w => take(w.text));
      const langs = F.langText(a), variedAddress = a.events.some(e => e.address && e.address !== a.address);
      const facts = fr(t('fact.age'), cardText(a.age) + (F.bounds(a) ? `<span class="sub">${esc(t('fact.publishedLimits', {value: F.ageShort(a)}))}</span>` : '') + ageFitNote(a)) +
        fr(t('fact.parent'), a.parentDetails ? cardText(a.parentDetails) : esc(F.parentLong(a))) + fr(t('fact.schedule'), cardText(a.schedule)) +
        fr(t('fact.price'), cardText(a.price) + (a.priceKind === 'course' ? `<span class="sub">${esc(t('fact.courseHint'))}</span>` : '')) +
        fr(t('fact.address'), variedAddress ? `<span class="np">${esc(t('fact.addressByDate'))}</span>` : (a.address ? cardText(a.address) : np(a.address)) + (a.addressPrecision === 'area' ? `<span class="sub">${esc(t('fact.areaOnly'))}</span>` : '')) +
        fr(t('fact.languages'), langs ? esc(langs) + (a.languages.includes('DE') ? `<span class="sub">${esc(t('fact.germanNote'))}</span>` : '') : `<span class="np">${esc(t('common.notStated'))}</span>`) +
        fr(t('fact.format'), esc(t('format.' + a.format)));
      let out = `<div class="d-top"><button type="button" class="ghost" data-close>${ICON.back(18)}${esc(t('card.back'))}</button><span class="d-actions"><span id="detail-save">${saveButton(a)}</span><button type="button" class="iconbtn" data-action="copy-link" aria-label="${esc(t('card.copyLink'))}" title="${esc(t('card.copyLink'))}">${ICON.link(20)}</button></span></div>` +
        `<div class="d-body" tabindex="-1" autofocus>` +
        `<p class="d-kicker">${esc(t('category.' + a.category))}</p><h2 class="d-name" id="dTitle"${en}>${nm(a.name)}</h2><p class="d-where">${esc(placeLine(a))} · ${esc(t('card.canton'))}</p>` +
        (why ? `<p class="hint d-english">${esc(t(why === 'failed' ? 'card.notLoaded' : 'card.inEnglish'))}</p>` : '') +
        `<p class="d-status" id="detail-data-status"><i class="dot ${statusClass[status]}" aria-hidden="true"></i>${esc(t('status.' + status + '.long'))}</p>${checkedLine(a)}` +
        (warnings.length ? `<ul class="warns">${warnings.map(w => `<li${w.card ? en : ''}>${esc(w.text)}</li>`).join('')}</ul>` : '') +
        (C.venueFor(a) ? `<button type="button" class="ghost venue-link" data-venue="${esc(C.venueFor(a).id)}">${esc(t('card.venue', {name: C.venueFor(a).name}))}</button>` : '') +
        `<dl class="facts">${facts}</dl><!--second-->`;
      if (a.events.length) out += section(t('dates.title'), dateRows(a));
      out += section(t('card.about'), `<p${a.intro ? en : ''}>${a.intro ? esc(a.intro) : `<span class="np">${esc(t('card.noDescription'))}</span>`}</p>`);
      const notes = a.notes.filter(take);
      if (notes.length) out += section(t('card.goodToKnow'), bullets(notes, en));
      const groups = [];
      for (const k of PRACTICAL_ORDER) {
        const f = a.practical?.[k];
        if (f?.text && take(f.text)) groups.push([k, f]);
      }
      const warn = (a.practical?.warnings || []).filter(take);
      if (groups.length || warn.length) out += section(t('card.practical'), `<dl class="pr">${groups.map(([k, f]) => `<div class="fr"><dt>${esc(t('practical.' + k))}</dt><dd>${cardText(f.text)}${f.source ? ' ' + link(f.source, esc(t('card.source')), 'inline-link') : ''}</dd></div>`).join('')}${warn.length ? `<div class="fr"><dt>${esc(t('practical.warnings'))}</dt><dd${en}>${warn.length > 1 ? `<ul>${warn.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : esc(warn[0])}</dd></div>` : ''}</dl>`);
      out += cost(a);
      const found = (a.research?.findings || []).filter(f => take(f.text));
      if (found.length) out += section(t('card.checkedTitle'), `<div class="found"${en}>${found.map(f => `<div>${f.field ? `<span class="ff">${esc(f.field)}</span>` : ''}<p>${esc(f.text)}</p></div>`).join('')}</div><p class="hint">${esc(t('card.checkedOn', {date: F.dateLabel(a.research.date)}))}</p>`);
      const rem = (a.research?.remaining || []).filter(take);
      if (rem.length) out += section(t('card.toConfirm'), bullets(rem, en) + `<button type="button" class="linkbtn" data-action="copy-questions">${ICON.copy(16)} ${esc(t('card.copyQuestions'))}</button>`);
      out += visitPlans(a) + notesBox(a);
      const contacts = a.contacts.map(c => `<div class="contact">${c.name ? `<strong${en}>${esc(c.name)}</strong>` : ''}${c.phone ? `<a href="${esc(phoneHref(c.phone))}">${ICON.phone(16)} ${esc(c.phone)}</a>` : ''}${c.email ? `<a href="mailto:${esc(c.email)}">${ICON.mail(16)} ${esc(c.email)}</a>` : ''}</div>`).join('');
      // A contact may be just a name; without a phone or address the family still needs the pointer to the sources.
      out += section(t('card.contacts'), contacts + (a.contacts.some(c => c.phone || c.email) ? '' : `<p class="np">${esc(t('card.noContact'))}</p>`));
      const photo = a.practical?.photo;
      if (photo || a.practical?.gallery) out += section(t('card.photos'), (photo ? `<figure class="place-photo"><img src="${esc(photo.path)}" alt="${esc(photo.alt)}" loading="lazy" width="960" height="443"><figcaption>${esc(photo.caption)} ${link(photo.source, esc(photo.credit), 'inline-link')}</figcaption></figure>` : '') + (a.practical.gallery ? link(a.practical.gallery, esc(t('card.gallery')) + ICON.out(14), 'inline-link') : '') + `<p class="hint">${esc(t('card.photoNote'))}</p>`);
      out += section(t('card.sources'), a.sources.filter(s => /^https:\/\//i.test(s.url)).length ? `<ul class="srcs"${en}>${a.sources.filter(s => /^https:\/\//i.test(s.url)).map(s => `<li>${link(s.url, `<span>${esc(s.label)}</span>${ICON.out(16)}`)}</li>`).join('')}</ul><p class="hint">${esc(P.checkAge(a, C.today()) === null ? t('card.sourceNoteUndated') : t('card.sourceNote', {date: F.dateLabel(a.checked)}))}${C.needsReview(a) ? ' ' + esc(t('card.reviewDue')) : ''}</p>` : `<p class="np">${esc(t('card.noSources'))}</p>`);
      // The correction form reaches the editors only through the family service; without it, the e-mail under the facts is the way.
      out += `<div class="d-more">${ctx.syncConnected?.() ? `<button type="button" class="linkbtn" data-action="report-change">${ICON.flag(16)} ${esc(t('card.report'))}</button>` : ''}${!C.isArchive(a) ? `<a class="linkbtn" href="places/${esc(a.id)}/">${esc(t('card.publicPage'))}</a>` : ''}</div></div>`;
      const url = organiserURL(a), first = a.contacts.find(c => c.phone), mail = a.contacts.find(c => c.email);
      const secondary = [!variedAddress && a.addressPrecision !== 'area' && a.address ? link(routeURL(a), ICON.route(18) + esc(t('card.directions')), 'ghost') : link(mapURL(a), ICON.pin(18) + esc(t('card.map')), 'ghost'),
        first ? `<a class="ghost" href="${esc(phoneHref(first.phone))}">${ICON.phone(18)}${esc(t('card.call'))}</a>` : '', mail ? `<a class="ghost" href="mailto:${esc(mail.email)}">${ICON.mail(18)}${esc(t('card.write'))}</a>` : '',
        `<button type="button" class="ghost" data-action="share-card">${ICON.share(18)}${esc(t('card.share'))}</button>`].filter(Boolean).join('');
      // The bottom bar keeps the one primary action; directions, phone, e-mail and sharing sit under the facts and scroll with the page,
      // and right below them the way to report an error.
      out = out.replace('<!--second-->', `<div class="d-second">${secondary}</div><p class="d-report"><a class="linkbtn" href="${esc(reportMail(a))}">${ICON.flag(16)} ${esc(t('card.reportError'))}</a></p>`);
      out += `<div class="d-foot">${url ? `<a class="go" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(t('card.open'))}${ICON.out(18)}</a><p class="fine">${esc(t('card.openNote'))}</p>` : `<p class="fine">${esc(t('card.noSources'))}</p>`}</div>`;
      return out;
    }

    /* ---------- saved view ---------- */
    function changesBox() {
      const changed = personal().favorites.map(id => ({a: C.byId.get(id), previous: personal().tracked[id]})).filter(x => x.a).map(x => ({...x, changes: P.changes(x.a, x.previous)})).filter(x => x.changes.length);
      const body = changed.map(({a, previous, changes}) => `<details class="more"><summary>${esc(shown(a).name)}</summary><p class="hint">${esc(t('saved.changesSince', {date: F.dateLabel(previous.date), checked: F.dateLabel(a.checked)}))}</p><dl class="changes">${changes.map(c => `<div><dt>${esc(t('tracked.' + c.key))}</dt><dd><span>${esc(t('saved.was'))}</span> ${esc(c.key === 'status' ? t('status.' + c.before + '.long') : c.before || t('common.notPublished'))}</dd><dd><span>${esc(t('saved.now'))}</span> ${esc(c.key === 'status' ? t('status.' + c.after + '.long') : c.after || t('common.notPublished'))}</dd></div>`).join('')}</dl><div class="rowbtns"><button type="button" class="ghost" data-open="${esc(a.id)}">${esc(t('saved.openCard'))}</button><button type="button" class="ghost" data-ack="${esc(a.id)}">${ICON.check(16)}${esc(t('saved.markRead'))}</button></div></details>`).join('');
      return {count: changed.length, html: changed.length ? `<section class="dsec" id="saved-changes" tabindex="-1"><h3>${esc(t('saved.changes'))} · ${changed.length}</h3>${body}</section>` : `<section class="dsec" id="saved-changes" tabindex="-1"><h3>${esc(t('saved.changes'))}</h3><p class="hint">${esc(t('saved.noChanges'))}</p></section>`};
    }
    function outing() {
      const day = state().outingDate, a0 = age();
      const entries = Object.entries(personal().visits).filter(([, v]) => v.date === day && v.booking !== 'cancelled').sort(([, a], [, b]) => a.time.localeCompare(b.time));
      const cards = entries.map(([id, v]) => {
        const card = C.byId.get(v.activity), a = shown(card);
        const backup = Number.isFinite(a0) && C.activities.find(c => c.id !== a.id && c.town === a.town && !C.isArchive(c) && P.scenario(c) === 'visit' && P.ageFrom(c, a0) && (c.max === null || a0 <= c.max));
        const packing = v.bring.split('\n').map((line, i) => line.trim() ? `<li>${v['pack' + i] ? '✓ ' : ''}${esc(line.trim())}</li>` : '').join('');
        return `<article class="outing-item"><div class="outing-head"><span>${esc(v.time || t('visit.noTime'))}</span><strong>${esc(a.name)}</strong><button type="button" class="iconbtn" data-edit-visit="${esc(id)}" aria-label="${esc(t('visit.edit'))}" title="${esc(t('visit.edit'))}">${ICON.pencil(20)}</button></div><p>${esc(a.address || t('visit.addressTbc', {town: a.town}))}</p><p class="hint">${esc(t('booking.' + v.booking))} · ${esc(F.parentShort(a))}</p>${packing ? `<details class="more"><summary>${esc(t('visit.bring'))}</summary><ul class="plain">${packing}</ul></details>` : ''}<div class="rowbtns">${link(a.address ? routeURL(a) : mapURL(a), esc(t('card.directions')), 'ghost')}<button type="button" class="ghost" data-open="${esc(a.id)}">${esc(t('saved.openCard'))}</button></div>${backup ? `<p class="hint">${esc(t('outing.backup', {town: a.town}))} <button type="button" class="linkbtn" data-open="${esc(backup.id)}">${esc(shown(backup).name)}</button></p>` : ''}<p class="hint">${esc(t('outing.checked', {date: F.dateLabel(a.checked)}))}</p></article>`;
      }).join('');
      return `<section class="dsec outing"><h3>${esc(t('outing.title'))}</h3><label class="glabel" for="outing-date">${esc(t('outing.date'))}</label><input class="field short" id="outing-date" type="date" value="${esc(day)}">${cards || `<p class="hint">${esc(t('outing.empty'))}</p>`}</section>`;
    }
    function saved() {
      const entries = Object.entries(personal().visits).sort(([, a], [, b]) => {
        const pa = a.date && a.date < C.today(), pb = b.date && b.date < C.today();
        return Number(pa) - Number(pb) || (pa ? (b.date + b.time).localeCompare(a.date + a.time) : (a.date || '9999').localeCompare(b.date || '9999') || a.time.localeCompare(b.time));
      });
      const changes = changesBox();
      return {changes: changes.count, html: outing() + `<section class="dsec saved-visits"><h3>${esc(t('saved.visits'))} · ${entries.length}</h3><div class="rowbtns"><button type="button" class="ghost" data-action="plan-exchange" ${entries.some(([, v]) => v.date) ? '' : 'disabled'}>${ICON.calPlus(18)}${esc(t('saved.sharePlan'))}</button><button type="button" class="ghost" data-action="plan-import">${ICON.upload(18)}${esc(t('saved.loadPlan'))}</button>${entries.length ? `<button type="button" class="ghost" data-action="pilot-summary">${esc(t('saved.summary'))}</button>` : ''}</div>${entries.length ? visitRows(entries) : `<p class="hint">${esc(t('saved.noVisits'))}</p>`}</section>` + changes.html};
    }
    function viewTools(view, hasFavorites, itemsCount) {
      if (view === 'saved') return `<div class="rowbtns"><button type="button" class="ghost" data-action="share-list" ${hasFavorites ? '' : 'disabled'}>${ICON.share(18)}${esc(t('saved.shareList'))}</button><button type="button" class="ghost" data-action="offline-addresses" ${hasFavorites ? '' : 'disabled'}>${ICON.download(18)}${esc(t('saved.addresses'))}</button></div>` +
        `<label class="glabel" for="plan-status">${esc(t('saved.filterStatus'))}</label><span class="select"><select class="field" id="plan-status"><option value="">${esc(t('saved.allStatuses'))}</option>${C.PERSONAL.map(v => `<option value="${v || 'none'}" ${state().f.planStatus === (v || 'none') ? 'selected' : ''}>${esc(keyed('personalStatus', v))}</option>`).join('')}</select></span><p class="hint">${esc(t('saved.privateNote'))}</p>`;
      if (view === 'shared') return `<button type="button" class="go" data-action="save-shared" ${itemsCount ? '' : 'disabled'}>${ICON.bookmark(18)}${esc(t('shared.save'))}</button><p class="hint">${esc(t('shared.note'))}</p>`;
      return '';
    }
    function venueBox(venue, members) {
      const a = shown(members[0]);
      return `<section class="dsec venue"><button type="button" class="linkbtn" data-view="catalog">${ICON.back(16)} ${esc(t('venue.back'))}</button><p>${esc(a.address || t('visit.addressTbc', {town: a.town}))}</p><div class="rowbtns">${link(a.address ? routeURL(a) : mapURL(a), esc(t('card.directions')), 'ghost')}${a.contacts.map(c => `${c.phone ? `<a class="ghost" href="${esc(phoneHref(c.phone))}">${ICON.phone(18)}${esc(c.phone)}</a>` : ''}${c.email ? `<a class="ghost" href="mailto:${esc(c.email)}">${ICON.mail(18)}${esc(c.email)}</a>` : ''}`).join('')}${link(venue.source, esc(t('venue.site')) + ICON.out(14), 'ghost')}</div><h3>${esc(t('venue.offers', {n: members.length}))}</h3><p class="hint">${esc(t('venue.note'))}</p></section>`;
    }
    function mapBox(cards) {
      const items = cards.map(shown), located = items.filter(a => a.geo), missing = items.filter(a => !a.geo);
      const list = (rowsList, fallback) => rowsList.map(a => `<div class="map-list-row"><button type="button" class="linkbtn" data-open="${esc(a.id)}">${esc(a.name)}</button><p>${esc(a.address || fallback(a))}</p></div>`).join('');
      return `<div class="map-shell"><p class="hint">${esc(t('map.caption', {located: located.length, total: items.length, n: items.length}))}</p>${located.length ? `<div id="places-map" class="places-map" role="region" aria-label="${esc(t('map.label'))}"></div><p id="map-error" role="status" hidden>${esc(t('map.tilesFailed'))}</p>` : ''}<p class="hint">${esc(t('map.credit'))}</p>` +
        `<details class="more"><summary>${esc(t('map.addresses', {n: located.length}))}</summary>${list(located, () => '')}</details>` +
        (missing.length ? `<details class="more"><summary>${esc(t('map.missing', {n: missing.length}))}</summary><p class="hint">${esc(t('map.missingNote'))}</p>${list(missing, a => t('visit.addressTbc', {town: a.town}))}</details>` : '') + '</div>';
    }
    // alt (day filters): {n, when, keepsAge} — what the same day filter finds without the other filters, offered instead of a dead end.
    function empty(kind, alt = null) {
      if (kind === 'when' && alt) {
        const when = t('when.' + alt.when);
        return `<p class="tt">${esc(t('empty.title'))}</p>` + (alt.n ? `<p class="hint">${esc(t('empty.whenAlt', {n: alt.n, when}))}</p><button type="button" class="ghost" data-action="when-only">${esc(t('empty.whenAltButton'))}</button>`
          : `<p class="hint">${esc(t('empty.whenNone', {when}))}</p><button type="button" class="ghost" data-reset>${esc(t('empty.reset'))}</button>`);
      }
      const savedEmpty = kind === 'saved';
      return `<p class="tt">${esc(t(savedEmpty ? 'empty.savedTitle' : 'empty.title'))}</p><p class="hint">${esc(t(savedEmpty ? 'empty.savedText' : kind === 'unknown' ? 'empty.unknownText' : 'empty.text'))}</p>` +
        (kind === 'unknown' ? `<button type="button" class="ghost" data-action="include-unknown">${esc(t('empty.includeUnknown'))}</button>` : '') +
        (savedEmpty ? `<button type="button" class="ghost" data-view="catalog">${esc(t('empty.openCatalogue'))}</button>` : `<button type="button" class="ghost" data-reset>${esc(t('empty.reset'))}</button>`);
    }

    /* ---------- dialogs (title + body) ---------- */
    const p = key => `<p>${esc(t(key))}</p>`;
    function about() {
      return {title: t('about.title'), body: `<div class="rowbtns"><button type="button" class="ghost" data-view="archive">${esc(t('about.archive'))}</button></div>` + p('about.intro') + `<h3>${esc(t('about.statusTitle'))}</h3>` +
        ['active', 'check', 'future'].map(k => `<p><span class="st"><i class="dot ${statusClass[k]}" aria-hidden="true"></i><strong>${esc(t('status.' + k + '.long'))}</strong></span><br>${esc(t('about.status.' + k))}</p>`).join('') +
        `<h3>${esc(t('about.datesTitle'))}</h3>` + p('about.dates') + p('about.price') + `<h3>${esc(t('about.privacyTitle'))}</h3>` + p('about.privacy') + p('about.scope') + `<h3>${esc(t('about.termsTitle'))}</h3>` + p('about.terms')};
    }
    function data(syncConfig, hasFavorites, storageOk) {
      return {title: t('data.title'), body: (window.MINITANDEM_FEATURES?.familySync === true ? `<h3>${esc(t('data.syncTitle'))}</h3><form id="sync-form"><label class="glabel" for="sync-url">${esc(t('data.syncUrl'))}</label><input class="field" id="sync-url" type="url" required placeholder="https://family.example.ch/" value="${esc(syncConfig?.url || ((location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? location.origin + '/' : ''))}">` +
        `<label class="glabel" for="sync-key">${esc(t('data.syncKey'))}</label><input class="field" id="sync-key" type="password" required minlength="40" autocomplete="off" value="${esc(syncConfig?.token || '')}"><div class="rowbtns"><button class="go" type="submit">${ICON.refresh(18)}${esc(t('data.connect'))}</button>${syncConfig ? `<button type="button" class="ghost" data-action="sync-now">${esc(t('data.checkNow'))}</button><button type="button" class="linkbtn" data-action="sync-disconnect">${esc(t('data.disconnect'))}</button>` : ''}</div></form><p class="hint">${esc(t('data.syncNote'))}</p>` : '') +
        `<h3>${esc(t('data.startTitle'))}</h3><label class="glabel" for="detail-origin">${esc(t('data.startLabel'))}</label><input class="field" id="detail-origin" type="text" maxlength="80" autocomplete="off" placeholder="${esc(t('data.startPlaceholder'))}" value="${esc(personal().origin)}"><p class="hint">${esc(t('data.startNote'))}</p>` +
        `<h3>${esc(t('data.backupTitle'))}</h3>${p('data.backupText')}<div class="rowbtns"><button type="button" class="ghost" data-action="backup-export">${ICON.download(18)}${esc(t('data.backupExport'))}</button><button type="button" class="ghost" data-action="backup-import">${ICON.upload(18)}${esc(t('data.backupImport'))}</button></div>` +
        `<h3>${esc(t('data.tripTitle'))}</h3>${p('data.tripText')}<button type="button" class="ghost" data-action="offline-addresses" ${hasFavorites ? '' : 'disabled'}>${ICON.download(18)}${esc(t('data.tripButton'))}</button>` +
        `<h3>${esc(t('data.catalogueTitle'))}</h3>${p('data.catalogueText')}<button type="button" class="ghost" data-action="csv">${ICON.download(18)}${esc(t('data.catalogueButton'))}</button><p class="hint">${esc(t(storageOk ? 'data.storageOk' : 'data.storageOff'))}</p>`};
    }
    function shareList() {
      const items = personal().favorites.map(id => C.byId.get(id)).filter(Boolean).map(shown);
      return {title: t('share.title'), body: `${p('share.text')}<div class="checks">${items.map((a, i) => `<label class="tickrow"><input type="checkbox" name="share-place" value="${esc(a.id)}" ${i < 50 ? 'checked' : ''}><span>${esc(a.name)}</span></label>`).join('')}</div><div class="rowbtns"><button type="button" class="go" data-action="share-send">${ICON.share(18)}${esc(t('share.send'))}</button><button type="button" class="ghost" data-action="share-copy">${ICON.copy(18)}${esc(t('share.copy'))}</button></div>`};
    }
    function planExchange() {
      const entries = Object.entries(personal().visits).filter(([, v]) => P.validDate(v.date)).sort(([, a], [, b]) => (a.date + a.time).localeCompare(b.date + b.time));
      return {title: t('exchange.title'), body: `<p class="notice">${esc(t('exchange.notice'))}</p>${entries.length ? `<div class="checks">${entries.map(([id, v]) => `<label class="tickrow"><input type="checkbox" name="plan-visit" value="${esc(id)}" ${v.date >= C.today() && v.booking !== 'cancelled' ? 'checked' : ''}><span>${esc(visitLabel(v))}<br>${esc(shown(C.byId.get(v.activity)).name)}<br><small>${esc(t('booking.' + v.booking))}</small></span></label>`).join('')}</div><div class="rowbtns"><button type="button" class="go" data-action="plan-download">${ICON.download(18)}${esc(t('exchange.file'))}</button><button type="button" class="ghost" data-action="plan-calendar">${ICON.calPlus(18)}${esc(t('exchange.calendar'))}</button></div>` : p('exchange.none')}<p class="hint">${esc(t('exchange.copyNote'))}</p>`};
    }
    function pilot() {
      const m = X.metrics(personal().visits);
      const row = (label, value) => `<div class="fr"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
      return {title: t('pilot.title'), body: `<dl class="pr">${row(t('pilot.planned'), m.planned)}${row(t('pilot.attended'), `${m.attended} / ${m.missed}`)}${row(t('pilot.selected'), `${m.selectedHere} / ${m.knownBefore}`)}${row(t('pilot.information'), `${m.enoughInformation} / ${m.neededClarification}`)}${row(t('pilot.repeat'), m.wantRepeat)}</dl>${p('pilot.note')}<p class="hint">${esc(t('pilot.fileNote'))}</p><button type="button" class="ghost" data-action="pilot-download">${ICON.download(18)}${esc(t('pilot.download'))}</button>`};
    }
    function visitForm(card, draft, isExisting) {
      const a = shown(card);
      const field = (k, label, type = 'text') => `<label class="glabel" for="visit-${k}">${esc(label)}</label><input class="field" id="visit-${k}" name="${k}" type="${type}" value="${esc(draft[k])}" ${type === 'date' ? 'min="2000-01-01" max="2099-12-31"' : ''}>`;
      const text = (k, label, max) => `<label class="glabel" for="visit-${k}">${esc(label)}</label><textarea class="field area" id="visit-${k}" name="${k}" maxlength="${max}" rows="3">${esc(draft[k])}</textarea>`;
      const select = (k, label, keys, prefix) => `<label class="glabel" for="visit-${k}">${esc(label)}</label><span class="select"><select class="field" id="visit-${k}" name="${k}">${keys.map(v => `<option value="${v}" ${draft[k] === v ? 'selected' : ''}>${esc(keyed(prefix, v))}</option>`).join('')}</select></span>`;
      const lines = draft.bring.split('\n').slice(0, 20);
      const packed = lines.filter(line => line.trim());
      return {title: t(isExisting ? 'visit.formEdit' : 'visit.formNew'), body: `<p><strong>${esc(a.name)}</strong></p><p class="notice">${esc(t('admission.' + P.admission(a)))}. ${P.admission(a) === 'course' ? esc(t('admission.courseJoin')) + ' ' : ''}${esc(t('visit.formNote'))}</p>` +
        `<p class="hint">${esc(t('visit.formAge', {age: a.age, parent: F.parentShort(a)}))}</p><form id="visit-form" class="visit-form"><div class="two"><div>${field('date', t('visit.date'), 'date')}</div><div>${field('time', t('visit.time'), 'time')}</div></div>` +
        select('booking', t('visit.booking'), P.bookingStateKeys, 'booking') + text('reply', t('visit.reply'), 2000) + text('bring', t('visit.bring'), 1000) +
        (packed.length ? `<fieldset class="group packing"><legend class="glabel">${esc(t('visit.packed'))}</legend>${lines.map((line, i) => line.trim() ? `<label class="tickrow"><input type="checkbox" name="pack${i}" ${draft['pack' + i] ? 'checked' : ''}><span>${esc(line)}</span></label>` : '').join('')}</fieldset>` : '') +
        `<h3>${esc(t('visit.after'))}</h3>` + select('attendance', t('visit.attendance'), P.attendanceKeys, 'attendance') + select('usefulness', t('visit.usefulness'), P.usefulnessKeys, 'usefulness') + select('information', t('visit.information'), P.informationKeys, 'information') +
        select('outcome', t('visit.outcome'), P.outcomeKeys, 'outcome') + text('observations', t('visit.observations'), 3000) +
        `<p class="hint">${esc(t('visit.privateNote'))}</p><div class="rowbtns"><button type="submit" class="go">${ICON.check(18)}${esc(t('visit.save'))}</button><button type="button" class="ghost" data-close-utility>${esc(t('common.cancel'))}</button></div></form>`};
    }
    function importConfirm(imported) {
      return {title: t('import.title'), body: `<p>${esc(t('import.contents', {favorites: imported.favorites.length, notes: Object.keys(imported.notes).length, statuses: Object.keys(imported.statuses).length, visits: Object.keys(imported.visits).length}))}</p><p class="notice">${esc(t('import.note', {age: F.ageLabel(imported.age), origin: imported.origin || t('common.notStated')}))}</p><div class="rowbtns"><button type="button" class="go" id="confirm-import">${esc(t('import.confirm'))}</button><button type="button" class="ghost" data-close-utility>${esc(t('common.cancel'))}</button></div>`};
    }
    function planImportConfirm(preview) {
      return {title: t('planImport.title'), body: `<p>${esc(t('planImport.counts', {added: preview.added, changed: preview.changed}))}</p><p class="notice">${esc(t('planImport.note'))}</p><ul class="plain">${Object.values(preview.clean.visits).map(v => `<li><strong>${esc(shown(C.byId.get(v.activity)).name)}</strong><br>${esc(visitLabel(v))}<br>${esc(t('booking.' + v.booking))}</li>`).join('')}</ul><div class="rowbtns"><button type="button" class="go" id="confirm-plan-import">${ICON.check(18)}${esc(t('planImport.confirm'))}</button><button type="button" class="ghost" data-close-utility>${esc(t('common.cancel'))}</button></div>`};
    }
    const topicKey = topic => ({'Schedule': 'schedule', 'Price': 'price', 'Age or adult participation': 'age', 'Address or closure': 'address', 'Other': 'other'}[topic]);
    function report(a, connected) {
      return {title: t('report.title'), body: `<p><strong>${esc(shown(a).name)}</strong></p><form id="change-report" data-id="${esc(a.id)}"><label class="glabel" for="report-topic">${esc(t('report.topic'))}</label><span class="select"><select class="field" id="report-topic">${X.topics.map(topic => `<option value="${esc(topic)}">${esc(t('report.topic.' + topicKey(topic)))}</option>`).join('')}</select></span>` +
        `<label class="glabel" for="report-text">${esc(t('report.text'))}</label><textarea class="field area" id="report-text" required maxlength="2000" rows="5"></textarea><label class="glabel" for="report-source">${esc(t('report.source'))}</label><input class="field" id="report-source" type="url" maxlength="500" placeholder="https://"><p class="hint">${esc(t('report.note'))}</p>` +
        `<div class="rowbtns"><button class="go" type="submit">${esc(t(connected ? 'report.send' : 'report.download'))}</button><button type="button" class="ghost" data-close-utility>${esc(t('common.cancel'))}</button></div></form>`};
    }
    function conflict(remote) {
      return {title: t('conflict.title'), body: `<p>${esc(t('conflict.text'))}</p><p class="notice">${esc(t('conflict.counts', {lf: personal().favorites.length, lv: Object.keys(personal().visits).length, rf: remote.profile?.favorites?.length || 0, rv: Object.keys(remote.profile?.visits || {}).length}))}</p><div class="rowbtns"><button type="button" class="ghost" data-action="backup-export">${ICON.download(18)}${esc(t('conflict.backup'))}</button><button type="button" class="ghost" data-action="sync-use-remote">${esc(t('conflict.useService'))}</button><button type="button" class="go" data-action="sync-use-local">${esc(t('conflict.keepHere'))}</button></div><p class="hint">${esc(t('conflict.note'))}</p>`};
    }
    const copyFallback = text => ({title: t('copy.title'), body: `<p>${esc(t('copy.denied'))}</p><textarea class="field area copy-fallback" readonly>${esc(text)}</textarea>`});
    return {esc, ICON, categoryIcon, nm, shown, hoursLine, row, dayRow, rows, filterChips, distanceText, week, weekGroup, reportMail, panel, detail, saveButton, visitPlans, visitRows, visitLabel, saved, changesBox, outing, viewTools, venueBox, mapBox, empty, about, data, shareList, planExchange, pilot, visitForm,
      importConfirm, planImportConfirm, report, conflict, copyFallback, warningText, hashFor, organiserURL, mapURL, routeURL, placeOptionsHtml, cost, ageFitNote, statusClass, phoneHref};
  }
  window.MinitandemViews = {create, esc, ICON, PRACTICAL_ORDER};
})();
