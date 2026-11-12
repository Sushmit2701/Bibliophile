// Optional sign-in and sync, through your own Supabase project.
// This file is only loaded once you turn sync on in Settings → Account & sync. In personal mode
// (the default) the app never loads it and nothing leaves your device.
//
// How sync works: every book, passage, your settings and your review history is one row in the
// cloud. The app remembers a fingerprint of each row as last synced, so it can tell what changed
// on this device (including deletions) and send only that. Changes from your other devices come
// down the same way. If the same thing was changed on two devices, the later change wins.

import { db, save, onSave } from './store.js';
import { CLOUD } from './cloud-config.js';

const CFG_KEY = 'bibliophile:cloud-config';
const SESSION_KEY = 'bibliophile:cloud-session';
const STATE_KEY = 'bibliophile:cloud-state';
const PKCE_KEY = 'bibliophile:cloud-pkce';
const EPOCH = '1970-01-01T00:00:00.000Z';
const PAGE = 500;
// Settings that belong to this device only (your AI key never leaves the browser).
const LOCAL_SETTINGS = ['geminiKey', 'geminiUsage', 'geminiModels', 'geminiModel', 'geminiModelManual', 'spotifyLast', 'spotifyVolume'];

const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const write = (k, v) => (v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)));

// ---------- config ----------
export function config() {
  if (CLOUD.url && CLOUD.anonKey) return { url: CLOUD.url.replace(/\/+$/, ''), anonKey: CLOUD.anonKey, builtIn: true };
  const c = read(CFG_KEY);
  return c?.url && c?.anonKey ? { ...c, builtIn: false } : null;
}
export function setConfig(url, anonKey) {
  url = String(url || '').trim().replace(/\/+$/, '');
  anonKey = String(anonKey || '').trim();
  if (!url && !anonKey) { write(CFG_KEY, null); providers = null; emit(); return; }
  if (!/^https:\/\/[^/\s]+$/.test(url) && !/^http:\/\/localhost(:\d+)?$/.test(url)) throw new Error('The project URL should look like https://abcd1234.supabase.co');
  if (anonKey.length < 20) throw new Error('That key looks too short. Copy the "anon public" key from Project Settings → API Keys.');
  write(CFG_KEY, { url, anonKey });
  providers = null;
  emit();
}

// ---------- status (for the Settings page) ----------
const status = { syncing: false, error: '', guard: null, pendingEmail: read('bibliophile:cloud-email') || '' };
let listener = () => {};
const emit = () => listener();
export function onStatus(fn) { listener = fn; }
export function getStatus() {
  const s = session();
  const st = state();
  return {
    configured: !!config(), builtIn: !!config()?.builtIn,
    signedIn: !!s, email: s?.user?.email || '', lastSync: st?.lastSync || '',
    syncing: status.syncing, error: status.error, guard: status.guard,
    pendingEmail: status.pendingEmail, google: providers?.google ?? null,
  };
}

// Which sign-in methods the project has switched on (asked once, no account needed).
let providers = null;
export async function loadProviders() {
  const c = config();
  if (!c || providers) return providers;
  try {
    const r = await fetch(c.url + '/auth/v1/settings', { headers: { apikey: c.anonKey } });
    const j = await r.json();
    providers = { google: !!j.external?.google, email: j.external?.email !== false };
  } catch { providers = { google: false, email: true, offline: true }; }
  emit();
  return providers;
}

// ---------- auth ----------
const session = () => read(SESSION_KEY);
function storeSession(j) {
  const s = {
    access_token: j.access_token, refresh_token: j.refresh_token,
    expires_at: j.expires_at || Math.floor(Date.now() / 1000) + Number(j.expires_in || 3600),
    user: j.user ? { id: j.user.id, email: j.user.email } : session()?.user,
  };
  write(SESSION_KEY, s);
  return s;
}

async function authFetch(path, body, { query = '' } = {}) {
  const c = config();
  if (!c) throw new Error('Sync isn\'t set up yet.');
  let res;
  try {
    res = await fetch(`${c.url}/auth/v1/${path}${query}`, {
      method: 'POST', headers: { apikey: c.anonKey, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch { throw new Error('Couldn\'t reach your sync server. Check your connection.'); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(friendlyAuthError(j));
    e.status = res.status;
    throw e;
  }
  return j;
}
function friendlyAuthError(j) {
  const m = j.msg || j.message || j.error_description || j.error || '';
  if (/rate limit|too many|security purposes/i.test(m)) return 'Too many sign-in emails for now. Wait a minute and try again (or use Google).';
  if (/expired|invalid.*(otp|token)|otp.*(invalid|expired)/i.test(m)) return 'That code didn\'t work — it may have expired. Ask for a new one.';
  if (/signups? not allowed/i.test(m)) return 'New sign-ups are switched off for this project.';
  if (/provider is not enabled/i.test(m)) return 'That sign-in method isn\'t switched on in your Supabase project.';
  return m || 'Sign-in failed. Please try again.';
}

const redirectTo = () => location.origin + location.pathname + '?auth=cloud';

export async function sendEmailCode(email) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Please enter a valid email address.');
  await authFetch('otp', { email, create_user: true }, { query: '?redirect_to=' + encodeURIComponent(redirectTo()) });
  status.pendingEmail = email;
  write('bibliophile:cloud-email', email);
  emit();
}
export function cancelEmail() { status.pendingEmail = ''; write('bibliophile:cloud-email', null); emit(); }

export async function verifyEmailCode(code) {
  const token = String(code || '').replace(/\s/g, '');
  if (!/^\d{6,10}$/.test(token)) throw new Error('Enter the code from the email.');
  const j = await authFetch('verify', { type: 'email', email: status.pendingEmail, token });
  return signedIn(j);
}

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function signInWithGoogle() {
  const c = config();
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  sessionStorage.setItem(PKCE_KEY, verifier);
  location.href = `${c.url}/auth/v1/authorize?` + new URLSearchParams({
    provider: 'google', redirect_to: redirectTo(), code_challenge: challenge, code_challenge_method: 's256',
  });
}

// Back from Google (…?auth=cloud&code=…) or from the link in the sign-in email (#access_token=…).
export function isRedirect() {
  return new URLSearchParams(location.search).get('auth') === 'cloud' || /(^|[#&])(access_token|error_description)=/.test(location.hash);
}
export async function handleRedirect() {
  if (!isRedirect()) return null;
  const q = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  history.replaceState(null, '', location.pathname + '#/settings');
  const err = q.get('error_description') || h.get('error_description');
  if (err) return { ok: false, message: /expired|invalid/i.test(err) ? 'That sign-in link has expired — ask for a new one.' : err.replace(/\+/g, ' ') };
  if (h.get('access_token')) {
    const s = storeSession(Object.fromEntries(h));
    try { const u = await rest('/auth/v1/user'); storeSession({ ...s, user: u }); } catch { write(SESSION_KEY, null); return { ok: false, message: 'Sign-in failed. Please try again.' }; }
    return signedIn(session(), true);
  }
  if (q.get('code')) {
    const verifier = sessionStorage.getItem(PKCE_KEY);
    sessionStorage.removeItem(PKCE_KEY);
    if (!verifier) return { ok: false, message: 'Sign-in expired — please try again in the same browser.' };
    try { return signedIn(await authFetch('token', { auth_code: q.get('code'), code_verifier: verifier }, { query: '?grant_type=pkce' })); }
    catch (e) { return { ok: false, message: e.message }; }
  }
  return null;
}

function signedIn(j, stored = false) {
  const s = stored ? j : storeSession(j);
  const st = state();
  // A fresh start for this account on this device: everything here is merged with the cloud copy.
  if (!st || st.user !== s.user.id) write(STATE_KEY, { user: s.user.id, cursor: EPOCH, snap: {}, fields: {}, dirty: {}, first: true, lastSync: '' });
  cancelEmail();
  status.error = '';
  start();
  return { ok: true, email: s.user.email };
}

let refreshing = null;
async function accessToken(force = false) {
  const s = session();
  if (!s) throw new Error('Signed out');
  if (!force && s.expires_at * 1000 - 60000 > Date.now()) return s.access_token;
  refreshing ||= (async () => {
    // Only one tab refreshes at a time; refresh tokens can be used once.
    const run = async () => {
      const cur = session();
      if (!cur) throw new Error('Signed out');
      if (cur.access_token !== s.access_token && cur.expires_at * 1000 - 60000 > Date.now()) return cur.access_token;
      try {
        return storeSession(await authFetch('token', { refresh_token: cur.refresh_token }, { query: '?grant_type=refresh_token' })).access_token;
      } catch (e) {
        if (e.status === 400 || e.status === 401) { forget(); status.error = 'You were signed out. Please sign in again to keep syncing.'; emit(); }
        throw e;
      }
    };
    return navigator.locks ? navigator.locks.request('bibliophile-cloud-auth', run) : run();
  })().finally(() => { refreshing = null; });
  return refreshing;
}

async function rest(path, { method = 'GET', body, headers = {} } = {}, retried = false) {
  const c = config();
  const token = await accessToken();
  let res;
  try {
    res = await fetch(c.url + path, {
      method,
      headers: { apikey: c.anonKey, authorization: 'Bearer ' + token, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { const e = new Error('offline'); e.offline = true; throw e; }
  if (res.status === 401 && !retried) { await accessToken(true); return rest(path, { method, body, headers }, true); }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const e = new Error(j.message || j.msg || `Server said ${res.status}`);
    e.status = res.status; e.code = j.code;
    throw e;
  }
  return res.status === 204 || res.status === 201 ? null : res.json().catch(() => null);
}

function forget() {
  stop();
  write(SESSION_KEY, null);
  write(STATE_KEY, null);
}

export async function signOut({ sendLast = true } = {}) {
  if (sendLast) await syncNow().catch(() => {}); // send any last changes first
  const s = session();
  if (s) {
    const c = config();
    fetch(c.url + '/auth/v1/logout?scope=local', { method: 'POST', headers: { apikey: c.anonKey, authorization: 'Bearer ' + s.access_token } }).catch(() => {});
  }
  forget();
  status.error = ''; status.guard = null;
  emit();
}

export async function deleteCloudCopy() {
  const s = session();
  await running?.catch(() => {});
  await rest('/rest/v1/records?user_id=eq.' + encodeURIComponent(s.user.id), { method: 'DELETE' });
  await signOut({ sendLast: false });
}

export async function deleteAccount() {
  await running?.catch(() => {});
  await rest('/rest/v1/rpc/delete_my_account', { method: 'POST', body: {} });
  forget();
  status.error = ''; status.guard = null;
  emit();
}

// ---------- the library as rows ----------
// Fingerprints use sorted keys, because the database stores JSON with its keys in its own order.
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}
function hash(v) { // cyrb53
  const str = canon(v);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}
const syncedSettings = () => Object.fromEntries(Object.entries(db.settings).filter(([k]) => !LOCAL_SETTINGS.includes(k)));
function rows() {
  const m = new Map();
  for (const b of db.books) m.set('book:' + b.id, b);
  for (const i of db.items) m.set('item:' + i.id, i);
  m.set('settings:main', syncedSettings());
  m.set('reviewLog:main', db.reviewLog || {});
  return m;
}
const state = () => read(STATE_KEY);

// Books and settings are merged field by field, so a rating changed on your phone and a cover found
// on your laptop for the same book both survive. For that, the app keeps a short fingerprint of each
// field as last synced.
const MERGED = new Set(['book', 'settings']);
const fieldHashes = (v) => Object.fromEntries(Object.keys(v || {}).filter((f) => v[f] !== undefined).map((f) => [f, hash(v[f]).slice(0, 6)]));
const kindOf = (k) => k.slice(0, k.indexOf(':'));
function remember(st, k, v) {
  if (v === undefined || v === null) { delete st.snap[k]; delete st.fields[k]; return; }
  st.snap[k] = hash(v);
  if (MERGED.has(kindOf(k))) st.fields[k] = fieldHashes(v); else delete st.fields[k];
}

// Notice what changed on this device since the last sync. Each change keeps the time it was last made.
function markDirty() {
  const st = state();
  if (!st || !session()) return;
  st.fields ||= {};
  const now = new Date().toISOString();
  const cur = rows();
  for (const [k, v] of cur) {
    const h = hash(v), d = st.dirty[k];
    if (st.snap[k] === h) { delete st.dirty[k]; continue; }
    if (d && d.h === h) continue; // already noted
    // On the first sync, a record's own timestamp decides whether it or the cloud copy is newer.
    const at = !d && st.first && st.snap[k] === undefined ? (v.updatedAt || v.createdAt || EPOCH) : now;
    st.dirty[k] = { at, h };
  }
  for (const k of Object.keys(st.snap)) if (!cur.has(k) && st.dirty[k]?.h !== null) st.dirty[k] = { at: now, h: null }; // deleted here
  for (const k of Object.keys(st.dirty)) if (!cur.has(k) && st.snap[k] === undefined) delete st.dirty[k];
  write(STATE_KEY, st);
}

// ---------- sync ----------
let running = null;
export function syncNow({ allowDeletes = false } = {}) {
  if (!session() || !config()) return Promise.resolve();
  running ||= doSync(allowDeletes).finally(() => { running = null; });
  return running;
}

async function doSync(allowDeletes) {
  status.syncing = true; emit();
  try {
    markDirty();
    const changed = await pull();
    await push(allowDeletes);
    const st = state();
    if (st) { st.first = false; delete st.preferCloud; st.lastSync = new Date().toISOString(); write(STATE_KEY, st); }
    status.error = '';
    if (changed.length) onPulledFn(changed);
  } catch (e) {
    if (!session()) return; // signed out meanwhile
    status.error = e.offline ? 'Offline — changes will sync when you\'re back online.'
      : e.code === '42P01' || e.code === 'PGRST205' ? 'The sync table is missing. Run supabase/schema.sql in your project\'s SQL Editor.'
      : e.message;
  } finally {
    status.syncing = false; emit();
  }
}

// Combine this device's version with the cloud's, field by field, using the last-synced fingerprints.
function mergeFields(local, remote, base, localAt, remoteAt) {
  const out = {};
  const localNewer = new Date(localAt) > new Date(remoteAt);
  for (const f of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const lh = local[f] === undefined ? undefined : hash(local[f]).slice(0, 6);
    const rh = remote[f] === undefined ? undefined : hash(remote[f]).slice(0, 6);
    let pick;
    if (lh === rh || rh === base[f]) pick = local[f];      // same, or only changed here
    else if (lh === base[f]) pick = remote[f];             // only changed on the other device
    else pick = localNewer ? local[f] : remote[f];         // changed on both: the later change wins
    if (pick !== undefined) out[f] = pick;
  }
  return out;
}

async function pull() {
  const st = state();
  st.fields ||= {};
  const since = new Date(new Date(st.cursor).getTime() - 5000).toISOString(); // small overlap, for safety
  const cur = rows();
  let cursor = st.cursor, changed = [], touched = false;
  for (let offset = 0; ; offset += PAGE) {
    const page = await rest(`/rest/v1/records?select=kind,id,data,deleted,client_at,updated_at&updated_at=gt.${encodeURIComponent(since)}&order=updated_at.asc,kind.asc,id.asc&limit=${PAGE}&offset=${offset}`);
    for (const r of page) {
      const k = r.kind + ':' + r.id;
      if (new Date(r.updated_at) > new Date(cursor)) cursor = r.updated_at;
      const remote = r.deleted ? undefined : r.data;
      if (r.kind === 'reviewLog') {
        // Review history is merged, never overwritten.
        if (remote) for (const [d, n] of Object.entries(remote)) if ((db.reviewLog[d] || 0) < n) { db.reviewLog[d] = n; touched = true; }
        remember(st, k, remote);
        continue;
      }
      const h = remote === undefined ? undefined : hash(remote);
      if (st.snap[k] === h) continue; // nothing new from the cloud
      const mine = st.dirty[k];
      let value = remote;
      if (mine && !st.preferCloud) {
        const local = cur.get(k);
        if (MERGED.has(r.kind) && local && remote && st.fields[k]) value = mergeFields(local, remote, st.fields[k], mine.at, r.client_at);
        else if (new Date(mine.at) > new Date(r.client_at)) { remember(st, k, remote); continue; } // ours is newer and goes up next
      }
      const before = r.kind === 'book' ? db.books.find((x) => x.id === r.id) : null;
      if (apply(r.kind, r.id, value)) {
        touched = true;
        if (r.kind === 'book') changed.push({ id: r.id, deleted: value === undefined, isNew: !before, coverChanged: !!before && !!value && (before.cover || '') !== (value.cover || '') });
      }
      remember(st, k, remote);
      const now = apply.result;
      if ((now === undefined ? undefined : hash(now)) === h) delete st.dirty[k];
      else if (mine) st.dirty[k] = { at: new Date(mine.at) > new Date(r.client_at) ? mine.at : r.client_at, h: hash(now) }; // the merged version goes up next
    }
    if (page.length < PAGE) break;
  }
  st.cursor = cursor;
  write(STATE_KEY, st);
  if (touched) save(); // redraws the page; the save hook then sees nothing new to send
  return changed;
}

// Put a record from the cloud into the library. Remembers what the record looks like now in apply.result.
function apply(kind, id, value) {
  apply.result = value;
  if (kind === 'settings') {
    if (!value) { apply.result = syncedSettings(); return false; }
    for (const [k, v] of Object.entries(value)) if (!LOCAL_SETTINGS.includes(k)) db.settings[k] = v;
    for (const k of Object.keys(syncedSettings())) if (!(k in value)) delete db.settings[k];
    apply.result = syncedSettings();
    return true;
  }
  const list = kind === 'book' ? db.books : kind === 'item' ? db.items : null;
  if (!list) return false;
  const i = list.findIndex((x) => x.id === id);
  if (value === undefined) { if (i < 0) return false; list.splice(i, 1); return true; }
  if (i < 0) list.push(value); else if (list[i] === value) return false; else list[i] = value;
  return true;
}

async function push(allowDeletes) {
  const st = state();
  const cur = rows();
  const keys = Object.keys(st.dirty);
  if (!keys.length) return;
  // Safety catch: if this device is about to delete a large part of your library at once (for example
  // because its browser storage was cleared), stop and ask before touching the cloud copy.
  const deletes = keys.filter((k) => !cur.has(k) && /^(book|item):/.test(k)).length;
  const total = Object.keys(st.snap).filter((k) => /^(book|item):/.test(k)).length;
  if (!allowDeletes && deletes > 10 && deletes > total * 0.3) {
    status.guard = { deletes, total };
    throw new Error(`Paused: this device would delete ${deletes} of ${total} books and passages from all your devices.`);
  }
  status.guard = null;
  const user = session().user.id;
  for (let i = 0; i < keys.length; i += 200) {
    const batch = keys.slice(i, i + 200).map((k) => {
      const kind = kindOf(k), v = cur.get(k);
      return { k, v, h: v ? hash(v) : undefined, row: { user_id: user, kind, id: k.slice(kind.length + 1), data: v ?? null, deleted: !v, client_at: st.dirty[k].at } };
    });
    await rest('/rest/v1/records?on_conflict=user_id,kind,id', {
      method: 'POST', body: batch.map((b) => b.row), headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    });
    const now = rows();
    for (const b of batch) {
      remember(st, b.k, b.v && JSON.parse(JSON.stringify(b.v)));
      const v = now.get(b.k);
      if ((v ? hash(v) : undefined) === b.h) delete st.dirty[b.k]; // unchanged while sending
    }
    write(STATE_KEY, st);
  }
}

// The cloud copy wins every difference; things that exist only on this device are kept and sent up.
export async function restoreFromCloud() {
  await running?.catch(() => {});
  write(STATE_KEY, { ...state(), cursor: EPOCH, snap: {}, fields: {}, dirty: {}, first: false, preferCloud: true });
  status.guard = null;
  return syncNow();
}

// ---------- running in the background ----------
let timer = null, interval = null, started = false;
let onPulledFn = () => {};
export function init({ onChange, onPulled } = {}) {
  if (onChange) listener = onChange;
  if (onPulled) onPulledFn = onPulled;
  if (session()) start();
}
function start() {
  if (started) { syncNow(); return; }
  started = true;
  onSave(() => {
    if (!session()) return;
    markDirty();
    clearTimeout(timer);
    timer = setTimeout(() => syncNow(), 2500);
  });
  interval = setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 60000);
  window.addEventListener('online', onWake);
  document.addEventListener('visibilitychange', onWake);
  syncNow();
}
function onWake() { if (document.visibilityState === 'visible' && navigator.onLine !== false) syncNow(); }
function stop() {
  clearTimeout(timer);
  // The save hook stays registered but does nothing while signed out.
}
