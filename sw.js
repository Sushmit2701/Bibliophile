// Offline support: cache the app shell, network-first so updates arrive when online.
const CACHE = 'bibliophile-v6';
const SHELL = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/store.js', 'js/importers.js', 'js/share.js', 'js/ai.js', 'js/yearcard.js', 'js/covers.js', 'js/recs.js', 'js/stats.js', 'manifest.webmanifest', 'icons/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  const isCover = url.hostname === 'covers.openlibrary.org';
  // Leave everything else that isn't the app itself (book search, AI) to the network.
  if (url.origin !== location.origin && !isFont && !isCover) return;
  if (isCover) {
    // cache-first for cover images so the shelf works offline
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res;
    })));
    return;
  }
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req).then((hit) => hit || caches.match('index.html'))));
});
