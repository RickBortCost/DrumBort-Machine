/**
 * synthpattern.js — Modello dati della sezione synth e groove demo.
 *
 * pattern.synth = {
 *   key: 0-11, scale: chiave di SCALES,
 *   tracks[4]: {
 *     preset, oct (-2..2), vol, pan, rev, dly,
 *     cut, res, env, dec, atk, rel, lfo, rate      macro del suono
 *     drv (0-1), crush (0 = off, 4-12 bit)          effetti per traccia
 *     arp: { on, mode, rate (tick per nota), oct, gate, src (traccia accordi) }
 *     mute, solo, len,
 *     steps[16]: null | { n: nota MIDI, g: gate (1-16), a: accento, sl: slide, ch: [intervalli],
 *                         pl: { cut, dec, vel } parametri bloccati sullo step }
 *   }
 * }
 */

import { PRESETS, SYNTH_TRACKS, SCALES, degreeNote, diatonicChord } from './synth.js';
import { normalizeWTPreset } from './wavetable.js';

export const SYNTH_STEPS = 16;
export const SYNTH_COUNT = SYNTH_TRACKS.length;
export const ARP_MODES = ['up', 'down', 'updown', 'random'];
export const ARP_RATES = [0.5, 1, 2, 4];          // in sedicesimi: 1/32, 1/16, 1/8, 1/4
const num = (v) => typeof v === 'number' && isFinite(v);
const clamp = (v, lo, hi, def) => (num(v) ? Math.min(hi, Math.max(lo, v)) : def);

/** Nota MIDI della tonica alla base della tastiera della traccia. */
export const trackBase = (syn, k) => 12 * (SYNTH_TRACKS[k].oct + (syn.tracks[k].oct || 0) + 1) + syn.key;

export const defaultArp = () => ({ on: false, mode: 'up', rate: 1, oct: 1, gate: 0.6, src: 2 });

export function defaultSynthTrack(k) {
  return {
    preset: SYNTH_TRACKS[k].preset, oct: 0,
    vol: [0.75, 0.75, 0.6, 0.65][k], pan: [0, 0.15, -0.1, 0.2][k], rev: [0, 0.2, 0.35, 0.2][k], dly: [0, 0.25, 0.1, 0.1][k],
    cut: 0, res: 0, env: 1, dec: 1, atk: 1, rel: 1, lfo: 1, rate: 1, pos: 0,
    drv: 0, crush: 0,
    arp: defaultArp(),
    mute: false, solo: false, len: SYNTH_STEPS,
    steps: new Array(SYNTH_STEPS).fill(null),
  };
}

export const emptySynth = () => ({ key: 9, scale: 'minor', tracks: SYNTH_TRACKS.map((_, k) => defaultSynthTrack(k)) });

// ---------------------------------------------------------------------
// Groove demo: [step, grado, gate, accento, slide]; per pad/keys [step, grado, gate, tipo]
// ---------------------------------------------------------------------
const DEMOS = [
  { // Acid in La minore
    key: 9, scale: 'minor', presets: ['acid303', 'sh101lead', 'juno', 'epiano'],
    bass: [[0, 0, 1, 1, 0], [2, 0, 1, 0, 1], [3, 7, 1, 0, 0], [6, 0, 1, 0, 0], [8, 2, 1, 1, 1], [9, 3, 1, 0, 0], [11, 0, 1, 0, 0], [12, 4, 1, 1, 0], [14, 3, 1, 0, 1], [15, 2, 1, 0, 0]],
    lead: [],
    pad: [[0, 0, 8, 'triad'], [8, 5, 8, 'triad']],
    keys: [],
  },
  { // Synth-pop in Do minore
    key: 0, scale: 'minor', presets: ['moogbass', 'mooglead', 'prophet', 'epiano'],
    bass: [[0, 0, 2, 1, 0], [3, 0, 1, 0, 0], [6, 0, 1, 0, 0], [8, 5, 2, 1, 0], [11, 5, 1, 0, 0], [12, 6, 2, 0, 0], [14, 4, 2, 0, 0]],
    lead: [[0, 7, 3, 1, 0], [4, 9, 2, 0, 1], [6, 8, 2, 0, 0], [8, 7, 4, 0, 0], [12, 4, 3, 0, 0]],
    pad: [[0, 0, 4, 'seventh'], [4, 5, 4, 'triad'], [8, 2, 4, 'triad'], [12, 6, 4, 'triad']],
    keys: [[2, 0, 1, 'triad'], [6, 5, 1, 'triad'], [10, 2, 1, 'triad'], [14, 6, 1, 'triad']],
  },
  { // Funk dorico in Mi
    key: 4, scale: 'dorian', presets: ['sh101bass', 'chip', 'obx', 'clav'],
    bass: [[0, 0, 1, 1, 0], [3, 0, 1, 0, 0], [4, 7, 1, 0, 0], [6, 6, 1, 0, 1], [7, 4, 1, 0, 0], [10, 0, 1, 1, 0], [12, 3, 1, 0, 0], [14, 4, 1, 0, 1], [15, 6, 1, 0, 0]],
    lead: [[2, 7, 1, 0, 0], [5, 9, 1, 0, 0], [10, 8, 2, 1, 0]],
    pad: [[0, 0, 2, 'seventh'], [6, 3, 2, 'seventh'], [8, 0, 2, 'seventh'], [14, 3, 2, 'seventh']],
    keys: [[1, 0, 1, 'seventh'], [3, 0, 1, 'seventh'], [9, 3, 1, 'seventh'], [11, 3, 1, 'seventh']],
  },
];

/** Synth con groove demo `i` (0-2). */
export function demoSynth(i = 0) {
  const d = DEMOS[((i % DEMOS.length) + DEMOS.length) % DEMOS.length];
  const syn = { key: d.key, scale: d.scale, tracks: SYNTH_TRACKS.map((_, k) => defaultSynthTrack(k)) };
  d.presets.forEach((p, k) => { syn.tracks[k].preset = p; });
  const put = (k, list, chords) => {
    const base = trackBase(syn, k);
    for (const e of list) {
      const n = degreeNote(base, syn.scale, e[1]);
      syn.tracks[k].steps[e[0]] = chords
        ? { n, g: e[2], a: 0, sl: 0, ch: diatonicChord(n, syn.key, syn.scale, e[3]) }
        : { n, g: e[2], a: e[3], sl: e[4], ch: null };
    }
  };
  put(0, d.bass, false);
  put(1, d.lead, false);
  put(2, d.pad, true);
  put(3, d.keys, true);
  return syn;
}

function normalizeLock(o) {
  if (!o || typeof o !== 'object') return null;
  const pl = {};
  if (num(o.cut)) pl.cut = clamp(o.cut, -1, 1, 0);
  if (num(o.dec)) pl.dec = clamp(o.dec, 0.25, 3, 1);
  if (num(o.vel)) pl.vel = clamp(o.vel, 0.1, 1, 0.7);
  return Object.keys(pl).length ? pl : null;
}

export function normalizeSynthStep(o) {
  if (!o || typeof o !== 'object' || !num(o.n)) return null;
  const ch = Array.isArray(o.ch) ? o.ch.filter(num).map((x) => Math.round(clamp(x, -24, 24, 0))).slice(0, 6) : null;
  const st = {
    n: Math.round(clamp(o.n, 12, 108, 60)),
    g: Math.round(clamp(o.g, 1, SYNTH_STEPS, 1)),
    a: o.a ? 1 : 0,
    sl: o.sl ? 1 : 0,
    ch: ch && ch.length ? ch : null,
  };
  const pl = normalizeLock(o.pl);
  if (pl) st.pl = pl;
  return st;
}

function normalizeArp(o) {
  const d = defaultArp();
  if (!o || typeof o !== 'object') return d;
  return {
    on: !!o.on,
    mode: ARP_MODES.includes(o.mode) ? o.mode : d.mode,
    rate: ARP_RATES.includes(o.rate) ? o.rate : d.rate,
    oct: Math.round(clamp(o.oct, 1, 3, 1)),
    gate: clamp(o.gate, 0.1, 1, d.gate),
    src: Math.round(clamp(o.src, 0, SYNTH_COUNT - 1, 2)),
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
      preset: PRESETS[src.preset] ? src.preset : d.preset,
      oct: Math.round(clamp(src.oct, -2, 2, 0)),
      vol: clamp(src.vol, 0, 1, d.vol), pan: clamp(src.pan, -1, 1, d.pan),
      rev: clamp(src.rev, 0, 1, d.rev), dly: clamp(src.dly, 0, 1, d.dly),
      cut: clamp(src.cut, -1, 1, 0), res: clamp(src.res, -1, 1, 0),
      env: clamp(src.env, 0, 2, 1), dec: clamp(src.dec, 0.25, 3, 1),
      atk: clamp(src.atk, 0.1, 4, 1), rel: clamp(src.rel, 0.1, 4, 1),
      lfo: clamp(src.lfo, 0, 2, 1), rate: clamp(src.rate, 0.25, 4, 1), pos: clamp(src.pos, -1, 1, 0),
      // Patch modificata nell'editor wavetable (validata come un preset)
      ...(src.patch && typeof src.patch === 'object' && src.patch.wt ? { patch: normalizeWTPreset(src.patch) } : {}),
      drv: clamp(src.drv, 0, 1, 0), crush: clampBits(src.crush),
      arp: normalizeArp(src.arp),
      mute: !!src.mute, solo: !!src.solo,
      len: Math.round(clamp(src.len, 1, SYNTH_STEPS, SYNTH_STEPS)),
      steps: Array.from({ length: SYNTH_STEPS }, (_, s) => normalizeSynthStep(Array.isArray(src.steps) && src.steps[s])),
    };
  });
  return syn;
}

/** Bit crusher per traccia: 0 = spento, altrimenti 4-12 bit. */
export function clampBits(v) {
  if (!num(v) || v <= 0) return 0;
  return Math.round(clamp(v, 4, 12, 0));
}

export const synthIsEmpty = (syn) => syn.tracks.every((t) => t.steps.every((s) => !s));
