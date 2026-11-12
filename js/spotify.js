// Spotify Premium in the reading room.
//
// Uses your own free Spotify "developer app" (Settings → Spotify) and Spotify's sign-in for apps
// without a server (Authorization Code with PKCE). The sign-in tokens stay in this browser only and
// are never put in backups. Music plays either right here in the browser (Web Playback SDK — on a
// computer) or on another device that's running Spotify, like your phone (Spotify Connect).
import { db, save } from './store.js';

const AUTH = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const TOKENS = 'bibliophile:spotify';
const SCOPES = 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative';

export const redirectUri = () => location.origin + location.pathname;
export const clientId = () => (db.settings.spotifyClientId || '').trim();

const readTokens = () => { try { return JSON.parse(localStorage.getItem(TOKENS) || 'null'); } catch { return null; } };
const writeTokens = (t) => { try { t ? localStorage.setItem(TOKENS, JSON.stringify(t)) : localStorage.removeItem(TOKENS); } catch {} };
export const isConnected = () => !!readTokens()?.refresh;

// ---------- sign in (PKCE) ----------
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function randomString(n = 64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => chars[x % chars.length]).join('');
}

export async function connect() {
  if (!clientId()) throw new Error('Add your Spotify Client ID first (Settings → Spotify).');
  const verifier = randomString(64);
  const state = randomString(16);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  sessionStorage.setItem('bibliophile:spotify-pkce', JSON.stringify({ verifier, state, back: location.hash || '#/timer' }));
  const u = new URL(AUTH + '/authorize');
  Object.entries({ response_type: 'code', client_id: clientId(), scope: SCOPES, redirect_uri: redirectUri(), state, code_challenge_method: 'S256', code_challenge: challenge })
    .forEach(([k, v]) => u.searchParams.set(k, v));
  location.assign(u.toString());
}

// Called once at start-up: finishes the sign-in when Spotify sends you back here.
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (q.get('auth') === 'cloud') return null; // that's the sync sign-in coming back, not Spotify
  if (!q.has('code') && !q.has('error')) return null;
  const saved = JSON.parse(sessionStorage.getItem('bibliophile:spotify-pkce') || 'null');
  sessionStorage.removeItem('bibliophile:spotify-pkce');
  const back = saved?.back || '#/timer';
  history.replaceState(null, '', location.pathname + back);
  if (q.get('error')) return { ok: false, message: q.get('error') === 'access_denied' ? 'Spotify sign-in was cancelled.' : `Spotify said: ${q.get('error')}` };
  if (!saved || saved.state !== q.get('state')) return { ok: false, message: 'Spotify sign-in expired — please try again.' };
  const res = await fetch(AUTH + '/api/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: redirectUri(), client_id: clientId(), code_verifier: saved.verifier }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, message: data.error_description || 'Spotify sign-in failed.' };
  writeTokens({ access: data.access_token, refresh: data.refresh_token, exp: Date.now() + (data.expires_in - 60) * 1000 });
  return { ok: true };
}

let refreshing = null;
async function refresh() {
  const t = readTokens();
  if (!t?.refresh) throw new Error('Not connected to Spotify.');
  refreshing ||= (async () => {
    const res = await fetch(AUTH + '/api/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: clientId() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { if (data.error === 'invalid_grant') writeTokens(null); throw new Error('Spotify sign-in has expired — connect again.'); }
    writeTokens({ access: data.access_token, refresh: data.refresh_token || t.refresh, exp: Date.now() + (data.expires_in - 60) * 1000 });
  })().finally(() => { refreshing = null; });
  return refreshing;
}
async function token() {
  const t = readTokens();
  if (!t) throw new Error('Not connected to Spotify.');
  if (Date.now() > t.exp) await refresh();
  return readTokens().access;
}

export function disconnect() {
  writeTokens(null);
  try { player?.disconnect(); } catch {}
  player = null; deviceId = null; sdkState = 'idle';
}

async function api(path, opts = {}, retry = true) {
  const res = await fetch(API + path, { ...opts, headers: { authorization: 'Bearer ' + (await token()), 'content-type': 'application/json', ...(opts.headers || {}) } });
  if (res.status === 401 && retry) { await refresh(); return api(path, opts, false); }
  if (res.status === 204 || res.status === 202) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.message || `Spotify error ${res.status}`;
    if (res.status === 403 && /premium/i.test(msg)) throw new Error('Playing music from other apps needs Spotify Premium.');
    if (res.status === 403) throw new Error('Spotify refused — check that your account is added under User Management in your Spotify developer app.');
    if (res.status === 404 && /device/i.test(msg)) throw new Error('No Spotify device found — open Spotify on your phone or computer, then try again.');
    if (res.status === 429) throw new Error('Spotify is limiting requests right now — try again in a minute.');
    throw new Error(msg);
  }
  return data;
}

// ---------- playing in this browser (Web Playback SDK) ----------
let player = null, deviceId = null, sdkState = 'idle', lastState = null, fromBrowser = false;
const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn());
export const status = () => ({ sdkState, deviceId, state: lastState });

export function startBrowserPlayer() {
  if (player || sdkState === 'loading') return;
  sdkState = 'loading'; emit();
  window.onSpotifyWebPlaybackSDKReady = () => {
    player = new window.Spotify.Player({ name: 'Bibliophile · Reading room', getOAuthToken: (cb) => token().then(cb).catch(() => {}), volume: (db.settings.spotifyVolume ?? 60) / 100 });
    player.addListener('ready', ({ device_id }) => { deviceId = device_id; sdkState = 'ready'; emit(); });
    player.addListener('not_ready', () => { sdkState = 'offline'; emit(); });
    player.addListener('player_state_changed', (s) => { lastState = s ? fromSdk(s) : null; fromBrowser = !!lastState; emit(); });
    player.addListener('initialization_error', () => { sdkState = 'unsupported'; emit(); });   // e.g. phone browsers
    player.addListener('authentication_error', () => { sdkState = 'auth'; emit(); });
    player.addListener('account_error', () => { sdkState = 'premium'; emit(); });
    player.connect();
  };
  if (window.Spotify?.Player) window.onSpotifyWebPlaybackSDKReady();
  else if (!document.querySelector('script[data-spotify-sdk]')) {
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js'; s.async = true; s.dataset.spotifySdk = '1';
    s.onerror = () => { sdkState = 'unsupported'; emit(); };
    document.head.appendChild(s);
  }
}
const fromSdk = (s) => {
  const t = s.track_window?.current_track;
  return t ? { name: t.name, artists: t.artists.map((a) => a.name).join(', '), art: t.album?.images?.[0]?.url || '', paused: s.paused, context: s.context?.metadata?.name || '' } : null;
};
const fromApi = (p) => {
  const t = p?.item;
  return t ? { name: t.name, artists: (t.artists || []).map((a) => a.name).join(', '), art: t.album?.images?.[0]?.url || '', paused: !p.is_playing, device: p.device?.name || '' } : null;
};

// ---------- library + playback ----------
export async function playlists() {
  const d = await api('/me/playlists?limit=30');
  return (d?.items || []).filter(Boolean).map((p) => ({ uri: p.uri, name: p.name, image: p.images?.[0]?.url || '', count: p.tracks?.total ?? p.items?.total ?? 0 }));
}
export async function searchPlaylists(q = 'reading') {
  const d = await api(`/search?type=playlist&limit=10&q=${encodeURIComponent(q)}`);
  return (d?.playlists?.items || []).filter(Boolean).map((p) => ({ uri: p.uri, name: p.name, image: p.images?.[0]?.url || '', owner: p.owner?.display_name || '' }));
}
export async function devices() {
  const d = await api('/me/player/devices');
  return (d?.devices || []).map((x) => ({ id: x.id, name: x.name, type: x.type, active: x.is_active }));
}
// Turn a pasted Spotify link (or URI) into a URI.
export function toUri(text) {
  const s = String(text || '').trim();
  if (/^spotify:(playlist|album|track|artist|show|episode):[A-Za-z0-9]+$/.test(s)) return s;
  const m = s.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(playlist|album|track|artist|show|episode)\/([A-Za-z0-9]+)/);
  return m ? `spotify:${m[1]}:${m[2]}` : '';
}

export async function play(uri, targetDevice) {
  const id = targetDevice || deviceId;
  if (player && id === deviceId) { try { await player.activateElement?.(); } catch {} }
  const body = uri ? (/^spotify:(track|episode):/.test(uri) ? { uris: [uri] } : { context_uri: uri }) : undefined;
  await api(`/me/player/play${id ? `?device_id=${id}` : ''}`, { method: 'PUT', body: body ? JSON.stringify(body) : undefined });
  db.settings.spotifyLast = uri || db.settings.spotifyLast; save({ quiet: true });
  setTimeout(refreshNowPlaying, 900);
}
const inBrowser = () => player && sdkState === 'ready' && fromBrowser;
export async function pause() { if (inBrowser()) return player.pause(); return api('/me/player/pause', { method: 'PUT' }).catch(() => {}); }
export async function resume() { if (inBrowser()) return player.resume(); return api('/me/player/play', { method: 'PUT' }).catch(() => {}); }
export async function next() { await api('/me/player/next', { method: 'POST' }); setTimeout(refreshNowPlaying, 700); }
export async function previous() { await api('/me/player/previous', { method: 'POST' }); setTimeout(refreshNowPlaying, 700); }
export async function setVolume(pct) {
  db.settings.spotifyVolume = pct; save({ quiet: true });
  if (inBrowser()) return player.setVolume(pct / 100);
  return api(`/me/player/volume?volume_percent=${Math.round(pct)}`, { method: 'PUT' }).catch(() => {});
}
export async function refreshNowPlaying() {
  try {
    const p = await api('/me/player');
    // Music in this browser reports itself; only take Spotify's answer for other devices.
    if (p && p.device?.id && p.device.id !== deviceId) { lastState = fromApi(p); fromBrowser = false; }
    else if (!p && !fromBrowser) lastState = null;
    emit();
  } catch {}
}
export const isPlaying = () => !!lastState && !lastState.paused;
