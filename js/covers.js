// Cover images, saved inside the app.
//
// Each book's cover is downloaded once, shrunk to ~500px wide, and kept in this
// browser's IndexedDB. That means covers:
//   • show offline and never disappear if a website changes,
//   • can be drawn into shareable images (the year card) — a picture straight from
//     another site usually can't, because that site doesn't allow it.
//
// Where covers come from:
//   1. the book's cover URL (normally Open Library, filled in when you add a book),
//   2. otherwise Google Books, looked up by ISBN, then by title + author,
//   3. or a photo you upload yourself.
// Google Books and Open Library don't let web pages read their image data, so the
// download goes through wsrv.nl, a free public image relay that adds that permission.
import { save } from './store.js';

const DB_NAME = 'bibliophile-covers';
const STORE = 'covers';
const RELAY = 'https://wsrv.nl/';
const NO_CORS_HOSTS = ['books.google.com', 'covers.openlibrary.org', 'archive.org', 'images-na.ssl-images-amazon.com', 'm.media-amazon.com'];

const urls = new Map(); // bookId -> object URL of the saved cover
const listeners = new Set();
export const onCoverChange = (fn) => listeners.add(fn);
const notify = () => listeners.forEach((fn) => fn());

// ---------- IndexedDB ----------
let dbPromise;
function idb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
async function run(mode, fn) {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export async function loadCovers() {
  try {
    const d = await idb();
    await new Promise((resolve) => {
      const req = d.transaction(STORE).objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve();
        urls.set(c.key, URL.createObjectURL(c.value));
        c.continue();
      };
      req.onerror = () => resolve();
    });
  } catch { /* private mode etc. — fall back to remote URLs */ }
}

async function putBlob(id, blob) {
  await run('readwrite', (s) => s.put(blob, id));
  const old = urls.get(id);
  if (old) URL.revokeObjectURL(old);
  urls.set(id, URL.createObjectURL(blob));
  notify();
}

export async function removeCover(id) {
  try { await run('readwrite', (s) => s.delete(id)); } catch {}
  const old = urls.get(id);
  if (old) URL.revokeObjectURL(old);
  urls.delete(id);
}

export async function clearCovers() {
  try { await run('readwrite', (s) => s.clear()); } catch {}
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls.clear();
}

// What <img> tags should show: the saved copy if there is one, else the web address.
export const coverSrc = (book) => (book && urls.get(book.id)) || book?.cover || '';
export const hasSavedCover = (id) => urls.has(id);
export const savedCoverCount = () => urls.size;

// ---------- downloading ----------
// "we" = never enlarge, so a 1×1 "no cover" placeholder stays 1×1 and gets rejected below.
const relayed = (url) => `${RELAY}?url=${encodeURIComponent(url)}&w=500&we&output=jpg&q=85`;
// Ask Open Library for a 404 instead of a blank placeholder when it has no cover.
const noPlaceholder = (url) => (/covers\.openlibrary\.org/.test(url) && !/default=/.test(url) ? url + (url.includes('?') ? '&' : '?') + 'default=false' : url);

async function fetchImage(url) {
  if (url.startsWith('data:') || url.startsWith('blob:')) return (await fetch(url)).blob();
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  url = noPlaceholder(url);
  const attempts = NO_CORS_HOSTS.some((h) => host === h || host.endsWith('.' + h)) ? [relayed(url)] : [url, relayed(url)];
  for (const u of attempts) {
    try {
      const res = await fetch(u, { mode: 'cors' });
      if (!res.ok) continue;
      const blob = await res.blob();
      if (blob.type.startsWith('image/') && blob.size > 800) return blob;
    } catch { /* blocked or offline — try the next way */ }
  }
  throw new Error('Could not download that cover');
}

// Shrink to a sensible size and reject blank placeholders (e.g. Open Library's 1×1 "no cover").
async function shrink(blob, maxW = 500) {
  const bmp = await createImageBitmap(blob);
  if (bmp.width < 40 || bmp.height < 40) throw new Error('No real cover at that address');
  const scale = Math.min(1, maxW / bmp.width);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  if (isBlank(ctx, c.width, c.height)) throw new Error('Blank placeholder, not a cover');
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process image'))), 'image/jpeg', 0.85));
}

// A real cover has some variation; a placeholder is one flat colour.
function isBlank(ctx, w, h) {
  const px = ctx.getImageData(0, 0, w, h).data;
  const step = Math.max(4, Math.floor(px.length / 4 / 400)) * 4;
  let n = 0, sum = 0, sumSq = 0;
  for (let i = 0; i < px.length; i += step) { const v = (px[i] + px[i + 1] + px[i + 2]) / 3; sum += v; sumSq += v * v; n++; }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sumSq / n - mean * mean)) < 3;
}

// Google Books — a fallback for books Open Library has no cover for.
export async function googleCover(book) {
  const queries = [];
  const isbn = (book.isbn || '').replace(/[^0-9X]/gi, '');
  if (isbn) queries.push(`isbn:${isbn}`);
  if (book.title) {
    const author = (book.author || '').split(/[,&]| and /)[0].trim();
    queries.push(`intitle:${book.title.replace(/[:(].*$/, '').trim()}${author ? ` inauthor:${author}` : ''}`);
  }
  for (const q of queries) {
    try {
      const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5&printType=books&fields=items(volumeInfo(title,imageLinks))`);
      if (!res.ok) continue;
      const data = await res.json();
      const hit = (data.items || []).find((i) => i.volumeInfo?.imageLinks?.thumbnail || i.volumeInfo?.imageLinks?.smallThumbnail);
      if (!hit) continue;
      const links = hit.volumeInfo.imageLinks;
      return (links.thumbnail || links.smallThumbnail)
        .replace(/^http:/, 'https:')
        .replace(/&edge=curl/, '')
        .replace(/zoom=\d/, 'zoom=1') + '&fife=w500';
    } catch { /* try the next query */ }
  }
  return '';
}

// Make sure a book has a saved cover. Returns 'have' | 'saved' | 'found' | 'none'.
export async function ensureCover(book, { force = false } = {}) {
  if (!book) return 'none';
  if (!force && urls.has(book.id)) return 'have';
  if (book.cover) {
    try { await putBlob(book.id, await shrink(await fetchImage(book.cover))); return 'saved'; } catch {}
  }
  const g = await googleCover(book);
  if (g && g !== book.cover) {
    try {
      await putBlob(book.id, await shrink(await fetchImage(g)));
      book.cover = g; delete book.coverMissingAt; save();
      return 'found';
    } catch {}
  }
  book.coverMissingAt = new Date().toISOString(); save(); // don't keep asking every time the app opens
  return 'none';
}

let busy = Promise.resolve();
// Runs one batch at a time, so the automatic background pass and the button never overlap.
export function ensureAll(books, onProgress) {
  const job = busy.then(() => ensureAllNow(books, onProgress));
  busy = job.catch(() => {});
  return job;
}

async function ensureAllNow(books, onProgress) {
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const todo = books.filter((b) => !urls.has(b.id) && !(b.coverMissingAt > weekAgo));
  const tally = { saved: 0, found: 0, none: 0 };
  for (let i = 0; i < todo.length; i++) {
    const r = await ensureCover(todo[i]);
    if (r in tally) tally[r]++;
    onProgress?.(i + 1, todo.length);
    await new Promise((res) => setTimeout(res, 150)); // be gentle with the free services
  }
  return { ...tally, checked: todo.length };
}

export async function useUploadedCover(book, file) {
  await putBlob(book.id, await shrink(file, 600));
}

// ---------- backups ----------
const toDataURL = (blob) => new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });

export async function exportCovers() {
  const out = {};
  try {
    const d = await idb();
    await new Promise((resolve) => {
      const req = d.transaction(STORE).objectStore(STORE).openCursor();
      const pending = [];
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return Promise.all(pending).then(resolve);
        const key = c.key;
        pending.push(toDataURL(c.value).then((u) => { out[key] = u; }));
        c.continue();
      };
      req.onerror = () => resolve();
    });
  } catch {}
  return out;
}

export async function importCovers(map, { overwrite = false } = {}) {
  let n = 0;
  for (const [id, dataUrl] of Object.entries(map || {})) {
    if (!overwrite && urls.has(id)) continue;
    try { await putBlob(id, await (await fetch(dataUrl)).blob()); n++; } catch {}
  }
  return n;
}

// ---------- choosing a cover yourself ----------
// Every edition of a book on Open Library has its own cover, and Google Books has several more.
const olFetch = async (url) => {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try { const r = await fetch(url, { signal: ctl.signal }); return r.ok ? await r.json() : null; }
  catch { return null; } finally { clearTimeout(t); }
};

export async function editionCovers(book) {
  let work = book.ol?.key?.startsWith('/works/') ? book.ol.key : '';
  if (!work) {
    const q = new URL('https://openlibrary.org/search.json');
    const isbn = (book.isbn || '').replace(/[^0-9X]/gi, '');
    if (isbn) q.searchParams.set('isbn', isbn);
    else {
      q.searchParams.set('title', book.title || '');
      if (book.author) q.searchParams.set('author', book.author.split(/[,&]| and /)[0].trim());
    }
    q.searchParams.set('fields', 'key,title'); q.searchParams.set('limit', '1');
    work = (await olFetch(q.toString()))?.docs?.[0]?.key || '';
  }
  if (!work) return [];
  const data = await olFetch(`https://openlibrary.org${work}/editions.json?limit=40`);
  const found = [];
  for (const e of data?.entries || []) {
    const label = [e.publish_date, (e.languages || [])[0]?.key?.split('/').pop()].filter(Boolean).join(' · ');
    for (const id of e.covers || []) if (id > 0 && !found.some((x) => x.id === id)) found.push({ id, label });
  }
  return found.slice(0, 30).map((x) => ({
    large: `https://covers.openlibrary.org/b/id/${x.id}-L.jpg`,
    thumb: `https://covers.openlibrary.org/b/id/${x.id}-M.jpg`,
    label: x.label || 'Edition',
  }));
}

export async function googleCoverOptions(book) {
  const qs = [];
  const isbn = (book.isbn || '').replace(/[^0-9X]/gi, '');
  if (isbn) qs.push(`isbn:${isbn}`);
  if (book.title) qs.push(`intitle:${book.title.replace(/[:(].*$/, '').trim()}${book.author ? ` inauthor:${book.author.split(/[,&]| and /)[0].trim()}` : ''}`);
  const out = []; const seen = new Set();
  for (const q of qs) {
    try {
      const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=12&printType=books&fields=items(volumeInfo(title,publishedDate,imageLinks))`);
      if (!res.ok) continue;
      for (const i of (await res.json()).items || []) {
        const l = i.volumeInfo?.imageLinks;
        const raw = l?.thumbnail || l?.smallThumbnail;
        if (!raw) continue;
        const url = raw.replace(/^http:/, 'https:').replace(/&edge=curl/, '').replace(/zoom=\d/, 'zoom=1') + '&fife=w500';
        const key = url.replace(/&fife=.*$/, '');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ url, label: [i.volumeInfo.title, (i.volumeInfo.publishedDate || '').slice(0, 4)].filter(Boolean).join(' · ') });
      }
    } catch { /* try the next search */ }
  }
  return out.slice(0, 16);
}

// Save a cover picked from a web address (or an option above). Same path as automatic covers:
// downloaded once, shrunk, stored in the app, so it works offline.
export async function coverFromUrl(book, url) {
  const blob = await shrink(await fetchImage(url));
  await putBlob(book.id, blob);
  book.cover = url;
  delete book.coverMissingAt;
  save();
}
