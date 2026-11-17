/**
 * sequencer.js — Modello del pattern e scheduler look-ahead.
 *
 * Pattern = { kit, bpm, swing, steps[8][16] (0 off, 1 normale, 2 accento),
 *             tracks[8] { vol, tune, decay, pan, mute, solo } }
 */

import { KITS, kitById } from './kits.js';

export const STEPS = 16;
export const TRACKS = 8;
export const VELOCITY = [0, 0.62, 1];      // livelli di velocity: off / normale / accento

const LOOKAHEAD_MS = 25;                   // periodo del timer
const SCHEDULE_AHEAD = 0.1;                // secondi pianificati in anticipo

const clamp = (v, lo, hi, def) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);

// =====================================================================
// Pattern
// =====================================================================

export function emptySteps() {
  return Array.from({ length: TRACKS }, () => new Array(STEPS).fill(0));
}

/** Converte le righe demo ('x..X') in matrice numerica. */
export function parseRows(rows) {
  return Array.from({ length: TRACKS }, (_, t) => {
    const r = (rows[t] || '').padEnd(STEPS, '.');
    return Array.from({ length: STEPS }, (_, s) => (r[s] === 'X' ? 2 : r[s] === 'x' ? 1 : 0));
  });
}

export function defaultTracks(kit) {
  return kit.tracks.map((tr) => ({ vol: 0.8, tune: 0, decay: 1, pan: tr.pan || 0, mute: false, solo: false }));
}

/** Nuovo pattern per un kit, con il suo groove demo. */
export function createPattern(kitId, withDemo = true) {
  const kit = kitById(kitId);
  return {
    kit: kit.id,
    bpm: kit.bpm || 120,
    swing: kit.swing || 50,
    steps: withDemo ? parseRows(kit.demo) : emptySteps(),
    tracks: defaultTracks(kit),
  };
}

/** Valida e normalizza un pattern (es. da JSON importato). */
export function normalizePattern(o) {
  if (!o || typeof o !== 'object') throw new Error('Pattern non valido');
  const kit = KITS.find((k) => k.id === o.kit) || KITS[0];
  const base = createPattern(kit.id, false);
  const steps = emptySteps();
  if (Array.isArray(o.steps)) {
    for (let t = 0; t < TRACKS; t++) {
      for (let s = 0; s < STEPS; s++) {
        const v = o.steps[t] && o.steps[t][s];
        steps[t][s] = v === 2 ? 2 : v ? 1 : 0;
      }
    }
  }
  const tracks = base.tracks.map((d, t) => {
    const src = (Array.isArray(o.tracks) && o.tracks[t]) || {};
    return {
      vol: clamp(src.vol, 0, 1, d.vol),
      tune: clamp(src.tune, -12, 12, d.tune),
      decay: clamp(src.decay, 0.2, 2.5, d.decay),
      pan: clamp(src.pan, -1, 1, d.pan),
      mute: !!src.mute,
      solo: !!src.solo,
    };
  });
  return {
    kit: kit.id,
    bpm: Math.round(clamp(o.bpm, 40, 240, base.bpm)),
    swing: Math.round(clamp(o.swing, 50, 75, base.swing)),
    steps,
    tracks,
  };
}

export const isEmpty = (pat) => pat.steps.every((r) => r.every((v) => !v));

// =====================================================================
// Scheduler
// =====================================================================

export class Sequencer {
  constructor(engine) {
    this.engine = engine;
    this.pattern = createPattern(KITS[0].id);
    this.playing = false;
    this.step = 0;          // prossimo step da pianificare
    this.nextTime = 0;      // istante del prossimo step (senza swing)
    this.timer = null;
    this.queue = [];        // { step, time } per la UI (playhead)
  }

  /** Durata di una semicroma. */
  get stepDur() { return 60 / this.pattern.bpm / 4; }

  start() {
    const ctx = this.engine.ctx;
    if (!ctx || this.playing) return;
    this.playing = true;
    this.step = 0;
    this.nextTime = ctx.currentTime + 0.06;
    this.queue.length = 0;
    this._tick();
    this.timer = setInterval(() => this._tick(), LOOKAHEAD_MS);
  }

  stop() {
    this.playing = false;
    clearInterval(this.timer);
    this.timer = null;
    this.queue.length = 0;
  }

  toggle() { this.playing ? this.stop() : this.start(); return this.playing; }

  /** Pianifica tutti gli step che cadono nella finestra di look-ahead. */
  _tick() {
    const ctx = this.engine.ctx;
    // Se il timer è rimasto indietro (tab in background), riallinea
    if (this.nextTime < ctx.currentTime - 0.2) this.nextTime = ctx.currentTime + 0.02;
    while (this.nextTime < ctx.currentTime + SCHEDULE_AHEAD) {
      this._schedule(this.step, this.nextTime + this._swingOffset(this.step));
      this.nextTime += this.stepDur;
      this.step = (this.step + 1) % STEPS;
    }
  }

  /** Swing: ritarda gli step dispari (50% = dritto, 75% = terzina piena). */
  _swingOffset(step) {
    if (step % 2 === 0) return 0;
    return (this.pattern.swing / 100 - 0.5) * 2 * this.stepDur;
  }

  _schedule(step, time) {
    const { steps, tracks } = this.pattern;
    const anySolo = tracks.some((t) => t.solo);
    for (let t = 0; t < TRACKS; t++) {
      const v = steps[t][step];
      if (!v) continue;
      const tr = tracks[t];
      if (anySolo ? !tr.solo : tr.mute) continue;
      this.engine.trigger(t, time, VELOCITY[v], tr);
    }
    this.queue.push({ step, time });
  }
}
