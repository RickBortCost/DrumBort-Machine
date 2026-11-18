/**
 * sw.js — Service worker: precache dei file statici e strategia cache-first.
 * Percorsi relativi: il sito è servito sotto /DrumBort-Machine/.
 * Aggiornare VERSION a ogni rilascio (insieme a js/version.js) per invalidare la cache.
 */
const VERSION = '1.4.0';
const CACHE = `drumbort-v${VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/kits.js',
  './js/engine.js',
  './js/sequencer.js',
  './js/ui.js',
  './js/version.js',
  './js/export.js',
  './js/midi.js',
  './js/idb.js',
  './js/synth.js',
  './js/synthpattern.js',
  './js/synthui.js',
  './js/voicecache.js',
  './js/presets.js',
  './js/library.js',
  './js/generate.js',
  './js/recorder.js',
  './js/midifile.js',
  './js/projects.js',
  './js/performance.js',
  './js/panels.js',
  './js/wavetable.js',
  './js/waveeditor.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

// ----- Install: precache. La nuova versione resta in attesa finché l'utente non conferma -----
// Le versioni ≤ 1.0.1 non hanno il banner "Aggiorna": in quel caso si attiva subito.
const LEGACY = ['drumbort-v1', 'drumbort-v1.0.1'];
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS))
      .then(() => caches.keys())
      .then((keys) => { if (keys.some((k) => LEGACY.includes(k))) return self.skipWaiting(); })
  );
});

// ----- Messaggi dalla pagina: "Aggiorna" → attiva subito la nuova versione -----
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
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
