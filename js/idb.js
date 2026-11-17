/**
 * idb.js — Persistenza dei campioni WAV utente in IndexedDB.
 * Record: chiave = indice traccia (0-7), valore = { name, data: ArrayBuffer }.
 * Tutte le funzioni falliscono in modo silenzioso (navigazione privata, storage bloccato).
 */

const DB = 'drumbort';
const STORE = 'samples';

function open() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB non disponibile')); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(out && 'result' in out ? out.result : undefined); };
    t.onerror = t.onabort = () => { db.close(); reject(t.error); };
  });
}

export async function saveSample(track, name, data) {
  try { await tx('readwrite', (s) => s.put({ name, data }, track)); return true; } catch (_) { return false; }
}

export async function deleteSample(track) {
  try { await tx('readwrite', (s) => s.delete(track)); } catch (_) { /* n/a */ }
}

export async function clearSamples() {
  try { await tx('readwrite', (s) => s.clear()); } catch (_) { /* n/a */ }
}

/** @returns {Promise<Array<{track:number, name:string, data:ArrayBuffer}>>} */
export async function loadSamples() {
  try {
    const db = await open();
    return await new Promise((resolve) => {
      const out = [];
      const t = db.transaction(STORE, 'readonly');
      const req = t.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (c) { out.push({ track: c.key, name: c.value.name, data: c.value.data }); c.continue(); }
      };
      t.oncomplete = () => { db.close(); resolve(out); };
      t.onerror = () => { db.close(); resolve(out); };
    });
  } catch (_) {
    return [];
  }
}
