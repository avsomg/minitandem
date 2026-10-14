/* One-time move of the visitor's data from the browser storage keys of the earlier version to the Minitandem keys.
   This is the only file in which the old key names may appear. Run it once on load, before anything reads the new keys.
   A value is copied only when the new key is still empty, and the old key is removed only after the copy succeeded, so a
   full or blocked storage loses nothing. */
(() => {
  'use strict';
  const LOCAL_KEYS = [
    ['vmeste-family-v1', 'minitandem-family-v1'],
    ['vmeste-sync-v1', 'minitandem-sync-v1'],
    ['vmeste-pending-corrections-v1', 'minitandem-pending-corrections-v1']
  ];
  // Session filters used another layout and the one-off announcement is gone: both are simply removed.
  const LOCAL_DROPPED = ['vmeste-family-v1-announcement-dining-2026-09-27'];
  const SESSION_DROPPED = ['vmeste-family-v1-filters'];
  function run(local, session) {
    const result = {migrated: [], kept: [], failed: [], removed: []};
    for (const [from, to] of LOCAL_KEYS) {
      try {
        const old = local.getItem(from);
        if (old === null || old === undefined) continue;
        const current = local.getItem(to);
        if (current === null || current === undefined) {
          local.setItem(to, old);
          if (local.getItem(to) !== old) { result.failed.push(from); continue; }
          result.migrated.push(to);
        } else result.kept.push(to);
        local.removeItem(from);
      } catch { result.failed.push(from); }
    }
    for (const [storage, keys] of [[local, LOCAL_DROPPED], [session, SESSION_DROPPED]]) {
      for (const key of keys) try { if (storage && storage.getItem(key) !== null) { storage.removeItem(key); result.removed.push(key); } } catch {}
    }
    return result;
  }
  window.MinitandemMigration = {run, LOCAL_KEYS, LOCAL_DROPPED, SESSION_DROPPED};
})();
