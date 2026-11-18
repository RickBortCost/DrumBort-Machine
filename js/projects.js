/**
 * projects.js — Progetti con nome (localStorage) e condivisione di un pattern via link.
 * Il link contiene il pattern compresso nell'hash dell'URL: nessun server coinvolto.
 */

const KEY = 'drumbort.projects';

export function listProjects() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(raw) ? raw.filter((p) => p && typeof p.name === 'string' && p.data) : [];
  } catch (_) {
    return [];
  }
}

function write(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch (_) { return false; }
}

/** Salva (o sovrascrive per nome) un progetto. */
export function saveProject(name, data) {
  const list = listProjects().filter((p) => p.name !== name);
  list.unshift({ name, updated: Date.now(), data });
  return write(list.slice(0, 50));
}

export function deleteProject(name) { write(listProjects().filter((p) => p.name !== name)); }
export const getProject = (name) => listProjects().find((p) => p.name === name) || null;

// ---------------------------------------------------------------------
// Link di condivisione: #p=z<base64url deflate> oppure #p=j<base64url json>
// ---------------------------------------------------------------------

const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function encodeShare(obj) {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream === 'function') {
    try { return 'z' + b64u(await pipe(json, new CompressionStream('deflate-raw'))); } catch (_) { /* fallback */ }
  }
  return 'j' + b64u(json);
}

export async function decodeShare(code) {
  const kind = code[0], bytes = unb64u(code.slice(1));
  const raw = kind === 'z' ? await pipe(bytes, new DecompressionStream('deflate-raw')) : bytes;
  return JSON.parse(new TextDecoder().decode(raw));
}

/** URL completo con il pattern nell'hash. */
export async function shareUrl(pattern) {
  const base = location.href.split('#')[0];
  return `${base}#p=${await encodeShare({ v: 1, pattern })}`;
}
