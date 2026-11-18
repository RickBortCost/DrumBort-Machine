/**
 * synthui.js — Interfaccia della sezione SYNTH: corsie note (BASS, LEAD, PAD), pad a note
 * in tonalità, parametri del synth, editor degli step, registrazione dal vivo e MIDI in.
 *
 * Riceve dall'app principale (ui.js) stato e funzioni condivise tramite `app`.
 */

import { PRESETS, SYNTH_TRACKS, SCALES, CHORD_TYPES, NOTE_NAMES, presetsFor, degreeNote, diatonicChord,
  chordName, noteName, pitchClass } from './synth.js';
import { trackBase, demoSynth, SYNTH_STEPS } from './synthpattern.js';
import { SYNTH_CH } from './engine.js';
import { stepDuration } from './sequencer.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const K = 3;   // tracce synth

const pct = (v) => `${Math.round(v * 100)}`;
const signed = (v) => (v > 0 ? '+' : '') + v.toFixed(2);
const SPARAMS = [
  { k: 'cut', label: 'CUT', min: -1, max: 1, step: 0.01, fmt: signed, pg: 'snd' },
  { k: 'res', label: 'RESO', min: -1, max: 1, step: 0.01, fmt: signed, pg: 'snd' },
  { k: 'env', label: 'ENV', min: 0, max: 2, step: 0.01, fmt: (v) => v.toFixed(2), pg: 'snd' },
  { k: 'dec', label: 'DECAY', min: 0.25, max: 3, step: 0.01, fmt: (v) => v.toFixed(2), pg: 'snd' },
  { k: 'len', label: 'LEN', min: 1, max: 16, step: 1, fmt: (v) => `${v}`, pg: 'snd' },
  { k: 'vol', label: 'VOL', min: 0, max: 1, step: 0.01, fmt: pct, pg: 'mix' },
  { k: 'pan', label: 'PAN', min: -1, max: 1, step: 0.05, fmt: (v) => (Math.abs(v) < 0.03 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100)), pg: 'mix' },
  { k: 'rev', label: 'REV', min: 0, max: 1, step: 0.01, fmt: pct, pg: 'mix' },
  { k: 'dly', label: 'DLY', min: 0, max: 1, step: 0.01, fmt: pct, pg: 'mix' },
];
const SDEFAULT = { cut: 0, res: 0, env: 1, dec: 1, len: 16 };

/** Tipo di accordo dedotto dagli intervalli salvati. */
function chordTypeOf(ch) {
  if (!ch || ch.length < 2) return 'single';
  if (ch.length >= 4) return 'seventh';
  if (ch.includes(5)) return 'sus4';
  return 'triad';
}

export function initSynthUI(app) {
  const { engine, seq, ui } = app;
  const grid = $('#grid');
  const scells = [];                 // scells[k][s]
  const slabels = [];
  const phCells = new Array(K).fill(null);
  ui.ssel = ui.ssel || 0;            // traccia synth selezionata
  ui.brush = [null, null, null];     // ultima nota/accordo suonato per traccia (pennello)

  const syn = () => app.pat().synth;
  const tr = (k = ui.ssel) => syn().tracks[k];

  // ===================================================================
  // DOM
  // ===================================================================
  for (let k = 0; k < K; k++) {
    const row = document.createElement('div');
    row.className = `row srow sk${k}`;
    row.setAttribute('role', 'group');
    const lbl = document.createElement('div');
    lbl.className = 'slbl';
    lbl.dataset.k = k;
    lbl.setAttribute('role', 'button');
    lbl.tabIndex = 0;
    lbl.innerHTML = '<b></b><i></i>';
    row.appendChild(lbl);
    slabels.push(lbl);
    scells[k] = [];
    for (let s = 0; s < SYNTH_STEPS; s++) {
      const c = document.createElement('div');
      c.className = `sstep g${s >> 2}`;
      c.dataset.k = k;
      c.dataset.s = s;
      c.dataset.p = s < 8 ? 0 : 1;
      c.setAttribute('role', 'button');
      c.tabIndex = -1;
      c.innerHTML = '<span class="nb"></span><em class="nn"></em>';
      row.appendChild(c);
      scells[k][s] = c;
    }
    grid.appendChild(row);
  }
  scells[0][0].tabIndex = 0;

  // Cursori parametri synth
  const sl = $('#ssliders');
  for (const d of SPARAMS) {
    const l = document.createElement('label');
    l.dataset.pg = d.pg;
    l.innerHTML = `<small>${d.label}</small><input type="range" data-sparam="${d.k}" min="${d.min}" max="${d.max}" step="${d.step}" aria-label="${d.label}"><output></output>`;
    sl.appendChild(l);
  }

  // Tonalità e scala
  $('#keySel').innerHTML = NOTE_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join('');
  $('#scaleSel').innerHTML = Object.entries(SCALES).map(([id, s]) => `<option value="${id}">${s.name}</option>`).join('');

  // Pad a note
  const spadGrid = $('#spadGrid');
  const spads = [];
  for (let d = 0; d < 8; d++) {
    const p = document.createElement('div');
    p.className = `spad d${d}`;
    p.dataset.d = d;
    p.setAttribute('role', 'button');
    p.innerHTML = '<b></b><i></i>';
    spadGrid.appendChild(p);
    spads.push(p);
  }

  // ===================================================================
  // Note dei pad e pennello
  // ===================================================================
  /** Note suonate dal pad di grado d sulla traccia k. */
  function padNotes(k, d) {
    const s = syn(), n = degreeNote(trackBase(s, k), s.scale, d);
    const ch = k === 2 ? diatonicChord(n, s.key, s.scale, 'triad') : null;
    return { n, ch };
  }

  function brushOf(k) {
    if (ui.brush[k]) return ui.brush[k];
    return padNotes(k, 0);
  }

  // ===================================================================
  // Render
  // ===================================================================
  function renderRow(k) {
    const t = tr(k), cells = scells[k];
    const notes = t.steps.filter(Boolean).map((st) => st.n);
    let lo = notes.length ? Math.min(...notes) : trackBase(syn(), k);
    let hi = notes.length ? Math.max(...notes) : lo + 12;
    if (hi - lo < 12) { const m = (hi + lo) / 2; lo = m - 6; hi = m + 6; }
    const y = (n) => 10 + ((n - lo) / (hi - lo)) * 62;
    const tie = new Array(SYNTH_STEPS).fill(null);
    t.steps.forEach((st, s) => {
      if (!st) return;
      for (let i = 1; i < st.g && s + i < t.len; i++) if (!t.steps[s + i]) tie[s + i] = st;
    });
    for (let s = 0; s < SYNTH_STEPS; s++) {
      const st = t.steps[s], c = cells[s], tt = tie[s];
      c.classList.toggle('on', !!st);
      c.classList.toggle('acc', !!(st && st.a));
      c.classList.toggle('sl', !!(st && st.sl));
      c.classList.toggle('tie', !st && !!tt);
      c.classList.toggle('more', !!(st && st.g > 1));
      c.classList.toggle('out', s >= t.len);
      const ref = st || tt;
      if (ref) c.style.setProperty('--y', `${y(ref.n)}%`);
      const label = st ? (k === 2 ? chordName(st.n, st.ch) : noteName(st.n)) : '';
      c.querySelector('.nn').textContent = label;
      c.setAttribute('aria-pressed', st ? 'true' : 'false');
      c.setAttribute('aria-label', `${SYNTH_TRACKS[k].name}, step ${s + 1}${st ? `, ${label}${st.g > 1 ? `, ${st.g} step` : ''}${st.a ? ', accento' : ''}${st.sl ? ', slide' : ''}` : ''}`);
    }
  }

  function renderLabels() {
    const s = syn(), anySolo = s.tracks.some((t) => t.solo);
    for (let k = 0; k < K; k++) {
      const t = s.tracks[k];
      slabels[k].querySelector('b').textContent = SYNTH_TRACKS[k].short;
      slabels[k].querySelector('i').textContent = PRESETS[t.preset].name + (t.len < SYNTH_STEPS ? ` /${t.len}` : '');
      slabels[k].classList.toggle('sel', k === ui.ssel);
      slabels[k].classList.toggle('muted', anySolo ? !t.solo : t.mute);
      slabels[k].classList.toggle('solo', t.solo);
      slabels[k].setAttribute('aria-label', `Seleziona ${SYNTH_TRACKS[k].name}, ${PRESETS[t.preset].name}`);
    }
  }

  function renderParams() {
    const k = ui.ssel, t = tr(k);
    const sel = $('#presetSel');
    sel.innerHTML = presetsFor(k).map(([id, p]) => `<option value="${id}">${p.name}</option>`).join('');
    sel.value = t.preset;
    sel.setAttribute('aria-label', `Preset ${SYNTH_TRACKS[k].name}`);
    app.setToggle($('#smuteBtn'), t.mute);
    app.setToggle($('#ssoloBtn'), t.solo);
    $$('#ssliders input').forEach((inp) => {
      const d = SPARAMS.find((x) => x.k === inp.dataset.sparam);
      inp.value = t[d.k];
      inp.nextElementSibling.textContent = d.fmt(t[d.k]);
    });
  }

  function renderPads() {
    const s = syn(), k = ui.ssel;
    $('#keySel').value = s.key;
    $('#scaleSel').value = s.scale;
    $('#octVal').textContent = noteName(trackBase(s, k));
    spads.forEach((p, d) => {
      const { n, ch } = padNotes(k, d);
      p.querySelector('b').textContent = k === 2 ? chordName(n, ch) : pitchClass(n);
      p.querySelector('i').textContent = k === 2 ? noteName(n) : `${d + 1}`;
      p.setAttribute('aria-label', `Pad ${k === 2 ? chordName(n, ch) : noteName(n)}`);
      p.classList.toggle('root', d % (SCALES[s.scale].iv.length) === 0);
    });
    $('#spads').dataset.k = k;
  }

  function render() {
    for (let k = 0; k < K; k++) renderRow(k);
    renderLabels();
    renderParams();
    renderPads();
  }

  function selectTrack(k) {
    ui.ssel = k;
    renderLabels(); renderParams(); renderPads();
  }

  // ===================================================================
  // Playhead
  // ===================================================================
  function showTick(e) {
    const s = syn();
    for (let k = 0; k < K; k++) {
      const c = scells[k][e.tick % s.tracks[k].len];
      if (phCells[k] !== c) {
        if (phCells[k]) phCells[k].classList.remove('ph');
        c.classList.add('ph');
        phCells[k] = c;
      }
    }
  }
  function clearPlayhead() {
    phCells.forEach((c, k) => { if (c) c.classList.remove('ph'); phCells[k] = null; });
  }

  // ===================================================================
  // Griglia: inserisci con il pennello, cancella, trascina
  // ===================================================================
  let paint = null;

  function setCell(k, s, mode) {
    const t = tr(k);
    if (mode === 'erase') t.steps[s] = null;
    else {
      const b = brushOf(k);
      t.steps[s] = { n: b.n, g: 1, a: 0, sl: 0, ch: b.ch ? b.ch.slice() : null };
    }
    renderRow(k);
    app.save();
  }

  grid.addEventListener('pointerdown', (e) => {
    const lbl = e.target.closest('.slbl');
    if (lbl) { selectTrack(+lbl.dataset.k); return; }
    const c = e.target.closest('.sstep');
    if (!c) return;
    e.preventDefault();
    const k = +c.dataset.k, s = +c.dataset.s;
    focusCell(c, false);
    if (k !== ui.ssel) selectTrack(k);
    if (ui.edit) { openEditor(k, s); return; }
    app.snapshot();
    const mode = tr(k).steps[s] ? 'erase' : 'add';
    setCell(k, s, mode);
    if (mode === 'add') preview(k, tr(k).steps[s]);
    paint = { k, mode, seen: new Set([c]) };
  });

  grid.addEventListener('pointermove', (e) => {
    if (!paint) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const c = el && el.closest && el.closest('.sstep');
    if (!c || paint.seen.has(c) || +c.dataset.k !== paint.k) return;
    paint.seen.add(c);
    const s = +c.dataset.s;
    if ((paint.mode === 'add') !== !!tr(paint.k).steps[s]) setCell(paint.k, s, paint.mode);
  });
  const endPaint = () => { paint = null; };
  window.addEventListener('pointerup', endPaint);
  window.addEventListener('pointercancel', endPaint);

  function focusCell(c, focus = true) {
    $$('.sstep[tabindex="0"]', grid).forEach((x) => { x.tabIndex = -1; });
    c.tabIndex = 0;
    if (focus) c.focus();
  }

  grid.addEventListener('keydown', (e) => {
    const lbl = e.target.closest('.slbl');
    if (lbl && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); selectTrack(+lbl.dataset.k); return; }
    const c = e.target.closest('.sstep');
    if (!c) return;
    let k = +c.dataset.k, s = +c.dataset.s;
    switch (e.key) {
      case 'ArrowRight': s = Math.min(SYNTH_STEPS - 1, s + 1); break;
      case 'ArrowLeft': s = Math.max(0, s - 1); break;
      case 'ArrowDown': k = Math.min(K - 1, k + 1); break;
      case 'ArrowUp': k = Math.max(0, k - 1); break;
      case 'Enter': case ' ':
        e.preventDefault(); e.stopPropagation();
        if (ui.edit) { openEditor(k, s); return; }
        app.snapshot();
        setCell(k, s, tr(k).steps[s] ? 'erase' : 'add');
        return;
      default: return;
    }
    e.preventDefault();
    const narrow = getComputedStyle(document.documentElement).getPropertyValue('--cols').trim() === '8';
    if (narrow && String(s >> 3) !== grid.dataset.page) app.setPage(s >> 3);
    focusCell(scells[k][s]);
  });

  // ===================================================================
  // Suono dal vivo (pad, anteprima, MIDI)
  // ===================================================================
  const held = new Map();   // pointerId/nota MIDI → { handle, rec }

  function preview(k, st) {
    if (!engine.ctx || !st) return;
    const notes = st.ch ? st.ch.map((x) => st.n + x) : [st.n];
    engine.playSynth(k, engine.ctx.currentTime, 0.22, notes, 0.8, tr(k));
  }

  /** Nota on: suona, aggiorna il pennello, registra se REC. */
  function noteOn(id, k, n, ch, vel = 0.85) {
    if (!engine.ctx) return;
    const t = tr(k);
    const notes = ch ? ch.map((x) => n + x) : [n];
    const handle = engine.playSynth(k, engine.ctx.currentTime, null, notes, vel, t);
    ui.brush[k] = { n, ch: ch ? ch.slice() : null };
    let rec = null;
    if (ui.rec && seq.playing) {
      const q = seq.quantize(engine.ctx.currentTime);
      if (q) {
        const p = seq.pattern, st = p.synth.tracks[k];
        const s = q.tick % st.len;
        st.steps[s] = { n, g: 1, a: vel > 0.95 ? 1 : 0, sl: 0, ch: ch ? ch.slice() : null };
        if (q.future) seq.skip.add(`s${k}:${s}`);
        rec = { p, k, s, start: engine.ctx.currentTime, sd: stepDuration(p.bpm) };
        if (p === app.pat()) renderRow(k);
        app.save();
      }
    }
    const prev = held.get(id);
    if (prev && prev.handle) prev.handle.release(engine.ctx.currentTime);
    held.set(id, { handle, rec });
  }

  function noteOff(id) {
    const h = held.get(id);
    if (!h) return;
    held.delete(id);
    const now = engine.ctx ? engine.ctx.currentTime : 0;
    if (h.handle) h.handle.release(now);
    if (h.rec) {
      // Gate registrato = durata della pressione, arrotondata agli step
      const st = h.rec.p.synth.tracks[h.rec.k].steps[h.rec.s];
      if (st) st.g = clamp(Math.round((now - h.rec.start) / h.rec.sd), 1, SYNTH_STEPS);
      if (h.rec.p === app.pat()) renderRow(h.rec.k);
      app.save();
    }
  }

  spadGrid.addEventListener('pointerdown', (e) => {
    const p = e.target.closest('.spad');
    if (!p || !engine.ctx) return;
    e.preventDefault();
    const { n, ch } = padNotes(ui.ssel, +p.dataset.d);
    noteOn(`p${e.pointerId}`, ui.ssel, n, ch);
    p.classList.add('down');
  });
  const padUp = (e) => {
    noteOff(`p${e.pointerId}`);
    spads.forEach((p) => p.classList.remove('down'));
  };
  window.addEventListener('pointerup', padUp);
  window.addEventListener('pointercancel', padUp);

  /** MIDI in nella vista synth: la nota esatta va alla traccia selezionata. */
  function onMidiRaw(note, vel, on) {
    if (ui.view !== 'synth') return false;
    if (on) {
      const k = ui.ssel, s = syn();
      const ch = k === 2 ? diatonicChord(note, s.key, s.scale, 'triad') : null;
      noteOn(`m${note}`, k, note, ch, vel);
    } else {
      noteOff(`m${note}`);
    }
    return true;
  }

  // ===================================================================
  // Parametri, preset, tonalità, ottava
  // ===================================================================
  let gesture = false;
  const begin = () => { if (!gesture) { app.snapshot(); gesture = true; } };
  window.addEventListener('pointerup', () => { gesture = false; });
  window.addEventListener('keyup', () => { gesture = false; });

  sl.addEventListener('pointerdown', (e) => { if (e.target.matches('input')) begin(); });
  sl.addEventListener('input', (e) => {
    const inp = e.target, key = inp.dataset.sparam;
    if (!key) return;
    begin();
    const t = tr();
    t[key] = key === 'len' ? parseInt(inp.value, 10) : parseFloat(inp.value);
    inp.nextElementSibling.textContent = SPARAMS.find((d) => d.k === key).fmt(t[key]);
    if (key === 'len') { renderRow(ui.ssel); renderLabels(); }
    else if (app.isPlayingPattern(app.pat())) engine.setChannel(SYNTH_CH + ui.ssel, t);
    app.save();
  });
  // Doppio tap → valore di default
  let last = { el: null, t: 0 };
  sl.addEventListener('pointerdown', (e) => {
    const inp = e.target.closest('input');
    if (!inp) return;
    const now = Date.now();
    if (last.el === inp && now - last.t < 300) {
      const k = inp.dataset.sparam;
      const def = k in SDEFAULT ? SDEFAULT[k] : { vol: [0.75, 0.75, 0.6], pan: [0, 0.15, -0.1], rev: [0, 0.2, 0.35], dly: [0, 0.25, 0.1] }[k][ui.ssel];
      inp.value = def;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
    last = { el: inp, t: now };
  });

  $('#presetSel').addEventListener('change', (e) => {
    app.snapshot();
    tr().preset = e.target.value;
    renderLabels(); app.save();
    preview(ui.ssel, { ...brushOf(ui.ssel) });
    e.target.blur();
  });

  $('#spgBtn').addEventListener('click', () => {
    const box = $('#sparams');
    box.dataset.pg = box.dataset.pg === 'snd' ? 'mix' : 'snd';
    $('#spgBtn').textContent = box.dataset.pg === 'snd' ? 'MIX' : 'SND';
  });
  $('#smuteBtn').addEventListener('click', () => { app.snapshot(); tr().mute = !tr().mute; renderLabels(); renderParams(); app.save(); });
  $('#ssoloBtn').addEventListener('click', () => { app.snapshot(); tr().solo = !tr().solo; renderLabels(); renderParams(); app.save(); });

  // Cambio tonalità: traspone le note esistenti dell'intervallo più vicino
  $('#keySel').addEventListener('change', (e) => {
    app.snapshot();
    const s = syn(), nk = +e.target.value;
    let d = ((nk - s.key) % 12 + 12) % 12;
    if (d > 6) d -= 12;
    s.key = nk;
    s.tracks.forEach((t) => t.steps.forEach((st) => { if (st) st.n = clamp(st.n + d, 12, 108); }));
    ui.brush = [null, null, null];
    render(); app.save();
    if (d) app.toast(`Note trasposte di ${d > 0 ? '+' : ''}${d} semitoni`);
    e.target.blur();
  });
  $('#scaleSel').addEventListener('change', (e) => {
    app.snapshot();
    syn().scale = e.target.value;
    ui.brush = [null, null, null];
    renderPads(); app.save();
    e.target.blur();
  });
  const setOct = (d) => {
    const t = tr();
    t.oct = clamp((t.oct || 0) + d, -2, 2);
    ui.brush[ui.ssel] = null;
    renderPads(); app.save();
  };
  $('#octDown').addEventListener('click', () => setOct(-1));
  $('#octUp').addEventListener('click', () => setOct(1));

  // ===================================================================
  // Editor step synth (nota, gate, accento, slide, accordo)
  // ===================================================================
  let editing = null;

  function openEditor(k, s) {
    app.snapshot();
    const t = tr(k);
    if (!t.steps[s]) {
      const b = brushOf(k);
      t.steps[s] = { n: b.n, g: 1, a: 0, sl: 0, ch: b.ch ? b.ch.slice() : null };
      renderRow(k);
    }
    editing = { k, s };
    renderEditor();
    app.openSheet('sstepSheet');
  }

  function renderEditor() {
    const { k, s } = editing, st = tr(k).steps[s];
    if (!st) return;
    const sheet = $('#sstepSheet');
    $('#sstepTitle').textContent = `${SYNTH_TRACKS[k].name} · step ${s + 1}`;
    $('#sNote').textContent = k === 2 ? `${chordName(st.n, st.ch)} (${noteName(st.n)})` : noteName(st.n);
    $('#sGate').value = st.g;
    $('#sGate').nextElementSibling.textContent = st.g;
    const vals = { a: st.a, sl: st.sl, ch: chordTypeOf(st.ch) };
    $$('.seg', sheet).forEach((g) => $$('.btn', g).forEach((b) => app.setToggle(b, b.dataset.v === String(vals[g.dataset.k]))));
    $('#sSlideRow').hidden = k === 2;
    $('#sChordRow').hidden = k !== 2;
  }

  function editStep(fn) {
    const { k, s } = editing, st = tr(k).steps[s];
    if (!st) return;
    fn(st, k);
    renderRow(k); renderEditor(); app.save();
  }

  $('#sstepSheet').addEventListener('click', (e) => {
    if (!editing) return;
    const tb = e.target.closest('[data-tr]');
    if (tb) {
      editStep((st, k) => {
        st.n = clamp(st.n + +tb.dataset.tr, 12, 108);
        if (k === 2) { const s = syn(); st.ch = diatonicChord(st.n, s.key, s.scale, chordTypeOf(st.ch)); }
        preview(k, st);
      });
    }
    const b = e.target.closest('.seg .btn');
    if (b) {
      const key = b.parentElement.dataset.k, v = b.dataset.v;
      editStep((st, k) => {
        if (key === 'ch') { const s = syn(); st.ch = v === 'single' ? null : diatonicChord(st.n, s.key, s.scale, v); preview(k, st); }
        else st[key] = +v;
      });
    }
    if (e.target.closest('[data-act="sstep-del"]')) {
      const { k, s } = editing;
      tr(k).steps[s] = null;
      renderRow(k); app.save();
      app.closeSheet($('#sstepSheet'));
    }
  });
  $('#sGate').addEventListener('input', (e) => editStep((st) => { st.g = +e.target.value; }));

  // ===================================================================
  // API per ui.js
  // ===================================================================
  return {
    render,
    showTick,
    clearPlayhead,
    onMidiRaw,
    clear() { syn().tracks.forEach((t) => { t.steps = t.steps.map(() => null); }); },
    demo() {
      ui.synthDemo = ((ui.synthDemo ?? -1) + 1) % 3;
      app.pat().synth = demoSynth(ui.synthDemo);
      ui.brush = [null, null, null];
    },
  };
}
