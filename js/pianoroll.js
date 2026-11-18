/**
 * pianoroll.js — Piano roll delle tracce synth (stile DAW) e tastiera del computer come
 * tastiera musicale.
 *
 * Il modello resta quello a step (synthpattern.js): ogni step ha una nota o un accordo
 * { n, g, a, sl, ch } con la stessa partenza e durata. Nel piano roll:
 *   clic su una cella vuota   → nota (trascinando a destra si allunga)
 *   clic su una nota          → la elimina          trascina in verticale → la sposta
 *   trascina il bordo destro  → durata              tastiera a sinistra   → ascolto
 *   corsia in basso           → accento (e slide per BASS/LEAD)
 * Sulle tracce BASS/LEAD (mono) una nuova nota sostituisce quella dello stesso step.
 */

import { SYNTH_TRACKS, SCALES, noteName, isChordTrack } from './synth.js';
import { trackBase } from './synthpattern.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const HI = 108, LO = 24, ROWS = HI - LO + 1, ROW_H = 14, KEY_W = 54;
const BLACK = new Set([1, 3, 6, 8, 10]);
const COLORS = ['#ff9b3d', '#67c8ff', '#b48cff', '#7fd67a'];

const notesOf = (st) => (st ? (st.ch || [0]).map((x) => st.n + x) : []);

export function initPianoRoll(app) {
  const { engine, ui } = app;
  const sheet = $('#pianoSheet'), wrap = $('#prWrap'), cv = $('#prCanvas'), lane = $('#prLane');
  let k = 0, colW = 40, open = false, drag = null, playTick = -1;

  const syn = () => app.pat().synth;
  const tr = () => syn().tracks[k];
  /** Step mostrati: tutte le battute del pattern. */
  const N = () => tr().steps.length;
  const mono = () => !isChordTrack(k);

  // ---------------------------------------------------------------
  // Disegno
  // ---------------------------------------------------------------
  function size() {
    const dpr = window.devicePixelRatio || 1;
    colW = Math.max(28, Math.floor((wrap.clientWidth - KEY_W - 2) / Math.min(N(), 32)));
    const w = KEY_W + colW * N(), h = ROWS * ROW_H;
    cv.style.width = `${w}px`; cv.style.height = `${h}px`;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    lane.style.width = `${w}px`;
    lane.width = Math.round(w * dpr); lane.height = Math.round(lane.clientHeight * dpr);
  }

  function draw() {
    if (!open) return;
    const dpr = window.devicePixelRatio || 1, g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = syn(), t = tr(), len = t.len || N();
    const scale = (SCALES[s.scale] || SCALES.minor).iv;
    const inScale = (n) => scale.includes((((n - s.key) % 12) + 12) % 12);
    const W = KEY_W + colW * N();
    // Righe: tasti neri più scuri, note della scala evidenziate, tonica marcata
    for (let r = 0; r < ROWS; r++) {
      const n = HI - r, y = r * ROW_H, pc = ((n % 12) + 12) % 12;
      g.fillStyle = BLACK.has(pc) ? '#262d33' : '#2e363d';
      g.fillRect(KEY_W, y, W - KEY_W, ROW_H);
      if (inScale(n)) { g.fillStyle = 'rgba(255,155,61,.07)'; g.fillRect(KEY_W, y, W - KEY_W, ROW_H); }
      if (pc === s.key) { g.fillStyle = 'rgba(255,155,61,.13)'; g.fillRect(KEY_W, y, W - KEY_W, ROW_H); }
      g.fillStyle = '#1b2025'; g.fillRect(KEY_W, y + ROW_H - 1, W - KEY_W, 1);
      // Tastiera
      g.fillStyle = BLACK.has(pc) ? '#1c2126' : '#d9e0e5';
      g.fillRect(0, y, KEY_W - 2, ROW_H - 1);
      if (pc === 0 || n === HI) {
        g.fillStyle = BLACK.has(pc) ? '#9aa6af' : '#3a444c';
        g.font = '10px system-ui, sans-serif';
        g.fillText(noteName(n), 4, y + ROW_H - 3);
      }
    }
    // Colonne: battiti marcati, oltre la lunghezza della traccia oscurato
    for (let c = 0; c <= N(); c++) {
      g.fillStyle = c % 16 === 0 ? '#0b0e10' : c % 4 === 0 ? '#151a1e' : '#232a30';
      g.fillRect(KEY_W + c * colW, 0, c % 16 === 0 ? 3 : c % 4 === 0 ? 2 : 1, ROWS * ROW_H);
    }
    if (len < N()) { g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(KEY_W + len * colW, 0, (N() - len) * colW, ROWS * ROW_H); }
    // Playhead
    if (playTick >= 0) {
      g.fillStyle = 'rgba(155,214,90,.16)';
      g.fillRect(KEY_W + (playTick % len) * colW, 0, colW, ROWS * ROW_H);
    }
    // Note
    const col = COLORS[k];
    t.steps.forEach((st, s0) => {
      if (!st) return;
      for (const n of notesOf(st)) {
        if (n < LO || n > HI) continue;
        const x = KEY_W + s0 * colW + 1, y = (HI - n) * ROW_H + 1, w = Math.min(st.g, N() - s0) * colW - 2;
        g.fillStyle = st.a ? '#ffd29e' : col;
        g.fillRect(x, y, w, ROW_H - 2);
        g.fillStyle = 'rgba(0,0,0,.35)';
        g.fillRect(x + w - 4, y, 4, ROW_H - 2);           // maniglia della durata
        if (colW > 34) { g.fillStyle = '#14191d'; g.font = '9px system-ui, sans-serif'; g.fillText(noteName(n), x + 3, y + ROW_H - 4); }
      }
    });
    drawLane();
  }

  function drawLane() {
    const dpr = window.devicePixelRatio || 1, g = lane.getContext('2d'), h = lane.height / dpr, t = tr();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, lane.width, lane.height);
    const rows = mono() ? 2 : 1, rh = h / rows;
    g.fillStyle = '#9aa6af'; g.font = '10px system-ui, sans-serif';
    g.fillText('ACCENTO', 4, rh / 2 + 4);
    if (rows === 2) g.fillText('SLIDE', 4, rh + rh / 2 + 4);
    for (let s = 0; s < N(); s++) {
      const st = t.steps[s], x = KEY_W + s * colW;
      for (let r = 0; r < rows; r++) {
        const on = st && (r === 0 ? st.a : st.sl);
        g.fillStyle = !st ? '#262d33' : on ? (r === 0 ? '#ff9b3d' : '#67c8ff') : '#3a434b';
        g.fillRect(x + 2, r * rh + 3, colW - 4, rh - 6);
      }
    }
  }

  // ---------------------------------------------------------------
  // Modifica
  // ---------------------------------------------------------------
  /** Scrive le note di uno step (accordo con stessa partenza e durata). */
  function setStep(s, notes, gate, keep) {
    const steps = tr().steps;
    const u = [...new Set(notes)].filter((n) => n >= 12 && n <= 108).sort((a, b) => a - b);
    if (!u.length) { steps[s] = null; return; }
    const prev = keep || steps[s] || {};
    steps[s] = {
      n: u[0], g: clamp(Math.round(gate ?? prev.g ?? 1), 1, N()), a: prev.a ? 1 : 0, sl: prev.sl ? 1 : 0,
      ch: u.length > 1 ? u.map((n) => n - u[0]) : null,
      ...(prev.pl ? { pl: prev.pl } : {}),
    };
  }

  /** Nota che copre la cella (step, altezza): { s, st }. */
  function hit(step, pitch) {
    const steps = tr().steps;
    for (let s = 0; s < N(); s++) {
      const st = steps[s];
      if (st && step >= s && step < s + st.g && notesOf(st).includes(pitch)) return { s, st };
    }
    return null;
  }

  function cell(e) {
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    return { x, step: Math.floor((x - KEY_W) / colW), pitch: HI - Math.floor(y / ROW_H) };
  }

  function audition(notes, dur = 0.3) {
    if (!engine.ctx || !notes.length) return;
    engine.playSynth(k, engine.ctx.currentTime + 0.01, dur, notes, 0.85, tr());
  }

  const changed = () => { app.save(); if (app.synthUI) app.synthUI.render(); draw(); };

  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const c = cell(e);
    if (c.x < KEY_W) { audition([c.pitch]); return; }
    if (c.step < 0 || c.step >= N() || c.pitch < LO || c.pitch > HI) return;
    cv.setPointerCapture(e.pointerId);
    app.snapshot();
    const h = hit(c.step, c.pitch);
    if (h) {
      const endX = KEY_W + (h.s + h.st.g) * colW;
      if (endX - c.x <= Math.max(10, colW * 0.35)) drag = { mode: 'len', s: h.s };
      else drag = { mode: 'move', s: h.s, from: c.pitch, to: c.pitch, moved: false };
      if (e.shiftKey) { h.st.a = h.st.a ? 0 : 1; drag = null; changed(); }
      return;
    }
    // Nuova nota: su BASS/LEAD sostituisce, su PAD/KEYS si aggiunge all'accordo dello step
    const st = tr().steps[c.step];
    const notes = st && !mono() ? notesOf(st).concat(c.pitch) : [c.pitch];
    setStep(c.step, notes, st && !mono() ? st.g : 1, st);
    drag = { mode: 'len', s: c.step };
    audition(notesOf(tr().steps[c.step]));
    changed();
  });

  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const c = cell(e), st = tr().steps[drag.s];
    if (!st) return;
    if (drag.mode === 'len') {
      const g = clamp(c.step - drag.s + 1, 1, N() - drag.s);
      if (g !== st.g) { st.g = g; draw(); }
    } else if (drag.mode === 'move' && c.pitch !== drag.to && c.pitch >= LO && c.pitch <= HI) {
      const notes = notesOf(st).filter((n) => n !== drag.to);
      if (!notes.includes(c.pitch)) {
        setStep(drag.s, notes.concat(c.pitch), st.g, st);
        drag.to = c.pitch; drag.moved = true;
        audition([c.pitch], 0.15);
        draw();
      }
    }
  });

  const end = () => {
    if (!drag) return;
    if (drag.mode === 'move' && !drag.moved) {
      const st = tr().steps[drag.s];
      setStep(drag.s, notesOf(st).filter((n) => n !== drag.from), st.g, st);
    }
    drag = null;
    changed();
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);

  lane.addEventListener('pointerdown', (e) => {
    const r = lane.getBoundingClientRect();
    const s = Math.floor((e.clientX - r.left - KEY_W) / colW);
    const st = tr().steps[s];
    if (s < 0 || s >= N() || !st) return;
    app.snapshot();
    const row = mono() && e.clientY - r.top > r.height / 2 ? 'sl' : 'a';
    st[row] = st[row] ? 0 : 1;
    changed();
  });

  // ---------------------------------------------------------------
  // Foglio
  // ---------------------------------------------------------------
  $('#prTracks').innerHTML = SYNTH_TRACKS.map((t, i) => `<button class="btn sm" data-prk="${i}" style="--tc:${COLORS[i]}">${t.name.toUpperCase()}</button>`).join('');
  $('#prTracks').addEventListener('click', (e) => {
    const b = e.target.closest('[data-prk]');
    if (b) select(+b.dataset.prk, true);
  });
  sheet.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pr]');
    if (!b) return;
    if (b.dataset.pr === 'clear') { app.snapshot(); tr().steps = tr().steps.map(() => null); changed(); }
    if (b.dataset.pr === 'kb') toggleKb();
  });

  function select(i, scroll) {
    k = i;
    ui.ssel = i;
    $$('#prTracks .btn').forEach((b) => app.setToggle(b, +b.dataset.prk === k));
    $('#pianoTitle').textContent = `PIANO ROLL · ${SYNTH_TRACKS[k].name.toUpperCase()}${mono() ? ' (mono)' : ' (accordi)'}`;
    lane.style.height = mono() ? '52px' : '28px';
    size();
    draw();
    if (scroll) {
      // Centra la vista sulle note della traccia (o sul suo registro)
      const ns = tr().steps.flatMap(notesOf);
      const mid = ns.length ? (Math.min(...ns) + Math.max(...ns)) / 2 : trackBase(syn(), k) + 6;
      wrap.scrollTop = (HI - mid) * ROW_H - wrap.clientHeight / 2;
    }
    if (app.synthUI) app.synthUI.render();
  }

  window.addEventListener('resize', () => { if (open) { size(); draw(); } });
  // La corsia accento/slide scorre in orizzontale insieme alla griglia
  wrap.addEventListener('scroll', () => { lane.style.transform = `translateX(${-wrap.scrollLeft}px)`; });

  // ---------------------------------------------------------------
  // Tastiera del computer come tastiera musicale (A W S E D F T G Y H U J K O L P; Z/X ottava)
  // ---------------------------------------------------------------
  const KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15 };
  let kbOn = false, kbOct = null;
  const down = new Set();
  function toggleKb(on = !kbOn) {
    kbOn = on;
    $$('[data-pr="kb"], #kbBtn').forEach((b) => app.setToggle(b, kbOn));
    if (kbOn) app.toast('Tastiera del computer: A–L suona, W E T Y U O P i diesis, Z/X ottava');
  }
  const octBase = () => {
    const b = trackBase(syn(), ui.ssel || 0);
    return (kbOct ?? Math.floor(b / 12)) * 12;
  };
  /** Gestisce un tasto; true se consumato (ui.js salta le altre scorciatoie). */
  function key(e, isDown) {
    if (!kbOn || e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, select, textarea')) return false;
    const c = e.key.toLowerCase();
    if (isDown && (c === 'z' || c === 'x')) {
      kbOct = clamp(Math.round(octBase() / 12) + (c === 'z' ? -1 : 1), 2, 7);
      app.toast(`Ottava ${kbOct - 1}`);
      return true;
    }
    if (!(c in KEYMAP)) return false;
    const id = `kb${c}`;
    if (isDown) {
      if (down.has(c)) return true;          // ripetizione automatica del tasto
      down.add(c);
      app.synthUI.noteOn(id, ui.ssel || 0, octBase() + KEYMAP[c], null, 0.85);
    } else {
      down.delete(c);
      app.synthUI.noteOff(id);
      if (open) draw();
    }
    return true;
  }

  return {
    open(i = ui.ssel || 0) {
      open = true;
      app.openSheet('pianoSheet');
      requestAnimationFrame(() => select(i, true));
    },
    close() { open = false; },
    get isOpen() { return open && !sheet.hidden; },
    tick(t) { if (open && !sheet.hidden) { playTick = t; draw(); } else open = !sheet.hidden && open; },
    clearPlayhead() { playTick = -1; if (open) draw(); },
    render() { if (open && !sheet.hidden) draw(); },
    key,
    toggleKb,
    get kb() { return kbOn; },
  };
}
