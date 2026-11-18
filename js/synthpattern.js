/**
 * synthpattern.js — Modello dati della sezione synth e groove demo.
 *
 * pattern.synth = {
 *   key: 0-11, scale: chiave di SCALES,
 *   tracks[3]: { preset, oct (-2..2), vol, pan, rev, dly, cut, res, env, dec, mute, solo, len,
 *                steps[16]: null | { n: nota MIDI, g: gate in step (1-16), a: accento, sl: slide, ch: [intervalli] } }
 * }
 */

import { PRESETS, SYNTH_TRACKS, SCALES, degreeNote, diatonicChord } from './synth.js';

export const SYNTH_STEPS = 16;
const num = (v) => typeof v === 'number' && isFinite(v);
const clamp = (v, lo, hi, def) => (num(v) ? Math.min(hi, Math.max(lo, v)) : def);

/** Nota MIDI della tonica alla base della tastiera della traccia. */
export const trackBase = (syn, k) => 12 * (SYNTH_TRACKS[k].oct + (syn.tracks[k].oct || 0) + 1) + syn.key;

export function defaultSynthTrack(k) {
  return {
    preset: SYNTH_TRACKS[k].preset, oct: 0,
    vol: k === 2 ? 0.6 : 0.75, pan: [0, 0.15, -0.1][k], rev: [0, 0.2, 0.35][k], dly: [0, 0.25, 0.1][k],
    cut: 0, res: 0, env: 1, dec: 1, mute: false, solo: false, len: SYNTH_STEPS,
    steps: new Array(SYNTH_STEPS).fill(null),
  };
}

export const emptySynth = () => ({ key: 9, scale: 'minor', tracks: [0, 1, 2].map(defaultSynthTrack) });

// ---------------------------------------------------------------------
// Groove demo: [step, grado, gate, accento, slide]; per il pad [step, grado, gate, tipo]
// ---------------------------------------------------------------------
const DEMOS = [
  { // Acid in La minore
    key: 9, scale: 'minor', presets: ['acid303', 'sh101lead', 'juno'],
    bass: [[0, 0, 1, 1, 0], [2, 0, 1, 0, 1], [3, 7, 1, 0, 0], [6, 0, 1, 0, 0], [8, 2, 1, 1, 1], [9, 3, 1, 0, 0], [11, 0, 1, 0, 0], [12, 4, 1, 1, 0], [14, 3, 1, 0, 1], [15, 2, 1, 0, 0]],
    lead: [],
    pad: [[0, 0, 8, 'triad'], [8, 5, 8, 'triad']],
  },
  { // Synth-pop in Do minore
    key: 0, scale: 'minor', presets: ['moogbass', 'mooglead', 'prophet'],
    bass: [[0, 0, 2, 1, 0], [3, 0, 1, 0, 0], [6, 0, 1, 0, 0], [8, 5, 2, 1, 0], [11, 5, 1, 0, 0], [12, 6, 2, 0, 0], [14, 4, 2, 0, 0]],
    lead: [[0, 7, 3, 1, 0], [4, 9, 2, 0, 1], [6, 8, 2, 0, 0], [8, 7, 4, 0, 0], [12, 4, 3, 0, 0]],
    pad: [[0, 0, 4, 'seventh'], [4, 5, 4, 'triad'], [8, 2, 4, 'triad'], [12, 6, 4, 'triad']],
  },
  { // Funk dorico in Mi
    key: 4, scale: 'dorian', presets: ['sh101bass', 'chip', 'obx'],
    bass: [[0, 0, 1, 1, 0], [3, 0, 1, 0, 0], [4, 7, 1, 0, 0], [6, 6, 1, 0, 1], [7, 4, 1, 0, 0], [10, 0, 1, 1, 0], [12, 3, 1, 0, 0], [14, 4, 1, 0, 1], [15, 6, 1, 0, 0]],
    lead: [[2, 7, 1, 0, 0], [5, 9, 1, 0, 0], [10, 8, 2, 1, 0]],
    pad: [[0, 0, 2, 'seventh'], [6, 3, 2, 'seventh'], [8, 0, 2, 'seventh'], [14, 3, 2, 'seventh']],
  },
];

/** Synth con groove demo `i` (0-2). */
export function demoSynth(i = 0) {
  const d = DEMOS[((i % DEMOS.length) + DEMOS.length) % DEMOS.length];
  const syn = { key: d.key, scale: d.scale, tracks: [0, 1, 2].map(defaultSynthTrack) };
  d.presets.forEach((p, k) => { syn.tracks[k].preset = p; });
  const put = (k, list, isPad) => {
    const base = trackBase(syn, k);
    for (const e of list) {
      const n = degreeNote(base, syn.scale, e[1]);
      syn.tracks[k].steps[e[0]] = isPad
        ? { n, g: e[2], a: 0, sl: 0, ch: diatonicChord(n, syn.key, syn.scale, e[3]) }
        : { n, g: e[2], a: e[3], sl: e[4], ch: null };
    }
  };
  put(0, d.bass, false);
  put(1, d.lead, false);
  put(2, d.pad, true);
  return syn;
}

export function normalizeSynthStep(o) {
  if (!o || typeof o !== 'object' || !num(o.n)) return null;
  const ch = Array.isArray(o.ch) ? o.ch.filter(num).map((x) => Math.round(clamp(x, -24, 24, 0))).slice(0, 6) : null;
  return {
    n: Math.round(clamp(o.n, 12, 108, 60)),
    g: Math.round(clamp(o.g, 1, SYNTH_STEPS, 1)),
    a: o.a ? 1 : 0,
    sl: o.sl ? 1 : 0,
    ch: ch && ch.length ? ch : null,
  };
}

export function normalizeSynth(o) {
  const syn = emptySynth();
  if (!o || typeof o !== 'object') return syn;
  syn.key = Math.round(clamp(o.key, 0, 11, 9));
  syn.scale = SCALES[o.scale] ? o.scale : 'minor';
  syn.tracks = syn.tracks.map((d, k) => {
    const src = (Array.isArray(o.tracks) && o.tracks[k]) || {};
    return {
      preset: PRESETS[src.preset] && PRESETS[src.preset].kind === k ? src.preset : d.preset,
      oct: Math.round(clamp(src.oct, -2, 2, 0)),
      vol: clamp(src.vol, 0, 1, d.vol), pan: clamp(src.pan, -1, 1, d.pan),
      rev: clamp(src.rev, 0, 1, d.rev), dly: clamp(src.dly, 0, 1, d.dly),
      cut: clamp(src.cut, -1, 1, 0), res: clamp(src.res, -1, 1, 0),
      env: clamp(src.env, 0, 2, 1), dec: clamp(src.dec, 0.25, 3, 1),
      mute: !!src.mute, solo: !!src.solo,
      len: Math.round(clamp(src.len, 1, SYNTH_STEPS, SYNTH_STEPS)),
      steps: Array.from({ length: SYNTH_STEPS }, (_, s) => normalizeSynthStep(Array.isArray(src.steps) && src.steps[s])),
    };
  });
  return syn;
}

export const synthIsEmpty = (syn) => syn.tracks.every((t) => t.steps.every((s) => !s));
