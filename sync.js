/* Optional sync of the visitor's own records with the family service (a small server the family runs). Off unless the
   visitor connects it. The wording of every state is left to the interface: this module only reports codes through
   onStatus: '' (not connected), 'waiting', 'syncing', 'saved', 'conflict', 'badKey', 'offline'. */
(() => {
  'use strict';
  const LOCAL_HOSTS = ['localhost', '127.0.0.1'];
  function endpoint(raw, hostname) {
    let url;
    try { url = new URL(raw); } catch { throw Object.assign(Error('Enter only the address of the service.'), {code: 'sync.addressOnly'}); }
    const local = LOCAL_HOSTS.includes(hostname) && LOCAL_HOSTS.includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw Object.assign(Error('HTTPS is required.'), {code: 'sync.needHttps'});
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.href.length > 300) throw Object.assign(Error('Enter the address only.'), {code: 'sync.addressOnly'});
    return url.origin;
  }
  function create({store, fetchFn = (...args) => fetch(...args), onStatus = () => {}, onConflict = () => {}, onApplied = () => {}, onCorrectionsSent = () => {},
    isOnline = () => navigator.onLine, setTimer = setTimeout, clearTimer = clearTimeout}) {
    const enabled = window.MINITANDEM_FEATURES?.familySync === true;
    let config = enabled ? store.loadSync() : null, busy = false, timer = null, conflict = null, generation = 0;
    let dirty = Boolean(config?.dirty);
    const save = () => store.saveSync(config);
    const status = code => onStatus(config ? code : '');

    async function request(path, method = 'GET', payload) {
      if (!enabled) throw Object.assign(Error('Family sync is disabled.'), {code:'sync.disabled'});
      const response = await fetchFn(config.url + path, {method, cache: 'no-store', headers: {Authorization: 'Bearer ' + config.token, ...(payload ? {'Content-Type': 'application/json'} : {})}, body: payload ? JSON.stringify(payload) : undefined});
      const data = await response.json();
      if (!response.ok) throw Object.assign(Error(data.error || 'Service unavailable'), {status: response.status, remote: data});
      return data;
    }
    function useRemote(profile, revision) {
      const next = store.validateBackup(profile);
      store.writeProfile(next);
      config.revision = revision; config.dirty = false; dirty = false; save();
      onApplied(); status('saved');
    }
    function showConflict(remote) { conflict = remote; status('conflict'); onConflict(remote); }
    async function flushCorrections() {
      if (!config) return;
      const queue = store.pendingCorrections();
      if (!queue.length) return;
      let sent = 0;
      for (const report of queue) { try { await request('/api/v1/corrections', 'POST', report); sent++; } catch { break; } }
      // Read the queue again: a correction may have been added while the others were being sent.
      if (sent) { store.setPendingCorrections(store.pendingCorrections().slice(sent)); onCorrectionsSent(sent); }
    }
    async function put(revision, cfg, gen) {
      const saved = await request('/api/v1/family', 'PUT', {revision, profile: store.personal});
      if (config !== cfg) return false;
      config.revision = saved.revision; dirty = generation !== gen; config.dirty = dirty; save();
      return true;
    }
    async function now() {
      if (!config || busy || conflict || !isOnline()) return;
      busy = true; status('syncing');
      const gen = generation, cfg = config;
      try {
        const remote = await request('/api/v1/family');
        if (config !== cfg) return;
        if (remote.profile === null) { if (await put(remote.revision, cfg, gen)) status(dirty ? 'waiting' : 'saved'); }
        else if (config.revision === null) { if (store.hasFamilyData(store.personal)) showConflict(remote); else useRemote(remote.profile, remote.revision); }
        else if (remote.revision !== config.revision) { if (dirty) showConflict(remote); else useRemote(remote.profile, remote.revision); }
        else if (dirty) { if (await put(remote.revision, cfg, gen)) status(dirty ? 'waiting' : 'saved'); }
        else status('saved');
        if (!conflict) await flushCorrections();
      } catch (error) {
        if (config !== cfg) return;
        // Another device saved between the check and the upload: that is a conflict to choose from, not a lost connection.
        if (error.status === 409 && error.remote && error.remote.profile !== undefined) showConflict(error.remote);
        else status(error.status === 401 ? 'badKey' : 'offline');
      }
      finally { busy = false; if (dirty && !conflict && isOnline() && generation !== gen) { clearTimer(timer); timer = setTimer(now, 1500); } }
    }
    function queue() { if (!config) return; generation++; dirty = true; config.dirty = true; save(); status('waiting'); clearTimer(timer); timer = setTimer(now, 900); }
    function connect(rawUrl, token) {
      if (!enabled) throw Object.assign(Error('Family sync is disabled.'), {code:'sync.disabled'});
      const url = endpoint(rawUrl.trim(), typeof location !== 'undefined' ? location.hostname : '');
      token = token.trim();
      if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) throw Object.assign(Error('Check the family key.'), {code: 'sync.badKeyFormat'});
      const same = config?.url === url && config?.token === token;
      config = {url, token, revision: same ? config.revision : null, dirty: same ? config.dirty : false};
      dirty = Boolean(config.dirty); conflict = null; save();
      return now();
    }
    function disconnect() { config = null; conflict = null; dirty = false; save(); status(''); }
    function retry() { conflict = null; return now(); }
    async function takeRemote() {
      if (!conflict) return;
      const cfg = config, gen = generation, expected = conflict.revision;
      try {
        const remote = await request('/api/v1/family');
        if (config !== cfg || !conflict) return;
        if (remote.revision !== expected || generation !== gen) { showConflict(remote); return; }
        useRemote(remote.profile, remote.revision); conflict = null;
        return 'applied';
      } catch (error) { throw error; }
    }
    async function keepLocal() {
      if (!conflict) return;
      const cfg = config, gen = generation;
      try {
        if (!await put(conflict.revision, cfg, gen)) return;
        conflict = null; status(dirty ? 'waiting' : 'saved');
        if (dirty) now();
        return 'applied';
      } catch (error) { if (config !== cfg) return; if (error.status === 409) { showConflict(error.remote); return; } throw error; }
    }
    return {get config() { return config; }, get conflict() { return conflict; }, endpoint, now, queue, connect, disconnect, retry, takeRemote, keepLocal, flushCorrections, request,
      init() { status(config ? (dirty ? 'waiting' : 'syncing') : ''); if (config) setTimer(now, 400); }};
  }
  window.MinitandemSync = {create, endpoint};
})();
