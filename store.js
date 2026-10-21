/* The visitor's own records (favourites, notes, statuses, visit plans, child's age, starting point, the town distances are measured
   from, Daycare applications) and where they live.
   Everything stays in the browser unless the visitor connects the optional family service. The storage object is passed in,
   so the same code runs against a fake storage in tests. Several tabs may write: persist() merges this tab's changes into
   whatever is stored now instead of overwriting it. */
(() => {
  'use strict';
  const KEYS = {family: 'minitandem-family-v1', sync: 'minitandem-sync-v1', corrections: 'minitandem-pending-corrections-v1', filters: 'minitandem-family-v1-filters',
    near: 'minitandem-near-town-v1', childcare: 'minitandem-childcare-v1'};
  const cleanOrigin = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '';
  const emptyPersonal = () => ({version: 1, favorites: [], notes: {}, statuses: {}, visits: {}, tracked: {}, age: null, origin: ''});
  const emptyChildcare = () => ({version: 1, commune: '', applications: {}});
  // A place or commune of the Daycare tab is known by the form of its id: data-childcare.js is loaded only with the tab, and an application
  // stays when its place is no longer listed.
  const RECORD_ID = /^[a-z0-9][a-z0-9-]{0,119}$/;

  // applicationKeys: the statuses of a Daycare application (childcare.js APPLICATION_KEYS).
  function create({storage, byId, P, today, statusKeys, canonicalId = id => id, onSaved = () => {}, applicationKeys = []}) {
    const fail = P.fail;
    function validateBackup(raw, fallbackOrigin = '') {
      if (!raw || raw.version !== 1 || !Array.isArray(raw.favorites) || typeof raw.notes !== 'object' || !raw.notes || typeof raw.statuses !== 'object' || !raw.statuses) throw fail('backup.invalid', 'Not a Minitandem backup file.');
      const renameKeys = value => value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([id, item]) => [canonicalId(id), item])) : {};
      const visits = Object.fromEntries(Object.entries(raw.visits || {}).map(([id, visit]) => [id, visit && typeof visit === 'object' ? {...visit, activity: canonicalId(visit.activity)} : visit]));
      return {version: 1,
        favorites: [...new Set(raw.favorites.map(canonicalId).filter(x => typeof x === 'string' && byId.has(x)))],
        notes: Object.fromEntries(Object.entries(renameKeys(raw.notes)).filter(([k, v]) => byId.has(k) && typeof v === 'string').map(([k, v]) => [k, v.slice(0, 10000)])),
        statuses: Object.fromEntries(Object.entries(renameKeys(raw.statuses)).filter(([k, v]) => byId.has(k) && statusKeys.includes(v))),
        visits: P.validateVisits(visits, byId), tracked: P.validateTracked(renameKeys(raw.tracked), byId),
        age: Number.isFinite(raw.age) && raw.age >= 0 && raw.age <= 18 ? raw.age : null,
        origin: Object.hasOwn(raw, 'origin') ? cleanOrigin(raw.origin) : fallbackOrigin};
    }
    // The Daycare tab's records: per place a status, the date registered, a date to renew by and a note, and the commune chosen under
    // "Where do you live?". They have a key of their own, apart from the family record, so the family service never receives them; they leave
    // this browser only in a backup file. At most 500 places, notes cut at 2000 characters.
    function validateChildcare(raw) {
      if (!raw || typeof raw !== 'object' || raw.version !== 1 || !raw.applications || typeof raw.applications !== 'object' || Array.isArray(raw.applications)) throw fail('backup.invalid', 'Not a Minitandem backup file.');
      const date = value => P.validDate(value) ? value : '', applications = {};
      for (const [id, a] of Object.entries(raw.applications).slice(0, 500)) {
        if (!RECORD_ID.test(id) || !a || typeof a !== 'object') continue;
        const entry = {status: applicationKeys.includes(a.status) ? a.status : '', registered: date(a.registered), renewBy: date(a.renewBy), note: typeof a.note === 'string' ? a.note.slice(0, 2000) : ''};
        if (entry.status || entry.registered || entry.renewBy || entry.note) applications[id] = entry;
      }
      return {version: 1, commune: typeof raw.commune === 'string' && RECORD_ID.test(raw.commune) ? raw.commune : '', applications};
    }
    // A storage in the page's memory only (app.js, when the browser refuses its own) keeps the records until the page is closed or reloaded:
    // it is never reported as available, and a save into it returns false like a failed one.
    const lasting = !storage.memoryOnly;
    const store = {KEYS, validateBackup, validateChildcare, cleanOrigin, emptyPersonal, emptyChildcare, personal: emptyPersonal(), baseline: emptyPersonal(), childcare: emptyChildcare(),
      childcareBaseline: emptyChildcare(), storageAvailable: lasting};
    try { const stored = storage.getItem(KEYS.family); if (stored) store.personal = validateBackup(JSON.parse(stored)); } catch { store.storageAvailable = false; }
    store.baseline = structuredClone(store.personal);
    const readChildcare = () => { const raw = storage.getItem(KEYS.childcare); return raw ? validateChildcare(JSON.parse(raw)) : emptyChildcare(); };
    const adoptChildcare = record => { store.childcare = record; store.childcareBaseline = structuredClone(record); };
    try { adoptChildcare(readChildcare()); } catch (error) { if (!(error instanceof SyntaxError) && error?.code !== 'backup.invalid') store.storageAvailable = false; }

    // Re-read what is stored now (another tab, or the family service) and make it the current state.
    store.adopt = profile => { store.personal = profile; store.baseline = structuredClone(profile); };
    store.reload = () => { const raw = storage.getItem(KEYS.family); store.adopt(raw ? validateBackup(JSON.parse(raw)) : emptyPersonal()); return store.personal; };
    store.writeProfile = profile => { storage.setItem(KEYS.family, JSON.stringify(profile)); store.adopt(profile); };

    // Apply this tab's changes to what is stored now; `overrides` (an explicit backup import) replaces the matching records.
    store.persist = (overrides = null) => {
      const personal = store.personal, baseline = store.baseline;
      try {
        const raw = storage.getItem(KEYS.family);
        // A stored profile that is not even JSON cannot be merged and is replaced; one of an unknown version is left alone.
        let latest;
        try { latest = raw ? validateBackup(JSON.parse(raw)) : emptyPersonal(); } catch (error) { if (!(error instanceof SyntaxError)) throw error; latest = emptyPersonal(); }
        const removed = new Set(baseline.favorites.filter(id => !personal.favorites.includes(id)));
        latest.favorites = [...new Set([...latest.favorites.filter(id => !removed.has(id)), ...personal.favorites.filter(id => !baseline.favorites.includes(id))])];
        for (const key of ['notes', 'statuses']) for (const [id, value] of Object.entries(personal[key])) if (value !== baseline[key][id]) latest[key][id] = value;
        latest.visits = P.mergeVisits(latest.visits, personal.visits, baseline.visits);
        for (const [id, value] of Object.entries(personal.tracked)) if (JSON.stringify(value) !== JSON.stringify(baseline.tracked[id])) latest.tracked[id] = value;
        if (personal.age !== baseline.age) latest.age = personal.age;
        if (personal.origin !== baseline.origin) latest.origin = personal.origin;
        if (overrides) {
          latest.favorites = [...new Set([...latest.favorites, ...overrides.favorites])];
          latest.notes = {...latest.notes, ...overrides.notes}; latest.statuses = {...latest.statuses, ...overrides.statuses};
          latest.visits = {...latest.visits, ...overrides.visits}; latest.tracked = {...latest.tracked, ...overrides.tracked};
          latest.age = overrides.age; latest.origin = overrides.origin;
        }
        for (const id of latest.favorites) if (!latest.tracked[id]) latest.tracked[id] = P.snapshot(byId.get(id), today());
        if (Object.keys(latest.visits).length > P.maxVisits) throw fail('visits.limit', 'Visit limit');
        storage.setItem(KEYS.family, JSON.stringify(latest));
        store.adopt(latest); store.storageAvailable = lasting; onSaved();
        return lasting;
      } catch (error) { if (error?.code !== 'visits.limit') store.storageAvailable = false; return false; }
    };

    // The Daycare records, saved the same way: this tab's changes (an application added, changed or removed, the commune) go into what is
    // stored now; `overrides` (an explicit backup import) replaces the matching applications and, when the file names one, the commune.
    store.saveChildcare = (overrides = null) => {
      const mine = store.childcare, base = store.childcareBaseline;
      try {
        let latest;
        try { latest = readChildcare(); } catch (error) { if (!(error instanceof SyntaxError) && error?.code !== 'backup.invalid') throw error; latest = emptyChildcare(); }
        for (const id of new Set([...Object.keys(mine.applications), ...Object.keys(base.applications)])) {
          if (JSON.stringify(mine.applications[id]) === JSON.stringify(base.applications[id])) continue;
          if (mine.applications[id]) latest.applications[id] = mine.applications[id]; else delete latest.applications[id];
        }
        if (mine.commune !== base.commune) latest.commune = mine.commune;
        if (overrides) { latest.applications = {...latest.applications, ...overrides.applications}; if (overrides.commune) latest.commune = overrides.commune; }
        storage.setItem(KEYS.childcare, JSON.stringify(latest));
        adoptChildcare(latest); store.storageAvailable = lasting;
        return lasting;
      } catch { store.storageAvailable = false; return false; }
    };
    store.reloadChildcare = () => { adoptChildcare(readChildcare()); return store.childcare; };
    // Corrections waiting for the family service.
    store.pendingCorrections = () => { try { const list = JSON.parse(storage.getItem(KEYS.corrections) || '[]'); return Array.isArray(list) ? list : []; } catch { return []; } };
    store.setPendingCorrections = list => storage.setItem(KEYS.corrections, JSON.stringify(list));
    // Connection to the family service.
    store.loadSync = () => { try { const saved = JSON.parse(storage.getItem(KEYS.sync) || 'null'); return saved && typeof saved.url === 'string' && typeof saved.token === 'string' ? saved : null; } catch { return null; } };
    store.saveSync = config => { try { if (config) storage.setItem(KEYS.sync, JSON.stringify(config)); else storage.removeItem(KEYS.sync); } catch {} };
    // The town chosen for distances: only a town name, kept in this browser apart from the family records (not in a backup, never
    // synced). A position from the browser's location service is never stored.
    store.loadNear = () => { try { const name = storage.getItem(KEYS.near); return typeof name === 'string' ? cleanOrigin(name) : ''; } catch { return ''; } };
    store.saveNear = name => { try { if (name) storage.setItem(KEYS.near, cleanOrigin(name)); else storage.removeItem(KEYS.near); } catch {} };
    store.hasFamilyData = value => Boolean(value.favorites.length || Object.keys(value.notes).length || Object.keys(value.statuses).length || Object.keys(value.visits).length);
    return store;
  }
  window.MinitandemStore = {create, KEYS, cleanOrigin, emptyPersonal, emptyChildcare};
})();
