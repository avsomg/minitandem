/* Interface language: English, German, French. Every word the visitor reads comes from the dictionaries in strings-en.js,
   strings-de.js and strings-fr.js (window.MINITANDEM_STRINGS[lang][key]); no interface text lives in the logic.
   Keys with a count have two forms, key_one and key_other, chosen with Intl.PluralRules from the parameter n (in a sentence with several
   counts, n is the one the counted word follows); {name} marks a parameter.
   The card texts (names, schedules, notes) are English; in German and French their checked translations are shown where they are
   current (catalogue-i18n.js, data-de.js, data-fr.js), and English otherwise. */
(() => {
  'use strict';
  const LANGS = ['en', 'de', 'fr'];
  const LOCALES = {en: 'en-GB', de: 'de-CH', fr: 'fr-CH'};
  const STORAGE_KEY = 'minitandem-lang-v1';
  const dictionaries = window.MINITANDEM_STRINGS = window.MINITANDEM_STRINGS || {};
  let current = 'en';
  // The visitor's remembered choice wins; otherwise the first browser language we have; otherwise English.
  function detect(browserLanguages, stored) {
    if (LANGS.includes(stored)) return stored;
    for (const raw of browserLanguages || []) {
      const base = String(raw || '').toLowerCase().split(/[-_]/)[0];
      if (LANGS.includes(base)) return base;
    }
    return 'en';
  }
  const form = (lang, n) => new Intl.PluralRules(LOCALES[lang]).select(Number(n)) === 'one' ? 'one' : 'other';
  function lookup(lang, key, n) {
    const dict = dictionaries[lang] || {};
    if (n !== undefined && dict[key + '_' + form(lang, n)] !== undefined) return dict[key + '_' + form(lang, n)];
    return dict[key];
  }
  function t(key, params) {
    let text = lookup(current, key, params?.n);
    if (text === undefined) text = lookup('en', key, params?.n);
    if (text === undefined) return key;
    const show = value => typeof value === 'number' && !Number.isInteger(value) ? new Intl.NumberFormat(LOCALES[current], {maximumFractionDigits: 2}).format(value) : String(value);
    return params ? text.replace(/\{(\w+)\}/g, (all, name) => (params[name] === undefined ? all : show(params[name]))) : text;
  }
  function setLang(lang, {persist = true} = {}) {
    if (!LANGS.includes(lang)) return current;
    current = lang;
    if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = lang;
    if (persist) try { localStorage.setItem(STORAGE_KEY, lang); } catch {}
    return current;
  }
  function init(browserLanguages = (typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [])) {
    let stored = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch {}
    return setLang(detect(browserLanguages, stored), {persist: false});
  }
  const locale = () => LOCALES[current];
  window.MinitandemI18n = {LANGS, LOCALES, STORAGE_KEY, detect, t, setLang, init, locale, lang: () => current, form, dictionaries};
})();
