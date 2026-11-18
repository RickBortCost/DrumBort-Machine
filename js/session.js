/**
 * session.js — Modalità session (layout Studio): ogni traccia suona la propria "clip",
 * cioè la sua parte in uno degli 8 pattern. Le scene lanciano la stessa riga su tutte le tracce.
 *
 * Il pattern composto usa riferimenti agli array dei pattern sorgente (nessuna copia):
 * le modifiche nell'editor si sentono subito.
 */

import { kitById } from './kits.js';

export const DRUM_TRACKS = 8;
export const SYNTH_COUNT = 4;
export const SESSION_TRACKS = DRUM_TRACKS + SYNTH_COUNT;

const EMPTY_ROW = Object.freeze(new Array(16).fill(0));
const EMPTY_OPTS = Object.freeze(new Array(16).fill(null));
const EMPTY_SYN = Object.freeze(new Array(16).fill(null));

/**
 * @param {object[]} slots    gli 8 pattern
 * @param {number[]} map      slot per traccia (0-11), -1 = traccia ferma
 * @param {number} master     slot che fornisce tempo, swing, tonalità e kit del bus
 * @param {string|null} lock  kit bloccato
 */
export function composePattern(slots, map, master, lock = null) {
  const base = slots[master] || slots[0];
  const src = (i) => (map[i] >= 0 ? slots[map[i]] : null);
  const p = {
    composite: true,
    kit: lock || base.kit, bpm: base.bpm, swing: base.swing, human: base.human || 0,
    steps: [], opts: [], tracks: [], kits: [],
    synth: { key: base.synth.key, scale: base.synth.scale, tracks: [] },
  };
  for (let t = 0; t < DRUM_TRACKS; t++) {
    const s = src(t);
    p.steps[t] = s ? s.steps[t] : EMPTY_ROW;
    p.opts[t] = s ? s.opts[t] : EMPTY_OPTS;
    p.tracks[t] = (s || base).tracks[t];
    p.kits[t] = kitById(lock || (s || base).kit);
  }
  // Automazione: ogni traccia porta quella della propria clip, il master quella del pattern principale
  const auto = {};
  const take = (from, prefix) => { if (from && from.auto) for (const [k, v] of Object.entries(from.auto)) if (k.startsWith(prefix)) auto[k] = v; };
  for (let t = 0; t < DRUM_TRACKS; t++) take(src(t), `d${t}.`);
  for (let k = 0; k < SYNTH_COUNT; k++) take(src(DRUM_TRACKS + k), `s${k}.`);
  take(base, 'fx.');
  if (Object.keys(auto).length) p.auto = auto;
  for (let k = 0; k < SYNTH_COUNT; k++) {
    const s = src(DRUM_TRACKS + k);
    const bt = base.synth.tracks[k];
    p.synth.tracks[k] = s ? s.synth.tracks[k] : { ...bt, steps: EMPTY_SYN, arp: { ...bt.arp, on: false } };
  }
  return p;
}

/** La traccia `i` ha contenuto nel pattern `p`? */
export function hasClip(p, i) {
  if (i < DRUM_TRACKS) return p.steps[i].some(Boolean);
  const t = p.synth.tracks[i - DRUM_TRACKS];
  return t.steps.some(Boolean) || !!(t.arp && t.arp.on);
}

// =====================================================================
// Quantizzazione del lancio, follow action delle scene, arrangiamento
// =====================================================================

/** Quantizzazione del lancio in tick (16 = 1 battuta; 0 = allo step successivo). */
export const QUANTS = [
  { v: 0, label: 'Nessuna' }, { v: 4, label: '1/4' }, { v: 8, label: '1/2' },
  { v: 16, label: '1 bar' }, { v: 32, label: '2 bar' }, { v: 64, label: '4 bar' },
];
/** Follow action delle scene: cosa lanciare dopo `n` battute. */
export const FOLLOW = [
  { v: 'none', label: '—' }, { v: 'next', label: '→ Succ.' }, { v: 'prev', label: '← Prec.' },
  { v: 'first', label: '⤒ Prima' }, { v: 'rand', label: '? Casuale' }, { v: 'other', label: '≠ Altra' }, { v: 'stop', label: '■ Stop' },
];
export const FOLLOW_BARS = [1, 2, 4, 8, 16];
export const MAX_ARR_BARS = 256;
const SLOT_COUNT = 8;

const validSlot = (v) => (Number.isInteger(v) && v >= -1 && v < SLOT_COUNT ? v : -1);
const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, v | 0));

export function normalizeSession(o) {
  const s = {
    map: new Array(SESSION_TRACKS).fill(-1), master: 0, quant: 16,
    follow: Array.from({ length: SLOT_COUNT }, () => ({ a: 'none', n: 4 })),
  };
  if (!o || typeof o !== 'object') return s;
  if (Array.isArray(o.map) && o.map.length === SESSION_TRACKS) s.map = o.map.map(validSlot);
  s.master = clampInt(o.master, 0, SLOT_COUNT - 1);
  if (QUANTS.some((q) => q.v === o.quant)) s.quant = o.quant;
  if (Array.isArray(o.follow)) {
    o.follow.slice(0, SLOT_COUNT).forEach((f, i) => {
      if (!f) return;
      s.follow[i] = { a: FOLLOW.some((x) => x.v === f.a) ? f.a : 'none', n: FOLLOW_BARS.includes(f.n) ? f.n : 4 };
    });
  }
  return s;
}

/** Arrangiamento: una voce per battuta con la clip di ogni traccia (`m`) e il pattern principale (`s`). */
export function normalizeArr(o) {
  const a = { on: false, bars: [] };
  if (!o || typeof o !== 'object' || !Array.isArray(o.bars)) return a;
  a.bars = o.bars.slice(0, MAX_ARR_BARS)
    .filter((b) => b && Array.isArray(b.m) && b.m.length === SESSION_TRACKS)
    .map((b) => ({ m: b.m.map(validSlot), s: clampInt(b.s, 0, SLOT_COUNT - 1) }));
  a.on = !!o.on && a.bars.length > 0;
  return a;
}

/** Scena successiva secondo la follow action (null = nessuna azione, -1 = stop). */
export function followTarget(action, cur, slots, rnd = Math.random) {
  const used = [];
  for (let s = 0; s < SLOT_COUNT; s++) if (slots[s] && hasAny(slots[s])) used.push(s);
  const pool = used.length ? used : [cur];
  const idx = pool.indexOf(cur);
  switch (action) {
    case 'next': return pool[(idx + 1) % pool.length] ?? cur;
    case 'prev': return pool[(idx - 1 + pool.length) % pool.length] ?? cur;
    case 'first': return pool[0];
    case 'rand': return pool[Math.floor(rnd() * pool.length)];
    case 'other': {
      const o = pool.filter((s) => s !== cur);
      return o.length ? o[Math.floor(rnd() * o.length)] : cur;
    }
    case 'stop': return -1;
    default: return null;
  }
}

/** Il pattern ha almeno una clip? */
export function hasAny(p) {
  for (let i = 0; i < SESSION_TRACKS; i++) if (hasClip(p, i)) return true;
  return false;
}

/** Converte la catena del song mode in battute dell'arrangiamento. */
export function songToArr(chain) {
  const bars = [];
  for (const e of chain) {
    for (let r = 0; r < e.rep && bars.length < MAX_ARR_BARS; r++) bars.push({ m: new Array(SESSION_TRACKS).fill(e.slot), s: e.slot });
  }
  return bars;
}
