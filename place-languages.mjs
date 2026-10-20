// The words of the plain pages (public-pages.mjs) in each language are the app's own. The dictionaries (strings-*.js), the formatting
// functions of dates, ages and prices (format.js) and the checked German and French card texts (catalogue-i18n.js with data-de.js and
// data-fr.js) are loaded here the way the build loads them, and run in Node. A page says a date, an age, a label or a note exactly as
// the app does, and a card whose English changed after it was translated is shown in English, as in the app.
import fs from 'node:fs';
import vm from 'node:vm';

const read = file => fs.readFileSync(new URL('./' + file, import.meta.url), 'utf8');
// The languages of the pages, in the order of the language switch (as on the legal notices).
export const PAGE_LANGS = ['de', 'fr', 'en'];
// English stays where these pages have always been, so that no address that was shared changes; German and French sit beside it.
export const ROOT_LANG = 'en';

const layers = new Map();
// One interface per language, each in a context of its own: the dictionary keeps its language in a variable, so a context
// must never be switched while a formatter made for it is still in use.
export function languageLayer(lang) {
  if (!PAGE_LANGS.includes(lang)) throw Error('No such page language: ' + lang);
  if (layers.has(lang)) return layers.get(lang);
  const context = {window: {}, structuredClone, TextEncoder};
  const files = ['strings-en.js', 'strings-de.js', 'strings-fr.js', 'i18n.js', 'format.js', 'catalogue-i18n.js', 'views.js', ...lang === ROOT_LANG ? [] : [`data-${lang}.js`]];
  for (const file of files) vm.runInNewContext(read(file), context, {filename: file});
  const W = context.window, I = W.MinitandemI18n;
  I.setLang(lang, {persist: false});
  const F = W.MinitandemFormat.create({t: I.t, locale: I.locale});
  const CI = W.MinitandemCatalogueI18n, order = W.MinitandemViews.PRACTICAL_ORDER, data = W.MINITANDEM_CARDS?.[lang];
  const layer = {
    lang, t: I.t, F, practicalOrder: order, plainPage: id => '/' + I.plainPage(lang, id),
    // The cards as these pages show them: shown(card) is the card in the page language (English where it has no current translation),
    // fallback(card) says that it is English although another language is the page's.
    cards(list) {
      if (lang === ROOT_LANG) return {shown: card => card, fallback: () => false, stale: []};
      const overlay = CI.overlay(list, data, order);
      return {shown: card => overlay.card(card), fallback: card => !overlay.translated(card), stale: overlay.stale, missing: overlay.missing};
    }
  };
  layers.set(lang, layer);
  return layer;
}

// The address of a place's page and of the directory in a language, from the one table the app uses for its own links (i18n.js).
export const placeURL = (id, lang) => languageLayer(lang).plainPage(id);
export const directoryURL = lang => languageLayer(lang).plainPage('');

// The sentences of a dictionary text, so that a page can take the first ones of a longer note without new wording.
export const sentences = text => String(text).split(/(?<=[.!?])\s+/);

// The few words these pages need that the interface has no key for. German and French were written for the pages, close to the
// wording of the neighbouring dictionary keys (breadcrumb, the name of the directory, the end of the search-result description).
export const PAGE_TEXT = {
  en: {breadcrumb: 'Breadcrumb', places: 'Places and activities', placesTitle: 'Places and activities for families', tail: 'Schedule, address, conditions for taking part and sources.'},
  de: {breadcrumb: 'Navigationspfad', places: 'Orte und Angebote', placesTitle: 'Orte und Angebote für Familien', tail: 'Zeiten, Adresse, Teilnahmebedingungen und Quellen.'},
  fr: {breadcrumb: 'Fil d’Ariane', places: 'Lieux et activités', placesTitle: 'Lieux et activités pour les familles', tail: 'Horaires, adresse, conditions de participation et sources.'}
};
