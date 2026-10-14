/* Files the visitor can download: backup, catalogue CSV, calendar entries, address list. Each function returns
   {name, text, type}; the page turns that into a download. Private notes and statuses never enter the catalogue files. */
(() => {
  'use strict';
  const ZURICH = ['BEGIN:VTIMEZONE', 'TZID:Europe/Zurich', 'BEGIN:DAYLIGHT', 'DTSTART:19960331T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT', 'BEGIN:STANDARD', 'DTSTART:19961027T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD', 'END:VTIMEZONE'];
  const UID_DOMAIN = 'minitandem.local';
  const icsEscape = s => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  function foldLine(line) {
    let result = '', current = '', bytes = 0;
    for (const ch of line) {
      const size = new TextEncoder().encode(ch).length;
      if (bytes + size > 73) { result += current + '\r\n '; current = ''; bytes = 1; }
      current += ch; bytes += size;
    }
    return result + current;
  }
  const dayAfter = date => { const next = new Date(date + 'T12:00:00Z'); next.setUTCDate(next.getUTCDate() + 1); return next.toISOString().slice(0, 10).replace(/-/g, ''); };
  const eventAddress = (a, e) => e?.address || a.address;
  const hasVaryingEventAddress = a => a.events.some(e => e.address && e.address !== a.address);
  const phoneLink = phone => phone.replace(/[^+\d]/g, '').replace(/^0(?=\d{9}$)/, '+41');

  // ctx: {t, lang, P, byId, regions, today, format, statusOf}
  function create(ctx) {
    const {t, P, byId, regions, today, format} = ctx;
    const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const calendar = (product, body) => ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//Minitandem//${product}//${ctx.lang().toUpperCase()}`, 'CALSCALE:GREGORIAN', ...ZURICH, ...body, 'END:VCALENDAR'].map(foldLine).join('\r\n') + '\r\n';

    function eventFile(id, index) {
      const a = byId.get(id), e = a?.events[index];
      if (!e) return null;
      const date = e.date.replace(/-/g, '');
      const lines = ['BEGIN:VEVENT', `UID:${a.id}-${date}-${e.start || 'date'}@${UID_DOMAIN}`, `DTSTAMP:${stamp()}`];
      if (e.start) { lines.push(`DTSTART;TZID=Europe/Zurich:${date}T${e.start.replace(':', '')}00`); if (e.end) lines.push(`DTEND;TZID=Europe/Zurich:${date}T${e.end.replace(':', '')}00`); }
      else lines.push(`DTSTART;VALUE=DATE:${date}`, `DTEND;VALUE=DATE:${dayAfter(e.date)}`);
      const course = P.admission(a) === 'course';
      const participation = t('admission.' + P.admission(a)) + (course ? '; ' + t('ics.courseJoin') : '');
      lines.push(`SUMMARY:${icsEscape((course ? t('ics.coursePrefix') + ' · ' : '') + (e.title ? e.title + ' · ' : '') + a.name + (e.start ? '' : ' ' + t('ics.timeTbc')))}`,
        `LOCATION:${icsEscape(eventAddress(a, e) || t('ics.addressTbc', {town: a.town}))}`,
        `DESCRIPTION:${icsEscape([e.title || a.name, participation, t('ics.notBooking'), a.schedule, a.price, ...a.notes, t('ics.checked', {date: a.checked}), ...a.sources.map(s => s.url)].join('\n'))}`, 'END:VEVENT');
      return {name: `${a.id}-${e.date}.ics`, text: calendar('Family Activities', lines), type: 'text/calendar;charset=utf-8'};
    }
    function planFile(plan) {
      const lines = [];
      for (const [id, v] of Object.entries(plan.visits)) {
        const a = byId.get(v.activity), date = v.date.replace(/-/g, '');
        lines.push('BEGIN:VEVENT', `UID:${id}@${UID_DOMAIN}`, `DTSTAMP:${stamp()}`);
        if (v.time) lines.push(`DTSTART;TZID=Europe/Zurich:${date}T${v.time.replace(':', '')}00`);
        else lines.push(`DTSTART;VALUE=DATE:${date}`, `DTEND;VALUE=DATE:${dayAfter(v.date)}`);
        const event = a.events.find(e => e.date === v.date);
        const address = eventAddress(a, event);
        lines.push(`SUMMARY:${icsEscape(a.name + (v.time ? '' : ' ' + t('ics.noTime')))}`,
          `LOCATION:${icsEscape(!event && hasVaryingEventAddress(a) ? t('ics.addressByDate', {town: a.town}) : address || a.town)}`,
          `DESCRIPTION:${icsEscape(t('ics.planNote', {state: t('booking.' + v.booking)}))}`, `STATUS:${v.booking === 'cancelled' ? 'CANCELLED' : 'TENTATIVE'}`, 'END:VEVENT');
      }
      return {name: `minitandem-plan-${today()}.ics`, text: calendar('Personal Plan', lines), type: 'text/calendar;charset=utf-8'};
    }
    const planJson = plan => ({name: `minitandem-plan-${today()}.json`, text: JSON.stringify(plan, null, 2), type: 'application/json'});
    const backupFile = personal => ({name: `minitandem-backup-${today()}.json`, text: JSON.stringify({...personal, exportedAt: new Date().toISOString()}, null, 2), type: 'application/json'});
    const pilotFile = metrics => ({name: 'minitandem-pilot-summary.json', text: JSON.stringify(metrics, null, 2), type: 'application/json'});
    const correctionFile = report => ({name: `minitandem-correction-${report.activity}.json`, text: JSON.stringify(report, null, 2), type: 'application/json'});

    // A spreadsheet treats a leading = + - @ as a formula: such cells are prefixed with an apostrophe.
    function csvFile(items, statusOfCard) {
      const headers = ['name', 'category', 'town', 'district', 'address', 'age', 'adult', 'language', 'schedule', 'price', 'status', 'contacts', 'sources', 'checked'].map(k => t('csv.' + k));
      const cell = s => { let text = String(s ?? ''); if (/^\s*[=+\-@]|^[\t\r\n]/.test(text)) text = "'" + text; return '"' + text.replace(/"/g, '""') + '"'; };
      const rows = items.map(a => [a.name, t('category.' + a.category), a.town, regions[a.region], a.address, a.age, format.parentLong(a), format.langText(a) || t('lang.unknown'), a.schedule, a.price,
        t('status.' + statusOfCard(a) + '.long'), a.contacts.map(c => [c.name, c.phone, c.email].filter(Boolean).join(' ')).join('; '), a.sources.map(s => s.url).join(' '), a.checked]);
      return {name: `minitandem-catalogue-${today()}.csv`, text: '\uFEFF' + [headers, ...rows].map(r => r.map(cell).join(';')).join('\r\n'), type: 'text/csv;charset=utf-8'};
    }
    function addressesFile(items) {
      const text = [t('addresses.title'), t('addresses.saved', {date: format.dateLabel(today())}), t('addresses.noPrivate'), '',
        ...items.flatMap(a => [a.name, a.address || t('common.addressTbc'), a.schedule, a.price, t('addresses.participation', {value: t('admission.' + P.admission(a))}), t('addresses.age', {value: a.age}), t('addresses.adult', {value: format.parentLong(a)}),
          ...a.contacts.map(c => [c.name, c.phone, c.email].filter(Boolean).join(' · ')), t('addresses.checked', {date: a.checked}), ...a.sources.map(s => s.url), ''])].join('\n');
      return {name: `minitandem-addresses-${today()}.txt`, text, type: 'text/plain;charset=utf-8'};
    }
    return {eventFile, planFile, planJson, backupFile, pilotFile, correctionFile, csvFile, addressesFile};
  }
  window.MinitandemExports = {create, icsEscape, foldLine, eventAddress, hasVaryingEventAddress, phoneLink, UID_DOMAIN};
})();
