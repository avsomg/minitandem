/* German and French card texts. The English card is the source; a translation belongs to one exact English text.
   unitStrings() lists every public text of a card by field path, in the same order and with the same paths as the translation
   pipeline (translation/units-target.mjs, targetUnit), and revision() is the digest it records: sha256 of JSON.stringify of those
   strings. overlay() puts a language file (data-de.js, data-fr.js) over the cards: a card whose English still has the recorded
   digest is shown translated, any other card stays English. No DOM: the same code runs in the page, in Node and in the tests. */
(() => {
  'use strict';
  // Descriptive text in the town field (archive placeholders) is translated; real town names are not.
  const descriptiveTown = town => /\b(?:not|outside|established|selection|various|confirmed)\b/i.test(town || '');
  // order: the practical fields in the order the card shows them (PRACTICAL_ORDER in views.js); fields outside it are not shown.
  function unitStrings(card, order) {
    const strings = {};
    const put = (key, value) => { if (typeof value === 'string' && value.trim()) strings[key] = value; };
    put('name', card.name);
    if (descriptiveTown(card.town)) put('town', card.town);
    for (const key of ['intro', 'parentDetails', 'age', 'schedule', 'price', 'address']) put(key, card[key]);
    (card.events || []).forEach((event, index) => { put(`events[${index}].title`, event.title); if (event.address !== card.address) put(`events[${index}].address`, event.address); });
    (card.notes || []).forEach((note, index) => put(`notes[${index}]`, note));
    for (const key of order) put(`practical.${key}.text`, card.practical?.[key]?.text);
    (card.practical?.warnings || []).forEach((warning, index) => put(`practical.warnings[${index}]`, warning));
    put('practical.tariff.note', card.practical?.tariff?.note);
    put('practical.photo.alt', card.practical?.photo?.alt); put('practical.photo.caption', card.practical?.photo?.caption);
    (card.research?.findings || []).forEach((finding, index) => { put(`research.findings[${index}].field`, finding.field); put(`research.findings[${index}].text`, finding.text); });
    (card.research?.remaining || []).forEach((item, index) => put(`research.remaining[${index}]`, item));
    (card.contacts || []).forEach((contact, index) => put(`contacts[${index}].name`, contact.name));
    (card.sources || []).forEach((source, index) => put(`sources[${index}].label`, source.label));
    return strings;
  }

  // SHA-256 of the UTF-8 bytes of a string, as lowercase hex (FIPS 180-4). Synchronous, so the page can check every card before it renders.
  const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  function sha256(text) {
    const bytes = new TextEncoder().encode(text), length = bytes.length, size = Math.ceil((length + 9) / 64) * 64;
    const message = new Uint8Array(size); message.set(bytes); message[length] = 0x80;
    const view = new DataView(message.buffer);
    view.setUint32(size - 8, Math.floor(length / 0x20000000)); view.setUint32(size - 4, (length * 8) >>> 0);
    const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let offset = 0; offset < size; offset += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = hash;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      [a, b, c, d, e, f, g, h].forEach((value, i) => { hash[i] = (hash[i] + value) | 0; });
    }
    return hash.map(value => (value >>> 0).toString(16).padStart(8, '0')).join('');
  }
  const revision = (card, order) => sha256(JSON.stringify(unitStrings(card, order)));

  // Writes one translated string into a copy of the card at its path ('notes[2]', 'practical.indoor.text', 'events[0].title').
  function setPath(target, key, value) {
    const steps = key.split('.').flatMap(part => { const m = part.match(/^([A-Za-z]+)(?:\[(\d+)\])?$/); return m ? (m[2] === undefined ? [m[1]] : [m[1], Number(m[2])]) : [null]; });
    if (steps.includes(null)) return false;
    let node = target;
    for (const step of steps.slice(0, -1)) { if (!node || typeof node[step] !== 'object') return false; node = node[step]; }
    if (!node || typeof node[steps.at(-1)] !== 'string') return false;
    node[steps.at(-1)] = value;
    return true;
  }

  // cards: the English cards; data: {id: {rev, strings}} of one language; order as above. A card is shown translated when its English
  // strings still have the recorded digest; strings the card does not have now are ignored, strings without a translation stay English.
  function overlay(cards, data, order) {
    const shown = new Map(), stale = [], missing = [], unmapped = [];
    for (const card of cards) {
      const entry = data && Object.hasOwn(data, card.id) ? data[card.id] : null;
      if (!entry || typeof entry !== 'object' || !entry.strings) { missing.push(card.id); continue; }
      const english = unitStrings(card, order);
      if (sha256(JSON.stringify(english)) !== entry.rev) { stale.push(card.id); continue; }
      const copy = structuredClone(card);
      for (const [key, text] of Object.entries(entry.strings)) {
        if (!Object.hasOwn(english, key) || typeof text !== 'string' || !text.trim() || !setPath(copy, key, text)) unmapped.push(card.id + ' ' + key);
      }
      // The English card stays reachable for decisions that read the English wording (format.js, ageShort).
      Object.defineProperty(copy, 'english', {value: card});
      shown.set(card.id, {copy, text: Object.values(entry.strings).join(' ')});
    }
    return {
      card: a => (a && shown.get(a.id)?.copy) || a,
      translated: a => Boolean(a && shown.has(a.id)),
      text: a => (a && shown.get(a.id)?.text) || '',
      stale, missing, unmapped, count: shown.size
    };
  }
  window.MinitandemCatalogueI18n = {unitStrings, revision, sha256, overlay, setPath, LANGS: ['de', 'fr']};
})();
