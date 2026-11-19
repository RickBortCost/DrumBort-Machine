/**
 * wavetable.js — Synth wavetable: 3 oscillatori con morph continuo della posizione,
 * unisono, rumore, 2 filtri (serie/parallelo) con drive, inviluppo di modulazione,
 * 2 LFO (liberi o a tempo), step sequencer di modulazione e matrice a 6 slot.
 *
 * Morph: ogni oscillatore usa 4 "frame" (PeriodicWave) sempre attivi; la posizione è un
 * segnale audio che, attraverso curve a triangolo (WaveShaper), pesa i frame. Così la
 * posizione si può modulare a frequenza audio con LFO, inviluppi e step.
 */

import { getNoise } from './kits.js';

const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);
const EPS = 0.0001;
const H = 256;         // armoniche per frame
const F = 4;           // frame per tabella
const num = (v) => typeof v === 'number' && isFinite(v);
const clamp = (v, lo, hi, def) => (num(v) ? Math.min(hi, Math.max(lo, v)) : def);

// =====================================================================
// Tabelle (generate): coefficienti di Fourier per frame
// =====================================================================

/** Coefficienti (real, imag) da una forma d'onda campionata su un periodo. */
function dft(fn, N = 1024) {
  const xs = new Float32Array(N);
  for (let i = 0; i < N; i++) xs[i] = fn(i / N);
  const real = new Float32Array(H), imag = new Float32Array(H);
  for (let n = 1; n < H; n++) {
    let re = 0, im = 0;
    for (let i = 0; i < N; i++) { const w = (2 * Math.PI * n * i) / N; re += xs[i] * Math.cos(w); im += xs[i] * Math.sin(w); }
    real[n] = (2 * re) / N; imag[n] = (2 * im) / N;
  }
  return { real, imag };
}

/** Spettro da ampiezze armoniche (fase sinusoidale). */
function spectrum(ampFn) {
  const real = new Float32Array(H), imag = new Float32Array(H);
  for (let n = 1; n < H; n++) imag[n] = ampFn(n);
  return { real, imag };
}

const gauss = (x, m, w) => Math.exp(-((x - m) * (x - m)) / (2 * w * w));
const VOWELS = [[700, 1220], [500, 1800], [300, 2300], [400, 800]];   // a, e, i, o

const TABLE_GEN = {
  /** Analogica: dente di sega → quadra → impulso 25% → impulso 10%. */
  analog: (k) => {
    if (k === 0) return spectrum((n) => ((n % 2 ? 1 : -1) / n));
    if (k === 1) return spectrum((n) => (n % 2 ? 1 / n : 0));
    const d = k === 2 ? 0.25 : 0.1;
    return dft((x) => (x < d ? 1 : -d / (1 - d)));
  },
  /** Sync: dente di sega "slave" sincronizzato a rapporti crescenti. */
  sync: (k) => { const r = [1, 1.6, 2.4, 3.6][k]; return dft((x) => 2 * ((x * r) % 1) - 1); },
  /** Formanti vocali: a → e → i → o. */
  formant: (k) => { const [f1, f2] = VOWELS[k]; return spectrum((n) => (gauss(n * 110, f1, 120) + 0.6 * gauss(n * 110, f2, 180)) / Math.sqrt(n)); },
  /** Digitale: maschere di armoniche. */
  digital: (k) => spectrum((n) => {
    if (k === 0) return n <= 4 ? 1 / n : 0;
    if (k === 1) return [1, 2, 4, 8, 16, 32].includes(n) ? 1 / Math.sqrt(n) : 0;
    if (k === 2) return [1, 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31].includes(n) ? 1 / Math.sqrt(n) : 0;
    return n >= 6 && n <= 14 ? 0.5 : n === 1 ? 1 : 0;
  }),
  /** Additiva: sempre più armoniche (1 → 3 → 7 → 20). */
  harmonic: (k) => { const m = [1, 3, 7, 20][k]; return spectrum((n) => (n <= m ? 1 / Math.pow(n, 0.7) : 0)); },
  /** Growl: dente di sega con pettine che si sposta (basso "parlante"). */
  growl: (k) => spectrum((n) => ((n % 2 ? 1 : -1) / n) * Math.abs(Math.cos((Math.PI * n * (k + 1)) / 9))),
  /** FM: portante + modulante 2:1 con indice crescente. */
  fm: (k) => { const I = [0.4, 1.4, 3, 5.5][k]; return dft((x) => Math.sin(2 * Math.PI * x + I * Math.sin(4 * Math.PI * x))); },
};
export const TABLES = Object.keys(TABLE_GEN);
export const TABLE_LABEL = { analog: 'Analog', sync: 'Sync', formant: 'Vocal', digital: 'Digital', harmonic: 'Additive', growl: 'Growl', fm: 'FM' };

const coefCache = new Map();
function coefs(table, k) {
  const key = `${table}|${k}`;
  if (!coefCache.has(key)) coefCache.set(key, (TABLE_GEN[table] || TABLE_GEN.analog)(k));
  return coefCache.get(key);
}

const waveCache = new WeakMap();
function wave(ctx, table, k) {
  let m = waveCache.get(ctx);
  if (!m) { m = new Map(); waveCache.set(ctx, m); }
  const key = `${table}|${k}`;
  if (!m.has(key)) { const c = coefs(table, k); m.set(key, ctx.createPeriodicWave(c.real, c.imag)); }
  return m.get(key);
}

/** Forma d'onda (un periodo, `N` campioni, normalizzata) alla posizione data: per il display. */
export function waveShape(table, pos, N = 256) {
  const x = clamp(pos, 0, 1, 0) * (F - 1);
  const out = new Float32Array(N);
  for (let k = 0; k < F; k++) {
    const w = Math.max(0, 1 - Math.abs(x - k));
    if (!w) continue;
    const c = coefs(table, k);
    const frame = new Float32Array(N);
    let pk = 0;
    for (let i = 0; i < N; i++) {
      let v = 0;
      for (let n = 1; n < H; n++) { const ph = (2 * Math.PI * n * i) / N; v += c.real[n] * Math.cos(ph) + c.imag[n] * Math.sin(ph); }
      frame[i] = v; pk = Math.max(pk, Math.abs(v));
    }
    for (let i = 0; i < N; i++) out[i] += (w * frame[i]) / (pk || 1);
  }
  return out;
}

// Curve dei pesi dei frame: ingresso -1..1 = posizione 0..1
const windowCurves = [];
for (let k = 0; k < F; k++) {
  const c = new Float32Array(1025);
  for (let i = 0; i < c.length; i++) { const x = (i / (c.length - 1)) * (F - 1); c[i] = Math.max(0, 1 - Math.abs(x - k)); }
  windowCurves.push(c);
}

const driveCurves = new Map();
function driveCurve(a) {
  const key = Math.round(a * 20);
  if (!driveCurves.has(key)) {
    const n = 1024, c = new Float32Array(n), k = 1 + a * 10;
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * k) / Math.tanh(k); }
    driveCurves.set(key, c);
  }
  return driveCurves.get(key);
}

const stepCache = new Map();
function stepBuffer(ctx, values) {
  const key = `${ctx.sampleRate}|${values.join(',')}`;
  if (!stepCache.has(key)) {
    const seg = 64, b = ctx.createBuffer(1, 16 * seg, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < 16; i++) d.fill(values[i] ?? 0, i * seg, (i + 1) * seg);
    if (stepCache.size > 64) stepCache.delete(stepCache.keys().next().value);
    stepCache.set(key, b);
  }
  return stepCache.get(key);
}

// =====================================================================
// Patch: modello e validazione
// =====================================================================

export const MOD_SOURCES = ['env2', 'env3', 'env4', 'lfo1', 'lfo2', 'lfo3', 'lfo4', 'step', 'vel', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'];
export const MOD_DESTS = ['pos', 'pos1', 'pos2', 'pos3', 'cut', 'cut1', 'cut2', 'pitch', 'amp', 'res', 'pm', 'noise'];
export const MOD_SLOTS = 16;
export const MODOSC_SHAPES = ['sine', 'triangle', 'sawtooth', 'square'];
const LFO_LIKE = new Set(['lfo1', 'lfo2', 'lfo3', 'lfo4', 'step']);
const BIPOLAR = new Set(['lfo1', 'lfo2', 'lfo3', 'lfo4']);
export const FILTER_TYPES = ['lowpass', 'bandpass', 'highpass', 'notch'];
export const LFO_SHAPES = ['sine', 'triangle', 'sawtooth', 'square'];
export const LFO_SYNC = [0, 0.25, 0.5, 1, 2, 4];   // 0 = libero (Hz); altrimenti durata in battiti
export const STEP_DIV = [0.5, 1, 2, 4];             // sedicesimi per step

const osc = (table, pos = 0, semi = 0, level = 1) => ({ table, pos, semi, fine: 0, level });

/** Patch completa di default (forma di riferimento per la validazione). */
export const WT_DEFAULT = Object.freeze({
  osc: [osc('analog', 0), osc('analog', 0, 0, 0), osc('analog', 0, -12, 0)],
  uni: { voices: 1, detune: 12 },
  noise: 0,
  f1: { type: 'lowpass', cut: 3000, res: 1 },
  f2: { type: 'none', cut: 1200, res: 1 },
  route: 'serial', mix: 0.5, drive: 0,
  env2: { a: 0.01, d: 0.4, s: 0, r: 0.3 },
  env3: { a: 0.3, d: 0.8, s: 0.5, r: 0.6 },
  env4: { a: 1.5, d: 2, s: 1, r: 1.5 },
  lfo1: { shape: 'sine', rate: 2, sync: 0 },
  lfo2: { shape: 'triangle', rate: 0.3, sync: 0 },
  lfo3: { shape: 'sawtooth', rate: 4, sync: 0 },
  lfo4: { shape: 'square', rate: 0.5, sync: 0 },
  modosc: { shape: 'sine', semi: 0, fine: 0, rm: [0, 0, 0], pm: [0, 0, 0] },
  macros: [0, 0, 0, 0, 0, 0, 0, 0],
  macroNames: ['Macro 1', 'Macro 2', 'Macro 3', 'Macro 4', 'Macro 5', 'Macro 6', 'Macro 7', 'Macro 8'],
  step: { values: [1, 0, 0.6, 0, 1, 0, 0.6, 0.3, 1, 0, 0.6, 0, 1, 0.3, 0.6, 0], div: 1 },
  mod: [],
});

/** Valida una patch (da storage, JSON importato o link): tutti i numeri finiti e nei limiti. */
export function normalizeWT(w) {
  const d = WT_DEFAULT, o = w && typeof w === 'object' ? w : {};
  const pick = (v, list, def) => (list.includes(v) ? v : def);
  const oscs = d.osc.map((def, i) => {
    const s = (Array.isArray(o.osc) && o.osc[i]) || {};
    return {
      table: pick(s.table, TABLES, def.table), pos: clamp(s.pos, 0, 1, def.pos),
      semi: Math.round(clamp(s.semi, -36, 36, def.semi)), fine: clamp(s.fine, -100, 100, 0), level: clamp(s.level, 0, 1, def.level),
    };
  });
  const filt = (s, def, allowNone) => ({
    type: pick(s && s.type, allowNone ? ['none', ...FILTER_TYPES] : FILTER_TYPES, def.type),
    cut: clamp(s && s.cut, 30, 18000, def.cut), res: clamp(s && s.res, 0.3, 25, def.res),
  });
  const env = (s, def) => ({ a: clamp(s && s.a, 0.001, 8, def.a), d: clamp(s && s.d, 0.01, 8, def.d), s: clamp(s && s.s, 0, 1, def.s), r: clamp(s && s.r, 0.01, 8, def.r) });
  const lfo = (s, def) => ({ shape: pick(s && s.shape, LFO_SHAPES, def.shape), rate: clamp(s && s.rate, 0.02, 30, def.rate), sync: pick(s && s.sync, LFO_SYNC, 0) });
  const values = Array.from({ length: 16 }, (_, i) => clamp(o.step && Array.isArray(o.step.values) ? o.step.values[i] : undefined, 0, 1, d.step.values[i]));
  const mod = (Array.isArray(o.mod) ? o.mod : []).slice(0, MOD_SLOTS)
    .filter((m) => m && MOD_SOURCES.includes(m.src) && MOD_DESTS.includes(m.dst))
    .map((m) => ({ src: m.src, dst: m.dst, amt: clamp(m.amt, -1, 1, 0) }));
  return {
    osc: oscs,
    uni: { voices: Math.round(clamp(o.uni && o.uni.voices, 1, 3, 1)), detune: clamp(o.uni && o.uni.detune, 0, 60, 12) },
    noise: clamp(o.noise, 0, 1, 0),
    f1: filt(o.f1, d.f1, false), f2: filt(o.f2, d.f2, true),
    route: pick(o.route, ['serial', 'parallel'], 'serial'), mix: clamp(o.mix, 0, 1, 0.5), drive: clamp(o.drive, 0, 1, 0),
    env2: env(o.env2, d.env2), env3: env(o.env3, d.env3), env4: env(o.env4, d.env4),
    lfo1: lfo(o.lfo1, d.lfo1), lfo2: lfo(o.lfo2, d.lfo2), lfo3: lfo(o.lfo3, d.lfo3), lfo4: lfo(o.lfo4, d.lfo4),
    modosc: {
      shape: pick(o.modosc && o.modosc.shape, MODOSC_SHAPES, 'sine'),
      semi: Math.round(clamp(o.modosc && o.modosc.semi, -36, 36, 0)), fine: clamp(o.modosc && o.modosc.fine, -100, 100, 0),
      rm: [0, 1, 2].map((i) => clamp(o.modosc && Array.isArray(o.modosc.rm) ? o.modosc.rm[i] : 0, 0, 1, 0)),
      pm: [0, 1, 2].map((i) => clamp(o.modosc && Array.isArray(o.modosc.pm) ? o.modosc.pm[i] : 0, 0, 1, 0)),
    },
    macros: Array.from({ length: 8 }, (_, i) => clamp(Array.isArray(o.macros) ? o.macros[i] : 0, 0, 1, 0)),
    macroNames: Array.from({ length: 8 }, (_, i) => (Array.isArray(o.macroNames) && typeof o.macroNames[i] === 'string' && o.macroNames[i].trim() ? o.macroNames[i].slice(0, 16) : d.macroNames[i])),
    step: { values, div: pick(o.step && o.step.div, STEP_DIV, 1) },
    mod,
  };
}

/** Preset wavetable completo e validato (campi comuni dei preset + `wt`). */
export function normalizeWTPreset(p, base = {}) {
  const o = p && typeof p === 'object' ? p : {};
  return {
    name: typeof o.name === 'string' ? o.name.slice(0, 40) : base.name || 'Wavetable',
    cat: typeof o.cat === 'string' ? o.cat.slice(0, 20) : base.cat || 'Wavetable',
    tags: Array.isArray(o.tags) ? o.tags.filter((t) => typeof t === 'string').slice(0, 8) : base.tags || ['wavetable'],
    a: clamp(o.a, 0.001, 8, 0.005), d: clamp(o.d, 0.01, 8, 0.5), s: clamp(o.s, 0, 1, 0.8), r: clamp(o.r, 0.01, 8, 0.3),
    glide: clamp(o.glide, 0, 1, 0), gain: clamp(o.gain, 0.1, 4, 1),
    rev: Math.round(clamp(o.rev, 0, 1e9, 0)),
    wt: normalizeWT(o.wt),
  };
}

// =====================================================================
// Voce
// =====================================================================

/**
 * Stessa interfaccia di playVoice (synth.js). p: macro { cut, res, env, dec, atk, rel, lfo, rate, pos, bpm }.
 * @returns {{release(at:number):void, kill(at:number):void}}
 */
export function playWT(ctx, out, t, dur, notes, vel, pr, p = {}, glideFrom = null) {
  const W = pr.wt, bpm = p.bpm || 120;
  const accent = vel >= 0.95;
  const decMul = p.dec ?? 1;
  const a = pr.a * (p.atk ?? 1), d = pr.d * decMul, s = pr.s, r = pr.r * Math.sqrt(decMul) * (p.rel ?? 1);
  const peak = ((0.36 + vel * 0.3) / Math.sqrt(notes.length)) * (pr.gain || 1);
  const sources = [];
  const modDepth = p.lfo ?? 1;

  // --- Uscita: release → (tremolo) → VCA ---
  const rel = ctx.createGain();
  rel.connect(out);
  const trem = ctx.createGain();
  trem.connect(rel);
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(EPS, t);
  if (a >= 0.05) amp.gain.linearRampToValueAtTime(peak, t + a);
  else amp.gain.exponentialRampToValueAtTime(peak, t + Math.max(0.002, a));
  amp.gain.setTargetAtTime(Math.max(EPS, peak * s), t + a, Math.max(0.01, d / 3));
  amp.connect(trem);

  // --- Sorgenti di modulazione ---
  const one = ctx.createConstantSource();
  sources.push(one);
  /** Inviluppo di modulazione 0..1 (A lineare, D/R esponenziali). */
  const envNode = (e) => {
    const g = ctx.createGain(), ea = e.a * (p.atk ?? 1), ed = e.d * decMul;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + ea);
    g.gain.setTargetAtTime(e.s, t + ea, Math.max(0.01, ed / 3));
    one.connect(g);
    return g;
  };
  const e2 = W.env2;
  const env2 = envNode(e2);
  const velSrc = ctx.createGain();
  velSrc.gain.value = vel;
  one.connect(velSrc);
  const lfoNode = (cfg) => {
    const o = ctx.createOscillator();
    o.type = cfg.shape;
    o.frequency.value = (cfg.sync ? bpm / 60 / cfg.sync : cfg.rate) * (p.rate ?? 1);
    sources.push(o);
    return o;
  };
  const used = new Set(W.mod.map((m) => m.src));
  const src = { env2, vel: velSrc };
  const envs = [[env2, e2]];
  for (const e of ['env3', 'env4']) if (used.has(e) && W[e]) { src[e] = envNode(W[e]); envs.push([src[e], W[e]]); }
  for (const l of ['lfo1', 'lfo2', 'lfo3', 'lfo4']) if (used.has(l) && W[l]) src[l] = lfoNode(W[l]);
  (W.macros || []).forEach((v, i) => { if (used.has(`m${i + 1}`)) { const g = ctx.createGain(); g.gain.value = v; one.connect(g); src[`m${i + 1}`] = g; } });
  if (used.has('step')) {
    const st = ctx.createBufferSource();
    st.buffer = stepBuffer(ctx, W.step.values);
    st.loop = true;
    const loopSec = 16 * (60 / bpm / 4) * W.step.div;
    st.playbackRate.value = st.buffer.duration / loopSec;
    sources.push(st);
    src.step = st;
  }
  /** Collega una sorgente a un parametro con un'ampiezza. */
  const route = (s, param, scale) => {
    const g = ctx.createGain();
    g.gain.value = scale * (lfoLikeNode(s) ? modDepth : 1);
    s.connect(g).connect(param);
  };
  function lfoLikeNode(s) { for (const k of LFO_LIKE) if (src[k] === s) return true; return false; }

  // --- Filtri e drive ---
  const accentCents = accent ? 700 : 0;
  const mkFilter = (cfg) => {
    const f = ctx.createBiquadFilter();
    f.type = cfg.type;
    f.frequency.value = Math.min(18000, cfg.cut * Math.pow(2, (p.cut || 0) * 3));
    f.Q.value = Math.min(25, cfg.res * Math.pow(2, (p.res || 0) * 1.5));
    f.detune.value = accentCents;
    return f;
  };
  const f1 = mkFilter(W.f1);
  const f2 = W.f2.type !== 'none' ? mkFilter(W.f2) : null;
  const pre = ctx.createGain();
  let entry = pre;
  if (W.drive > 0) {
    const ws = ctx.createWaveShaper();
    ws.curve = driveCurve(W.drive);
    ws.oversample = '4x';
    const comp = ctx.createGain();
    comp.gain.value = 1 / (1 + W.drive);
    pre.connect(ws).connect(comp);
    entry = comp;
  }
  if (!f2) entry.connect(f1).connect(amp);
  else if (W.route === 'serial') entry.connect(f1).connect(f2).connect(amp);
  else {
    const g1 = ctx.createGain(), g2 = ctx.createGain();
    g1.gain.value = 1 - W.mix; g2.gain.value = W.mix;
    entry.connect(f1).connect(g1).connect(amp);
    entry.connect(f2).connect(g2).connect(amp);
  }

  // --- Bus di posizione per oscillatore (segnale -1..1) ---
  // Se la posizione di un oscillatore non è modulata i pesi dei frame sono costanti: bastano i
  // 1-2 frame vicini con guadagni fissi (niente bus, niente waveshaper, 2 oscillatori invece di 4).
  const posMod = W.osc.map((_, i) => W.mod.some((m) => m.amt && MOD_SOURCES.includes(m.src) && (m.dst === 'pos' || m.dst === `pos${i + 1}`)));
  const posBus = W.osc.map((o, i) => {
    if (!o.level || !posMod[i]) return null;
    const bus = ctx.createGain();
    const off = ctx.createConstantSource();
    off.offset.value = Math.min(1, Math.max(0, o.pos + (p.pos || 0))) * 2 - 1;
    off.connect(bus);
    sources.push(off);
    return bus;
  });

  // --- Oscillatori: frame pesati dalla posizione ---
  const mix = ctx.createGain();
  const activeLvl = W.osc.reduce((x, o) => x + o.level, 0) || 1;
  mix.gain.value = 1 / activeLvl;
  mix.connect(pre);
  const pitchBus = ctx.createGain();     // somma delle modulazioni di pitch (cent) → detune di tutti gli oscillatori
  const pitchMod = W.mod.some((m) => m.dst === 'pitch' && m.amt);
  const oscs = [];
  const glide = glideFrom != null && pr.glide ? pr.glide : 0;
  // Oscillatore di modulazione (uno per nota): ring mod sul volume e phase mod sulla frequenza
  const MO = W.modosc || { rm: [0, 0, 0], pm: [0, 0, 0], semi: 0, fine: 0, shape: 'sine' };
  const pmDest = W.mod.some((m) => m.dst === 'pm' && m.amt);
  const useMO = MO.rm.some((x) => x > 0) || MO.pm.some((x) => x > 0) || pmDest;
  const pmAmts = [];                                 // quantità di phase mod per nota (modulabile dalla matrice)
  const modOsc = new Map(), pmNote = new Map();
  const modOf = (n) => {
    if (!useMO) return null;
    if (!modOsc.has(n)) {
      const o = ctx.createOscillator();
      o.type = MO.shape;
      o.frequency.setValueAtTime(mtof(n + MO.semi), t);
      o.detune.value = MO.fine;
      if (pitchMod) pitchBus.connect(o.detune);
      oscs.push(o);
      modOsc.set(n, o);
      const g = ctx.createGain();
      o.connect(g);
      pmNote.set(n, g);
      pmAmts.push(g);
    }
    return modOsc.get(n);
  };
  W.osc.forEach((o, i) => {
    if (!o.level) return;
    let weights = null, fixed = null;
    if (posMod[i]) {
      weights = windowCurves.map((curve) => {
        const sh = ctx.createWaveShaper();
        sh.curve = curve;
        posBus[i].connect(sh);
        return sh;
      });
    } else {
      const x = Math.min(1, Math.max(0, o.pos + (p.pos || 0))) * (F - 1);
      fixed = Array.from({ length: F }, (_, k) => Math.max(0, 1 - Math.abs(x - k)));
    }
    const voices = i === 0 ? W.uni.voices : 1;
    const spread = voices === 1 ? [0] : voices === 2 ? [-0.5, 0.5] : [-1, 0, 1];
    const lvl = ctx.createGain();
    lvl.gain.value = o.level / voices;
    lvl.connect(mix);
    for (const n of notes) {
      const mo = modOf(n);
      // Ring mod: volume dell'oscillatore = (1 − rm) + rm · modulatore
      let dest = lvl;
      if (mo && MO.rm[i] > 0) {
        dest = ctx.createGain();
        dest.gain.value = 1 - MO.rm[i];
        const rg = ctx.createGain();
        rg.gain.value = MO.rm[i];
        mo.connect(rg).connect(dest.gain);
        dest.connect(lvl);
      }
      // Phase mod (come FM): modulatore → frequenza, indice proporzionale alla nota
      let pmIn = null;
      if (mo && (MO.pm[i] > 0 || pmDest)) {
        pmIn = ctx.createGain();
        pmIn.gain.value = MO.pm[i] * 3 * mtof(n + o.semi);
        pmNote.get(n).connect(pmIn);
      }
      for (const sp of spread) {
        for (let k = 0; k < F; k++) {
          if (fixed && fixed[k] <= 0) continue;
          const osc = ctx.createOscillator();
          osc.setPeriodicWave(wave(ctx, o.table, k));
          const target = mtof(n + o.semi);
          if (glide) {
            osc.frequency.setValueAtTime(mtof(glideFrom + (n - notes[0]) + o.semi), t);
            osc.frequency.exponentialRampToValueAtTime(target, t + glide);
          } else {
            osc.frequency.setValueAtTime(target, t);
          }
          osc.detune.value = o.fine + sp * W.uni.detune;
          if (pitchMod) pitchBus.connect(osc.detune);
          const fg = ctx.createGain();
          if (fixed) fg.gain.value = fixed[k];
          else { fg.gain.value = 0; weights[k].connect(fg.gain); }
          osc.connect(fg).connect(dest);
          if (pmIn) pmIn.connect(osc.frequency);
          oscs.push(osc);
        }
      }
    }
  });
  const noiseDest = W.mod.some((m) => m.dst === 'noise' && m.amt);
  let noiseGain = null;
  if (W.noise > 0 || noiseDest) {
    const n = ctx.createBufferSource();
    n.buffer = getNoise(ctx);
    n.loop = true;
    noiseGain = ctx.createGain();
    noiseGain.gain.value = W.noise * 0.6;
    n.connect(noiseGain).connect(pre);
    sources.push(n);
  }

  // --- Matrice di modulazione ---
  let tremDepth = 0;
  const envAmt = p.env ?? 1;
  for (const m of W.mod) {
    const s0 = src[m.src];
    if (!s0 || !m.amt) continue;
    const amt = m.amt * (m.src.startsWith('env') ? envAmt : 1);
    switch (m.dst) {
      case 'pos': posBus.forEach((b) => b && route(s0, b, 2 * amt)); break;
      case 'pos1': case 'pos2': case 'pos3': { const b = posBus[+m.dst[3] - 1]; if (b) route(s0, b, 2 * amt); break; }
      case 'cut': route(s0, f1.detune, amt * 4800); if (f2) route(s0, f2.detune, amt * 4800); break;
      case 'cut1': route(s0, f1.detune, amt * 4800); break;
      case 'cut2': if (f2) route(s0, f2.detune, amt * 4800); break;
      case 'pitch': route(s0, pitchBus, amt * 1200); break;
      case 'res': route(s0, f1.Q, amt * 10); break;
      case 'pm': pmAmts.forEach((g) => route(s0, g.gain, amt * 2)); break;
      case 'noise': if (noiseGain) route(s0, noiseGain.gain, amt * 0.6); break;
      case 'amp': {
        // Sorgenti unipolari (inviluppo, step, velocity): 0 → volume ridotto di |amt| (gate);
        // LFO bipolari: oscillazione di ±|amt|/2 attorno a 1 - |amt|/2
        const bip = BIPOLAR.has(m.src);
        route(s0, trem.gain, bip ? amt / 2 : Math.abs(amt));
        tremDepth += Math.abs(amt) * (bip ? 0.5 : 1);
        break;
      }
      default: break;
    }
  }
  trem.gain.value = 1 - Math.min(0.95, tremDepth);

  sources.forEach((x) => x.start(t));
  oscs.forEach((x) => x.start(t));

  let released = false;
  const all = () => sources.concat(oscs);
  const handle = {
    release(at) {
      if (released) return;
      released = true;
      const when = Math.max(at, ctx.currentTime);
      rel.gain.setValueAtTime(1, when);
      rel.gain.setTargetAtTime(0, when, Math.max(0.005, r / 4));
      envs.forEach(([g, e]) => g.gain.setTargetAtTime(0, when, Math.max(0.01, e.r / 3)));
      all().forEach((o) => { try { o.stop(when + r * 1.6 + 0.05); } catch (_) { /* già fermo */ } });
    },
    kill(at) {
      const when = Math.max(at, ctx.currentTime);
      released = true;
      rel.gain.setTargetAtTime(0, when, 0.004);
      all().forEach((o) => { try { o.stop(when + 0.04); } catch (_) { /* già fermo */ } });
    },
  };
  if (dur != null) handle.release(t + Math.max(0.01, dur));
  return handle;
}

// =====================================================================
// Preset wavetable (nomi e suoni originali)
// =====================================================================

const O3 = (a, b = {}, c = {}) => [{ table: 'analog', pos: 0, semi: 0, fine: 0, level: 1, ...a }, { table: 'analog', pos: 0, semi: 0, fine: 0, level: 0, ...b }, { table: 'analog', pos: 0, semi: -12, fine: 0, level: 0, ...c }];
const P = (name, tags, amp, wt) => normalizeWTPreset({ name, cat: 'Wavetable', tags: ['wavetable', ...tags], ...amp, wt });
const GATE = [1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1];

export const WT_PRESETS = {
  wtGrowl: P('Growl Bass', ['bass', 'dubstep', 'aggressive'], { a: 0.003, d: 0.4, s: 0.9, r: 0.1, gain: 1.1 }, {
    osc: O3({ table: 'growl', pos: 0.2 }, { semi: -12, level: 0.6 }), f1: { type: 'lowpass', cut: 700, res: 4 }, drive: 0.5,
    lfo1: { shape: 'sine', rate: 2, sync: 0.5 }, mod: [{ src: 'lfo1', dst: 'pos1', amt: 0.6 }, { src: 'lfo1', dst: 'cut', amt: 0.35 }] }),
  wtTalk: P('Talking Bass', ['bass', 'vocal', 'evolving'], { a: 0.004, d: 0.4, s: 0.9, r: 0.12 }, {
    osc: O3({ table: 'formant', pos: 0 }, { semi: -12, level: 0.4 }), f1: { type: 'lowpass', cut: 2500, res: 2 }, drive: 0.3,
    lfo1: { shape: 'triangle', rate: 1, sync: 1 }, mod: [{ src: 'lfo1', dst: 'pos1', amt: 0.9 }] }),
  wtNeuro: P('Neuro Bass', ['bass', 'dnb', 'aggressive'], { a: 0.002, d: 0.3, s: 0.8, r: 0.1, gain: 1.5 }, {
    osc: O3({ table: 'fm', pos: 0.5 }, { table: 'growl', pos: 0.6, level: 0.7 }), uni: { voices: 2, detune: 15 },
    f1: { type: 'lowpass', cut: 900, res: 6 }, f2: { type: 'bandpass', cut: 1300, res: 3 }, route: 'parallel', mix: 0.4, drive: 0.7,
    env2: { a: 0.001, d: 0.25, s: 0, r: 0.1 }, step: { values: [0, 0.8, 0.3, 1, 0, 0.6, 0.2, 0.9, 0, 0.8, 0.4, 1, 0.1, 0.7, 0.3, 0.9], div: 1 },
    mod: [{ src: 'step', dst: 'pos', amt: 0.5 }, { src: 'env2', dst: 'cut', amt: 0.5 }] }),
  wtSubWobble: P('Sub Wobble', ['bass', 'sub', 'dubstep'], { a: 0.004, d: 0.3, s: 0.9, r: 0.1 }, {
    osc: O3({ table: 'analog', pos: 0.05 }, {}, { table: 'harmonic', pos: 0, level: 0.8 }), f1: { type: 'lowpass', cut: 300, res: 8 },
    lfo1: { shape: 'sine', rate: 2, sync: 0.5 }, mod: [{ src: 'lfo1', dst: 'cut', amt: 0.7 }] }),
  wtStepBass: P('Step Filter Bass', ['bass', 'rhythmic', 'acid'], { a: 0.003, d: 0.3, s: 0.9, r: 0.1, gain: 0.75 }, {
    osc: O3({ table: 'analog', pos: 0.25 }), f1: { type: 'lowpass', cut: 450, res: 9 }, drive: 0.3,
    step: { values: [1, 0.2, 0.6, 0.1, 0.9, 0.3, 0.5, 0, 1, 0.4, 0.7, 0.1, 0.8, 0.2, 0.6, 0.3], div: 1 },
    mod: [{ src: 'step', dst: 'cut', amt: 0.8 }] }),
  wtHoover: P('Hoover Lead', ['lead', 'rave', 'wide'], { a: 0.01, d: 0.4, s: 0.9, r: 0.3, glide: 0.1 }, {
    osc: O3({ table: 'analog', pos: 0.6 }, { table: 'analog', pos: 0.3, semi: -12, level: 0.7 }), uni: { voices: 3, detune: 35 },
    f1: { type: 'lowpass', cut: 4000, res: 1 }, env2: { a: 0.001, d: 0.3, s: 0, r: 0.2 }, mod: [{ src: 'env2', dst: 'pitch', amt: -0.15 }] }),
  wtSyncLead: P('Sync Sweep Lead', ['lead', 'bright', 'classic'], { a: 0.005, d: 0.5, s: 0.85, r: 0.25, gain: 1.4 }, {
    osc: O3({ table: 'sync', pos: 0 }), uni: { voices: 2, detune: 8 }, f1: { type: 'lowpass', cut: 6000, res: 1 },
    env2: { a: 0.001, d: 0.6, s: 0.2, r: 0.3 }, mod: [{ src: 'env2', dst: 'pos1', amt: 0.9 }] }),
  wtFormantLead: P('Formant Lead', ['lead', 'vocal', 'expressive'], { a: 0.02, d: 0.4, s: 0.9, r: 0.25, glide: 0.06, gain: 1.4 }, {
    osc: O3({ table: 'formant', pos: 0.3 }, { table: 'analog', pos: 0, level: 0.4 }), f1: { type: 'lowpass', cut: 7000, res: 0.8 },
    lfo1: { shape: 'sine', rate: 5.5, sync: 0 }, lfo2: { shape: 'triangle', rate: 0.5, sync: 0 },
    mod: [{ src: 'lfo2', dst: 'pos1', amt: 0.5 }, { src: 'lfo1', dst: 'pitch', amt: 0.02 }] }),
  wtDigiPluck: P('Digital Pluck', ['pluck', 'digital', 'bright'], { a: 0.001, d: 0.5, s: 0, r: 0.2 }, {
    osc: O3({ table: 'digital', pos: 0.2 }, { table: 'fm', pos: 0.6, level: 0.5 }), f1: { type: 'lowpass', cut: 800, res: 3 },
    env2: { a: 0.001, d: 0.25, s: 0, r: 0.1 }, mod: [{ src: 'env2', dst: 'cut', amt: 0.8 }, { src: 'env2', dst: 'pos', amt: 0.4 }] }),
  wtGlassKeys: P('Glass Keys', ['keys', 'fm', 'soft'], { a: 0.002, d: 1.4, s: 0.2, r: 0.6 }, {
    osc: O3({ table: 'fm', pos: 0.3 }, { table: 'harmonic', pos: 0.2, semi: 12, level: 0.4 }), f1: { type: 'lowpass', cut: 9000, res: 0.7 },
    env2: { a: 0.001, d: 0.8, s: 0, r: 0.3 }, mod: [{ src: 'env2', dst: 'pos1', amt: 0.5 }] }),
  wtBell: P('Morph Bell', ['bell', 'fm', 'cinematic'], { a: 0.001, d: 2, s: 0, r: 1.2 }, {
    osc: O3({ table: 'fm', pos: 0.9 }, { table: 'digital', pos: 0.4, semi: 24, level: 0.3 }), f1: { type: 'lowpass', cut: 10000, res: 0.7 },
    env2: { a: 0.001, d: 1.5, s: 0, r: 0.5 }, mod: [{ src: 'env2', dst: 'pos1', amt: -0.8 }] }),
  wtEvolve: P('Evolving Pad', ['pad', 'evolving', 'ambient'], { a: 1.2, d: 2, s: 0.9, r: 2.5 }, {
    osc: O3({ table: 'harmonic', pos: 0.3 }, { table: 'formant', pos: 0.5, semi: 12, level: 0.5 }), uni: { voices: 2, detune: 18 },
    f1: { type: 'lowpass', cut: 2500, res: 1 }, lfo1: { shape: 'sine', rate: 0.08, sync: 0 }, lfo2: { shape: 'triangle', rate: 0.13, sync: 0 },
    mod: [{ src: 'lfo1', dst: 'pos1', amt: 0.6 }, { src: 'lfo2', dst: 'pos2', amt: 0.7 }, { src: 'lfo2', dst: 'cut', amt: 0.2 }] }),
  wtShimmer: P('Shimmer Pad', ['pad', 'bright', 'airy'], { a: 0.8, d: 2, s: 0.9, r: 2 }, {
    osc: O3({ table: 'digital', pos: 0.1, semi: 12, level: 0.6 }, { table: 'analog', pos: 0, level: 0.8 }),
    f1: { type: 'highpass', cut: 300, res: 1 }, f2: { type: 'lowpass', cut: 6000, res: 1 }, route: 'serial',
    lfo1: { shape: 'sine', rate: 6, sync: 0 }, lfo2: { shape: 'sine', rate: 0.2, sync: 0 },
    mod: [{ src: 'lfo1', dst: 'amp', amt: 0.2 }, { src: 'lfo2', dst: 'pos1', amt: 0.7 }] }),
  wtGate: P('Trance Gate Pad', ['pad', 'trance', 'rhythmic'], { a: 0.05, d: 1, s: 1, r: 0.6, gain: 1.4 }, {
    osc: O3({ table: 'analog', pos: 0 }), uni: { voices: 3, detune: 20 }, f1: { type: 'lowpass', cut: 3500, res: 1 },
    step: { values: GATE, div: 1 }, mod: [{ src: 'step', dst: 'amp', amt: 1 }] }),
  wtChoir: P('Vocal Morph Choir', ['choir', 'vocal', 'lush'], { a: 0.4, d: 1, s: 0.9, r: 1.2, gain: 1.8 }, {
    osc: O3({ table: 'formant', pos: 0 }), uni: { voices: 3, detune: 14 }, f1: { type: 'lowpass', cut: 5000, res: 0.8 },
    lfo1: { shape: 'sine', rate: 0.15, sync: 0 }, mod: [{ src: 'lfo1', dst: 'pos1', amt: 0.9 }] }),
  wtRiser: P('Wavetable Riser', ['fx', 'riser', 'build-up'], { a: 3, d: 1, s: 1, r: 0.5 }, {
    osc: O3({ table: 'sync', pos: 0 }), uni: { voices: 3, detune: 25 }, noise: 0.4, f1: { type: 'highpass', cut: 200, res: 2 },
    env2: { a: 4, d: 1, s: 1, r: 0.5 }, mod: [{ src: 'env2', dst: 'pos', amt: 0.9 }, { src: 'env2', dst: 'cut', amt: 0.8 }, { src: 'env2', dst: 'pitch', amt: 0.3 }] }),
  wtRingBell: P('Ring Mod Bell', ['bell', 'metallic', 'ring'], { a: 0.002, d: 1.4, s: 0, r: 1.2, gain: 1.3 }, {
    osc: O3({ table: 'harmonic', pos: 0.4 }, { table: 'fm', pos: 0.2, semi: 12, level: 0.4 }),
    modosc: { shape: 'sine', semi: 7, fine: 0, rm: [0.7, 0.4, 0], pm: [0, 0, 0] },
    f1: { type: 'lowpass', cut: 9000, res: 1 }, env3: { a: 0.001, d: 1.2, s: 0, r: 0.8 },
    mod: [{ src: 'env3', dst: 'cut', amt: 0.4 }, { src: 'lfo3', dst: 'pitch', amt: 0.01 }], lfo3: { shape: 'sine', rate: 5, sync: 0 } }),
  wtPmGrowl: P('Phase Mod Growl', ['bass', 'growl', 'phase mod'], { a: 0.003, d: 0.4, s: 0.9, r: 0.12, gain: 1.1 }, {
    osc: O3({ table: 'analog', pos: 0.1 }, { semi: -12, level: 0.5 }),
    modosc: { shape: 'sine', semi: 0, fine: 0, rm: [0, 0, 0], pm: [0.35, 0, 0] },
    f1: { type: 'lowpass', cut: 1400, res: 3 }, drive: 0.4,
    lfo4: { shape: 'triangle', rate: 2, sync: 0.5 }, macros: [0.6, 0, 0, 0, 0, 0, 0, 0],
    mod: [{ src: 'lfo4', dst: 'pm', amt: 0.5 }, { src: 'm1', dst: 'cut', amt: 0.3 }, { src: 'lfo4', dst: 'pos1', amt: 0.4 }] }),
};
