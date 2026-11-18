/**
 * sequencer.js — Modello del pattern e scheduler look-ahead.
 *
 * Pattern = {
 *   kit, bpm, swing,
 *   steps[8][16]  0 off, 1 normale, 2 accento
 *   opts[8][16]   null | { p: probabilità 0-100, r: ratchet 1-4, f: flam 0/1, n: nudge -50..50 (% step) }
 *   tracks[8]     { vol, tune, decay, pan, mute, solo, len (1-16), rev, dly (mandate 0-1) }
 *   synth         sezione melodica (vedi synthpattern.js)
 * }
 */

import { KITS, kitById } from './kits.js';
import { demoSynth, emptySynth, normalizeSynth } from './synthpattern.js';

export const STEPS = 16;
export const TRACKS = 8;
export const VELOCITY = [0, 0.62, 1];      // off / normale / accento
export const STEP_DEFAULT = Object.freeze({ p: 100, r: 1, f: 0, n: 0 });

const LOOKAHEAD_MS = 25;                   // periodo del timer
const SCHEDULE_AHEAD = 0.12;               // secondi pianificati in anticipo (tollera ~90 ms di blocco UI)
const FLAM_GAP = 0.022;                    // distanza nota di abbellimento (s)

const num = (v) => typeof v === 'number' && isFinite(v);
const clamp = (v, lo, hi, def) => (num(v) ? Math.min(hi, Math.max(lo, v)) : def);

// =====================================================================
// Pattern
// =====================================================================

export const emptySteps = () => Array.from({ length: TRACKS }, () => new Array(STEPS).fill(0));
export const emptyOpts = () => Array.from({ length: TRACKS }, () => new Array(STEPS).fill(null));

/** Converte le righe demo ('x..X') in matrice numerica. */
export function parseRows(rows) {
  return Array.from({ length: TRACKS }, (_, t) => {
    const r = (rows[t] || '').padEnd(STEPS, '.');
    return Array.from({ length: STEPS }, (_, s) => (r[s] === 'X' ? 2 : r[s] === 'x' ? 1 : 0));
  });
}

export function defaultTrack(kit, t) {
  return { vol: 0.8, tune: 0, decay: 1, pan: kit.tracks[t].pan || 0, mute: false, solo: false, len: STEPS, rev: 0, dly: 0 };
}
export const defaultTracks = (kit) => kit.tracks.map((_, t) => defaultTrack(kit, t));

/**
 * Nuovo pattern per un kit, con il suo groove demo.
 * @param {number|null} synthDemo  indice del groove synth demo (null = synth vuoto)
 */
export function createPattern(kitId, withDemo = true, synthDemo = null) {
  const kit = kitById(kitId);
  return {
    kit: kit.id,
    bpm: kit.bpm || 120,
    swing: kit.swing || 50,
    steps: withDemo ? parseRows(kit.demo) : emptySteps(),
    opts: emptyOpts(),
    tracks: defaultTracks(kit),
    synth: synthDemo === null ? emptySynth() : demoSynth(synthDemo),
  };
}

/** Normalizza le opzioni di uno step; null se tutte di default. */
export function normalizeOpt(o) {
  if (!o || typeof o !== 'object') return null;
  const r = {
    p: Math.round(clamp(o.p, 0, 100, 100)),
    r: Math.round(clamp(o.r, 1, 4, 1)),
    f: o.f ? 1 : 0,
    n: Math.round(clamp(o.n, -50, 50, 0)),
  };
  return r.p === 100 && r.r === 1 && !r.f && !r.n ? null : r;
}

/** Valida e normalizza un pattern (localStorage, JSON importato, versioni precedenti). */
export function normalizePattern(o) {
  if (!o || typeof o !== 'object') throw new Error('Pattern non valido');
  const kit = KITS.find((k) => k.id === o.kit) || KITS[0];
  const steps = emptySteps();
  const opts = emptyOpts();
  for (let t = 0; t < TRACKS; t++) {
    for (let s = 0; s < STEPS; s++) {
      const v = Array.isArray(o.steps) && o.steps[t] && o.steps[t][s];
      steps[t][s] = v === 2 ? 2 : v ? 1 : 0;
      opts[t][s] = normalizeOpt(Array.isArray(o.opts) && o.opts[t] && o.opts[t][s]);
    }
  }
  const tracks = defaultTracks(kit).map((d, t) => {
    const src = (Array.isArray(o.tracks) && o.tracks[t]) || {};
    return {
      vol: clamp(src.vol, 0, 1, d.vol),
      tune: clamp(src.tune, -12, 12, d.tune),
      decay: clamp(src.decay, 0.2, 2.5, d.decay),
      pan: clamp(src.pan, -1, 1, d.pan),
      mute: !!src.mute,
      solo: !!src.solo,
      len: Math.round(clamp(src.len, 1, STEPS, STEPS)),
      rev: clamp(src.rev, 0, 1, 0),
      dly: clamp(src.dly, 0, 1, 0),
    };
  });
  return {
    kit: kit.id,
    bpm: Math.round(clamp(o.bpm, 40, 240, kit.bpm || 120)),
    swing: Math.round(clamp(o.swing, 50, 75, kit.swing || 50)),
    steps,
    opts,
    tracks,
    synth: normalizeSynth(o.synth),
  };
}

export const isEmpty = (pat) => pat.steps.every((r) => r.every((v) => !v));
export const clonePattern = (pat) => JSON.parse(JSON.stringify(pat));

/** Durata di una semicroma. */
export const stepDuration = (bpm) => 60 / bpm / 4;

/** Swing: ritarda i tick dispari (50% = dritto, 75% = terzina piena). */
export const swingOffset = (tick, swing, stepDur) => (tick % 2 ? (swing / 100 - 0.5) * 2 * stepDur : 0);

/**
 * Pianifica un tick su un motore (live o offline).
 * Ogni traccia avanza con la propria lunghezza: step = tick % len (poliritmi).
 * @returns {Array<{t:number, time:number, vel:number}>} note effettivamente suonate
 */
export function scheduleTick(engine, pat, tick, time, opt = {}) {
  const { random = Math.random, skip = null } = opt;
  const sd = stepDuration(pat.bpm);
  const anySolo = pat.tracks.some((t) => t.solo);
  const played = [];
  for (let t = 0; t < TRACKS; t++) {
    const tr = pat.tracks[t];
    const s = tick % (tr.len || STEPS);
    const v = pat.steps[t][s];
    if (!v) continue;
    if (skip && skip.delete(`${t}:${s}`)) continue;     // già suonato dal vivo in registrazione
    if (anySolo ? !tr.solo : tr.mute) continue;
    const o = pat.opts && pat.opts[t][s];
    if (o && o.p < 100 && random() * 100 >= o.p) continue;
    let tt = time + (o ? (o.n / 100) * sd : 0);
    const vel = VELOCITY[v];
    if (o && o.f) {
      engine.trigger(t, tt, vel * 0.45, tr);
      played.push({ t, time: tt, vel: vel * 0.45 });
      tt += FLAM_GAP;
    }
    const r = o ? o.r : 1;
    for (let k = 0; k < r; k++) {
      const kv = k ? vel * 0.8 : vel;
      engine.trigger(t, tt + (k * sd) / r, kv, tr);
      played.push({ t, time: tt + (k * sd) / r, vel: kv });
    }
  }

  // ----- Sezione synth (BASS, LEAD, PAD) -----
  const syn = pat.synth;
  if (syn && engine.playSynth) {
    const anySynthSolo = syn.tracks.some((t) => t.solo);
    syn.tracks.forEach((tr, k) => {
      if (anySynthSolo ? !tr.solo : tr.mute) return;
      const s = tick % (tr.len || STEPS);
      if (!tr.steps[s]) return;
      if (skip && skip.delete(`s${k}:${s}`)) return;
      const ev = synthEvent(pat, k, s);
      engine.playSynth(k, time, ev.dur, ev.notes, ev.vel, tr, ev.glideFrom);
      played.push({ synth: k, notes: ev.notes, time, dur: ev.dur, vel: ev.vel });
    });
  }
  return played;
}

/**
 * Evento synth dello step s della traccia k (null se vuoto): note, durata, velocity, slide.
 * Usato dallo scheduler e dal pre-render delle voci.
 */
export function synthEvent(pat, k, s) {
  const tr = pat.synth.tracks[k];
  const len = tr.len || STEPS;
  const st = tr.steps[s];
  if (!st) return null;
  const prev = tr.steps[(s - 1 + len) % len];
  const glideFrom = k < 2 && prev && prev.sl && len > 1 ? prev.n : null;
  const notes = st.ch ? st.ch.map((x) => st.n + x) : [st.n];
  // Gate: le note con slide si sovrappongono alla successiva (legato)
  const dur = st.g * stepDuration(pat.bpm) * (st.sl ? 1.15 : 0.92);
  return { notes, dur, vel: st.a ? 1 : 0.7, glideFrom };
}

// =====================================================================
// Scheduler live
// =====================================================================

/**
 * Timer dello scheduler in un Web Worker: non viene ritardato da un thread principale
 * occupato né rallentato dal browser quando la pagina è in background.
 * Fallback su setInterval se i Worker non sono disponibili.
 */
function createTicker(fn, ms) {
  try {
    const src = `let id = null;
      onmessage = (e) => {
        clearInterval(id);
        id = e.data === 'start' ? setInterval(() => postMessage(0), ${ms}) : null;
      };`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = fn;
    return { start: () => w.postMessage('start'), stop: () => w.postMessage('stop') };
  } catch (_) {
    let id = null;
    return { start: () => { clearInterval(id); id = setInterval(fn, ms); }, stop: () => clearInterval(id) };
  }
}

export class Sequencer {
  constructor(engine) {
    this.engine = engine;
    this.pattern = createPattern(KITS[0].id);
    this.playing = false;
    this.tick = 0;            // prossimo tick da pianificare
    this.nextTime = 0;        // istante del prossimo tick (senza swing)
    this.ticker = null;       // timer (Worker), creato al primo start
    this.queue = [];          // { tick, time, pattern } per la UI
    this.recent = [];         // ultimi tick pianificati (registrazione)
    this.skip = new Set();    // step registrati dal vivo da non ripetere
    this.metronome = false;
    this.meta = null;         // dato opaco copiato nelle voci di coda (es. posizione song)
    // Hook
    this.onBar = null;        // (tick, time) → pattern successivo | null  (song mode)
    this.onTick = null;       // (tick, time, stepDur, played) → MIDI out/clock
    this.onStart = null;      // (time)
    this.onStop = null;       // ()
  }

  get stepDur() { return stepDuration(this.pattern.bpm); }

  start() {
    const ctx = this.engine.ctx;
    if (!ctx || this.playing) return;
    this.playing = true;
    this.tick = 0;
    this.nextTime = ctx.currentTime + 0.06;
    this.queue.length = 0;
    this.recent.length = 0;
    this.skip.clear();
    if (this.onStart) this.onStart(this.nextTime);
    this._tick();
    if (!this.ticker) this.ticker = createTicker(() => { if (this.playing) this._tick(); }, LOOKAHEAD_MS);
    this.ticker.start();
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    if (this.ticker) this.ticker.stop();
    this.queue.length = 0;
    if (this.onStop) this.onStop();
  }

  toggle() { this.playing ? this.stop() : this.start(); return this.playing; }

  /** Pianifica tutti i tick che cadono nella finestra di look-ahead. */
  _tick() {
    const ctx = this.engine.ctx;
    // Timer rimasto indietro (tab in background): riallinea
    if (this.nextTime < ctx.currentTime - 0.2) this.nextTime = ctx.currentTime + 0.02;
    while (this.nextTime < ctx.currentTime + SCHEDULE_AHEAD) {
      if (this.tick > 0 && this.tick % STEPS === 0 && this.onBar) {
        const np = this.onBar(this.tick, this.nextTime);
        if (np) this.pattern = np;
      }
      const sd = this.stepDur;
      const time = this.nextTime + swingOffset(this.tick, this.pattern.swing, sd);
      const played = scheduleTick(this.engine, this.pattern, this.tick, time, { skip: this.skip });
      if (this.metronome && this.tick % 4 === 0) this.engine.click(time, this.tick % STEPS === 0);
      if (this.onTick) this.onTick(this.tick, this.nextTime, sd, played);
      const entry = { tick: this.tick, time, pattern: this.pattern, meta: this.meta };
      this.queue.push(entry);
      if (this.queue.length > 64) this.queue.shift();
      this.recent.push(entry);
      if (this.recent.length > 8) this.recent.shift();
      this.nextTime += sd;
      this.tick++;
    }
  }

  /**
   * Quantizza un colpo dal vivo allo step più vicino.
   * @returns {{tick:number, future:boolean}|null}
   */
  quantize(time) {
    if (!this.playing) return null;
    let best = null;
    for (const e of this.recent) {
      if (!best || Math.abs(e.time - time) < Math.abs(best.time - time)) best = e;
    }
    // Il prossimo tick non ancora pianificato può essere più vicino (BPM bassi)
    const nt = this.nextTime + swingOffset(this.tick, this.pattern.swing, this.stepDur);
    if (!best || Math.abs(nt - time) < Math.abs(best.time - time)) return { tick: this.tick, future: true };
    return { tick: best.tick, future: false };
  }
}
