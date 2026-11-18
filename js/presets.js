/**
 * presets.js — Libreria dei suoni synth (tutti sintetizzati, nessun campione).
 *
 * Campi di un preset:
 *   name, cat (categoria), tags[]
 *   osc: [{ type, oct, det (cent), g }]   type: sine|square|sawtooth|triangle|organ:<9 drawbar>
 *   gen: { type: 'pluck'|'piano', ... }   sorgente generata in JS (corda pizzicata, piano additivo)
 *   fm: { ratio, index, decay }            modulazione di frequenza su ogni oscillatore
 *   noise: { g, hp, d }                    strato di rumore (hp = passa-alto, d = decay; assente = sostenuto)
 *   formants: [[freq, Q, gain], ...]       banco di formanti (voci, cori)
 *   lfo: { to: 'pitch'|'cut'|'amp', rate (Hz), depth, delay }
 *   pitch: { from, to, time }              inviluppo di pitch in semitoni
 *   cut, res, envOct, fdec                 filtro passa-basso e suo inviluppo
 *   a, d, s, r                             ADSR del volume
 *   glide, drive, gain
 * I nomi descrivono il suono e non indicano affiliazione con produttori di strumenti.
 */

export const CATEGORIES = ['Bass', 'Lead', 'Pad', 'Keys', 'Piano', 'Organ', 'Strings', 'Brass', 'Pluck', 'Mallet', 'Bell', 'Choir', 'FX'];

const O = (type, oct = 0, det = 0, g = 1) => ({ type, oct, det, g });

const RAW = {
  // ------------------------------------------------------------------ BASS
  acid303: { name: 'Acid 303', cat: 'Bass', tags: ['acid', 'analog', 'mono'], osc: [O('sawtooth')], cut: 260, res: 13, envOct: 4.2, fdec: 0.22, a: 0.003, d: 0.25, s: 0.15, r: 0.06, glide: 0.07, drive: 0.35 , gain: 0.85 },
  sh101bass: { name: 'Mono Bass 101', cat: 'Bass', tags: ['analog', 'mono', 'classic'], osc: [O('square'), O('square', -1, 0, 0.7)], cut: 420, res: 4, envOct: 3, fdec: 0.18, a: 0.002, d: 0.2, s: 0.35, r: 0.07, glide: 0.05 },
  moogbass: { name: 'Ladder Bass', cat: 'Bass', tags: ['analog', 'warm', 'classic'], osc: [O('sawtooth'), O('sawtooth', 0, 7), O('sawtooth', -1, -5, 0.7)], cut: 380, res: 3.5, envOct: 3, fdec: 0.28, a: 0.003, d: 0.35, s: 0.5, r: 0.1, glide: 0.06, drive: 0.45 },
  fmbass: { name: 'FM Bass', cat: 'Bass', tags: ['fm', 'bright', 'classic'], osc: [O('sine')], fm: { ratio: 1, index: 4.5, decay: 0.22 }, cut: 5000, res: 0.7, envOct: 0, fdec: 0.2, a: 0.002, d: 0.45, s: 0.25, r: 0.08, glide: 0.04 },
  reese: { name: 'Reese Bass', cat: 'Bass', tags: ['dark', 'evolving', 'dnb'], osc: [O('sawtooth', 0, -14), O('sawtooth', 0, 14), O('sine', -1, 0, 0.6)], cut: 700, res: 1.5, envOct: 1, fdec: 0.4, a: 0.01, d: 0.4, s: 0.8, r: 0.15, glide: 0.08, drive: 0.25 },
  subbass: { name: 'Sub Bass', cat: 'Bass', tags: ['sub', 'clean', 'deep'], osc: [O('sine'), O('triangle', 1, 0, 0.12)], cut: 900, res: 0.7, envOct: 0.3, fdec: 0.2, a: 0.004, d: 0.3, s: 0.9, r: 0.09, glide: 0.05, drive: 0.15 },
  wobble: { name: 'Wobble Bass', cat: 'Bass', tags: ['dubstep', 'evolving', 'dark'], osc: [O('sawtooth'), O('square', -1, 0, 0.6)], cut: 320, res: 7, envOct: 0.5, fdec: 0.3, a: 0.004, d: 0.3, s: 0.9, r: 0.1, lfo: { to: 'cut', rate: 4, depth: 5 }, drive: 0.4, gain: 0.7 },
  pluckbass: { name: 'Plucked Bass', cat: 'Bass', tags: ['physical', 'acoustic', 'warm'], osc: [], gen: { type: 'pluck', damp: 0.994, bright: 0.25, len: 1.6 }, cut: 2200, res: 0.7, envOct: 0, fdec: 0.3, a: 0.001, d: 1.5, s: 0.8, r: 0.12, gain: 1.4 },
  fretless: { name: 'Fretless Bass', cat: 'Bass', tags: ['warm', 'soft', 'jazz'], osc: [O('sine'), O('triangle', 0, 0, 0.5)], cut: 1200, res: 1.2, envOct: 1, fdec: 0.25, a: 0.02, d: 0.5, s: 0.7, r: 0.15, glide: 0.12, lfo: { to: 'pitch', rate: 5, depth: 12, delay: 0.3 } },

  // ------------------------------------------------------------------ LEAD
  sh101lead: { name: 'Mono Lead 101', cat: 'Lead', tags: ['analog', 'mono', 'classic'], osc: [O('square'), O('sawtooth', 0, 6, 0.6)], cut: 1500, res: 5, envOct: 2.2, fdec: 0.3, a: 0.004, d: 0.3, s: 0.6, r: 0.15, glide: 0.05 },
  mooglead: { name: 'Ladder Lead', cat: 'Lead', tags: ['analog', 'warm', 'classic'], osc: [O('sawtooth'), O('sawtooth', 0, -8), O('sawtooth', 1, 4, 0.5)], cut: 1900, res: 5.5, envOct: 2, fdec: 0.35, a: 0.006, d: 0.3, s: 0.8, r: 0.2, glide: 0.09, drive: 0.3 },
  ms20: { name: 'Screamer Lead', cat: 'Lead', tags: ['analog', 'aggressive', 'resonant'], osc: [O('sawtooth'), O('sawtooth', 0, 12, 0.5)], cut: 1100, res: 15, envOct: 3, fdec: 0.25, a: 0.003, d: 0.25, s: 0.55, r: 0.12, glide: 0.04, drive: 0.6 , gain: 0.8 },
  chip: { name: 'Chip Square', cat: 'Lead', tags: ['8-bit', 'retro', 'mono'], osc: [O('square')], cut: 9000, res: 0.6, envOct: 0, fdec: 0.1, a: 0.001, d: 0.1, s: 0.7, r: 0.04, glide: 0 , gain: 0.7 },
  supersaw: { name: 'Supersaw', cat: 'Lead', tags: ['trance', 'bright', 'wide'], osc: [O('sawtooth', 0, -24, 0.7), O('sawtooth', 0, -10), O('sawtooth'), O('sawtooth', 0, 10), O('sawtooth', 0, 24, 0.7)], cut: 6000, res: 0.8, envOct: 0.6, fdec: 0.4, a: 0.005, d: 0.4, s: 0.85, r: 0.3 , gain: 1.6 },
  sinelead: { name: 'Sine Lead', cat: 'Lead', tags: ['soft', 'clean', 'mono'], osc: [O('sine'), O('triangle', 1, 0, 0.2)], cut: 6000, res: 0.7, envOct: 0, fdec: 0.2, a: 0.01, d: 0.2, s: 0.9, r: 0.2, glide: 0.06, lfo: { to: 'pitch', rate: 5.5, depth: 15, delay: 0.25 } },
  voxlead: { name: 'Vox Lead', cat: 'Lead', tags: ['vocal', 'formant', 'mono'], osc: [O('sawtooth'), O('sawtooth', 0, 7, 0.6)], formants: [[700, 7, 1], [1220, 8, 0.6], [2600, 10, 0.35]], cut: 6000, res: 0.7, envOct: 0, fdec: 0.2, a: 0.02, d: 0.3, s: 0.85, r: 0.2, glide: 0.07, lfo: { to: 'pitch', rate: 5.2, depth: 14, delay: 0.3 }, gain: 2.6 },
  whistle: { name: 'Whistle', cat: 'Lead', tags: ['soft', 'airy', 'mono'], osc: [O('sine')], noise: { g: 0.08, hp: 2500 }, cut: 7000, res: 0.7, envOct: 0, fdec: 0.2, a: 0.04, d: 0.2, s: 0.9, r: 0.15, glide: 0.05, lfo: { to: 'pitch', rate: 6, depth: 18, delay: 0.2 } },

  // ------------------------------------------------------------------ PAD
  juno: { name: 'Poly Strings 106', cat: 'Pad', tags: ['analog', 'warm', 'classic'], osc: [O('sawtooth', 0, -9), O('sawtooth', 0, 9), O('square', -1, 0, 0.3)], cut: 2400, res: 1, envOct: 0.6, fdec: 1.2, a: 0.45, d: 1.2, s: 0.8, r: 1.2 },
  prophet: { name: 'Poly Pad 5', cat: 'Pad', tags: ['analog', 'warm', 'classic'], osc: [O('sawtooth', 0, -6), O('square', 0, 7, 0.6)], cut: 1700, res: 2, envOct: 1, fdec: 1.5, a: 0.6, d: 1.5, s: 0.7, r: 1.6 },
  cs80: { name: 'Dream Pad 80', cat: 'Pad', tags: ['analog', 'lush', 'classic'], osc: [O('sawtooth', 0, -5), O('sine', 1, 3, 0.4), O('sawtooth', 0, 5)], cut: 2000, res: 1.5, envOct: 0.8, fdec: 2, a: 1.0, d: 2, s: 0.85, r: 2.2 },
  glass: { name: 'Glass Pad', cat: 'Pad', tags: ['fm', 'bright', 'airy'], osc: [O('sine')], fm: { ratio: 2, index: 1.6, decay: 2.5 }, cut: 6000, res: 0.7, envOct: 0, fdec: 1, a: 0.3, d: 2, s: 0.6, r: 1.6 },
  warmpad: { name: 'Warm Sweep Pad', cat: 'Pad', tags: ['warm', 'evolving', 'analog'], osc: [O('sawtooth', 0, -12), O('sawtooth', 0, 12)], cut: 900, res: 2.5, envOct: 0.5, fdec: 2, a: 0.8, d: 2, s: 0.9, r: 1.8, lfo: { to: 'cut', rate: 0.25, depth: 1.2 } },
  airpad: { name: 'Air Pad', cat: 'Pad', tags: ['airy', 'ambient', 'evolving'], osc: [O('sine'), O('sine', 1, 4, 0.4)], noise: { g: 0.18, hp: 4000 }, cut: 5000, res: 1, envOct: 0, fdec: 1, a: 1.2, d: 2, s: 0.9, r: 2.5, lfo: { to: 'amp', rate: 0.3, depth: 0.3 } },
  darkpad: { name: 'Dark Pad', cat: 'Pad', tags: ['dark', 'cinematic', 'evolving'], osc: [O('sawtooth', 0, -7), O('square', -1, 7, 0.5)], cut: 550, res: 3, envOct: 0.4, fdec: 2, a: 1.0, d: 2, s: 0.9, r: 2.0, lfo: { to: 'cut', rate: 0.15, depth: 0.8 } },

  // ------------------------------------------------------------------ KEYS
  epiano: { name: 'Tine E-Piano', cat: 'Keys', tags: ['fm', 'vintage', 'soft'], osc: [O('sine'), O('sine', 1, 0, 0.12)], fm: { ratio: 1, index: 2.2, decay: 0.6 }, cut: 7000, res: 0.7, envOct: 0, fdec: 0.5, a: 0.002, d: 2.2, s: 0.05, r: 0.5, lfo: { to: 'amp', rate: 4.5, depth: 0.18 }, gain: 1.2 },
  reedpiano: { name: 'Reed E-Piano', cat: 'Keys', tags: ['vintage', 'gritty', 'fm'], osc: [O('triangle')], fm: { ratio: 1, index: 3.5, decay: 0.3 }, cut: 4500, res: 0.8, envOct: 0, fdec: 0.4, a: 0.002, d: 1.6, s: 0.1, r: 0.35, drive: 0.25, gain: 1.2 },
  clav: { name: 'Funk Clav', cat: 'Keys', tags: ['funk', 'bright', 'percussive'], osc: [O('square'), O('sawtooth', 0, 0, 0.5)], cut: 2500, res: 3, envOct: 2, fdec: 0.15, a: 0.001, d: 0.5, s: 0.1, r: 0.1 },
  fmkeys: { name: 'FM Keys', cat: 'Keys', tags: ['fm', 'bright', 'digital'], osc: [O('sine')], fm: { ratio: 2, index: 1.4, decay: 0.5 }, cut: 8000, res: 0.7, envOct: 0, fdec: 0.4, a: 0.002, d: 1.4, s: 0.15, r: 0.4, gain: 1.2 },

  // ------------------------------------------------------------------ PIANO
  grand: { name: 'Grand Piano', cat: 'Piano', tags: ['acoustic', 'bright', 'additive'], osc: [], gen: { type: 'piano', B: 0.0004, bright: 1, len: 3.2, beat: 0.0008 }, cut: 12000, res: 0.6, envOct: 0, fdec: 0.5, a: 0.001, d: 3, s: 1, r: 0.35, gain: 1.3 },
  upright: { name: 'Upright Piano', cat: 'Piano', tags: ['acoustic', 'warm', 'additive'], osc: [], gen: { type: 'piano', B: 0.0006, bright: 0.55, len: 2.6, beat: 0.0012 }, cut: 7000, res: 0.6, envOct: 0, fdec: 0.5, a: 0.001, d: 3, s: 1, r: 0.3, gain: 1.3 },
  honky: { name: 'Honky-Tonk', cat: 'Piano', tags: ['acoustic', 'detuned', 'vintage'], osc: [], gen: { type: 'piano', B: 0.0005, bright: 0.8, len: 2.6, beat: 0.005 }, cut: 9000, res: 0.6, envOct: 0, fdec: 0.5, a: 0.001, d: 3, s: 1, r: 0.3, gain: 1.3 },

  // ------------------------------------------------------------------ ORGAN
  organJazz: { name: 'Jazz Organ', cat: 'Organ', tags: ['drawbar', 'vintage', 'warm'], osc: [O('organ:888000000')], cut: 9000, res: 0.6, envOct: 0, fdec: 0.2, a: 0.005, d: 0.2, s: 1, r: 0.06, lfo: { to: 'pitch', rate: 6.5, depth: 6 } },
  organGospel: { name: 'Gospel Organ', cat: 'Organ', tags: ['drawbar', 'full', 'vintage'], osc: [O('organ:888800008')], cut: 9000, res: 0.6, envOct: 0, fdec: 0.2, a: 0.005, d: 0.2, s: 1, r: 0.08, drive: 0.2, lfo: { to: 'pitch', rate: 6.8, depth: 7 } },
  organRock: { name: 'Rock Organ', cat: 'Organ', tags: ['drawbar', 'overdrive', 'aggressive'], osc: [O('organ:868000006')], cut: 7000, res: 0.6, envOct: 0, fdec: 0.2, a: 0.004, d: 0.2, s: 1, r: 0.07, drive: 0.55, lfo: { to: 'pitch', rate: 7, depth: 8 } },
  organChurch: { name: 'Pipe Organ', cat: 'Organ', tags: ['church', 'full', 'sustain'], osc: [O('organ:808808008'), O('organ:008000000', 0, 3, 0.5)], cut: 8000, res: 0.6, envOct: 0, fdec: 0.2, a: 0.08, d: 0.2, s: 1, r: 0.6 },

  // ------------------------------------------------------------------ STRINGS
  strings: { name: 'String Ensemble', cat: 'Strings', tags: ['orchestral', 'warm', 'lush'], osc: [O('sawtooth', 0, -10), O('sawtooth'), O('sawtooth', 0, 10)], cut: 3500, res: 0.8, envOct: 0.3, fdec: 1, a: 0.35, d: 1, s: 0.9, r: 0.9, lfo: { to: 'pitch', rate: 5.5, depth: 8, delay: 0.3 } },
  cello: { name: 'Solo Cello', cat: 'Strings', tags: ['orchestral', 'expressive', 'mono'], osc: [O('sawtooth'), O('sawtooth', 0, 5, 0.5)], formants: [[300, 4, 1], [1100, 5, 0.5], [2800, 6, 0.25]], cut: 4000, res: 0.7, envOct: 0, fdec: 1, a: 0.12, d: 0.6, s: 0.9, r: 0.4, glide: 0.08, lfo: { to: 'pitch', rate: 5.2, depth: 18, delay: 0.25 }, gain: 1.5 },
  pizz: { name: 'Pizzicato', cat: 'Strings', tags: ['orchestral', 'physical', 'short'], osc: [], gen: { type: 'pluck', damp: 0.99, bright: 0.55, len: 0.9 }, cut: 4500, res: 0.7, envOct: 0, fdec: 0.3, a: 0.001, d: 0.8, s: 0.8, r: 0.1, gain: 2 },

  // ------------------------------------------------------------------ BRASS
  obx: { name: 'Brass Stack', cat: 'Brass', tags: ['analog', 'bold', 'classic'], osc: [O('sawtooth', 0, -11), O('sawtooth', 0, 11)], cut: 1100, res: 2, envOct: 2, fdec: 0.55, a: 0.07, d: 0.5, s: 0.7, r: 0.5 },
  synthbrass: { name: 'Synth Brass', cat: 'Brass', tags: ['analog', 'punchy', 'bright'], osc: [O('sawtooth'), O('sawtooth', 0, 8)], cut: 800, res: 1.5, envOct: 2.6, fdec: 0.3, a: 0.05, d: 0.4, s: 0.75, r: 0.25 },
  horns: { name: 'Soft Horns', cat: 'Brass', tags: ['soft', 'warm', 'orchestral'], osc: [O('sawtooth'), O('triangle', 0, 4, 0.6)], cut: 900, res: 1, envOct: 1.4, fdec: 0.5, a: 0.12, d: 0.6, s: 0.8, r: 0.35, lfo: { to: 'pitch', rate: 5, depth: 6, delay: 0.4 } },

  // ------------------------------------------------------------------ PLUCK
  guitar: { name: 'Nylon Guitar', cat: 'Pluck', tags: ['acoustic', 'physical', 'warm'], osc: [], gen: { type: 'pluck', damp: 0.997, bright: 0.4, len: 2.5 }, cut: 6000, res: 0.6, envOct: 0, fdec: 0.3, a: 0.001, d: 2.5, s: 0.9, r: 0.2, gain: 1.6 },
  harp: { name: 'Harp', cat: 'Pluck', tags: ['acoustic', 'physical', 'bright'], osc: [], gen: { type: 'pluck', damp: 0.998, bright: 0.75, len: 3 }, cut: 9000, res: 0.6, envOct: 0, fdec: 0.3, a: 0.001, d: 3, s: 0.9, r: 0.4, gain: 1.7 },
  koto: { name: 'Koto', cat: 'Pluck', tags: ['physical', 'eastern', 'bright'], osc: [], gen: { type: 'pluck', damp: 0.995, bright: 0.95, len: 1.8 }, cut: 9000, res: 0.6, envOct: 0, fdec: 0.3, a: 0.001, d: 1.8, s: 0.9, r: 0.2, gain: 1.8 },
  synthpluck: { name: 'Synth Pluck', cat: 'Pluck', tags: ['analog', 'short', 'bright'], osc: [O('sawtooth'), O('square', 0, 7, 0.5)], cut: 600, res: 3, envOct: 3.5, fdec: 0.12, a: 0.001, d: 0.3, s: 0, r: 0.15 },

  // ------------------------------------------------------------------ MALLET
  marimba: { name: 'Marimba', cat: 'Mallet', tags: ['wood', 'fm', 'percussive'], osc: [O('sine')], fm: { ratio: 4, index: 2.5, decay: 0.08 }, cut: 6000, res: 0.6, envOct: 0, fdec: 0.2, a: 0.001, d: 0.5, s: 0, r: 0.3, gain: 0.9 },
  vibes: { name: 'Vibraphone', cat: 'Mallet', tags: ['metal', 'jazz', 'soft'], osc: [O('sine'), O('sine', 2, 0, 0.1)], cut: 8000, res: 0.6, envOct: 0, fdec: 0.5, a: 0.001, d: 2.5, s: 0, r: 1.2, lfo: { to: 'amp', rate: 5, depth: 0.35 }, gain: 1.0 },
  kalimba: { name: 'Kalimba', cat: 'Mallet', tags: ['wood', 'fm', 'african'], osc: [O('sine')], fm: { ratio: 5.4, index: 2, decay: 0.06 }, cut: 7000, res: 0.6, envOct: 0, fdec: 0.2, a: 0.001, d: 0.8, s: 0, r: 0.4, gain: 0.9 },

  // ------------------------------------------------------------------ BELL
  fmbell: { name: 'FM Bell', cat: 'Bell', tags: ['fm', 'bright', 'classic'], osc: [O('sine')], fm: { ratio: 3.5, index: 6, decay: 1.1 }, cut: 9000, res: 0.6, envOct: 0, fdec: 0.5, a: 0.001, d: 1.4, s: 0, r: 0.9, glide: 0 , gain: 0.8 },
  tubular: { name: 'Tubular Bells', cat: 'Bell', tags: ['fm', 'orchestral', 'long'], osc: [O('sine')], fm: { ratio: 2.76, index: 3, decay: 2 }, cut: 9000, res: 0.6, envOct: 0, fdec: 0.5, a: 0.001, d: 3, s: 0, r: 2, gain: 0.8 },
  musicbox: { name: 'Music Box', cat: 'Bell', tags: ['fm', 'toy', 'bright'], osc: [O('sine', 1)], fm: { ratio: 7, index: 1.2, decay: 0.3 }, cut: 10000, res: 0.6, envOct: 0, fdec: 0.3, a: 0.001, d: 1.2, s: 0, r: 0.6, gain: 0.9 },
  celesta: { name: 'Celesta', cat: 'Bell', tags: ['fm', 'orchestral', 'soft'], osc: [O('sine'), O('sine', 1, 0, 0.2)], fm: { ratio: 4, index: 1, decay: 0.4 }, cut: 9000, res: 0.6, envOct: 0, fdec: 0.3, a: 0.001, d: 1.6, s: 0, r: 0.7, gain: 0.9 },

  // ------------------------------------------------------------------ CHOIR
  choirAah: { name: 'Choir Aah', cat: 'Choir', tags: ['vocal', 'formant', 'lush'], osc: [O('sawtooth', 0, -8), O('sawtooth', 0, 8)], formants: [[800, 6, 1], [1150, 7, 0.6], [2900, 9, 0.3]], cut: 6000, res: 0.6, envOct: 0, fdec: 1, a: 0.3, d: 1, s: 0.9, r: 0.8, lfo: { to: 'pitch', rate: 5, depth: 6 }, gain: 3 },
  choirOoh: { name: 'Choir Ooh', cat: 'Choir', tags: ['vocal', 'formant', 'soft'], osc: [O('sawtooth', 0, -8), O('triangle', 0, 8)], formants: [[350, 6, 1], [600, 7, 0.5], [2400, 9, 0.2]], cut: 5000, res: 0.6, envOct: 0, fdec: 1, a: 0.35, d: 1, s: 0.9, r: 0.9, lfo: { to: 'pitch', rate: 5, depth: 6 }, gain: 2.2 },
  robotvox: { name: 'Robot Voice', cat: 'Choir', tags: ['vocoder', 'formant', 'digital'], osc: [O('square'), O('sawtooth', 0, 0, 0.5)], formants: [[400, 9, 1], [2000, 11, 0.6], [2550, 11, 0.4]], cut: 7000, res: 0.6, envOct: 0, fdec: 0.5, a: 0.02, d: 0.5, s: 0.9, r: 0.2, gain: 2.4 },

  // ------------------------------------------------------------------ FX
  riser: { name: 'Noise Riser', cat: 'FX', tags: ['riser', 'noise', 'build-up'], osc: [O('sawtooth', 0, 0, 0.3)], noise: { g: 1, hp: 150 }, cut: 200, res: 3, envOct: 6, fdec: 2, a: 2.0, d: 1, s: 0.9, r: 0.6 },
  subdrop: { name: 'Sub Drop', cat: 'FX', tags: ['impact', 'sub', 'cinematic'], osc: [O('sine')], pitch: { from: 0, to: -24, time: 1.2 }, cut: 2000, res: 0.7, envOct: 0, fdec: 0.5, a: 0.005, d: 1.2, s: 0.9, r: 0.4, drive: 0.2 , gain: 0.7 },
  zap: { name: 'Laser Zap', cat: 'FX', tags: ['retro', 'game', 'short'], osc: [O('square')], pitch: { from: 36, to: 0, time: 0.15 }, cut: 6000, res: 2, envOct: 0, fdec: 0.2, a: 0.001, d: 0.25, s: 0, r: 0.08 , gain: 0.7 },
  sweepdown: { name: 'Downlifter', cat: 'FX', tags: ['sweep', 'noise', 'transition'], osc: [O('sawtooth', 0, 0, 0.4)], noise: { g: 0.8, hp: 300 }, pitch: { from: 12, to: -12, time: 2 }, cut: 6000, res: 2, envOct: 0, fdec: 2, a: 0.01, d: 2, s: 0.6, r: 0.8, lfo: { to: 'cut', rate: 0.4, depth: 0.6 } },
};

// Id dentro ogni preset (servono per le cache dei buffer generati)
for (const [id, p] of Object.entries(RAW)) p.id = id;

export const PRESETS = RAW;

/** Preset filtrati per categoria/testo/tag/preferiti. */
export function findPresets({ cat = null, text = '', favs = null } = {}) {
  const q = text.trim().toLowerCase();
  return Object.values(PRESETS).filter((p) => {
    if (cat && p.cat !== cat) return false;
    if (favs && !favs.includes(p.id)) return false;
    if (q && !(`${p.name} ${p.cat} ${p.tags.join(' ')}`.toLowerCase().includes(q))) return false;
    return true;
  });
}
