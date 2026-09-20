/* ===================================================================
   sync.js — shares app state between coaches by storing it as a JSON
   file in this app's own GitHub repo. Reads use raw.githubusercontent.com
   (no auth, works for any viewer); writes use the Contents API with a
   fine-grained token each editing coach keeps in their own browser.
   No DOM code here; ui.js renders status. Depends on model.js (Store).
   =================================================================== */

const Sync = (() => {
  const CFG_KEY = 'rockiesSyncConfig_v1';
  const DEFAULT_CFG = { owner: 'kevintcarlberg', repo: 'fall-rockies-lineup', branch: 'master', path: 'data/state.json', token: '' };
  const PUSH_DEBOUNCE_MS = 600;
  const POLL_MS = 10000;

  function getConfig() {
    try { return Object.assign({}, DEFAULT_CFG, JSON.parse(localStorage.getItem(CFG_KEY) || '{}')); }
    catch (e) { return Object.assign({}, DEFAULT_CFG); }
  }
  function saveConfig(partial) {
    const cfg = Object.assign({}, getConfig(), partial);
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    return cfg;
  }
  function hasToken() { return !!getConfig().token; }

  function rawUrl(cfg) { return `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${cfg.branch}/${cfg.path}?t=${Date.now()}`; }
  function apiUrl(cfg) { return `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.path}`; }

  /* ---------- status ---------- */
  let status = 'idle', lastError = '', lastSyncedAt = null;
  const listeners = [];
  function snapshot() { return { status, lastError, lastSyncedAt }; }
  function setStatus(s, err) {
    status = s; lastError = err || '';
    if (s === 'synced') lastSyncedAt = Date.now();
    listeners.forEach(fn => fn(snapshot()));
  }
  function onStatus(fn) { listeners.push(fn); fn(snapshot()); }

  /* ---------- read ---------- */
  function looksLikeState(x) { return !!x && typeof x === 'object' && Array.isArray(x.roster) && Array.isArray(x.games); }

  // quiet = background poll: don't flash the "checking…" status every few seconds.
  async function pull(quiet) {
    const cfg = getConfig();
    if (!quiet) setStatus('pulling');
    try {
      const res = await fetch(rawUrl(cfg), { cache: 'no-store' });
      if (res.status === 404) { setStatus('idle'); return null; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const remote = await res.json();
      if (!looksLikeState(remote)) throw new Error('shared file is not valid lineup data');
      setStatus('synced');
      return remote;
    } catch (e) {
      setStatus('error', e.message || String(e));
      return null;
    }
  }

  /* ---------- write ---------- */
  async function fetchSha(cfg) {
    const res = await fetch(apiUrl(cfg) + '?ref=' + encodeURIComponent(cfg.branch), {
      headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github+json' }
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('HTTP ' + res.status + ' reading file info (bad token or wrong repo?)');
    return (await res.json()).sha;
  }

  function toBase64(str) { return btoa(unescape(encodeURIComponent(str))); }

  async function pushOnce(cfg, state, retried) {
    const sha = await fetchSha(cfg);
    const body = {
      message: 'Lineup update — ' + new Date().toISOString(),
      content: toBase64(JSON.stringify(state, null, 2)),
      branch: cfg.branch
    };
    if (sha) body.sha = sha;
    const res = await fetch(apiUrl(cfg), {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    // 409 = someone else committed between our sha read and our write; re-read once and retry.
    if (res.status === 409 && !retried) return pushOnce(cfg, state, true);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || ('HTTP ' + res.status));
    }
  }

  let pushing = false, pushQueued = false, pushTimer = null;

  async function push() {
    const cfg = getConfig();
    if (!cfg.token) { setStatus('no-token'); return; }
    if (pushing) { pushQueued = true; return; }
    pushing = true;
    setStatus('pushing');
    try {
      await pushOnce(cfg, Store.get());
      setStatus('synced');
    } catch (e) {
      setStatus('error', e.message || String(e));
    } finally {
      pushing = false;
      if (pushQueued) { pushQueued = false; push(); }
    }
  }

  function schedulePush() {
    if (!hasToken()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, PUSH_DEBOUNCE_MS);
  }

  /* ---------- reconcile ---------- */
  let onRemoteApplied = null;

  async function syncOnce(isInitial) {
    const cfg = getConfig();
    const remote = await pull(!isInitial);
    const local = Store.get();
    if (remote) {
      if ((remote.updatedAt || 0) > (local.updatedAt || 0)) {
        Store.replaceAll(remote);
        if (onRemoteApplied) onRemoteApplied();
      } else if (isInitial && cfg.token && (local.updatedAt || 0) > (remote.updatedAt || 0)) {
        push();
      }
    } else if (isInitial && cfg.token && status !== 'error') {
      push(); // no shared file yet — seed it from this browser
    }
  }

  let pollTimer = null;
  function init(callback) {
    onRemoteApplied = callback;
    syncOnce(true);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (document.visibilityState === 'visible') syncOnce(false); }, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncOnce(false); });
  }

  return { getConfig, saveConfig, hasToken, pull, push, schedulePush, syncOnce, onStatus, init };
})();

// Every local edit goes through Store.save(); piggyback on it so edits publish
// without touching each call site. replaceAll() (imports / applying remote
// data) deliberately bypasses save(), so it never echoes back to GitHub.
(() => {
  const origSave = Store.save;
  Store.save = function () { origSave(); Sync.schedulePush(); };
})();
