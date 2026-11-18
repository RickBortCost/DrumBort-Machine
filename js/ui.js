/**
 * ui.js — Interfaccia: griglia, pad, parametri, strumenti, fogli modali,
 * salvataggio locale, undo/redo, song mode, registrazione, export, MIDI, PWA.
 * La sezione SYNTH è in synthui.js.
 */

import { KITS, kitById } from './kits.js';
import { Engine, DEFAULT_FX } from './engine.js';
import { Sequencer, createPattern, normalizePattern, normalizeOpt, parseRows, defaultTrack,
  isEmpty, clonePattern, STEPS, TRACKS, STEP_DEFAULT } from './sequencer.js';
import { renderBars, encodeWav } from './export.js';
import { Midi } from './midi.js';
import { saveSample, loadSamples, clearSamples } from './idb.js';
import { APP_VERSION } from './version.js';
import { initSynthUI } from './synthui.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const engine = new Engine();
const seq = new Sequencer(engine);
const midi = new Midi();

// =====================================================================
// Stato e persistenza (localStorage)
// =====================================================================

const STORE_KEY = 'drumbort.v1';
const SLOTS = 8;
const MAX_REP = 8;

const state = {
  slot: 0,                          // pattern visualizzato/modificato
  slots: [],                        // 8 pattern
  sel: 0,                           // traccia selezionata
  fx: { ...DEFAULT_FX },            // effetti master (globali)
  song: { on: false, chain: [] },   // catena { slot, rep }
  lock: null,                       // id kit bloccato o null
  midi: { opts: { ...midi.opts }, input: '', output: '' },
  view: 'drum',                     // 'drum' | 'synth'
};

/** Stato solo di interfaccia (non salvato). */
const ui = { edit: false, rec: false, met: false, clip: null, songIdx: -1, songPos: null, view: 'drum' };
let synthUI = null;

function normalizeFx(o) {
  const fx = { ...DEFAULT_FX };
  if (o && typeof o === 'object') {
    for (const k of Object.keys(fx)) if (typeof o[k] === 'number' && isFinite(o[k])) fx[k] = o[k];
  }
  fx.filter = clamp(fx.filter, -1, 1); fx.res = clamp(fx.res, 0.5, 15);
  fx.rev = clamp(fx.rev, 0, 1); fx.size = clamp(fx.size, 0.3, 6);
  fx.dly = clamp(fx.dly, 0, 1); fx.fb = clamp(fx.fb, 0, 0.9);
  fx.div = clamp(fx.div, 0.5, 8); fx.master = clamp(fx.master, 0, 1);
  return fx;
}

function normalizeSong(o) {
  const chain = (o && Array.isArray(o.chain) ? o.chain : [])
    .map((e) => ({ slot: clamp(e.slot | 0, 0, SLOTS - 1), rep: clamp(e.rep | 0 || 1, 1, MAX_REP) }))
    .slice(0, 64);
  return { on: !!(o && o.on), chain };
}

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY));
    if (raw && Array.isArray(raw.slots) && raw.slots.length === SLOTS) {
      state.slots = raw.slots.map(normalizePattern);
      state.slot = clamp(raw.slot | 0, 0, SLOTS - 1);
      state.fx = normalizeFx(raw.fx);
      state.song = normalizeSong(raw.song);
      state.lock = KITS.some((k) => k.id === raw.lock) ? raw.lock : null;
      state.view = raw.view === 'synth' ? 'synth' : 'drum';
      if (raw.midi && raw.midi.opts) {
        state.midi = { opts: { ...state.midi.opts, ...raw.midi.opts }, input: raw.midi.input || '', output: raw.midi.output || '' };
      }
      return;
    }
  } catch (_) { /* storage non disponibile o dati corrotti */ }
  // Primo caricamento: ogni slot contiene il groove demo di un kit e un groove synth
  state.slots = Array.from({ length: SLOTS }, (_, i) => createPattern(KITS[i % KITS.length].id, true, i % 3));
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        slot: state.slot, slots: state.slots, fx: state.fx, song: state.song, lock: state.lock, midi: state.midi, view: state.view,
      }));
    } catch (_) { /* quota / navigazione privata */ }
    // Le modifiche cambiano le voci: pre-renderizza in background quelle nuove
    if (engine.ctx) engine.prewarm(seq.pattern);
  }, 250);
}

const pat = () => state.slots[state.slot];
const kitOf = (p) => kitById(state.lock || p.kit);
const isPlayingPattern = (p) => seq.pattern === p;

/** Allinea il motore al pattern in riproduzione (o a quello visualizzato se fermo). */
function syncPlayback() {
  const songPlaying = seq.playing && state.song.on && state.song.chain.length;
  if (!songPlaying) seq.pattern = pat();
  const p = seq.pattern;
  engine.setKit(kitOf(p));
  engine.applyMix(p);
  engine.setFx(state.fx, p.bpm);
}

// =====================================================================
// Undo / redo (istantanee del pattern, max 100)
// =====================================================================

const undoStack = [];
const redoStack = [];

function snapshot() {
  undoStack.push({ slot: state.slot, p: JSON.stringify(pat()) });
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
  renderUndo();
}

function restore(from, to) {
  const e = from.pop();
  if (!e) return;
  to.push({ slot: e.slot, p: JSON.stringify(state.slots[e.slot]) });
  const wasPlaying = isPlayingPattern(state.slots[e.slot]);
  state.slots[e.slot] = JSON.parse(e.p);
  state.slot = e.slot;
  if (wasPlaying) seq.pattern = state.slots[e.slot];
  syncPlayback(); renderAll(); save();
}
const undo = () => restore(undoStack, redoStack);
const redo = () => restore(redoStack, undoStack);

function renderUndo() {
  $('[data-cmd="undo"]').disabled = !undoStack.length;
  $('[data-cmd="redo"]').disabled = !redoStack.length;
}

// =====================================================================
// Costruzione DOM
// =====================================================================

const grid = $('#grid');
const padsEl = $('#pads');
const cells = [];      // cells[t][s]
const labels = [];
const pads = [];
const phCells = new Array(TRACKS).fill(null);

function buildGrid() {
  for (let t = 0; t < TRACKS; t++) {
    const row = document.createElement('div');
    row.className = 'row';
    row.setAttribute('role', 'group');
    const lbl = document.createElement('div');
    lbl.className = 'lbl';
    lbl.dataset.t = t;
    lbl.setAttribute('role', 'button');
    lbl.innerHTML = '<b></b><i></i>';
    row.appendChild(lbl);
    labels.push(lbl);
    cells[t] = [];
    for (let s = 0; s < STEPS; s++) {
      const c = document.createElement('div');
      c.className = `step g${s >> 2}`;
      c.dataset.t = t;
      c.dataset.s = s;
      c.dataset.p = s < 8 ? 0 : 1;
      c.setAttribute('role', 'button');
      c.tabIndex = t === 0 && s === 0 ? 0 : -1;
      row.appendChild(c);
      cells[t][s] = c;
    }
    grid.appendChild(row);
  }
}

function buildPads() {
  for (let t = 0; t < TRACKS; t++) {
    const p = document.createElement('div');
    p.className = `pad c${t}`;
    p.dataset.t = t;
    p.setAttribute('role', 'button');
    p.innerHTML = '<b></b><i></i>';
    padsEl.appendChild(p);
    pads.push(p);
  }
}

function buildSelects() {
  $('#kit').innerHTML = KITS.map((k) => `<option value="${k.id}">${k.name}</option>`).join('');
  $('#slot').innerHTML = Array.from({ length: SLOTS }, (_, i) => `<option value="${i}">P${i + 1}</option>`).join('');
}

// ----- Definizione cursori traccia -----
const pct = (v) => `${Math.round(v * 100)}`;
const PARAMS = [
  { k: 'vol', label: 'VOL', min: 0, max: 1, step: 0.01, fmt: pct, pg: 'both' },
  { k: 'tune', label: 'TUNE', min: -12, max: 12, step: 0.5, fmt: (v) => (v > 0 ? '+' : '') + v, pg: 'snd' },
  { k: 'decay', label: 'DECAY', min: 0.2, max: 2.5, step: 0.01, fmt: (v) => v.toFixed(2), pg: 'snd' },
  { k: 'len', label: 'LEN', min: 1, max: 16, step: 1, fmt: (v) => `${v}`, pg: 'snd' },
  { k: 'pan', label: 'PAN', min: -1, max: 1, step: 0.05, fmt: (v) => (Math.abs(v) < 0.03 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100)), pg: 'mix' },
  { k: 'rev', label: 'REV', min: 0, max: 1, step: 0.01, fmt: pct, pg: 'mix' },
  { k: 'dly', label: 'DLY', min: 0, max: 1, step: 0.01, fmt: pct, pg: 'mix' },
];

function buildSliders() {
  const box = $('#sliders');
  const make = (d, pg) => {
    const l = document.createElement('label');
    l.dataset.pg = pg;
    l.innerHTML = `<small>${d.label}</small><input type="range" data-param="${d.k}" min="${d.min}" max="${d.max}" step="${d.step}" aria-label="${d.label}"><output></output>`;
    box.appendChild(l);
  };
  for (const pg of ['snd', 'mix']) {
    for (const d of PARAMS) if (d.pg === pg || d.pg === 'both') make(d, pg);
  }
}

// ----- Definizione controlli FX -----
const FX = [
  { k: 'filter', label: 'FILTER', min: -1, max: 1, step: 0.01, fmt: (v) => (Math.abs(v) < 0.03 ? 'OFF' : (v < 0 ? 'LP' : 'HP') + Math.round(Math.abs(v) * 100)) },
  { k: 'res', label: 'RESO', min: 0.5, max: 15, step: 0.1, fmt: (v) => v.toFixed(1) },
  { k: 'rev', label: 'REVERB', min: 0, max: 1, step: 0.01, fmt: pct },
  { k: 'size', label: 'SIZE', min: 0.3, max: 6, step: 0.1, fmt: (v) => v.toFixed(1) + 's' },
  { k: 'dly', label: 'DELAY', min: 0, max: 1, step: 0.01, fmt: pct },
  { k: 'fb', label: 'FEEDBK', min: 0, max: 0.9, step: 0.01, fmt: pct },
  { k: 'div', label: 'TIME', options: [[1, '1/16'], [4 / 3, '1/8T'], [2, '1/8'], [3, '1/8.'], [4, '1/4'], [6, '1/4.']] },
  { k: 'master', label: 'MASTER', min: 0, max: 1, step: 0.01, fmt: pct },
];

function buildFx() {
  const box = $('#fxCtl');
  for (const d of FX) {
    const l = document.createElement('label');
    l.className = 'row-ctl';
    if (d.options) {
      l.innerHTML = `<small>${d.label}</small><select class="sel" data-fx="${d.k}" aria-label="${d.label}">${
        d.options.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select>`;
    } else {
      l.innerHTML = `<small>${d.label}</small><input type="range" data-fx="${d.k}" min="${d.min}" max="${d.max}" step="${d.step}" aria-label="${d.label}"><output></output>`;
    }
    box.appendChild(l);
  }
}

// =====================================================================
// Render
// =====================================================================

function renderCell(t, s) {
  const p = pat(), v = p.steps[t][s], c = cells[t][s];
  const o = p.opts[t][s];
  c.classList.toggle('on', v === 1);
  c.classList.toggle('acc', v === 2);
  c.classList.toggle('opt', !!o);
  c.classList.toggle('out', s >= p.tracks[t].len);
  c.setAttribute('aria-pressed', v ? 'true' : 'false');
  let label = `${kitOf(p).tracks[t].name}, step ${s + 1}${v === 2 ? ', accento' : ''}`;
  if (o) label += `, prob ${o.p}%${o.r > 1 ? `, ratchet ${o.r}` : ''}${o.f ? ', flam' : ''}${o.n ? `, nudge ${o.n}` : ''}`;
  c.setAttribute('aria-label', label);
}

function renderRow(t) { for (let s = 0; s < STEPS; s++) renderCell(t, s); }

function renderTrackLabels() {
  const p = pat(), kit = kitOf(p);
  const anySolo = p.tracks.some((t) => t.solo);
  for (let t = 0; t < TRACKS; t++) {
    const tr = p.tracks[t], k = kit.tracks[t];
    const wav = engine.samples[t] ? '•' : '';
    labels[t].querySelector('b').textContent = k.short + wav;
    labels[t].querySelector('i').textContent = k.name + (tr.len < STEPS ? ` /${tr.len}` : '');
    labels[t].classList.toggle('sel', t === state.sel);
    labels[t].classList.toggle('muted', anySolo ? !tr.solo : tr.mute);
    labels[t].classList.toggle('solo', tr.solo);
    labels[t].setAttribute('aria-label', `Seleziona ${k.name}${tr.mute ? ', muta' : ''}${tr.solo ? ', solo' : ''}`);
    labels[t].parentElement.setAttribute('aria-label', k.name);
    pads[t].querySelector('b').textContent = k.short + wav;
    pads[t].querySelector('i').textContent = k.name;
    pads[t].classList.toggle('sel', t === state.sel);
    pads[t].setAttribute('aria-label', `Pad ${k.name}`);
  }
}

function renderParams() {
  const p = pat(), t = state.sel, tr = p.tracks[t];
  const smp = engine.samples[t];
  $('#trkName').textContent = kitOf(p).tracks[t].name + (smp ? ` (${smp.name})` : '');
  setToggle($('#muteBtn'), tr.mute);
  setToggle($('#soloBtn'), tr.solo);
  $$('#sliders input[data-param]').forEach((inp) => {
    const d = PARAMS.find((x) => x.k === inp.dataset.param);
    inp.value = tr[d.k];
    inp.nextElementSibling.textContent = d.fmt(tr[d.k]);
  });
}

function renderTransport() {
  const p = pat();
  $('#bpmVal').textContent = p.bpm;
  $('#swing').value = p.swing;
  $('#swingVal').textContent = p.swing + '%';
  $('#kit').value = kitOf(p).id;
  $('#slot').value = state.slot;
  setToggle($('#lockBtn'), !!state.lock);
  $('#lockBtn').textContent = state.lock ? '🔒' : '🔓';
}

function renderTools() {
  setToggle($('[data-cmd="edit"]'), ui.edit);
  setToggle($('[data-cmd="met"]'), ui.met);
  const vb = $('[data-cmd="view"]');
  vb.textContent = ui.view === 'synth' ? 'DRM' : 'SYN';
  vb.setAttribute('aria-label', ui.view === 'synth' ? 'Mostra batteria' : 'Mostra synth');
  vb.classList.toggle('on', ui.view === 'synth');
  $('[data-cmd="song"]').classList.toggle('on', state.song.on);
  const fxOn = state.fx.filter !== 0 || pat().tracks.some((t) => t.rev > 0 || t.dly > 0);
  $('[data-cmd="fx"]').classList.toggle('on', fxOn);
  $('[data-cmd="paste"]').disabled = !ui.clip;
  grid.classList.toggle('editing', ui.edit);
  renderUndo();
}

function renderAll() {
  for (let t = 0; t < TRACKS; t++) renderRow(t);
  renderTrackLabels();
  renderParams();
  renderTransport();
  renderTools();
  if (synthUI) synthUI.render();
}

function setToggle(el, on) {
  el.classList.toggle('on', !!on);
  el.setAttribute('aria-pressed', on ? 'true' : 'false');
}

// =====================================================================
// Playhead (requestAnimationFrame sincronizzato con il tempo audio)
// =====================================================================

function clearPlayhead() {
  if (synthUI) synthUI.clearPlayhead();
  phCells.forEach((c, t) => { if (c) c.classList.remove('ph'); phCells[t] = null; });
  pagerBtns.forEach((b) => b.classList.remove('lit'));
  litPage = -1;
}

const pagerBtns = $$('.pager .page');
let litPage = -1;

function showTick(e) {
  // Song mode: la vista segue il pattern in riproduzione
  if (state.song.on && e.pattern !== pat()) {
    const i = state.slots.indexOf(e.pattern);
    if (i >= 0) { state.slot = i; renderAll(); }
  }
  if (e.meta !== ui.songIdx) { ui.songIdx = e.meta; if (!$('#songSheet').hidden) renderSong(); }
  const p = pat();
  for (let t = 0; t < TRACKS; t++) {
    const c = cells[t][e.tick % p.tracks[t].len];
    if (phCells[t] !== c) {
      if (phCells[t]) phCells[t].classList.remove('ph');
      c.classList.add('ph');
      phCells[t] = c;
    }
  }
  const page = (e.tick % STEPS) >> 3;
  if (page !== litPage) {
    litPage = page;
    pagerBtns.forEach((b) => b.classList.toggle('lit', +b.dataset.page === page));
  }
  if (synthUI) synthUI.showTick(e);
}

function frame() {
  if (seq.playing && engine.ctx) {
    const now = engine.ctx.currentTime;
    let e = null;
    while (seq.queue.length && seq.queue[0].time <= now) e = seq.queue.shift();
    if (e) showTick(e);
  } else if (phCells.some(Boolean)) {
    clearPlayhead();
  }
  requestAnimationFrame(frame);
}

// =====================================================================
// Griglia: tap, trascinamento, tastiera
// =====================================================================

let paint = null;

function setStep(t, s, v) {
  pat().steps[t][s] = v;
  renderCell(t, s);
  save();
}

function activateStep(t, s) {
  if (ui.edit) { openStepEditor(t, s); return null; }
  snapshot();
  const v = (pat().steps[t][s] + 1) % 3;   // off → normale → accento → off
  setStep(t, s, v);
  return v;
}

grid.addEventListener('pointerdown', (e) => {
  const lbl = e.target.closest('.lbl');
  if (lbl) { selectTrack(+lbl.dataset.t); return; }
  const c = e.target.closest('.step');
  if (!c) return;
  e.preventDefault();
  setFocusCell(c, false);
  const v = activateStep(+c.dataset.t, +c.dataset.s);
  if (v !== null) paint = { v, seen: new Set([c]) };
});

grid.addEventListener('pointermove', (e) => {
  if (!paint) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const c = el && el.closest && el.closest('.step');
  if (!c || paint.seen.has(c)) return;
  paint.seen.add(c);
  setStep(+c.dataset.t, +c.dataset.s, paint.v);
});

const endPaint = () => { paint = null; };
window.addEventListener('pointerup', endPaint);
window.addEventListener('pointercancel', endPaint);

/** Roving tabindex: un solo step raggiungibile con Tab. */
function setFocusCell(c, focus = true) {
  $$('.step[tabindex="0"]', grid).forEach((x) => { x.tabIndex = -1; });
  c.tabIndex = 0;
  if (focus) c.focus();
}

grid.addEventListener('keydown', (e) => {
  const c = e.target.closest('.step');
  if (c) {
    let t = +c.dataset.t, s = +c.dataset.s;
    const narrow = getComputedStyle(document.documentElement).getPropertyValue('--cols').trim() === '8';
    switch (e.key) {
      case 'ArrowRight': s = Math.min(STEPS - 1, s + 1); break;
      case 'ArrowLeft': s = Math.max(0, s - 1); break;
      case 'ArrowDown': t = Math.min(TRACKS - 1, t + 1); break;
      case 'ArrowUp': t = Math.max(0, t - 1); break;
      case 'Home': s = 0; break;
      case 'End': s = STEPS - 1; break;
      case 'Enter': case ' ':
        e.preventDefault(); e.stopPropagation();
        activateStep(t, s);
        return;
      default: return;
    }
    e.preventDefault();
    if (narrow && String(s >> 3) !== grid.dataset.page) setPage(s >> 3);
    setFocusCell(cells[t][s]);
  } else if (e.target.closest('.lbl') && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault(); e.stopPropagation();
    selectTrack(+e.target.closest('.lbl').dataset.t);
  }
});

// =====================================================================
// Pad live e registrazione
// =====================================================================

function hitPad(t, vel = 1) {
  if (!engine.ctx) return;
  engine.trigger(t, engine.ctx.currentTime, vel, seq.pattern.tracks[t]);
  // Web Animations: nessun reflow forzato (prima: classList + offsetWidth)
  if (pads[t].animate) {
    pads[t].animate([{ filter: 'brightness(1.8)', transform: 'translateY(2px)' }, { filter: 'none', transform: 'none' }],
      { duration: 160, easing: 'ease-out' });
  }
  if (ui.rec) recordHit(t, vel);
}

/** Scrive il colpo nello step più vicino del pattern in riproduzione. */
function recordHit(t, vel) {
  const q = seq.quantize(engine.ctx.currentTime);
  if (!q) return;
  const p = seq.pattern;
  const s = q.tick % p.tracks[t].len;
  if (p.steps[t][s]) return;
  p.steps[t][s] = 1;
  if (q.future) seq.skip.add(`${t}:${s}`);
  if (p === pat()) renderCell(t, s);
  save();
}

padsEl.addEventListener('pointerdown', (e) => {
  const pad = e.target.closest('.pad');
  if (!pad || !engine.ctx) return;
  e.preventDefault();
  const t = +pad.dataset.t;
  hitPad(t, 1);
  if (t !== state.sel) selectTrack(t);
});

function selectTrack(t) {
  state.sel = t;
  renderTrackLabels();
  renderParams();
}

// =====================================================================
// Parametri traccia
// =====================================================================

let gesture = false;     // un'istantanea undo per gesto sui cursori
function beginGesture() { if (!gesture) { snapshot(); gesture = true; } }
window.addEventListener('pointerup', () => { gesture = false; });
window.addEventListener('keyup', () => { gesture = false; });

$('#sliders').addEventListener('pointerdown', (e) => { if (e.target.matches('input')) beginGesture(); });
$('#sliders').addEventListener('keydown', (e) => { if (e.target.matches('input')) beginGesture(); });
$('#sliders').addEventListener('input', (e) => {
  const inp = e.target, k = inp.dataset.param;
  if (!k) return;
  beginGesture();
  const p = pat(), tr = p.tracks[state.sel];
  tr[k] = k === 'len' ? parseInt(inp.value, 10) : parseFloat(inp.value);
  $$(`#sliders input[data-param="${k}"]`).forEach((x) => {
    if (x !== inp) x.value = inp.value;
    x.nextElementSibling.textContent = PARAMS.find((d) => d.k === k).fmt(tr[k]);
  });
  if (isPlayingPattern(p)) engine.setChannel(state.sel, tr);
  if (k === 'len') { renderRow(state.sel); renderTrackLabels(); }
  if (k === 'rev' || k === 'dly') renderTools();
  save();
});

// Doppio tap sul cursore → valore di default
let lastSlider = { el: null, t: 0 };
$('#sliders').addEventListener('pointerdown', (e) => {
  const inp = e.target.closest('input');
  if (!inp) return;
  const now = Date.now();
  if (lastSlider.el === inp && now - lastSlider.t < 300) {
    inp.value = defaultTrack(kitOf(pat()), state.sel)[inp.dataset.param];
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }
  lastSlider = { el: inp, t: now };
});

$('#pgBtn').addEventListener('click', () => {
  const box = $('#params');
  box.dataset.pg = box.dataset.pg === 'snd' ? 'mix' : 'snd';
  $('#pgBtn').textContent = box.dataset.pg === 'snd' ? 'MIX' : 'SND';
  $('#pgBtn').setAttribute('aria-label', box.dataset.pg === 'snd' ? 'Mostra mixer' : 'Mostra suono');
});

$('#muteBtn').addEventListener('click', () => {
  snapshot();
  const tr = pat().tracks[state.sel];
  tr.mute = !tr.mute;
  renderTrackLabels(); renderParams(); save();
});
$('#soloBtn').addEventListener('click', () => {
  snapshot();
  const tr = pat().tracks[state.sel];
  tr.solo = !tr.solo;
  renderTrackLabels(); renderParams(); save();
});

// Campione WAV per traccia (persistito in IndexedDB)
$('#wavBtn').addEventListener('click', () => $('#wavFile').click());
$('#wavFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const t = state.sel;
  try {
    const data = await f.arrayBuffer();
    await engine.loadSample(t, data, f.name);
    const stored = await saveSample(t, f.name, data);
    toast(`${f.name} → ${kitOf(pat()).tracks[t].short}${stored ? '' : ' (non salvato)'}`);
  } catch (_) {
    toast('File audio non decodificabile');
  }
  renderTrackLabels(); renderParams();
});

async function restoreSamples() {
  const list = await loadSamples();
  for (const r of list) {
    try { await engine.loadSample(r.track, r.data, r.name); } catch (_) { /* file corrotto */ }
  }
  if (list.length) { renderTrackLabels(); renderParams(); }
}

// =====================================================================
// Trasporto, tempo, kit, pattern
// =====================================================================

function startPlayback() {
  if (!engine.ctx || seq.playing) return;
  if (state.song.on && state.song.chain.length) {
    ui.songPos = { i: 0, r: 0 };
    seq.meta = 0;
    const first = state.slots[state.song.chain[0].slot];
    seq.pattern = first;
    state.slot = state.song.chain[0].slot;
    renderAll();
  } else {
    seq.meta = null;
    seq.pattern = pat();
  }
  syncPlayback();
  seq.start();
  setToggle($('#play'), true);
  $('#play').setAttribute('aria-label', 'Stop');
}

function stopPlayback() {
  seq.stop();
  ui.songIdx = -1;
  setToggle($('#play'), false);
  $('#play').setAttribute('aria-label', 'Play');
  if (!$('#songSheet').hidden) renderSong();
}

const togglePlay = () => (seq.playing ? stopPlayback() : startPlayback());
$('#play').addEventListener('click', togglePlay);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $$('.sheet').forEach((s) => { s.hidden = true; }); return; }
  if (e.code === 'Space' && !e.target.closest('input, select, button, .step, .lbl, [role="button"]')) {
    e.preventDefault();
    togglePlay();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
});

function setBpm(v) {
  const p = pat();
  p.bpm = clamp(Math.round(v), 40, 240);
  $('#bpmVal').textContent = p.bpm;
  if (isPlayingPattern(p)) engine.setFx({}, p.bpm);
  save();
}

/** Pulsante con auto-repeat alla pressione prolungata. */
function holdRepeat(btn, fn) {
  let to = null, iv = null;
  const stop = () => { clearTimeout(to); clearInterval(iv); };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    fn();
    to = setTimeout(() => { iv = setInterval(fn, 60); }, 380);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, stop));
  btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
}
holdRepeat($('#bpmDown'), () => setBpm(pat().bpm - 1));
holdRepeat($('#bpmUp'), () => setBpm(pat().bpm + 1));

// Tap tempo: media degli ultimi intervalli (reset dopo 2 s)
let taps = [];
$('#tap').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
  taps.push(now);
  if (taps.length > 5) taps.shift();
  if (taps.length >= 2) setBpm(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)));
});

$('#swing').addEventListener('pointerdown', () => beginGesture());
$('#swing').addEventListener('input', (e) => {
  beginGesture();
  pat().swing = +e.target.value;
  $('#swingVal').textContent = pat().swing + '%';
  save();
});

$('#kit').addEventListener('change', (e) => {
  const kit = kitById(e.target.value);
  if (state.lock) {
    state.lock = kit.id;
  } else {
    snapshot();
    const p = pat();
    p.kit = kit.id;
    // Pattern vuoto → carica il groove demo del nuovo kit
    if (isEmpty(p)) { p.steps = parseRows(kit.demo); p.bpm = kit.bpm; p.swing = kit.swing; }
    p.tracks.forEach((tr, i) => { tr.pan = kit.tracks[i].pan || 0; });
  }
  syncPlayback(); renderAll(); save();
  e.target.blur();
});

$('#lockBtn').addEventListener('click', () => {
  state.lock = state.lock ? null : pat().kit;
  syncPlayback(); renderAll(); save();
  toast(state.lock ? `Kit bloccato: ${kitById(state.lock).name}` : 'Kit sbloccato');
});

$('#slot').addEventListener('change', (e) => {
  state.slot = +e.target.value;
  syncPlayback(); renderAll(); save();
  e.target.blur();
});

// Paginazione step (iPhone portrait: 8 step per pagina)
/** Vista batteria / synth. */
function setView(v) {
  ui.view = state.view = v;
  $('#app').dataset.view = v;
  renderTools(); save();
}

function setPage(n) {
  grid.dataset.page = n;
  $$('.pager .page').forEach((x) => setToggle(x, +x.dataset.page === +n));
}
$$('.pager .page').forEach((b) => b.addEventListener('click', () => setPage(b.dataset.page)));

// Tab pad/parametri e cassetto (iPhone landscape)
$$('.tabs .tab').forEach((b) => b.addEventListener('click', () => {
  $('.side').dataset.tab = b.dataset.tab;
  $$('.tabs .tab').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
}));
$('#drawerBtn').addEventListener('click', () => {
  const open = $('#app').dataset.drawer !== 'open';
  $('#app').dataset.drawer = open ? 'open' : 'closed';
  $('#drawerBtn').setAttribute('aria-expanded', open);
  $('#drawerBtn').classList.toggle('on', open);
});

$('#rec').addEventListener('click', () => {
  ui.rec = !ui.rec;
  if (ui.rec) snapshot();          // un'istantanea per tutta la ripresa
  setToggle($('#rec'), ui.rec);
  if (ui.rec && !seq.playing) toast('REC armato: premi Play e suona i pad');
});

// =====================================================================
// Strumenti: undo/redo, copia/incolla, edit, metronomo, song, FX
// =====================================================================

$('.tools').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cmd]');
  if (!b) return;
  switch (b.dataset.cmd) {
    case 'undo': undo(); break;
    case 'redo': redo(); break;
    case 'copy':
      ui.clip = clonePattern(pat());
      toast(`PAT ${state.slot + 1} copiato`);
      break;
    case 'paste': {
      if (!ui.clip) return;
      snapshot();
      const wasPlaying = isPlayingPattern(pat());
      state.slots[state.slot] = clonePattern(ui.clip);
      if (wasPlaying) seq.pattern = pat();
      syncPlayback(); renderAll(); save();
      toast(`Incollato in PAT ${state.slot + 1}`);
      break;
    }
    case 'edit':
      ui.edit = !ui.edit;
      if (ui.edit) toast('EDIT: tocca uno step per le opzioni');
      break;
    case 'met':
      ui.met = !ui.met;
      seq.metronome = ui.met;
      break;
    case 'song': renderSong(); openSheet('songSheet'); break;
    case 'fx': renderFx(); openSheet('fxSheet'); break;
    case 'view': setView(ui.view === 'synth' ? 'drum' : 'synth'); break;
  }
  renderTools();
});

// =====================================================================
// Fogli modali (generico)
// =====================================================================

let lastFocus = null;
let sheetOpenedAt = 0;
function openSheet(id) {
  lastFocus = document.activeElement;
  sheetOpenedAt = performance.now();
  const s = $('#' + id);
  s.hidden = false;
  const f = s.querySelector('button, input, select');
  if (f) f.focus({ preventScroll: true });
}
function closeSheet(s) {
  s.hidden = true;
  if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
}
$$('.sheet').forEach((s) => s.addEventListener('click', (e) => {
  // Il click "fantasma" del tap che ha aperto il foglio non deve richiuderlo
  if (e.target === s && performance.now() - sheetOpenedAt < 400) return;
  if (e.target === s || e.target.closest('[data-close]')) closeSheet(s);
}));

// =====================================================================
// Editor opzioni step (probabilità, ratchet, flam, nudge)
// =====================================================================

let editing = null;   // { t, s }

function openStepEditor(t, s) {
  snapshot();
  editing = { t, s };
  renderStepEditor();
  openSheet('stepSheet');
}

function renderStepEditor() {
  const { t, s } = editing, p = pat();
  const o = p.opts[t][s] || STEP_DEFAULT;
  $('#stepTitle').textContent = `${kitOf(p).tracks[t].name} · step ${s + 1}`;
  const sheet = $('#stepSheet');
  const vals = { v: p.steps[t][s], r: o.r, f: o.f };
  $$('.seg', sheet).forEach((g) => $$('.btn', g).forEach((b) => setToggle(b, +b.dataset.v === vals[g.dataset.k])));
  $('input[data-k="p"]', sheet).value = o.p;
  $('input[data-k="p"]', sheet).nextElementSibling.textContent = o.p + '%';
  $('input[data-k="n"]', sheet).value = o.n;
  $('input[data-k="n"]', sheet).nextElementSibling.textContent = (o.n > 0 ? '+' : '') + o.n;
}

function setStepOpt(k, v) {
  const { t, s } = editing, p = pat();
  if (k === 'v') {
    p.steps[t][s] = v;
  } else {
    const o = { ...(p.opts[t][s] || STEP_DEFAULT), [k]: v };
    p.opts[t][s] = normalizeOpt(o);
    if (!p.steps[t][s]) p.steps[t][s] = 1;   // un'opzione su uno step spento lo accende
  }
  renderCell(t, s); renderStepEditor(); save();
}

$('#stepSheet').addEventListener('click', (e) => {
  const b = e.target.closest('.seg .btn');
  if (b) setStepOpt(b.parentElement.dataset.k, +b.dataset.v);
  if (e.target.closest('[data-act="step-reset"]')) {
    const { t, s } = editing;
    pat().opts[t][s] = null;
    renderCell(t, s); renderStepEditor(); save();
  }
});
$('#stepSheet').addEventListener('input', (e) => {
  const k = e.target.dataset.k;
  if (k) setStepOpt(k, +e.target.value);
});

// =====================================================================
// Song mode
// =====================================================================

/** Chiamato dal sequencer all'inizio di ogni battuta (16 tick). */
seq.onBar = (tick, time) => {
  const chain = state.song.chain;
  if (!state.song.on || !chain.length || !ui.songPos) return null;
  const pos = ui.songPos;
  pos.r++;
  if (pos.i >= chain.length) pos.i = 0;
  if (pos.r >= chain[pos.i].rep) { pos.i = (pos.i + 1) % chain.length; pos.r = 0; }
  seq.meta = pos.i;
  const next = state.slots[chain[pos.i].slot];
  const kit = kitOf(next);
  engine.setVoiceKit(kit);
  engine.applyMix(next, time);
  engine.setFx({}, next.bpm);
  // La catena lo-fi cambia quando la battuta suona davvero
  setTimeout(() => engine.setChainKit(kit), Math.max(0, (time - engine.ctx.currentTime) * 1000));
  return next;
};

function renderSong() {
  const on = state.song.on;
  const b = $('#songOn');
  setToggle(b, on);
  b.textContent = `Song mode: ${on ? 'ON' : 'OFF'}`;
  $('#chain').innerHTML = state.song.chain.map((e, i) =>
    `<div class="chip${seq.playing && on && ui.songIdx === i ? ' cur' : ''}" data-i="${i}">` +
    `<button class="btn sm" data-chip="rep" aria-label="PAT ${e.slot + 1}, ${e.rep} ripetizioni">P${e.slot + 1}×${e.rep}</button>` +
    `<button class="btn sm x" data-chip="del" aria-label="Rimuovi">×</button></div>`).join('');
  $('[data-cmd="song"]').classList.toggle('on', on);
}

$('#chainAdd').innerHTML = Array.from({ length: SLOTS }, (_, i) =>
  `<button class="btn sm" data-add="${i}" aria-label="Aggiungi PAT ${i + 1}">+${i + 1}</button>`).join('');

$('#songSheet').addEventListener('click', (e) => {
  const chain = state.song.chain;
  if (e.target.closest('#songOn')) {
    state.song.on = !state.song.on;
    if (state.song.on && !chain.length) chain.push({ slot: state.slot, rep: 1 });
    if (seq.playing) { stopPlayback(); startPlayback(); }
  }
  const add = e.target.closest('[data-add]');
  if (add && chain.length < 64) chain.push({ slot: +add.dataset.add, rep: 1 });
  const chip = e.target.closest('[data-chip]');
  if (chip) {
    const i = +chip.parentElement.dataset.i;
    if (chip.dataset.chip === 'rep') chain[i].rep = (chain[i].rep % MAX_REP) + 1;
    else chain.splice(i, 1);
  }
  if (e.target.closest('[data-act="chain-clear"]')) chain.length = 0;
  renderSong(); renderTools(); save();
});

// =====================================================================
// FX master
// =====================================================================

function renderFx() {
  $$('#fxCtl [data-fx]').forEach((el) => {
    const d = FX.find((x) => x.k === el.dataset.fx), v = state.fx[d.k];
    if (d.options) {
      const best = d.options.reduce((a, o) => (Math.abs(o[0] - v) < Math.abs(a[0] - v) ? o : a));
      el.value = String(best[0]);
    } else {
      el.value = v;
      el.nextElementSibling.textContent = d.fmt(v);
    }
  });
}

function onFx(e) {
  const k = e.target.dataset.fx;
  if (!k) return;
  state.fx[k] = parseFloat(e.target.value);
  engine.setFx(state.fx, seq.pattern.bpm);
  renderFx(); renderTools(); save();
}
$('#fxCtl').addEventListener('input', onFx);
$('#fxCtl').addEventListener('change', onFx);
$('#fxSheet').addEventListener('click', (e) => {
  if (!e.target.closest('[data-act="fx-reset"]')) return;
  state.fx = { ...DEFAULT_FX };
  engine.setFx(state.fx, seq.pattern.bpm);
  renderFx(); renderTools(); save();
});

// =====================================================================
// Menu: clear, demo, export WAV/JSON, import, MIDI
// =====================================================================

$('#menuBtn').addEventListener('click', () => openSheet('menu'));
$('#menu').addEventListener('click', async (e) => {
  const act = e.target.dataset && e.target.dataset.act;
  if (!act) return;
  closeSheet($('#menu'));
  const p = pat();
  switch (act) {
    case 'clear':
      snapshot();
      if (ui.view === 'synth') { synthUI.clear(); break; }
      p.steps = p.steps.map((r) => r.map(() => 0));
      p.opts = p.opts.map((r) => r.map(() => null));
      break;
    case 'demo': {
      snapshot();
      if (ui.view === 'synth') { synthUI.demo(); syncPlayback(); break; }
      const kit = kitById(p.kit);
      const synth = p.synth;
      Object.assign(p, createPattern(kit.id), { synth });
      syncPlayback();
      break;
    }
    case 'wav-pattern': exportAudio(Array.from({ length: 4 }, () => clonePattern(p)), `pat${state.slot + 1}`); return;
    case 'wav-song': {
      const bars = [];
      state.song.chain.forEach((c) => { for (let r = 0; r < c.rep; r++) bars.push(clonePattern(state.slots[c.slot])); });
      if (!bars.length) { toast('Catena song vuota'); return; }
      exportAudio(bars, 'song');
      return;
    }
    case 'export': exportJSON(); return;
    case 'import': $('#importFile').click(); return;
    case 'midi': renderMidi(); openSheet('midiSheet'); return;
    case 'resetwav':
      for (let i = 0; i < TRACKS; i++) engine.clearSample(i);
      await clearSamples();
      toast('Campioni WAV rimossi');
      break;
  }
  renderAll(); save();
});

/** Condivide (iOS) o scarica un file. */
async function deliver(file) {
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (standalone && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name }); return; } catch (_) { /* annullato */ }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

async function exportAudio(bars, name) {
  toast('Rendering audio…');
  try {
    const buf = await renderBars(bars, { fx: state.fx, samples: engine.samples, lockKit: state.lock });
    const blob = encodeWav(buf);
    await deliver(new File([blob], `drumbort-${name}-${bars[0].bpm}bpm.wav`, { type: 'audio/wav' }));
    toast(`WAV pronto (${buf.duration.toFixed(1)} s)`);
  } catch (err) {
    toast('Export audio non riuscito');
  }
}

function exportJSON() {
  const data = JSON.stringify({
    app: 'drumbort', version: 2, appVersion: APP_VERSION,
    slot: state.slot, slots: state.slots, song: state.song, fx: state.fx, lock: state.lock,
  });
  deliver(new File([data], 'drumbort-patterns.json', { type: 'application/json' }));
}

$('#importFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const o = JSON.parse(await f.text());
    snapshot();
    if (Array.isArray(o.slots)) {
      for (let i = 0; i < SLOTS; i++) if (o.slots[i]) state.slots[i] = normalizePattern(o.slots[i]);
      if (o.song) state.song = normalizeSong(o.song);
      if (o.fx) state.fx = normalizeFx(o.fx);
      toast(`Importati ${Math.min(SLOTS, o.slots.length)} pattern`);
    } else {
      state.slots[state.slot] = normalizePattern(o);
      toast(`Pattern importato in PAT ${state.slot + 1}`);
    }
    if (seq.playing) stopPlayback();
    syncPlayback(); renderAll(); save();
  } catch (_) {
    toast('JSON non valido');
  }
});

// =====================================================================
// MIDI
// =====================================================================

midi.opts = { ...midi.opts, ...state.midi.opts };
midi.onNote = (t, vel) => hitPad(t, vel);
midi.onRaw = (note, vel, on) => (synthUI ? synthUI.onMidiRaw(note, vel, on) : false);
midi.onStart = () => { if (engine.ctx && !seq.playing) startPlayback(); };
midi.onStop = () => { if (seq.playing) stopPlayback(); };
midi.onTempo = (bpm) => { if (Math.abs(bpm - pat().bpm) >= 1) setBpm(bpm); };
midi.onDevices = () => renderMidi();

seq.onStart = (time) => midi.start(engine.ctx, time);
seq.onStop = () => midi.stop();
seq.onTick = (tick, time, sd, played) => {
  midi.clock(engine.ctx, time, sd);
  for (const n of played) {
    if (n.synth !== undefined) midi.synthNotes(engine.ctx, n.synth, n.notes, n.time, n.dur, n.vel);
    else midi.note(engine.ctx, n.t, n.time, n.vel);
  }
};

function renderMidi() {
  const msg = $('#midiMsg');
  if (!midi.supported) {
    msg.textContent = 'Web MIDI non è supportato da questo browser (es. Safari su iPhone/iPad). Usa Chrome o Edge su desktop o Android.';
    $('#midiEnable').hidden = true;
    $('#midiCtl').hidden = true;
    return;
  }
  $('#midiEnable').hidden = midi.enabled;
  $('#midiCtl').hidden = !midi.enabled;
  msg.textContent = midi.enabled ? 'Note GM su canale 10: 36 BD, 38 SD, 39 CP, 42 CH, 46 OH, 45 TOM, 49 CY, 56 PERC.' : 'Collega un dispositivo e attiva il MIDI.';
  if (!midi.enabled) return;
  const fill = (sel, list, cur) => {
    sel.innerHTML = '<option value="">— nessuno —</option>' + list.map((d) => `<option value="${d.id}">${d.name}</option>`).join('');
    sel.value = list.some((d) => d.id === cur) ? cur : '';
  };
  fill($('#midiIn'), midi.inputs(), state.midi.input);
  fill($('#midiOut'), midi.outputs(), state.midi.output);
  $$('[data-mopt]').forEach((b) => setToggle(b, midi.opts[b.dataset.mopt]));
}

$('#midiEnable').addEventListener('click', async () => {
  try {
    await midi.enable();
    midi.setInput(state.midi.input);
    midi.setOutput(state.midi.output);
  } catch (_) {
    toast('Accesso MIDI negato');
  }
  renderMidi();
});
$('#midiIn').addEventListener('change', (e) => { state.midi.input = e.target.value; midi.setInput(e.target.value); save(); });
$('#midiOut').addEventListener('change', (e) => { state.midi.output = e.target.value; midi.setOutput(e.target.value); save(); });
$('#midiCtl').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mopt]');
  if (!b) return;
  midi.opts[b.dataset.mopt] = !midi.opts[b.dataset.mopt];
  state.midi.opts = { ...midi.opts };
  renderMidi(); save();
});

// =====================================================================
// Toast
// =====================================================================

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

// =====================================================================
// Avvio audio (overlay "Tocca per iniziare") e ripresa su iOS
// =====================================================================

const overlay = $('#overlay');
let unlocked = false;

async function startAudio() {
  try {
    await engine.unlock();
    if (!unlocked) {
      unlocked = true;
      syncPlayback();
      restoreSamples();
      engine.ctx.addEventListener('statechange', () => {
        // iOS può sospendere/interrompere il contesto (chiamate, background)
        if (engine.ctx.state !== 'running' && document.visibilityState === 'visible') overlay.hidden = false;
      });
      if (midi.supported && (state.midi.input || state.midi.output)) {
        midi.enable().then(() => { midi.setInput(state.midi.input); midi.setOutput(state.midi.output); }).catch(() => {});
      }
    }
    if (engine.ctx.state === 'running') overlay.hidden = true;
  } catch (_) {
    overlay.hidden = false;
  }
}
overlay.addEventListener('pointerup', startAudio);
overlay.addEventListener('click', startAudio);
overlay.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startAudio(); } });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && engine.ctx && engine.ctx.state !== 'running') {
    engine.ctx.resume().catch(() => {}).finally(() => {
      if (engine.ctx.state !== 'running') overlay.hidden = false;
    });
  }
});

// =====================================================================
// Blocco zoom (iOS Safari ignora user-scalable=no)
// =====================================================================

// Pinch: eventi gesture proprietari di WebKit
['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) =>
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));

// Pinch: qualunque movimento con più di un dito
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1 || (e.scale && e.scale !== 1)) e.preventDefault();
}, { passive: false });

// Doppio tap: annulla il secondo tap ravvicinato fuori dai controlli interattivi
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  const interactive = e.target.closest('button, select, input, .step, .pad, .lbl, .overlay, .sheet');
  if (!interactive && now - lastTouchEnd < 350) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });

// Zoom da tastiera/trackpad su desktop (Ctrl/Cmd + rotella o +/-)
window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '0'].includes(e.key)) e.preventDefault();
});

// =====================================================================
// Init
// =====================================================================

loadState();
$('#version').textContent = `DrumBort Machine v${APP_VERSION}`;
buildSelects();
buildGrid();
buildPads();
buildSliders();
buildFx();
synthUI = initSynthUI({
  engine, seq, ui, pat, save, snapshot, toast, setToggle, isPlayingPattern,
  openSheet, closeSheet, setPage: (n) => setPage(n),
});
ui.view = state.view;
$('#app').dataset.view = ui.view;
seq.pattern = pat();
engine.setKit(kitOf(pat()));
engine.fx = { ...state.fx };
renderAll();
requestAnimationFrame(frame);

// Esposto per debug/test
window.drumbort = { engine, seq, state, ui, midi, version: APP_VERSION, undo, redo };

// =====================================================================
// PWA: service worker + avviso di aggiornamento
// =====================================================================

if ('serviceWorker' in navigator) {
  // Alla prima visita (pagina non ancora gestita) non c'è nulla da aggiornare:
  // niente banner e nessun controllo mentre il primo service worker si installa.
  const hadController = !!navigator.serviceWorker.controller;
  let refreshing = false;
  let reloadRequested = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloadRequested || refreshing) return;   // primo install: nessun reload
    refreshing = true;
    location.reload();
  });

  const showUpdate = (worker) => {
    if (!hadController) return;
    $('#updateBar').hidden = false;
    $('#updateBtn').onclick = () => {
      reloadRequested = true;
      if (seq.playing) stopPlayback();
      worker.postMessage({ type: 'SKIP_WAITING' });
    };
  };

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      const track = (w) => {
        if (!w) return;
        if (w.state === 'installed' && navigator.serviceWorker.controller) { showUpdate(w); return; }
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(w);
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
      track(reg.installing);
      reg.addEventListener('updatefound', () => track(reg.installing));
      if (hadController) reg.update().catch(() => {});   // controllo immediato all'avvio
      // Controlla aggiornamenti quando l'app torna in primo piano
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && reg.active && !reg.installing) reg.update().catch(() => {});
      });
    }).catch(() => { /* offline non disponibile */ });
  });
}
