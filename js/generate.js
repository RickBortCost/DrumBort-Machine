/**
 * generate.js — Generatori: ritmi euclidei, variazioni di batteria e synth, fill.
 * Funzioni pure sui dati del pattern (nessun audio).
 */

import { degreeNote } from './synth.js';
import { trackBase } from './synthpattern.js';

/** Ritmo euclideo: `hits` colpi distribuiti il più uniformemente possibile su `len` step. */
export function euclid(hits, len, rot = 0) {
  const out = new Array(len).fill(0);
  if (hits <= 0 || len <= 0) return out;
  const h = Math.min(hits, len);
  for (let i = 0; i < len; i++) {
    if (Math.floor((i * h) / len) !== Math.floor(((i - 1) * h) / len) || i === 0) out[(i + rot) % len] = 1;
  }
  return out;
}

/**
 * Varia la batteria mantenendo lo stile: sposta/aggiunge colpi fantasma, cambia accenti.
 * Kick sui quarti e snare sul 2 e 4 restano fermi.
 */
export function varyDrums(p, amount = 0.35, random = Math.random) {
  for (let t = 0; t < p.steps.length; t++) {
    const row = p.steps[t], len = p.tracks[t].len;
    for (let s = 0; s < len; s++) {
      const anchor = (t === 0 && s % 4 === 0 && row[s]) || (t === 1 && (s === 4 || s === 12) && row[s]);
      if (anchor || random() > amount * 0.5) continue;
      if (row[s]) {
        // sposta o toglie il colpo, oppure cambia l'accento
        const r = random();
        if (r < 0.35) row[s] = 0;
        else if (r < 0.7) row[s] = row[s] === 2 ? 1 : 2;
        else { const n = (s + (random() < 0.5 ? 1 : len - 1)) % len; if (!row[n]) { row[n] = row[s]; row[s] = 0; } }
      } else if (t >= 2 && random() < 0.5) {
        row[s] = 1;   // colpo fantasma su hat/percussioni
      }
    }
  }
  return p;
}

/** Varia le linee di BASS e LEAD restando nella scala (gradi vicini, ottave). */
export function varySynth(p, amount = 0.35, random = Math.random) {
  const syn = p.synth;
  [0, 1].forEach((k) => {
    const tr = syn.tracks[k], base = trackBase(syn, k);
    tr.steps.forEach((st, s) => {
      if (!st || random() > amount) return;
      // grado di scala attuale (approssimato) ± 1-2 gradi
      let deg = 0;
      for (let d = -14; d <= 21; d++) if (degreeNote(base, syn.scale, d) <= st.n) deg = d;
      const nd = deg + (random() < 0.5 ? -1 : 1) * (random() < 0.7 ? 1 : 2);
      st.n = Math.max(24, Math.min(96, degreeNote(base, syn.scale, nd)));
      if (random() < 0.2) st.a = st.a ? 0 : 1;
      if (k === 0 && random() < 0.15) st.sl = st.sl ? 0 : 1;
    });
  });
  return p;
}

/** Pattern di fill: rullata di rullante e tom in crescendo, crash sul primo step. */
export function fillPattern(p) {
  const f = JSON.parse(JSON.stringify(p));
  const set = (t, s, v) => { if (f.steps[t]) f.steps[t][s] = v; };
  for (let s = 0; s < 16; s++) {
    set(2, s, 0); set(3, s, 0); set(4, s, 0);
    set(1, s, s >= 8 ? (s >= 12 ? 2 : 1) : (s % 2 ? 1 : 0));
    set(5, s, [2, 3, 6, 7, 10, 11].includes(s) ? 1 : 0);
  }
  set(0, 0, 2); set(0, 8, 1);
  set(6, 0, 2);
  // ratchet sulle ultime due semicrome
  f.opts[1][14] = { p: 100, r: 2, f: 0, n: 0 };
  f.opts[1][15] = { p: 100, r: 3, f: 0, n: 0 };
  f.tracks.forEach((t) => { t.len = 16; });
  return f;
}
