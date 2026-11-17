/**
 * sw.js — Service worker: precache dei file statici e strategia cache-first.
 * Percorsi relativi: il sito è servito sotto /DrumBort-Machine/.
 * Aggiornare CACHE a ogni rilascio per invalidare la cache.
 */
const CACHE = 'drumbort-v1';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/kits.js',
  './js/engine.js',
  './js/sequencer.js',
  './js/ui.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

// ----- Install: precache -----
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

// ----- Activate: rimuove le cache vecchie -----
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ----- Fetch: cache-first, fallback rete (e salvataggio in cache) -----
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()));
    })
  );
});
