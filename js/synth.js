/**
 * synth.js — Sintetizzatori sottrattivi/FM, preset e teoria musicale (scale, accordi).
 *
 * Quattro tracce melodiche: 0 BASS, 1 LEAD (mono), 2 PAD, 3 KEYS (accordi).
 * Ogni voce: oscillatori/sorgenti generate (+ FM, rumore) → drive → formanti → low-pass con
 * inviluppo → VCA ADSR → tremolo → release. Preset in presets.js.
 * playVoice(...) restituisce un handle { release(time) } per note tenute dal vivo.
 */

// =====================================================================
// Teoria: note, scale, accordi
// =====================================================================

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (n) => NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
export const pitchClass = (n) => NOTE_NAMES[((n % 12) + 12) % 12];
export const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);

export const SCALES = {
  minor: { name: 'Minore', iv: [0, 2, 3, 5, 7, 8, 10] },
  major: { name: 'Maggiore', iv: [0, 2, 4, 5, 7, 9, 11] },
  dorian: { name: 'Dorica', iv: [0, 2, 3, 5, 7, 9, 10] },
  phrygian: { name: 'Frigia', iv: [0, 1, 3, 5, 7, 8, 10] },
  mixolydian: { name: 'Misolidia', iv: [0, 2, 4, 5, 7, 9, 10] },
  harmonic: { name: 'Minore armonica', iv: [0, 2, 3, 5, 7, 8, 11] },
  pentaMinor: { name: 'Pentatonica min.', iv: [0, 3, 5, 7, 10] },
  pentaMajor: { name: 'Pentatonica magg.', iv: [0, 2, 4, 7, 9] },
  blues: { name: 'Blues', iv: [0, 3, 5, 6, 7, 10] },
};

/** Nota del grado `deg` (0 = tonica, può superare l'ottava) a partire da `base` (MIDI della tonica). */
export function degreeNote(base, scale, deg) {
  const iv = (SCALES[scale] || SCALES.minor).iv;
  const oct = Math.floor(deg / iv.length);
  return base + oct * 12 + iv[((deg % iv.length) + iv.length) % iv.length];
}

/** Grado di scala della nota (il più vicino verso il basso). */
function degreeOf(note, key, scale) {
  const iv = (SCALES[scale] || SCALES.minor).iv;
  const rel = ((note - key) % 12 + 12) % 12;
  let d = 0;
  for (let i = 0; i < iv.length; i++) if (iv[i] <= rel) d = i;
  return d;
}

export const CHORD_TYPES = { triad: 'Triade', seventh: 'Settima', sus4: 'Sus4', single: 'Nota' };

/**
 * Accordo diatonico costruito sulla nota `root` nella tonalità/scala date.
 * @returns {number[]} intervalli in semitoni da root (es. [0,3,7])
 */
export function diatonicChord(root, key, scale, type = 'triad') {
  if (type === 'single') return [0];
  // Pentatoniche/blues non hanno terze diatoniche: si usa la scala a 7 note più vicina
  const ref = SCALES[scale] && SCALES[scale].iv.length === 7 ? scale : scale === 'pentaMajor' ? 'major' : 'minor';
  const iv = SCALES[ref].iv;
  const d = degreeOf(root, key, ref);
  const steps = type === 'seventh' ? [0, 2, 4, 6] : type === 'sus4' ? [0, 3, 4] : [0, 2, 4];
  const abs = (k) => iv[k % 7] + Math.floor(k / 7) * 12;
  return steps.map((s) => abs(d + s) - abs(d));
}

/** Nome dell'accordo da root + intervalli (es. "Am7"). */
export function chordName(root, ch) {
  if (!ch || ch.length < 2) return pitchClass(root);
  const k = ch.join(',');
  const suffix = {
    '0,4,7': '', '0,3,7': 'm', '0,3,6': 'dim', '0,4,8': 'aug', '0,5,7': 'sus4', '0,2,7': 'sus2',
    '0,4,7,11': 'maj7', '0,3,7,10': 'm7', '0,4,7,10': '7', '0,3,6,10': 'm7♭5', '0,3,6,9': 'dim7', '0,3,7,11': 'mMaj7', '0,4,8,11': 'maj7#5',
  }[k];
  return pitchClass(root) + (suffix !== undefined ? suffix : '+');
}

// =====================================================================
// Preset e tracce
// =====================================================================

import { PRESETS } from './presets.js';
import { getNoise } from './kits.js';

export { PRESETS };

/** Tracce synth: BASS e LEAD monofoniche, PAD e KEYS polifoniche (accordi). */
export const SYNTH_TRACKS = [
  { name: 'Bass', short: 'BS', oct: 2, preset: 'acid303', mono: true },
  { name: 'Lead', short: 'LD', oct: 4, preset: 'sh101lead', mono: true },
  { name: 'Pad', short: 'PD', oct: 3, preset: 'juno', mono: false },
  { name: 'Keys', short: 'KY', oct: 4, preset: 'epiano', mono: false },
];
export const isChordTrack = (k) => !SYNTH_TRACKS[k].mono;

/** Macro utente di una traccia (con default). */
export const voiceParams = (tr) => ({
  cut: tr.cut || 0, res: tr.res || 0, env: tr.env ?? 1, dec: tr.dec ?? 1,
  atk: tr.atk ?? 1, rel: tr.rel ?? 1, lfo: tr.lfo ?? 1, rate: tr.rate ?? 1,
});

/** Coda di rilascio (s) di un preset con i parametri utente. */
export const releaseTime = (pr, p) => pr.r * Math.sqrt(p.dec ?? 1) * (p.rel ?? 1);

// =====================================================================
// Sorgenti generate in JS (cache per preset/nota/sample rate)
// =====================================================================

const genCache = new Map();

/** Corda pizzicata (Karplus-Strong). */
function genPluck(sr, freq, g) {
  const N = Math.max(2, Math.round(sr / freq));
  const total = Math.floor(sr * g.len);
  const out = new Float32Array(total);
  const buf = new Float32Array(N);
  let prev = 0;
  const k = 0.15 + 0.85 * g.bright;
  for (let i = 0; i < N; i++) { prev += ((Math.random() * 2 - 1) - prev) * k; buf[i] = prev; }
  let idx = 0;
  for (let i = 0; i < total; i++) {
    const a = buf[idx], b = buf[idx + 1 === N ? 0 : idx + 1];
    out[i] = a;
    buf[idx] = g.damp * 0.5 * (a + b);
    idx = idx + 1 === N ? 0 : idx + 1;
  }
  return out;
}

/** Piano additivo: parziali inarmoniche, corde doppie leggermente scordate, colpo del martelletto. */
function genPiano(sr, freq, g) {
  const total = Math.floor(sr * g.len);
  const out = new Float32Array(total);
  const K = Math.max(3, Math.min(14, Math.floor(sr / 2.2 / freq)));
  const baseTau = g.len * 0.45 * Math.pow(261.6 / freq, 0.45);
  for (let k = 1; k <= K; k++) {
    const fk = k * freq * Math.sqrt(1 + g.B * k * k);
    if (fk > sr / 2.2) break;
    const amp = Math.pow(k, -(1.05 + (1 - g.bright) * 0.9)) * (0.6 + 0.4 * Math.abs(Math.sin(k * 0.95)));
    const tau = baseTau / (1 + 0.3 * (k - 1));
    for (const det of [1, 1 + g.beat]) {
      // Oscillatore ricorsivo (niente Math.sin per campione)
      const w = (2 * Math.PI * fk * det) / sr;
      const c = 2 * Math.cos(w);
      let y1 = Math.sin(-w), y2 = Math.sin(-2 * w);
      const dec = Math.exp(-1 / (tau * sr));
      let e = amp * 0.5;
      for (let i = 0; i < total; i++) {
        const y = c * y1 - y2;
        y2 = y1; y1 = y;
        out[i] += y * e;
        e *= dec;
      }
    }
  }
  // Colpo del martelletto (rumore breve filtrato)
  const thump = Math.floor(sr * 0.012);
  let lp = 0;
  for (let i = 0; i < thump; i++) {
    lp += ((Math.random() * 2 - 1) - lp) * 0.3;
    out[i] += lp * 0.25 * (1 - i / thump);
  }
  return out;
}

function genBuffer(ctx, pr, note) {
  const key = `${pr.id}|${note}|${ctx.sampleRate}`;
  let b = genCache.get(key);
  if (!b) {
    const freq = mtof(note);
    const data = pr.gen.type === 'piano' ? genPiano(ctx.sampleRate, freq, pr.gen) : genPluck(ctx.sampleRate, freq, pr.gen);
    let pk = 0;
    for (let i = 0; i < data.length; i++) pk = Math.max(pk, Math.abs(data[i]));
    const norm = pk > 0 ? 0.9 / pk : 1;
    for (let i = 0; i < data.length; i++) data[i] *= norm;
    b = ctx.createBuffer(1, data.length, ctx.sampleRate);
    b.getChannelData(0).set(data);
    if (genCache.size > 400) genCache.delete(genCache.keys().next().value);
    genCache.set(key, b);
  }
  return b;
}

// =====================================================================
// Organo a drawbar (PeriodicWave)
// =====================================================================
// 9 drawbar 16' 5⅓' 8' 4' 2⅔' 2' 1⅗' 1⅓' 1': armoniche relative alla fondamentale del 16'
const DRAWBAR_HARM = [1, 3, 2, 4, 6, 8, 10, 12, 16];
const waveCache = new WeakMap();
function organWave(ctx, reg) {
  let m = waveCache.get(ctx);
  if (!m) { m = new Map(); waveCache.set(ctx, m); }
  if (!m.has(reg)) {
    const real = new Float32Array(17), imag = new Float32Array(17);
    [...reg].forEach((ch, i) => { imag[DRAWBAR_HARM[i]] += (+ch || 0) / 8; });
    m.set(reg, ctx.createPeriodicWave(real, imag));
  }
  return m.get(reg);
}

// =====================================================================
// Voce
// =====================================================================

const driveCache = new Map();
function driveCurve(amount) {
  const key = Math.round(amount * 20);
  if (!driveCache.has(key)) {
    const n = 1024, c = new Float32Array(n), k = 1 + amount * 8;
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * k) / Math.tanh(k); }
    driveCache.set(key, c);
  }
  return driveCache.get(key);
}

const EPS = 0.0001;

/**
 * Suona una voce (nota singola o accordo).
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} out
 * @param {number} t          inizio
 * @param {number|null} dur   durata del gate (s); null = tenuta fino a release()
 * @param {number[]} notes    note MIDI
 * @param {number} vel        0..1 (≥ 0.95 = accento)
 * @param {object} pr         preset
 * @param {object} p          macro utente { cut, res, env, dec, atk, rel, lfo, rate }
 * @param {number|null} glideFrom  nota da cui scivolare (slide)
 */
export function playVoice(ctx, out, t, dur, notes, vel, pr, p = {}, glideFrom = null) {
  const accent = vel >= 0.95;
  const decMul = p.dec ?? 1;
  const a = pr.a * (p.atk ?? 1), d = pr.d * decMul, s = pr.s, r = releaseTime(pr, p);
  const peak = ((0.38 + vel * 0.3) / Math.sqrt(notes.length)) * (pr.gain || 1);
  const sources = [];

  // --- Release (nodo separato: nessuna cancellazione di automazioni) ---
  const rel = ctx.createGain();
  rel.connect(out);
  let post = rel;

  // --- Tremolo (LFO sul volume) ---
  const lfoCfg = pr.lfo && (p.lfo ?? 1) > 0 ? pr.lfo : null;
  let lfoGain = null;
  if (lfoCfg) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = lfoCfg.rate * (p.rate ?? 1);
    lfoGain = ctx.createGain();
    const depth = lfoCfg.depth * (p.lfo ?? 1);
    if (lfoCfg.delay) {
      lfoGain.gain.setValueAtTime(0, t);
      lfoGain.gain.linearRampToValueAtTime(lfoCfg.to === 'amp' ? depth / 2 : depth, t + lfoCfg.delay);
    } else {
      lfoGain.gain.value = lfoCfg.to === 'amp' ? depth / 2 : depth;
    }
    lfo.connect(lfoGain);
    sources.push(lfo);
    if (lfoCfg.to === 'amp') {
      const trem = ctx.createGain();
      trem.gain.value = 1 - Math.min(0.95, depth) / 2;
      lfoGain.connect(trem.gain);
      trem.connect(rel);
      post = trem;
    }
  }

  // --- VCA ADS ---
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(EPS, t);
  // Attacchi lunghi lineari: quelli esponenziali restano quasi muti per gran parte della salita
  if (a >= 0.05) amp.gain.linearRampToValueAtTime(peak, t + a);
  else amp.gain.exponentialRampToValueAtTime(peak, t + Math.max(0.002, a));
  amp.gain.setTargetAtTime(Math.max(EPS, peak * s), t + a, Math.max(0.01, d / 3));
  amp.connect(post);

  // --- Filtro con inviluppo ---
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  const base = Math.min(18000, pr.cut * Math.pow(2, (p.cut || 0) * 3));
  const envAmt = pr.envOct * (p.env ?? 1) * (accent ? 1.35 : 1);
  const top = Math.min(18000, base * Math.pow(2, envAmt));
  f.frequency.setValueAtTime(base, t);
  f.frequency.exponentialRampToValueAtTime(Math.max(base, top), t + Math.max(0.003, a * 0.8));
  f.frequency.setTargetAtTime(base, t + a, Math.max(0.01, pr.fdec * decMul * (accent ? 0.7 : 1) / 3));
  f.Q.value = Math.min(25, pr.res * Math.pow(2, (p.res || 0) * 1.5) * (accent ? 1.2 : 1));
  f.connect(amp);
  if (lfoGain && lfoCfg.to === 'cut') {
    const lg = ctx.createGain();
    lg.gain.value = base;          // profondità in multipli del cutoff
    lfoGain.connect(lg).connect(f.frequency);
  }

  let dest = f;
  if (pr.drive) {
    const ws = ctx.createWaveShaper();
    ws.curve = driveCurve(pr.drive);
    ws.connect(f);
    dest = ws;
  }

  // --- Formanti (voci/cori): banco di passa-banda in parallelo ---
  if (pr.formants) {
    const sum = ctx.createGain();
    sum.connect(dest);
    const fin = ctx.createGain();
    for (const [fq, q, g] of pr.formants) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = fq;
      bp.Q.value = q;
      const bg = ctx.createGain();
      bg.gain.value = g;
      fin.connect(bp).connect(bg).connect(sum);
    }
    dest = fin;
  }

  // --- Strato di rumore ---
  if (pr.noise) {
    const n = ctx.createBufferSource();
    n.buffer = getNoise(ctx);
    n.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = pr.noise.hp || 20;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(pr.noise.g, t);
    if (pr.noise.d) ng.gain.setTargetAtTime(0, t, pr.noise.d / 3);
    n.connect(hp).connect(ng).connect(dest);
    sources.push(n);
  }

  // --- Oscillatori / sorgenti generate ---
  const mix = ctx.createGain();
  const totG = pr.osc.reduce((x, o) => x + o.g, 0);
  mix.gain.value = 1 / Math.max(1, totG);
  mix.connect(dest);
  const glide = glideFrom != null && pr.glide ? pr.glide : 0;
  for (const n of notes) {
    if (pr.gen) {
      const src = ctx.createBufferSource();
      src.buffer = genBuffer(ctx, pr, n);
      src.connect(mix);
      sources.push(src);
    }
    for (const o of pr.osc) {
      const osc = ctx.createOscillator();
      const organ = o.type.startsWith('organ:');
      if (organ) osc.setPeriodicWave(organWave(ctx, o.type.slice(6)));
      else osc.type = o.type;
      // L'organo usa come fondamentale il registro da 16' (un'ottava sotto)
      const target = mtof(n + o.oct * 12) / (organ ? 2 : 1);
      if (glide) {
        osc.frequency.setValueAtTime(mtof(glideFrom + (n - notes[0]) + o.oct * 12) / (organ ? 2 : 1), t);
        osc.frequency.exponentialRampToValueAtTime(target, t + glide);
      } else {
        osc.frequency.setValueAtTime(target, t);
      }
      if (pr.pitch) {
        osc.detune.setValueAtTime(o.det + pr.pitch.from * 100, t);
        osc.detune.linearRampToValueAtTime(o.det + pr.pitch.to * 100, t + pr.pitch.time);
      } else {
        osc.detune.value = o.det;
      }
      if (lfoGain && lfoCfg.to === 'pitch') lfoGain.connect(osc.detune);
      const g = ctx.createGain();
      g.gain.value = o.g;
      osc.connect(g).connect(mix);
      if (pr.fm) {
        const mod = ctx.createOscillator();
        mod.frequency.setValueAtTime(target * pr.fm.ratio, t);
        const mg = ctx.createGain();
        const depth = target * pr.fm.index * (0.6 + vel * 0.4);
        mg.gain.setValueAtTime(depth, t);
        mg.gain.setTargetAtTime(depth * 0.08, t, Math.max(0.01, pr.fm.decay * decMul / 3));
        mod.connect(mg).connect(osc.frequency);
        sources.push(mod);
      }
      sources.push(osc);
    }
  }
  sources.forEach((o) => o.start(t));

  let released = false;
  const handle = {
    release(at) {
      if (released) return;
      released = true;
      const when = Math.max(at, ctx.currentTime);
      rel.gain.setValueAtTime(1, when);
      rel.gain.setTargetAtTime(0, when, Math.max(0.005, r / 4));
      sources.forEach((o) => { try { o.stop(when + r * 1.6 + 0.05); } catch (_) { /* già fermo */ } });
    },
    /** Taglio rapido (voice stealing): sfuma in pochi ms e ferma le sorgenti. */
    kill(at) {
      const when = Math.max(at, ctx.currentTime);
      released = true;
      rel.gain.setTargetAtTime(0, when, 0.004);
      sources.forEach((o) => { try { o.stop(when + 0.04); } catch (_) { /* già fermo */ } });
    },
  };
  if (dur != null) handle.release(t + Math.max(0.01, dur));
  return handle;
}
