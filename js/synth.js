/**
 * synth.js — Sintetizzatori sottrattivi/FM, preset e teoria musicale (scale, accordi).
 *
 * Tre tracce melodiche: 0 BASS (mono), 1 LEAD (mono), 2 PAD (accordi).
 * Ogni voce: oscillatori (+ FM opzionale) → drive → low-pass con inviluppo → VCA ADSR → release.
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
// Preset (ispirati a synth storici; tutto sintetizzato)
// =====================================================================
// osc: [{ type, oct, det (cent), g }], cut (Hz), res (Q), envOct (ottave di modulazione),
// fdec (s), a/d/s/r (ADSR), glide (s), drive (0-1), fm: { ratio, index, decay }

const O = (type, oct = 0, det = 0, g = 1) => ({ type, oct, det, g });

export const PRESETS = {
  // ---- BASS ----
  acid303: { name: 'TB-303 Acid', kind: 0, osc: [O('sawtooth')], cut: 260, res: 13, envOct: 4.2, fdec: 0.22, a: 0.003, d: 0.25, s: 0.15, r: 0.06, glide: 0.07, drive: 0.35 },
  sh101bass: { name: 'SH-101 Bass', kind: 0, osc: [O('square'), O('square', -1, 0, 0.7)], cut: 420, res: 4, envOct: 3, fdec: 0.18, a: 0.002, d: 0.2, s: 0.35, r: 0.07, glide: 0.05 },
  moogbass: { name: 'Minimoog Bass', kind: 0, osc: [O('sawtooth'), O('sawtooth', 0, 7), O('sawtooth', -1, -5, 0.7)], cut: 380, res: 3.5, envOct: 3, fdec: 0.28, a: 0.003, d: 0.35, s: 0.5, r: 0.1, glide: 0.06, drive: 0.45 },
  fmbass: { name: 'DX7 FM Bass', kind: 0, osc: [O('sine')], fm: { ratio: 1, index: 4.5, decay: 0.22 }, cut: 5000, res: 0.7, envOct: 0, fdec: 0.2, a: 0.002, d: 0.45, s: 0.25, r: 0.08, glide: 0.04 },
  reese: { name: 'Reese Bass', kind: 0, osc: [O('sawtooth', 0, -14), O('sawtooth', 0, 14), O('sine', -1, 0, 0.6)], cut: 700, res: 1.5, envOct: 1, fdec: 0.4, a: 0.01, d: 0.4, s: 0.8, r: 0.15, glide: 0.08, drive: 0.25 },
  // ---- LEAD ----
  sh101lead: { name: 'SH-101 Lead', kind: 1, osc: [O('square'), O('sawtooth', 0, 6, 0.6)], cut: 1500, res: 5, envOct: 2.2, fdec: 0.3, a: 0.004, d: 0.3, s: 0.6, r: 0.15, glide: 0.05 },
  mooglead: { name: 'Minimoog Lead', kind: 1, osc: [O('sawtooth'), O('sawtooth', 0, -8), O('sawtooth', 1, 4, 0.5)], cut: 1900, res: 5.5, envOct: 2, fdec: 0.35, a: 0.006, d: 0.3, s: 0.8, r: 0.2, glide: 0.09, drive: 0.3 },
  ms20: { name: 'MS-20 Lead', kind: 1, osc: [O('sawtooth'), O('sawtooth', 0, 12, 0.5)], cut: 1100, res: 15, envOct: 3, fdec: 0.25, a: 0.003, d: 0.25, s: 0.55, r: 0.12, glide: 0.04, drive: 0.6 },
  chip: { name: 'Chip Square', kind: 1, osc: [O('square')], cut: 9000, res: 0.6, envOct: 0, fdec: 0.1, a: 0.001, d: 0.1, s: 0.7, r: 0.04, glide: 0 },
  fmbell: { name: 'DX7 FM Bell', kind: 1, osc: [O('sine')], fm: { ratio: 3.5, index: 6, decay: 1.1 }, cut: 9000, res: 0.6, envOct: 0, fdec: 0.5, a: 0.001, d: 1.4, s: 0, r: 0.9, glide: 0 },
  // ---- PAD ----
  juno: { name: 'Juno-106 Strings', kind: 2, osc: [O('sawtooth', 0, -9), O('sawtooth', 0, 9), O('square', -1, 0, 0.3)], cut: 2400, res: 1, envOct: 0.6, fdec: 1.2, a: 0.45, d: 1.2, s: 0.8, r: 1.2 },
  prophet: { name: 'Prophet-5 Pad', kind: 2, osc: [O('sawtooth', 0, -6), O('square', 0, 7, 0.6)], cut: 1700, res: 2, envOct: 1, fdec: 1.5, a: 0.6, d: 1.5, s: 0.7, r: 1.6 },
  obx: { name: 'OB-X Brass', kind: 2, osc: [O('sawtooth', 0, -11), O('sawtooth', 0, 11)], cut: 1100, res: 2, envOct: 2, fdec: 0.55, a: 0.07, d: 0.5, s: 0.7, r: 0.5 },
  cs80: { name: 'CS-80 Pad', kind: 2, osc: [O('sawtooth', 0, -5), O('sine', 1, 3, 0.4), O('sawtooth', 0, 5)], cut: 2000, res: 1.5, envOct: 0.8, fdec: 2, a: 1.0, d: 2, s: 0.85, r: 2.2 },
  glass: { name: 'DX7 Glass Pad', kind: 2, osc: [O('sine')], fm: { ratio: 2, index: 1.6, decay: 2.5 }, cut: 6000, res: 0.7, envOct: 0, fdec: 1, a: 0.3, d: 2, s: 0.6, r: 1.6 },
};

export const SYNTH_TRACKS = [
  { name: 'Bass', short: 'BS', oct: 2, preset: 'acid303' },
  { name: 'Lead', short: 'LD', oct: 4, preset: 'sh101lead' },
  { name: 'Pad', short: 'PD', oct: 3, preset: 'juno' },
];

export const presetsFor = (kind) => Object.entries(PRESETS).filter(([, p]) => p.kind === kind);

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
 * @param {object} p          parametri utente { cut (-1..1), res (-1..1), env (0..2), dec (0.25..3) }
 * @param {number|null} glideFrom  nota da cui scivolare (slide)
 */
export function playVoice(ctx, out, t, dur, notes, vel, pr, p = {}, glideFrom = null) {
  const accent = vel >= 0.95;
  const decMul = p.dec ?? 1;
  const a = pr.a, d = pr.d * decMul, s = pr.s, r = pr.r * Math.sqrt(decMul);
  const peak = (0.38 + vel * 0.3) / Math.sqrt(notes.length);

  // --- Release (nodo separato: nessuna cancellazione di automazioni) ---
  const rel = ctx.createGain();
  rel.connect(out);

  // --- VCA ADS ---
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(EPS, t);
  amp.gain.exponentialRampToValueAtTime(peak, t + Math.max(0.002, a));
  amp.gain.setTargetAtTime(Math.max(EPS, peak * s), t + a, Math.max(0.01, d / 3));
  amp.connect(rel);

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

  let dest = f;
  if (pr.drive) {
    const ws = ctx.createWaveShaper();
    ws.curve = driveCurve(pr.drive);
    ws.connect(f);
    dest = ws;
  }

  // --- Oscillatori ---
  const oscs = [];
  const mix = ctx.createGain();
  mix.gain.value = 1 / Math.max(1, pr.osc.reduce((x, o) => x + o.g, 0));
  mix.connect(dest);
  const glide = glideFrom != null && pr.glide ? pr.glide : 0;
  for (const n of notes) {
    for (const o of pr.osc) {
      const osc = ctx.createOscillator();
      osc.type = o.type;
      const target = mtof(n + o.oct * 12);
      if (glide) {
        osc.frequency.setValueAtTime(mtof(glideFrom + (n - notes[0]) + o.oct * 12), t);
        osc.frequency.exponentialRampToValueAtTime(target, t + glide);
      } else {
        osc.frequency.setValueAtTime(target, t);
      }
      osc.detune.value = o.det;
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
        oscs.push(mod);
      }
      oscs.push(osc);
    }
  }
  oscs.forEach((o) => o.start(t));

  let released = false;
  const handle = {
    release(at) {
      if (released) return;
      released = true;
      const when = Math.max(at, ctx.currentTime);
      rel.gain.setValueAtTime(1, when);
      rel.gain.setTargetAtTime(0, when, Math.max(0.005, r / 4));
      oscs.forEach((o) => { try { o.stop(when + r * 1.6 + 0.05); } catch (_) { /* già fermo */ } });
    },
    /** Taglio rapido (voice stealing): sfuma in pochi ms e ferma gli oscillatori. */
    kill(at) {
      const when = Math.max(at, ctx.currentTime);
      released = true;
      rel.gain.setTargetAtTime(0, when, 0.004);
      oscs.forEach((o) => { try { o.stop(when + 0.04); } catch (_) { /* già fermo */ } });
    },
  };
  if (dur != null) handle.release(t + Math.max(0.01, dur));
  return handle;
}
