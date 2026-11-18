/**
 * kits.js — Sintesi dei suoni (nessun campione esterno).
 *
 * Ogni voce è una factory: voice(opzioni) → play(ctx, out, time, velocity, p)
 *   - ctx:      AudioContext
 *   - out:      AudioNode di destinazione (canale della traccia)
 *   - time:     istante (ctx.currentTime based) di attacco
 *   - velocity: 0..1
 *   - p:        { tune (semitoni, -12..12), decay (moltiplicatore, 0.2..2.5) }
 * Volume e pan sono gestiti dal mixer in engine.js.
 */

// =====================================================================
// Helper di sintesi
// =====================================================================

const noiseCache = new WeakMap();

/** Buffer di rumore bianco (2 s) condiviso per AudioContext. */
export function getNoise(ctx) {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    const len = ctx.sampleRate * 2;
    buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, buf);
  }
  return buf;
}

const ratio = (p) => Math.pow(2, (p && p.tune ? p.tune : 0) / 12);
const dmul = (p) => (p && typeof p.decay === 'number' ? p.decay : 1);
const EPS = 0.0001;

/** Gain con inviluppo esponenziale attacco/decadimento. */
function vca(ctx, out, t, peak, dur, attack = 0.001) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(EPS, t);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, EPS * 2), t + attack);
  g.gain.exponentialRampToValueAtTime(EPS, t + attack + Math.max(dur, 0.005));
  g.connect(out);
  return g;
}

/** Sorgente di rumore che parte in un punto casuale del buffer. */
function noiseSrc(ctx, t, dur) {
  const s = ctx.createBufferSource();
  s.buffer = getNoise(ctx);
  s.loop = true;
  s.start(t, Math.random() * 1.5);
  s.stop(t + dur + 0.05);
  return s;
}

function filt(ctx, type, freq, Q = 0.7) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = Math.min(freq, ctx.sampleRate / 2 - 100);
  f.Q.value = Q;
  return f;
}

function osc(ctx, type, freq, t, dur) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  o.start(t);
  o.stop(t + dur + 0.05);
  return o;
}

const driveCache = new Map();
/** Curva di saturazione tanh normalizzata. */
function driveCurve(amount) {
  if (!driveCache.has(amount)) {
    const n = 2048, c = new Float32Array(n), k = 1 + amount * 6;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * k) / Math.tanh(k);
    }
    driveCache.set(amount, c);
  }
  return driveCache.get(amount);
}

// =====================================================================
// Voci parametriche
// =====================================================================

/** Cassa: sinusoide con pitch-sweep esponenziale, click e drive opzionali. */
export const kick = ({ start = 150, end = 50, sweep = 0.05, decay = 0.5, click = 0, drive = 0,
  noise = 0, noiseFreq = 1500, type = 'sine', level = 1 } = {}) =>
  (ctx, out, t, v, p) => {
    const k = ratio(p), dur = decay * dmul(p);
    const amp = vca(ctx, out, t, v * level, dur, 0.0015);
    const o = osc(ctx, type, start * k, t, dur);
    o.frequency.exponentialRampToValueAtTime(end * k, t + sweep);
    if (drive) {
      const ws = ctx.createWaveShaper();
      ws.curve = driveCurve(drive);
      o.connect(ws).connect(amp);
    } else {
      o.connect(amp);
    }
    if (click) {
      const g = vca(ctx, out, t, v * click, 0.01);
      noiseSrc(ctx, t, 0.02).connect(filt(ctx, 'highpass', 2500)).connect(g);
    }
    if (noise) {
      const g = vca(ctx, out, t, v * noise, dur * 0.4);
      noiseSrc(ctx, t, dur).connect(filt(ctx, 'bandpass', noiseFreq, 1)).connect(g);
    }
    return amp;
  };

/** Rullante: corpo tonale (1-2 oscillatori con leggero drop) + rumore filtrato. */
export const snare = ({ tones = [180, 330], oscType = 'triangle', drop = 1.4, sweep = 0.03,
  toneDecay = 0.12, toneLevel = 0.6, nType = 'highpass', nFreq = 1800, nQ = 0.7,
  nDecay = 0.18, noiseLevel = 0.7 } = {}) =>
  (ctx, out, t, v, p) => {
    const k = ratio(p), d = dmul(p);
    const bus = ctx.createGain();
    bus.connect(out);
    const tg = vca(ctx, bus, t, (v * toneLevel) / tones.length, toneDecay * d);
    for (const f of tones) {
      const o = osc(ctx, oscType, f * k * drop, t, toneDecay * d);
      o.frequency.exponentialRampToValueAtTime(f * k, t + sweep);
      o.connect(tg);
    }
    const ng = vca(ctx, bus, t, v * noiseLevel, nDecay * d);
    noiseSrc(ctx, t, nDecay * d).connect(filt(ctx, nType, nFreq * k, nQ)).connect(ng);
    return bus;
  };

/** Clap (e guiro): raffiche di rumore band-pass + coda. */
export const clap = ({ freq = 1100, q = 1.2, bursts = 3, spacing = 0.011, burstDecay = 0.008,
  tail = 0.18, level = 0.9 } = {}) =>
  (ctx, out, t, v, p) => {
    const k = ratio(p), d = dmul(p);
    const g = ctx.createGain();
    g.gain.setValueAtTime(EPS, t);
    for (let i = 0; i < bursts; i++) {
      const bt = t + i * spacing;
      g.gain.setValueAtTime(v * level, bt);
      g.gain.exponentialRampToValueAtTime(v * level * 0.08 + EPS, bt + burstDecay);
    }
    const tt = t + bursts * spacing;
    g.gain.setValueAtTime(v * level * 0.75, tt);
    g.gain.exponentialRampToValueAtTime(EPS, tt + tail * d);
    noiseSrc(ctx, t, bursts * spacing + tail * d)
      .connect(filt(ctx, 'bandpass', freq * k, q)).connect(g).connect(out);
    return g;
  };

/** Rimshot / clave / click: oscillatori brevissimi, opzionalmente filtrati. */
export const rim = ({ freqs = [500, 1700], type = 'square', decay = 0.035, hp = 600,
  level = 0.5 } = {}) =>
  (ctx, out, t, v, p) => {
    const k = ratio(p), dur = decay * dmul(p);
    const amp = vca(ctx, out, t, (v * level) / freqs.length, dur);
    const dest = hp ? filt(ctx, 'highpass', hp * k) : amp;
    if (hp) dest.connect(amp);
    for (const f of freqs) osc(ctx, type, f * k, t, dur).connect(dest);
    return amp;
  };

/** Frequenze inarmoniche "metalliche" (stile circuito hat/cymbal 808). */
const METAL_808 = [205.3, 304.4, 369.6, 522.7, 540, 800];
const METAL_909 = [245, 306.5, 365.8, 415.3, 437.9, 619.9];

/** Hat / piatti: sei square inarmoniche → band-pass → high-pass (+ rumore). */
export const metal = ({ freqs = METAL_808, mult = 1, bp = 10000, bpQ = 1, hp = 7000,
  decay = 0.06, level = 0.5, noise = 0, type = 'square', attack = 0.001 } = {}) =>
  (ctx, out, t, v, p) => {
    const k = ratio(p) * mult, dur = decay * dmul(p);
    const amp = vca(ctx, out, t, v * level, dur, attack);
    const b = filt(ctx, 'bandpass', bp, bpQ);
    const h = filt(ctx, 'highpass', hp);
    b.connect(h).connect(amp);
    const og = ctx.createGain();
    og.gain.value = 1 / freqs.length;
    og.connect(b);
    for (const f of freqs) osc(ctx, type, f * k, t, dur).connect(og);
    if (noise) {
      const ng = ctx.createGain();
      ng.gain.value = noise;
      noiseSrc(ctx, t, dur).connect(ng).connect(b);
    }
    return amp;
  };

/** Tom / conga / bongo: oscillatore con pitch-sweep, rumore opzionale. */
export const tom = ({ start = 200, end = 120, sweep = 0.15, decay = 0.4, type = 'sine',
  noise = 0, noiseFreq = 1200, level = 0.9 } = {}) =>
  (ctx, out, t, v, p) => {
    const k = ratio(p), dur = decay * dmul(p);
    const amp = vca(ctx, out, t, v * level, dur, 0.002);
    const o = osc(ctx, type, start * k, t, dur);
    o.frequency.exponentialRampToValueAtTime(end * k, t + sweep);
    o.connect(amp);
    if (noise) {
      const g = vca(ctx, out, t, v * noise, dur * 0.5);
      noiseSrc(ctx, t, dur).connect(filt(ctx, 'bandpass', noiseFreq * k, 0.9)).connect(g);
    }
    return amp;
  };

/** Cowbell: due square detunate → band-pass, inviluppo a due stadi. */
export const cowbell = ({ freqs = [540, 800], bp = 2640, q = 1.2, decay = 0.35, level = 0.45 } = {}) =>
  (ctx, out, t, v, p) => {
    const k = ratio(p), dur = decay * dmul(p);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(EPS, t);
    amp.gain.exponentialRampToValueAtTime(v * level, t + 0.001);
    amp.gain.exponentialRampToValueAtTime(v * level * 0.35, t + 0.03);
    amp.gain.exponentialRampToValueAtTime(EPS, t + 0.03 + dur);
    amp.connect(out);
    const f = filt(ctx, 'bandpass', bp * k, q);
    f.connect(amp);
    for (const fr of freqs) osc(ctx, 'square', fr * k, t, dur + 0.03).connect(f);
    return amp;
  };

// =====================================================================
// Libreria kit
// =====================================================================
// crush: bit di quantizzazione (carattere "campionato"), lp: filtro anti-alias
// del convertitore. demo: 8 righe × 16 step ('.' off, 'x' normale, 'X' accento).

const T = (name, short, play, pan = 0) => ({ name, short, play, pan });

export const KITS = [
  {
    id: 'tr808', name: 'Roland TR-808', bpm: 112, swing: 54,
    tracks: [
      T('Kick', 'BD', kick({ start: 115, end: 47, sweep: 0.07, decay: 1.25, level: 1.05 })),
      T('Snare', 'SD', snare({ tones: [238, 476], oscType: 'sine', drop: 1.15, toneDecay: 0.11, toneLevel: 0.55, nFreq: 1800, nDecay: 0.2, noiseLevel: 0.55 })),
      T('Clap', 'CP', clap({ freq: 1000, q: 1.1, bursts: 4, spacing: 0.01, tail: 0.22 }), -0.15),
      T('Closed Hat', 'CH', metal({ hp: 7500, bp: 10000, decay: 0.045, level: 0.55 }), 0.25),
      T('Open Hat', 'OH', metal({ hp: 7000, bp: 9500, decay: 0.42, level: 0.45 }), 0.25),
      T('Tom', 'TM', tom({ start: 180, end: 140, sweep: 0.2, decay: 0.5, noise: 0.05 }), -0.3),
      T('Cymbal', 'CY', metal({ hp: 5000, bp: 7500, bpQ: 0.5, decay: 1.4, level: 0.4, noise: 0.15 }), 0.35),
      T('Cowbell', 'CB', cowbell(), -0.2),
    ],
    demo: [
      'X..x..x...X..x..',
      '....X.......X...',
      '............x...',
      'x.x.x.x.x.x.x.xx',
      '..............x.',
      '..........x.x...',
      'X...............',
      '..x....x..x.....',
    ],
  },
  {
    id: 'tr909', name: 'Roland TR-909', bpm: 126, swing: 50,
    tracks: [
      T('Kick', 'BD', kick({ start: 260, end: 52, sweep: 0.035, decay: 0.55, click: 0.5, drive: 0.4 })),
      T('Snare', 'SD', snare({ tones: [185, 330], oscType: 'triangle', drop: 1.6, sweep: 0.02, toneDecay: 0.1, toneLevel: 0.7, nType: 'highpass', nFreq: 2500, nDecay: 0.22, noiseLevel: 0.75 })),
      T('Clap', 'CP', clap({ freq: 1250, q: 1.4, bursts: 4, spacing: 0.009, tail: 0.25 }), -0.15),
      T('Closed Hat', 'CH', metal({ freqs: METAL_909, mult: 1.6, hp: 8500, bp: 11000, bpQ: 0.8, decay: 0.05, level: 0.6, noise: 0.08 }), 0.25),
      T('Open Hat', 'OH', metal({ freqs: METAL_909, mult: 1.6, hp: 8000, bp: 10500, bpQ: 0.8, decay: 0.32, level: 0.5, noise: 0.08 }), 0.25),
      T('Tom', 'TM', tom({ start: 230, end: 150, sweep: 0.12, decay: 0.35, noise: 0.12, noiseFreq: 900 }), -0.3),
      T('Ride', 'RD', metal({ freqs: METAL_909, mult: 2.1, hp: 3500, bp: 6500, bpQ: 1.4, decay: 1.2, level: 0.35, noise: 0.05 }), 0.35),
      T('Rimshot', 'RS', rim({ freqs: [455, 1660], decay: 0.04, hp: 500 }), -0.2),
    ],
    demo: [
      'X...X...X...X...',
      '....x.......x..x',
      '....X.......X...',
      'x...x...x...x...',
      '..X...X...X...X.',
      '................',
      'X...............',
      '...x......x..x..',
    ],
  },
  {
    id: 'tr606', name: 'Roland TR-606', bpm: 132, swing: 50,
    tracks: [
      T('Kick', 'BD', kick({ start: 140, end: 60, sweep: 0.03, decay: 0.28, click: 0.1 })),
      T('Snare', 'SD', snare({ tones: [260], oscType: 'triangle', drop: 1.2, toneDecay: 0.06, toneLevel: 0.4, nFreq: 3500, nDecay: 0.14, noiseLevel: 0.75 })),
      T('Rim', 'RM', rim({ freqs: [820, 1400], decay: 0.025, hp: 700 }), -0.15),
      T('Closed Hat', 'CH', metal({ mult: 1.25, hp: 8500, bp: 12000, decay: 0.035, level: 0.55 }), 0.25),
      T('Open Hat', 'OH', metal({ mult: 1.25, hp: 8000, bp: 11000, decay: 0.25, level: 0.45 }), 0.25),
      T('Tom', 'TM', tom({ start: 210, end: 170, sweep: 0.1, decay: 0.25 }), -0.3),
      T('Cymbal', 'CY', metal({ mult: 1.1, hp: 6000, bp: 9000, bpQ: 0.6, decay: 0.9, level: 0.35, noise: 0.25 }), 0.35),
      T('Clave', 'CL', rim({ freqs: [2500], type: 'sine', decay: 0.05, hp: 0, level: 0.6 }), -0.2),
    ],
    demo: [
      'X...x...X..x.x..',
      '....X.......X...',
      '..x.......x.....',
      'XxxxXxxxXxxxXxxx',
      '......x.......x.',
      '..............xx',
      'X...............',
      'x..x..x...x..x..',
    ],
  },
  {
    id: 'cr78', name: 'Roland CR-78', bpm: 104, swing: 58,
    tracks: [
      T('Kick', 'BD', kick({ start: 95, end: 62, sweep: 0.04, decay: 0.3, level: 0.9 })),
      T('Snare', 'SD', snare({ tones: [300], oscType: 'sine', drop: 1.05, toneDecay: 0.05, toneLevel: 0.35, nType: 'bandpass', nFreq: 4200, nQ: 0.9, nDecay: 0.12, noiseLevel: 0.6 })),
      T('Rim', 'RM', rim({ freqs: [1100], type: 'sine', decay: 0.03, hp: 0, level: 0.5 }), -0.15),
      T('Closed Hat', 'CH', metal({ mult: 1.4, hp: 9000, bp: 11000, bpQ: 1.5, decay: 0.03, level: 0.6, noise: 0.15 }), 0.25),
      T('Open Hat', 'OH', metal({ mult: 1.4, hp: 8500, bp: 10500, bpQ: 1.5, decay: 0.2, level: 0.5, noise: 0.15 }), 0.25),
      T('Bongo', 'BG', tom({ start: 420, end: 380, sweep: 0.03, decay: 0.12, level: 0.6 }), -0.3),
      T('Cymbal', 'CY', metal({ mult: 1.2, hp: 6500, bp: 8500, bpQ: 0.7, decay: 0.8, level: 0.3, noise: 0.3 }), 0.35),
      T('Guiro', 'GU', clap({ freq: 3400, q: 4, bursts: 8, spacing: 0.016, burstDecay: 0.01, tail: 0.03, level: 0.6 }), -0.2),
    ],
    demo: [
      'X.....x.X.....x.',
      '....x.......x...',
      '..x..x....x..x..',
      'x.x.x.x.x.x.x.x.',
      '................',
      '......x.x...x.x.',
      'X...............',
      'x.......x.......',
    ],
  },
  {
    id: 'lm1', name: 'Linn LM-1', bpm: 100, swing: 56, crush: 8, lp: 11000,
    tracks: [
      T('Kick', 'BD', kick({ start: 150, end: 55, sweep: 0.04, decay: 0.35, click: 0.25, drive: 0.6 })),
      T('Snare', 'SD', snare({ tones: [200, 280], drop: 1.3, toneDecay: 0.09, toneLevel: 0.7, nType: 'bandpass', nFreq: 3000, nQ: 0.6, nDecay: 0.2, noiseLevel: 0.75 })),
      T('Clap', 'CP', clap({ freq: 1300, q: 1, bursts: 3, spacing: 0.012, tail: 0.16 }), -0.15),
      T('Closed Hat', 'CH', metal({ mult: 1.8, hp: 7000, bp: 9000, bpQ: 0.6, decay: 0.05, level: 0.45, noise: 0.5 }), 0.25),
      T('Open Hat', 'OH', metal({ mult: 1.8, hp: 6500, bp: 8500, bpQ: 0.6, decay: 0.35, level: 0.4, noise: 0.5 }), 0.25),
      T('Tom', 'TM', tom({ start: 200, end: 110, sweep: 0.2, decay: 0.45, noise: 0.15 }), -0.3),
      T('Ride', 'RD', metal({ mult: 2.4, hp: 3000, bp: 5200, bpQ: 1.8, decay: 1.1, level: 0.3, noise: 0.15 }), 0.35),
      T('Conga', 'CG', tom({ start: 340, end: 290, sweep: 0.03, decay: 0.22, level: 0.7 }), -0.2),
    ],
    demo: [
      'X..x..X...x..x..',
      '....X.......X..x',
      '............x...',
      'xxXxxxXxxxXxxxXx',
      '..............x.',
      '................',
      '................',
      '..x..x.x..x..x.x',
    ],
  },
  {
    id: 'linndrum', name: 'LinnDrum', bpm: 116, swing: 50, crush: 8, lp: 14000,
    tracks: [
      T('Kick', 'BD', kick({ start: 130, end: 54, sweep: 0.045, decay: 0.42, click: 0.35, drive: 0.4 })),
      T('Snare', 'SD', snare({ tones: [190, 310], drop: 1.4, toneDecay: 0.11, toneLevel: 0.7, nFreq: 2200, nDecay: 0.26, noiseLevel: 0.8 })),
      T('Clap', 'CP', clap({ freq: 1150, q: 1.2, bursts: 4, spacing: 0.01, tail: 0.2 }), -0.15),
      T('Closed Hat', 'CH', metal({ mult: 1.7, hp: 7500, bp: 10000, bpQ: 0.7, decay: 0.05, level: 0.45, noise: 0.45 }), 0.25),
      T('Open Hat', 'OH', metal({ mult: 1.7, hp: 7000, bp: 9500, bpQ: 0.7, decay: 0.4, level: 0.4, noise: 0.45 }), 0.25),
      T('Tom', 'TM', tom({ start: 220, end: 120, sweep: 0.18, decay: 0.5, noise: 0.12 }), -0.3),
      T('Crash', 'CR', metal({ mult: 1.3, hp: 4500, bp: 7000, bpQ: 0.5, decay: 1.6, level: 0.35, noise: 0.4 }), 0.35),
      T('Cowbell', 'CB', cowbell({ freqs: [560, 845], decay: 0.3 }), -0.2),
    ],
    demo: [
      'X.....x.X.......',
      '....X.......X...',
      '....x.......x...',
      'x.x.x.x.x.x.x.x.',
      '...............x',
      '............xxx.',
      'X...............',
      '..x...x...x...x.',
    ],
  },
  {
    id: 'dmx', name: 'Oberheim DMX', bpm: 98, swing: 52, crush: 8, lp: 12000,
    tracks: [
      T('Kick', 'BD', kick({ start: 180, end: 50, sweep: 0.05, decay: 0.48, click: 0.3, drive: 0.8, level: 0.95 })),
      T('Snare', 'SD', snare({ tones: [175, 290], drop: 1.5, toneDecay: 0.12, toneLevel: 0.75, nType: 'bandpass', nFreq: 2600, nQ: 0.5, nDecay: 0.25, noiseLevel: 0.85 })),
      T('Clap', 'CP', clap({ freq: 1050, q: 1, bursts: 3, spacing: 0.013, tail: 0.2 }), -0.15),
      T('Closed Hat', 'CH', metal({ mult: 1.9, hp: 7000, bp: 9000, bpQ: 0.5, decay: 0.055, level: 0.45, noise: 0.6 }), 0.25),
      T('Open Hat', 'OH', metal({ mult: 1.9, hp: 6500, bp: 8500, bpQ: 0.5, decay: 0.38, level: 0.4, noise: 0.6 }), 0.25),
      T('Tom', 'TM', tom({ start: 190, end: 105, sweep: 0.2, decay: 0.5, noise: 0.1 }), -0.3),
      T('Crash', 'CR', metal({ mult: 1.2, hp: 4000, bp: 6500, bpQ: 0.5, decay: 1.5, level: 0.35, noise: 0.45 }), 0.35),
      T('Tambourine', 'TB', metal({ freqs: [2200, 3100, 4500, 5700, 6800, 7900], hp: 6000, bp: 8000, bpQ: 0.6, decay: 0.2, level: 0.45, noise: 0.6 }), -0.2),
    ],
    demo: [
      'X......x..X.....',
      '....X.......X...',
      '....x.......x...',
      'x.x.x.x.x.x.x.xx',
      '......x.........',
      '................',
      '................',
      '....x.......x...',
    ],
  },
  {
    id: 'sdsv', name: 'Simmons SDS-V', bpm: 120, swing: 50,
    tracks: [
      T('Kick', 'BD', kick({ start: 320, end: 58, sweep: 0.11, decay: 0.42, noise: 0.15, noiseFreq: 900, type: 'triangle' })),
      T('Snare', 'SD', snare({ tones: [230], oscType: 'sine', drop: 2.0, sweep: 0.08, toneDecay: 0.25, toneLevel: 0.75, nType: 'bandpass', nFreq: 3000, nQ: 0.8, nDecay: 0.25, noiseLevel: 0.6 })),
      T('Rim', 'RM', rim({ freqs: [900, 1800], type: 'triangle', decay: 0.03, hp: 400 }), -0.15),
      T('Closed Hat', 'CH', metal({ mult: 2.2, hp: 8000, bp: 10000, bpQ: 0.5, decay: 0.05, level: 0.35, noise: 0.9 }), 0.25),
      T('Open Hat', 'OH', metal({ mult: 2.2, hp: 7500, bp: 9500, bpQ: 0.5, decay: 0.35, level: 0.3, noise: 0.9 }), 0.25),
      T('Tom Lo', 'TL', tom({ start: 360, end: 95, sweep: 0.3, decay: 0.55, type: 'triangle', noise: 0.18, noiseFreq: 1500 }), -0.35),
      T('Cymbal', 'CY', metal({ mult: 1.5, hp: 5000, bp: 7000, bpQ: 0.4, decay: 1.3, level: 0.3, noise: 1.2 }), 0.35),
      T('Tom Hi', 'TH', tom({ start: 600, end: 180, sweep: 0.25, decay: 0.4, type: 'triangle', noise: 0.15, noiseFreq: 2200 }), 0.1),
    ],
    demo: [
      'X.......X.x.....',
      '....X.......X...',
      '................',
      'x.x.x.x.x.x.x.x.',
      '................',
      '............x.X.',
      'X...............',
      '..........X.x...',
    ],
  },
  {
    id: 'drumtraks', name: 'Sequential Drumtraks', bpm: 118, swing: 50, crush: 10, lp: 13000,
    tracks: [
      T('Kick', 'BD', kick({ start: 140, end: 52, sweep: 0.05, decay: 0.42, click: 0.25, drive: 0.3 })),
      T('Snare', 'SD', snare({ tones: [195, 320], drop: 1.35, toneDecay: 0.1, toneLevel: 0.65, nFreq: 2000, nDecay: 0.22, noiseLevel: 0.8 })),
      T('Clap', 'CP', clap({ freq: 1200, q: 1.3, bursts: 3, spacing: 0.011, tail: 0.18 }), -0.15),
      T('Closed Hat', 'CH', metal({ mult: 1.6, hp: 7500, bp: 10000, bpQ: 0.7, decay: 0.05, level: 0.45, noise: 0.4 }), 0.25),
      T('Open Hat', 'OH', metal({ mult: 1.6, hp: 7000, bp: 9500, bpQ: 0.7, decay: 0.36, level: 0.4, noise: 0.4 }), 0.25),
      T('Tom', 'TM', tom({ start: 210, end: 115, sweep: 0.18, decay: 0.45, noise: 0.1 }), -0.3),
      T('Crash', 'CR', metal({ mult: 1.25, hp: 4500, bp: 7000, bpQ: 0.5, decay: 1.5, level: 0.35, noise: 0.4 }), 0.35),
      T('Cowbell', 'CB', cowbell({ freqs: [580, 870], decay: 0.28 }), -0.2),
    ],
    demo: [
      'X...x.x.X...x...',
      '....X.......X...',
      '...........x....',
      'XxxxXxxxXxxxXxxx',
      '................',
      '................',
      'X...............',
      'x..x..x..x..x...',
    ],
  },
  {
    id: 'drumulator', name: 'E-mu Drumulator', bpm: 108, swing: 55, crush: 9, lp: 10000,
    tracks: [
      T('Kick', 'BD', kick({ start: 160, end: 50, sweep: 0.05, decay: 0.38, click: 0.3, drive: 0.7 })),
      T('Snare', 'SD', snare({ tones: [185, 300], drop: 1.4, toneDecay: 0.1, toneLevel: 0.7, nType: 'bandpass', nFreq: 2400, nQ: 0.6, nDecay: 0.22, noiseLevel: 0.8 })),
      T('Clap', 'CP', clap({ freq: 1100, q: 1, bursts: 3, spacing: 0.012, tail: 0.17 }), -0.15),
      T('Closed Hat', 'CH', metal({ mult: 1.8, hp: 7000, bp: 9000, bpQ: 0.6, decay: 0.05, level: 0.45, noise: 0.55 }), 0.25),
      T('Open Hat', 'OH', metal({ mult: 1.8, hp: 6500, bp: 8500, bpQ: 0.6, decay: 0.33, level: 0.4, noise: 0.55 }), 0.25),
      T('Tom', 'TM', tom({ start: 200, end: 110, sweep: 0.2, decay: 0.45, noise: 0.12 }), -0.3),
      T('Ride', 'RD', metal({ mult: 2.3, hp: 3200, bp: 5500, bpQ: 1.6, decay: 1.0, level: 0.3, noise: 0.2 }), 0.35),
      T('Clave', 'CL', rim({ freqs: [2450], type: 'sine', decay: 0.06, hp: 0, level: 0.6 }), -0.2),
    ],
    demo: [
      'X..x.x..X..x....',
      '....X..x....X...',
      '....x.......x...',
      'x.xxx.xxx.xxx.xx',
      '..x...x...x...x.',
      '................',
      '................',
      '..x..x....x..x..',
    ],
  },
];

export const kitById = (id) => findKit(id) || KITS[0];

// =====================================================================
// Kit utente (composti da voci di kit diversi)
// =====================================================================
// def = { id: 'u:…', name, crush: 0|bit, map: [{ kit, track }] × 8 }

export const USER_KITS = [];

/** Costruisce un kit utilizzabile dal motore a partire dalla sua definizione. */
export function buildUserKit(def) {
  const base = KITS.find((k) => k.id === (def.map[0] && def.map[0].kit)) || KITS[0];
  return {
    id: def.id, name: def.name, user: true, def,
    bpm: base.bpm, swing: base.swing,
    crush: def.crush || undefined, lp: def.crush ? 12000 : undefined,
    demo: base.demo,
    tracks: def.map.map((m, i) => {
      const src = (KITS.find((k) => k.id === m.kit) || base).tracks[m.track] || base.tracks[i];
      return { ...src };
    }),
  };
}

/** Sostituisce l'elenco dei kit utente. */
export function setUserKits(defs) {
  USER_KITS.length = 0;
  for (const d of defs || []) {
    if (!d || typeof d.id !== 'string' || !Array.isArray(d.map) || d.map.length !== 8) continue;
    USER_KITS.push(buildUserKit(d));
  }
}

export const findKit = (id) => KITS.find((k) => k.id === id) || USER_KITS.find((k) => k.id === id) || null;
export const allKits = () => KITS.concat(USER_KITS);
