// Reading-room sound: calming sounds (made live in the browser), free radio, and Spotify.
// The panel lives outside the page area that redraws, so music never restarts when the app updates.
import { db, save } from './store.js';
import * as Sp from './spotify.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = () => (db.settings.sound ||= { tab: 'calm', mix: {}, followTimer: true, radioVolume: 70, favourites: [] });
const remember = () => save({ quiet: true });

// ==========================================================================
// Calming sounds — synthesised with the Web Audio API (free, offline, endless)
// ==========================================================================
let ctx = null, master = null;
const voices = {}; // name -> { gain, stop() }
function audio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 1; master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
const buffers = {};
function noise(kind) {
  if (buffers[kind]) return buffers[kind];
  const len = ctx.sampleRate * 4, buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') d[i] = w * 0.5;
      else if (kind === 'pink') { // Paul Kellet's filter
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
      } else { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } // brown
    }
  }
  return (buffers[kind] = buf);
}
function src(kind) { const s = ctx.createBufferSource(); s.buffer = noise(kind); s.loop = true; s.loopStart = Math.random(); s.start(0, Math.random() * 3); return s; }
function filt(type, freq, q = 0.7) { const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; return f; }
function lfo(rate, depth, offset, param) {
  const o = ctx.createOscillator(); o.frequency.value = rate;
  const g = ctx.createGain(); g.gain.value = depth; o.connect(g); g.connect(param); param.value = offset; o.start();
  return o;
}
// Random short bursts (rain drops, fire crackles), scheduled a little ahead of time.
function bursts(gainParam, { rate, minLen, maxLen, amp }) {
  let alive = true, t = ctx.currentTime;
  const tick = () => {
    if (!alive) return;
    while (t < ctx.currentTime + 0.4) {
      t += -Math.log(1 - Math.random()) / rate;           // Poisson spacing
      const a = amp * (0.25 + Math.random() * 0.75) ** 2, len = minLen + Math.random() * (maxLen - minLen);
      gainParam.setValueAtTime(0.0001, t); gainParam.linearRampToValueAtTime(a, t + 0.002); gainParam.exponentialRampToValueAtTime(0.0001, t + len);
    }
    setTimeout(tick, 150);
  };
  tick();
  return () => { alive = false; };
}

const SOUNDS = {
  // trim: balances loudness so every sound sits at a similar level (measured with measure())
  rain: { label: 'Rain', icon: '☂', trim: 1.3, build(out) {
    const n = src('pink'), hp = filt('highpass', 500), lp = filt('lowpass', 6500), g = ctx.createGain(); g.gain.value = 0.7;
    n.connect(hp).connect(lp).connect(g).connect(out);
    const d = src('white'), bp = filt('bandpass', 2600, 1.2), dg = ctx.createGain(); dg.gain.value = 0.0001;
    d.connect(bp).connect(dg).connect(out);
    const stopDrops = bursts(dg.gain, { rate: 28, minLen: 0.012, maxLen: 0.04, amp: 0.35 });
    const l = lfo(0.11, 0.12, 0.7, g.gain);
    return () => { stopDrops(); [n, d, l].forEach((x) => x.stop()); };
  } },
  fire: { label: 'Fireplace', icon: '🔥', trim: 0.68, build(out) {
    const n = src('brown'), lp = filt('lowpass', 420), g = ctx.createGain(); g.gain.value = 0.9;
    n.connect(lp).connect(g).connect(out);
    const c = src('white'), hp = filt('highpass', 1800), cg = ctx.createGain(); cg.gain.value = 0.0001;
    c.connect(hp).connect(cg).connect(out);
    const stopCrackle = bursts(cg.gain, { rate: 7, minLen: 0.004, maxLen: 0.03, amp: 0.9 });
    const p = src('white'), plp = filt('bandpass', 700, 0.8), pg = ctx.createGain(); pg.gain.value = 0.0001;
    p.connect(plp).connect(pg).connect(out);
    const stopPops = bursts(pg.gain, { rate: 0.6, minLen: 0.03, maxLen: 0.09, amp: 1.2 });
    const l = lfo(0.2, 0.2, 0.9, g.gain);
    return () => { stopCrackle(); stopPops(); [n, c, p, l].forEach((x) => x.stop()); };
  } },
  waves: { label: 'Ocean waves', icon: '〰', trim: 1, build(out) {
    const n = src('pink'), lp = filt('lowpass', 700), g = ctx.createGain();
    n.connect(lp).connect(g).connect(out);
    const l1 = lfo(0.075, 0.42, 0.5, g.gain), l2 = lfo(0.075, 450, 800, lp.frequency);
    return () => [n, l1, l2].forEach((x) => x.stop());
  } },
  wind: { label: 'Wind', icon: '❋', trim: 2.5, build(out) {
    const n = src('pink'), bp = filt('bandpass', 500, 0.9), g = ctx.createGain();
    n.connect(bp).connect(g).connect(out);
    const l1 = lfo(0.045, 250, 520, bp.frequency), l2 = lfo(0.03, 0.3, 0.6, g.gain);
    return () => [n, l1, l2].forEach((x) => x.stop());
  } },
  brown: { label: 'Soft noise', icon: '◍', hint: 'brown noise, for focus', trim: 1.05, build(out) {
    const n = src('brown'), lp = filt('lowpass', 1100), g = ctx.createGain(); g.gain.value = 0.6;
    n.connect(lp).connect(g).connect(out);
    return () => n.stop();
  } },
};
const PRESETS = {
  'Rainy evening': { rain: 70, fire: 25 },
  'By the fire': { fire: 75, wind: 15 },
  'Seaside': { waves: 70, wind: 20 },
  'Deep focus': { brown: 55 },
};

function setLevel(name, pct) {
  S().mix[name] = pct;
  if (pct > 0) S().lastMix = { ...S().mix };
  const v = voices[name];
  if (pct > 0) {
    audio();
    if (!v) {
      const gain = ctx.createGain(); gain.gain.value = 0; gain.connect(master);
      voices[name] = { gain, stop: SOUNDS[name].build(gain) };
    }
    voices[name].gain.gain.setTargetAtTime((pct / 100) ** 1.6 * 0.9 * (SOUNDS[name].trim || 1), ctx.currentTime, 0.25);
  } else if (v) {
    v.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.2);
    setTimeout(() => { if (!(S().mix[name] > 0) && voices[name] === v) { v.stop(); v.gain.disconnect(); delete voices[name]; } }, 1500);
  }
}
const calmPlaying = () => Object.keys(voices).length > 0 && master?.gain.value > 0.01;

// ==========================================================================
// Radio — a few calm stations, plus the free Radio Browser directory
// ==========================================================================
// SomaFM runs several copies (mirrors) of every station and publishes the current list in a
// playlist file; we read it so we always use live servers, and try the next one if one is busy.
const SOMA = (id, name, tag) => ({
  id, name, tag, by: 'SomaFM', pls: `https://api.somafm.com/${id}.pls`,
  mirrors: ['ice6', 'ice2', 'ice5', 'ice4'].map((h) => `https://${h}.somafm.com/${id}-128-mp3`),
});
const STATIONS = [
  SOMA('groovesalad', 'Groove Salad', 'Ambient · downtempo'),
  SOMA('dronezone', 'Drone Zone', 'Atmospheric · no beats'),
  SOMA('fluid', 'Fluid', 'Instrumental hip-hop · lo-fi'),
  SOMA('sonicuniverse', 'Sonic Universe', 'Jazz'),
  // The direct https address; the older one redirects to plain http, which browsers block on an https page.
  { id: 'swissclassic', name: 'Radio Swiss Classic', tag: 'Classical · no talk', by: 'SRG SSR', mirrors: ['https://stream.srg-ssr.ch/srgssr/rsc_de/mp3/128'] },
  { id: 'swissjazz', name: 'Radio Swiss Jazz', tag: 'Jazz · no talk', by: 'SRG SSR', mirrors: ['https://stream.srg-ssr.ch/srgssr/rsj/mp3/128'] },
];
const plsCache = new Map();
async function mirrorsOf(st) {
  const fallback = st.mirrors || (st.url ? [st.url] : []);
  if (!st.pls) return fallback;
  const c = plsCache.get(st.id);
  if (c && Date.now() - c.at < 6 * 3600e3) return c.urls;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
    const txt = await (await fetch(st.pls, { signal: ctl.signal })).text(); clearTimeout(t);
    const listed = [...txt.matchAll(/^File\d+=(https:\/\/\S+)/gm)].map((m) => m[1].trim());
    if (listed.length) { const urls = [...new Set([...listed, ...fallback])]; plsCache.set(st.id, { at: Date.now(), urls }); return urls; }
  } catch { /* use the built-in list */ }
  return fallback;
}

const radio = new Audio();
radio.preload = 'none';
// idle | connecting | playing | reconnecting | paused | error
let radioNow = null, radioState = 'idle', radioError = '', attempt = 0, watchdog = null, retries = 0, fading = null;
const radioActive = () => ['connecting', 'playing', 'reconnecting'].includes(radioState);
function fadeRadio(to, ms = 900) {
  clearInterval(fading);
  const from = radio.volume, steps = 18, target = Math.max(0, Math.min(1, to));
  let i = 0;
  return new Promise((res) => {
    fading = setInterval(() => { i++; try { radio.volume = from + (target - from) * (i / steps); } catch {} if (i >= steps) { clearInterval(fading); res(); } }, ms / steps);
  });
}
function waitForPlaying(ms) {
  return new Promise((resolve, reject) => {
    const done = (ok, why) => { clearTimeout(t); radio.removeEventListener('playing', onPlay); radio.removeEventListener('error', onErr); ok ? resolve() : reject(new Error(why)); };
    const onPlay = () => done(true);
    const onErr = () => done(false, 'error');
    const t = setTimeout(() => done(false, 'timeout'), ms);
    radio.addEventListener('playing', onPlay); radio.addEventListener('error', onErr);
  });
}
// Connect to a station, trying each server in turn. A newer tap always wins over an older attempt.
async function connect(st, { reconnecting = false } = {}) {
  const token = ++attempt;
  clearTimeout(watchdog);
  radioNow = st; radioError = '';
  radioState = reconnecting ? 'reconnecting' : 'connecting'; render();
  const urls = await mirrorsOf(st);
  for (const url of urls) {
    if (token !== attempt) return;                       // you tapped something else meanwhile
    const playing = waitForPlaying(8000);
    playing.catch(() => {});
    try {
      radio.src = url; radio.volume = 0; radio.load();
      // Don't wait on play() itself: against a server that never answers it never settles.
      // Whichever comes first wins — sound starting, an error, the 10-second cut-off, or the
      // browser refusing to start audio without a tap.
      const started = radio.play().then(() => null, (e) => e);
      const blocked = started.then((e) => (e && e.name === 'NotAllowedError' ? e : new Promise(() => {})));
      const result = await Promise.race([playing.then(() => null), blocked]);
      if (token !== attempt) return;
      if (result) { radioState = 'error'; radioError = 'Your browser needs a tap to start the radio — press ▶ again.'; radioNow = null; render(); return; }
      if (token !== attempt) return;
      radioState = 'playing'; retries = reconnecting ? retries : 0;
      fadeRadio(S().radioVolume / 100);
      render();
      return;
    } catch { /* this server didn't start in time — try the next one */ }
  }
  if (token !== attempt) return;
  radio.removeAttribute('src'); radio.load();
  radioNow = null; radioState = 'error';
  radioError = `Couldn't reach ${st.name} — it may be busy. Try again in a moment, or pick another station.`;
  render();
}
function stopRadio() {
  ++attempt; clearTimeout(watchdog);
  const was = radioActive();
  radioNow = null; radioState = 'idle'; radioError = '';
  const end = () => { radio.pause(); radio.removeAttribute('src'); radio.load(); };
  was ? fadeRadio(0, 500).then(end) : end();
}
// Live streams can drop or stall; reconnect quietly a few times before giving up.
function recover() {
  if (radioState !== 'playing' || !radioNow) return;
  if (++retries > 3) { const name = radioNow.name; stopRadio(); radioState = 'error'; radioError = `${name} keeps dropping out — try another station.`; render(); return; }
  connect(radioNow, { reconnecting: true });
}
const armWatchdog = () => { if (radioState !== 'playing') return; clearTimeout(watchdog); watchdog = setTimeout(recover, 9000); };
radio.addEventListener('waiting', armWatchdog);
radio.addEventListener('stalled', armWatchdog);
radio.addEventListener('playing', () => clearTimeout(watchdog));
radio.addEventListener('ended', () => recover());
radio.addEventListener('error', () => { if (radioState === 'playing') recover(); });

const RB = ['https://de1.api.radio-browser.info', 'https://nl1.api.radio-browser.info', 'https://at1.api.radio-browser.info'];
async function searchStations(q) {
  for (const host of RB) {
    try {
      const u = `${host}/json/stations/search?name=${encodeURIComponent(q)}&limit=25&hidebroken=true&order=clickcount&reverse=true`;
      const res = await fetch(u);
      if (!res.ok) continue;
      const list = await res.json();
      // Only secure (https) streams can play on an https page.
      return list.filter((x) => (x.url_resolved || '').startsWith('https://')).slice(0, 12)
        .map((x) => ({ id: x.stationuuid, name: x.name.trim(), tag: [x.tags?.split(',').slice(0, 2).join(' · '), x.country].filter(Boolean).join(' · '), mirrors: [x.url_resolved], by: 'Radio Browser' }));
    } catch {}
  }
  throw new Error('The station directory is unreachable right now.');
}

// ==========================================================================
// Timer hooks: music follows your reading
// ==========================================================================
let pausedByTimer = { calm: false, radio: null, spotify: false };
export async function onTimerPause() {
  if (S().followTimer === false) return;
  pausedByTimer = { calm: calmPlaying(), radio: radioActive() ? radioNow : null, spotify: Sp.isConnected() && Sp.isPlaying() };
  if (pausedByTimer.calm) master.gain.setTargetAtTime(0, ctx.currentTime, 0.35);
  if (pausedByTimer.radio) { const st = radioNow; stopRadio(); radioState = 'paused'; radioNow = st; render(); }
  if (pausedByTimer.spotify) Sp.pause();
}
export async function onTimerResume() {
  if (S().followTimer === false) return;
  if (pausedByTimer.calm) { audio(); master.gain.setTargetAtTime(1, ctx.currentTime, 0.5); }
  if (pausedByTimer.radio && radioState === 'paused') connect(pausedByTimer.radio);   // live radio: a fresh connection
  if (pausedByTimer.spotify) Sp.resume();
  pausedByTimer = { calm: false, radio: null, spotify: false };
}
export async function stopAll() {
  if (Object.values(S().mix).some((v) => v > 0)) S().lastMix = { ...S().mix };
  S().mix = {}; remember();
  for (const k of Object.keys(voices)) voices[k].gain.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
  setTimeout(() => { for (const [k, v] of Object.entries(voices)) { v.stop(); v.gain.disconnect(); delete voices[k]; } }, 1500);
  if (radioNow || radioState !== 'idle') stopRadio();
  if (Sp.isConnected() && Sp.isPlaying()) Sp.pause();
  render();
}
export const anyPlaying = () => calmPlaying() || radioActive() || (Sp.isConnected() && Sp.isPlaying());

// ==========================================================================
// The panel
// ==========================================================================
let dock = null, spLists = null, spSearch = null, spDevices = null, spError = '', rbResults = null, rbError = '', embedUri = '';
export function mount(el) {
  dock = el;
  dock.addEventListener('click', onClick);
  dock.addEventListener('input', onInput);
  dock.addEventListener('change', onChangeEv);
  dock.addEventListener('submit', onSubmit);
  Sp.onChange(() => { if (S().tab === 'spotify') render(); });
  render();
}
export function show(visible) { if (dock) dock.hidden = !visible; if (visible && S().tab === 'spotify' && Sp.isConnected()) ensureSpotify(); }

function ensureSpotify() {
  Sp.startBrowserPlayer();
  if (!spLists) { spLists = 'loading'; Sp.playlists().then((l) => { spLists = l; render(); }).catch((e) => { spLists = []; spError = e.message; render(); }); }
  if (!spSearch) { spSearch = 'loading'; Sp.searchPlaylists('reading').then((l) => { spSearch = l; render(); }).catch(() => { spSearch = []; render(); }); }
  Sp.refreshNowPlaying();
}

let body = null, embedWrap = null;
function render() {
  if (!dock) return;
  const s = S();
  const tabs = { calm: 'Calming sounds', radio: 'Radio', spotify: 'Spotify' };
  // The Spotify embed (linking without signing in) sits in its own element that is only shown or
  // hidden — never moved — because a moved iframe reloads and the music would stop.
  if (!body) {
    body = document.createElement('div'); body.className = 'snd-body';
    embedWrap = document.createElement('div'); embedWrap.className = 'sp-embed-wrap';
    dock.append(body, embedWrap);
  }
  body.innerHTML = `
    <div class="snd-head">
      <div><div class="eyebrow">Reading room</div><h2>Sound</h2></div>
      <div class="row gap center-v">
        <label class="snd-follow"><input type="checkbox" data-snd="follow" ${s.followTimer !== false ? 'checked' : ''}> Pause with the timer</label>
        ${anyPlaying() ? '<button class="btn sm" data-snd="stop-all">Stop all</button>' : ''}
      </div>
    </div>
    <div class="chips snd-tabs">${Object.entries(tabs).map(([k, v]) => `<button class="chip ${s.tab === k ? 'on' : ''}" data-snd="tab" data-v="${k}">${v}</button>`).join('')}</div>
    <div class="snd-pane">${s.tab === 'calm' ? calmPane() : s.tab === 'radio' ? radioPane() : spotifyPane()}</div>`;
  if (embedUri && !embedWrap.firstChild) embedWrap.appendChild(makeEmbed(embedUri));
  embedWrap.hidden = !(s.tab === 'spotify' && !Sp.isConnected() && embedUri);
}

function calmPane() {
  const mix = S().mix, last = S().lastMix;
  const anyOn = Object.values(mix).some((v) => v > 0);
  return `
    ${!anyOn && last && Object.values(last).some((v) => v > 0) ? `<button class="btn sm primary snd-last" data-snd="last-mix">▶ Play your last mix · ${esc(Object.entries(last).filter(([, v]) => v > 0).map(([k]) => SOUNDS[k]?.label).filter(Boolean).join(' + '))}</button>` : ''}
    <div class="presets">${Object.keys(PRESETS).map((p) => `<button class="chip sm" data-snd="preset" data-v="${esc(p)}">${esc(p)}</button>`).join('')}</div>
    <div class="mixer">${Object.entries(SOUNDS).map(([k, v]) => `
      <div class="mix-row ${mix[k] > 0 ? 'on' : ''}">
        <button class="mix-icon" data-snd="toggle" data-v="${k}" aria-label="${v.label} on/off" aria-pressed="${mix[k] > 0}">${v.icon}</button>
        <div class="mix-name">${v.label}${v.hint ? `<small>${v.hint}</small>` : ''}</div>
        <input type="range" min="0" max="100" value="${mix[k] || 0}" data-snd="level" data-v="${k}" aria-label="${v.label} volume">
      </div>`).join('')}
    </div>
    <p class="muted small">Made live on your device — no downloads, no data, never repeats.</p>`;
}

function stationCard(st) {
  const mine = radioNow?.id === st.id;
  const state = mine ? radioState : 'idle';
  const busy = state === 'connecting' || state === 'reconnecting';
  const fav = (S().favourites || []).some((f) => f.id === st.id);
  return `<div class="station ${state === 'playing' ? 'on' : ''} ${busy ? 'busy' : ''}">
    <button class="st-play" data-snd="station" data-id="${esc(st.id)}" aria-label="${state === 'playing' || busy ? 'Stop' : 'Play'} ${esc(st.name)}">${busy ? '<span class="spin"></span>' : state === 'playing' ? '■' : '▶'}</button>
    <div class="st-text"><b>${esc(st.name)}</b><small>${busy ? (state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…') : esc(st.tag + (st.by ? ` · ${st.by}` : ''))}</small></div>
    ${st.by === 'Radio Browser' || fav ? `<button class="icon-btn" data-snd="fav" data-id="${esc(st.id)}" title="${fav ? 'Remove from' : 'Add to'} your stations">${fav ? '♥' : '♡'}</button>` : ''}
  </div>`;
}
const stationIndex = new Map();
function radioPane() {
  const favs = S().favourites || [];
  [...STATIONS, ...favs, ...(Array.isArray(rbResults) ? rbResults : [])].forEach((st) => stationIndex.set(st.id, st));
  return `
    ${radioError ? `<p class="snd-error">${esc(radioError)}</p>` : ''}
    <div class="stations">${STATIONS.map(stationCard).join('')}</div>
    ${favs.length ? `<h3 class="snd-sub">Your stations</h3><div class="stations">${favs.map(stationCard).join('')}</div>` : ''}
    <form class="row gap snd-search" data-snd-form="radio"><input name="q" placeholder="Find a station — e.g. classical, jazz, lofi, rain"><button class="btn sm">Search</button></form>
    ${rbError ? `<p class="snd-error">${esc(rbError)}</p>` : ''}
    ${rbResults === 'loading' ? '<p class="muted small">Searching…</p>' : Array.isArray(rbResults) ? (rbResults.length ? `<div class="stations">${rbResults.map(stationCard).join('')}</div>` : '<p class="muted small">No stations found.</p>') : ''}
    <div class="row gap center-v snd-vol"><span class="muted small">Volume</span><input type="range" min="0" max="100" value="${S().radioVolume}" data-snd="radio-vol"></div>
    <p class="muted small">Free internet radio. Stations from <a href="https://somafm.com" target="_blank" rel="noopener">SomaFM</a> (listener-supported) and SRG SSR; search uses the free <a href="https://www.radio-browser.info" target="_blank" rel="noopener">Radio Browser</a> directory. If a station is busy, the next server is tried automatically.</p>`;
}

function spotifyPane() {
  if (!Sp.clientId() || !Sp.isConnected()) {
    return `
      <div class="sp-connect">
        <p><b>Play your own Spotify</b> — your playlists, full songs, and music that pauses when you pause the timer. Needs Spotify Premium and a one-time setup.</p>
        ${Sp.clientId() ? '<button class="btn primary" data-snd="sp-connect">Connect Spotify</button>' : '<a class="btn primary" href="#/settings" data-snd="to-settings">Set up Spotify</a>'}
        ${spError ? `<p class="snd-error">${esc(spError)}</p>` : ''}
      </div>
      <h3 class="snd-sub">Or just paste a playlist link</h3>
      <form class="row gap snd-search" data-snd-form="embed"><input name="link" placeholder="https://open.spotify.com/playlist/…" value="${esc(S().embedLink || '')}"><button class="btn sm">Show</button></form>
      <p class="muted small">Plays full songs if you're signed in to spotify.com in this browser, otherwise 30-second previews.</p>`;
  }
  const st = Sp.status();
  const now = st.state;
  const where = st.sdkState === 'ready' ? 'this browser' : '';
  const notes = { loading: 'Starting the Spotify player…', unsupported: 'This browser can’t play Spotify directly (phones usually can’t) — open Spotify on your phone and choose it below.', premium: 'Spotify says this account isn’t Premium — playing here needs Premium.', auth: 'Spotify sign-in expired — reconnect in Settings.', offline: 'The Spotify player went offline — reload to restart it.' };
  const list = (items, empty) => items === 'loading' ? '<p class="muted small">Loading…</p>' : !items?.length ? `<p class="muted small">${empty}</p>`
    : `<div class="sp-grid">${items.map((p) => `<button class="sp-item" data-snd="sp-play" data-uri="${esc(p.uri)}" title="${esc(p.name)}">
        ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : '<span class="sp-noimg">♪</span>'}<span>${esc(p.name)}</span>${p.owner ? `<small>${esc(p.owner)}</small>` : ''}</button>`).join('')}</div>`;
  return `
    ${spError ? `<p class="snd-error">${esc(spError)}</p>` : ''}
    ${notes[st.sdkState] ? `<p class="muted small">${notes[st.sdkState]}</p>` : ''}
    <div class="sp-now ${now ? '' : 'empty'}">
      ${now?.art ? `<img src="${esc(now.art)}" alt="">` : '<span class="sp-noimg big">♪</span>'}
      <div class="sp-now-text"><b>${esc(now?.name || 'Nothing playing')}</b><small>${esc(now ? now.artists : 'Pick a playlist below')}${now?.device ? ` · on ${esc(now.device)}` : where && now ? ` · ${where}` : ''}</small></div>
      <div class="sp-controls">
        <button class="mini-btn" data-snd="sp-prev" aria-label="Previous">⏮</button>
        <button class="mini-btn play" data-snd="sp-toggle" aria-label="${now && !now.paused ? 'Pause' : 'Play'}">${now && !now.paused ? '❚❚' : '▶'}</button>
        <button class="mini-btn" data-snd="sp-next" aria-label="Next">⏭</button>
      </div>
    </div>
    <div class="row gap center-v snd-vol"><span class="muted small">Volume</span><input type="range" min="0" max="100" value="${db.settings.spotifyVolume ?? 60}" data-snd="sp-vol">
      <button class="link-btn" data-snd="sp-devices">Play on another device…</button></div>
    ${Array.isArray(spDevices) ? `<div class="sp-devices">${spDevices.length ? spDevices.map((d) => `<button class="chip sm ${d.active ? 'on' : ''}" data-snd="sp-device" data-id="${esc(d.id)}">${esc(d.name)}</button>`).join('') : '<span class="muted small">No devices — open Spotify on your phone or computer.</span>'}</div>` : ''}
    <h3 class="snd-sub">Your playlists</h3>${list(spLists, 'No playlists found.')}
    <h3 class="snd-sub">Reading playlists on Spotify</h3>
    <form class="row gap snd-search" data-snd-form="sp-search"><input name="q" placeholder="Search playlists — reading, rain, piano, classical"><button class="btn sm">Search</button></form>
    ${list(spSearch, 'No playlists found.')}
    <form class="row gap snd-search" data-snd-form="sp-link"><input name="link" placeholder="Or paste any Spotify link"><button class="btn sm">Play</button></form>`;
}

function makeEmbed(uri) {
  const [, type, id] = uri.split(':');
  const f = document.createElement('iframe');
  f.className = 'sp-embed';
  f.src = `https://open.spotify.com/embed/${type}/${id}?utm_source=generator&theme=0`;
  f.height = type === 'track' ? 152 : 380; f.loading = 'lazy';
  f.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
  f.title = 'Spotify player';
  return f;
}

let selectedDevice = null;
async function spDo(fn) { spError = ''; try { await fn(); } catch (e) { spError = e.message; } render(); }

function onClick(e) {
  const el = e.target.closest('[data-snd]');
  if (!el) return;
  const a = el.dataset.snd, v = el.dataset.v;
  if (el.tagName === 'BUTTON') e.preventDefault();
  const s = S();
  switch (a) {
    case 'tab': s.tab = v; remember(); render(); if (v === 'spotify' && Sp.isConnected()) ensureSpotify(); break;
    case 'toggle': setLevel(v, s.mix[v] > 0 ? 0 : 55); remember(); render(); break;
    case 'preset': for (const k of Object.keys(SOUNDS)) setLevel(k, PRESETS[v][k] || 0); remember(); render(); break;
    case 'stop-all': stopAll(); break;
    case 'last-mix': for (const k of Object.keys(SOUNDS)) setLevel(k, (s.lastMix || {})[k] || 0); remember(); render(); break;
    case 'station': {
      const st = stationIndex.get(el.dataset.id); if (!st) break;
      if (radioNow?.id === st.id && (radioActive() || radioState === 'paused')) { stopRadio(); render(); }
      else connect(st);
      break;
    }
    case 'fav': {
      const st = stationIndex.get(el.dataset.id); if (!st) break;
      const favs = s.favourites || (s.favourites = []);
      const i = favs.findIndex((f) => f.id === st.id);
      i >= 0 ? favs.splice(i, 1) : favs.push(st); remember(); render(); break;
    }
    case 'sp-connect': Sp.connect().catch((err) => { spError = err.message; render(); }); break;
    case 'sp-play': spDo(() => Sp.play(el.dataset.uri, selectedDevice)); break;
    case 'sp-toggle': spDo(async () => { const now = Sp.status().state; if (now && !now.paused) await Sp.pause(); else if (now) await Sp.resume(); else if (db.settings.spotifyLast) await Sp.play(db.settings.spotifyLast, selectedDevice); }); break;
    case 'sp-next': spDo(() => Sp.next()); break;
    case 'sp-prev': spDo(() => Sp.previous()); break;
    case 'sp-devices': spDo(async () => { spDevices = await Sp.devices(); }); break;
    case 'sp-device': selectedDevice = el.dataset.id; spDo(() => Sp.play(db.settings.spotifyLast || '', selectedDevice)); break;
  }
}
function onInput(e) {
  const el = e.target;
  if (el.dataset.snd === 'level') { setLevel(el.dataset.v, Number(el.value)); el.closest('.mix-row')?.classList.toggle('on', Number(el.value) > 0); }
  if (el.dataset.snd === 'radio-vol') { S().radioVolume = Number(el.value); clearInterval(fading); try { radio.volume = Number(el.value) / 100; } catch {} }
}
function onChangeEv(e) {
  const el = e.target;
  if (el.dataset.snd === 'level' || el.dataset.snd === 'radio-vol') remember();
  if (el.dataset.snd === 'follow') { S().followTimer = el.checked; remember(); }
  if (el.dataset.snd === 'sp-vol') Sp.setVolume(Number(el.value));
}
async function onSubmit(e) {
  const form = e.target.closest('[data-snd-form]');
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.sndForm;
  if (kind === 'radio') {
    const q = form.q.value.trim(); if (!q) return;
    rbError = ''; rbResults = 'loading'; render();
    try { rbResults = await searchStations(q); } catch (err) { rbResults = null; rbError = err.message; }
    render();
  } else if (kind === 'embed') {
    const uri = Sp.toUri(form.link.value);
    if (!uri) { spError = 'That doesn’t look like a Spotify link.'; render(); return; }
    spError = ''; S().embedLink = form.link.value.trim(); remember();
    embedUri = uri; embedWrap.innerHTML = ''; render();
  } else if (kind === 'sp-search') {
    const q = form.q.value.trim(); if (!q) return;
    spSearch = 'loading'; render();
    try { spSearch = await Sp.searchPlaylists(q); } catch (err) { spSearch = []; spError = err.message; }
    render();
  } else if (kind === 'sp-link') {
    const uri = Sp.toUri(form.link.value);
    if (!uri) { spError = 'That doesn’t look like a Spotify link.'; render(); return; }
    spDo(() => Sp.play(uri, selectedDevice));
  }
}

// Restore the saved Spotify link (embed) on start-up.
export function init() {
  const s = S();
  if (s.embedLink) embedUri = Sp.toUri(s.embedLink);
  s.favourites = (s.favourites || []).map((f) => (f.mirrors ? f : { ...f, id: f.id || f.url, mirrors: [f.url] }));
  // Browsers don't allow sound to start by itself, so start silent and offer the last mix.
  if (Object.values(s.mix || {}).some((v) => v > 0)) s.lastMix = { ...s.mix };
  s.mix = {};
}

// For automated checks: render a few seconds of a sound offline and report its loudness.
export async function measure(name, seconds = 4) {
  const live = ctx;
  const off = new OfflineAudioContext(2, 44100 * seconds, 44100);
  ctx = off;
  const g = off.createGain(); g.gain.value = (60 / 100) ** 1.6 * 0.9 * (SOUNDS[name].trim || 1); g.connect(off.destination);
  const stop = SOUNDS[name].build(g);
  const buf = await off.startRendering();
  stop?.(); ctx = live;
  const d = buf.getChannelData(0); let peak = 0, sum = 0;
  for (const v of d) { peak = Math.max(peak, Math.abs(v)); sum += v * v; }
  return { peak: +peak.toFixed(3), rms: +Math.sqrt(sum / d.length).toFixed(4) };
}

// A soft bell for focus blocks: "ting ting ting" to start a break, one "ting" to read again.
// It plays straight to the speakers, so it rings even while other sounds are faded out.
export function bell(strikes = 3, gap = 0.8) {
  audio();
  const out = ctx.createGain(); out.gain.value = 0.22; out.connect(ctx.destination);
  const partials = [[1, 1], [2.01, 0.45], [2.76, 0.28], [5.4, 0.12], [8.93, 0.05]]; // bell-like overtones
  for (let i = 0; i < strikes; i++) {
    const t0 = ctx.currentTime + 0.05 + i * gap;
    const f0 = 988 * (i === strikes - 1 && strikes > 1 ? 0.89 : 1);       // last strike a touch lower
    for (const [ratio, amp] of partials) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f0 * ratio;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(amp, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.8 / Math.sqrt(ratio));
      o.connect(g).connect(out); o.start(t0); o.stop(t0 + 3);
    }
  }
}
