/* Wording of card facts in the current language. The card text itself (names, schedules, notes, prices) is shown as written, in
   English or in its German or French translation (catalogue-i18n.js); what is built here are the short labels around it: dates, age
   summaries, adult participation. */
(() => {
  'use strict';
  function create({t, locale = () => 'en-GB'}) {
    const utc = {timeZone: 'UTC'};
    const at = d => new Date(`${d}T12:00:00Z`);
    const dateLabel = d => new Intl.DateTimeFormat(locale(), {...utc, day: 'numeric', month: 'short', year: 'numeric'}).format(at(d));
    const shortDate = d => new Intl.DateTimeFormat(locale(), {...utc, day: 'numeric', month: 'short'}).format(at(d));
    const dayDate = d => new Intl.DateTimeFormat(locale(), {...utc, weekday: 'short', day: 'numeric', month: 'short'}).format(at(d));
    // 'Wednesday 14 October' for the day headings of the week view ('mercredi 14 octobre' in French).
    const dayLong = d => new Intl.DateTimeFormat(locale(), {...utc, weekday: 'long', day: 'numeric', month: 'long'}).format(at(d));
    // 1 = Monday ... 7 = Sunday (1 January 2024 was a Monday).
    const weekdayName = n => new Intl.DateTimeFormat(locale(), {...utc, weekday: 'short'}).format(new Date(Date.UTC(2024, 0, n)));
    const clockLabel = e => e.start ? `${e.start}${e.end ? '–' + e.end : ''}` : t('time.tbc');
    const first = s => String(s).split(';')[0].trim();
    const bounds = a => (a.min !== null && a.min > 0) || a.max !== null;
    // A bound under 2 years that is not a whole year reads in months (0.33 is 4 months, 1.5 is 18 months); from 2 years on it stays in years.
    const inMonths = n => n !== null && n < 2 && !Number.isInteger(n), months = n => Math.round(n * 12);
    // 'From 3 years', 'Up to 5 years', '2–4 years', 'From 4 months', '4 months–4 years', '4–12 months'; without a real bound, the organiser's own first phrase.
    function ageShort(a) {
      if (bounds(a)) {
        if (a.max === null) return inMonths(a.min) ? t('age.fromMonths', {n: months(a.min)}) : t('age.from', {n: a.min});
        if (a.min === null || a.min === 0) return inMonths(a.max) ? t('age.upToMonths', {n: months(a.max)}) : t('age.upTo', {n: a.max});
        if (inMonths(a.min) || inMonths(a.max)) return a.max < 2 ? t('age.rangeMonths', {min: months(a.min), max: months(a.max), n: months(a.max)}) : t('age.rangeMonthsYears', {min: months(a.min), max: a.max, n: a.max});
        return t('age.range', {min: a.min, max: a.max});
      }
      // The decision reads the English phrase (a translated card keeps it in a.english); the translated phrase is what is shown.
      const phrase = first(a.age);
      return /confirm|check|not published|restriction|to be/i.test(first((a.english || a).age)) ? t('age.notPublished') : phrase;
    }
    // The age as a bare number for sentences such as 'Fits age 3'.
    const ageBare = age => age === 0 ? t('age.underOne') : String(age);
    const ageLabel = age => !Number.isFinite(age) ? t('common.any') : age === 0 ? t('age.under1') : t('age.years', {n: age});
    const parentLong = a => a.parentDetails || t('parent.' + (['yes', 'no'].includes(a.parent) ? a.parent : 'unknown') + '.long');
    const parentShort = a => t('parent.' + (['yes', 'no'].includes(a.parent) ? a.parent : 'unknown') + '.short');
    const langText = a => a.languages.length ? a.languages.map(l => l === 'none' ? t('lang.none') : l === 'DE/FR' ? t('lang.bilingual') : l === 'DE' ? t('lang.de') : l === 'FR' ? t('lang.fr') : l).join(' · ') : null;
    const nextText = (a, upcoming, past) => {
      if (upcoming.length) { const e = upcoming[0]; return t('date.next', {date: dayDate(e.date), time: e.start ? clockLabel(e) : t('time.tbc')}) + (upcoming.length > 1 ? ' ' + t('date.more', {n: upcoming.length - 1}) : ''); }
      if (past.length) return t('date.passed', {date: dayDate(past[past.length - 1].date)});
      return null;
    };
    // The next date without "Next:", for the table column that is already headed "Next date".
    const nextShort = upcoming => { const e = upcoming[0]; return `${dayDate(e.date)}, ${e.start ? clockLabel(e) : t('time.tbc')}` + (upcoming.length > 1 ? ' ' + t('date.more', {n: upcoming.length - 1}) : ''); };
    const cell = value => String(value ?? '');
    return {dateLabel, shortDate, dayDate, dayLong, weekdayName, clockLabel, first, ageShort, ageLabel, ageBare, parentLong, parentShort, langText, nextText, nextShort, bounds, cell};
  }
  window.MinitandemFormat = {create};
})();
