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
