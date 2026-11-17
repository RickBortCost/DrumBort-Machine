/**
 * ui.js — Griglia, pad, controlli, salvataggio locale, import/export.
 */

import { KITS, kitById } from './kits.js';
import { Engine } from './engine.js';
import { APP_VERSION } from './version.js';
import { Sequencer, createPattern, normalizePattern, parseRows, defaultTracks, isEmpty,
  STEPS, TRACKS } from './sequencer.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const engine = new Engine();
const seq = new Sequencer(engine);

// =====================================================================
// Stato e persistenza (localStorage, 8 slot)
// =====================================================================

const STORE_KEY = 'drumbort.v1';
const SLOTS = 8;
const state = { slot: 0, slots: [], sel: 0 };

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY));
    if (raw && Array.isArray(raw.slots) && raw.slots.length === SLOTS) {
      state.slots = raw.slots.map(normalizePattern);
      state.slot = Math.min(SLOTS - 1, Math.max(0, raw.slot | 0));
      return;
    }
  } catch (_) { /* storage non disponibile o dati corrotti */ }
  // Primo caricamento: ogni slot contiene il groove demo di un kit
  state.slots = Array.from({ length: SLOTS }, (_, i) => createPattern(KITS[i % KITS.length].id));
  state.slot = 0;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ slot: state.slot, slots: state.slots })); } catch (_) { /* quota/private */ }
  }, 250);
}

const pat = () => state.slots[state.slot];

// =====================================================================
// Costruzione DOM
// =====================================================================

const grid = $('#grid');
const padsEl = $('#pads');
const cells = [];      // cells[t][s] → elemento step
const cols = [];       // cols[s] → elementi della colonna (playhead)
const labels = [];
const pads = [];

function buildGrid() {
  for (let t = 0; t < TRACKS; t++) {
    const row = document.createElement('div');
    row.className = 'row';
    const lbl = document.createElement('div');
    lbl.className = 'lbl';
    lbl.dataset.t = t;
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
      row.appendChild(c);
      cells[t][s] = c;
      (cols[s] = cols[s] || []).push(c);
    }
    grid.appendChild(row);
  }
}

function buildPads() {
  for (let t = 0; t < TRACKS; t++) {
    const p = document.createElement('div');
    p.className = `pad c${t}`;
    p.dataset.t = t;
    p.innerHTML = '<b></b><i></i>';
    padsEl.appendChild(p);
    pads.push(p);
  }
}

function buildSelects() {
  $('#kit').innerHTML = KITS.map((k) => `<option value="${k.id}">${k.name}</option>`).join('');
  $('#slot').innerHTML = Array.from({ length: SLOTS }, (_, i) => `<option value="${i}">PAT ${i + 1}</option>`).join('');
}

// =====================================================================
// Render
// =====================================================================

function renderCell(t, s) {
  const v = pat().steps[t][s];
  const c = cells[t][s];
  c.classList.toggle('on', v === 1);
  c.classList.toggle('acc', v === 2);
}

function renderTrackLabels() {
  const p = pat(), kit = kitById(p.kit);
  const anySolo = p.tracks.some((t) => t.solo);
  for (let t = 0; t < TRACKS; t++) {
    const tr = p.tracks[t], k = kit.tracks[t];
    const wav = engine.samples[t] ? '•' : '';
    labels[t].querySelector('b').textContent = k.short + wav;
    labels[t].querySelector('i').textContent = k.name;
    labels[t].classList.toggle('sel', t === state.sel);
    labels[t].classList.toggle('muted', anySolo ? !tr.solo : tr.mute);
    labels[t].classList.toggle('solo', tr.solo);
    pads[t].querySelector('b').textContent = k.short + wav;
    pads[t].querySelector('i').textContent = k.name;
    pads[t].classList.toggle('sel', t === state.sel);
  }
}

function renderParams() {
  const p = pat(), t = state.sel, tr = p.tracks[t];
  $('#trkName').textContent = kitById(p.kit).tracks[t].name + (engine.samples[t] ? ' (WAV)' : '');
  $('#muteBtn').classList.toggle('on', tr.mute);
  $('#soloBtn').classList.toggle('on', tr.solo);
  $$('#params input[data-param]').forEach((inp) => { inp.value = tr[inp.dataset.param]; });
}

function renderTransport() {
  const p = pat();
  $('#bpmVal').textContent = p.bpm;
  $('#swing').value = p.swing;
  $('#swingVal').textContent = p.swing + '%';
  $('#kit').value = p.kit;
  $('#slot').value = state.slot;
}

function renderAll() {
  for (let t = 0; t < TRACKS; t++) for (let s = 0; s < STEPS; s++) renderCell(t, s);
  renderTrackLabels();
  renderParams();
  renderTransport();
}

/** Applica il pattern corrente al motore audio (kit + mixer). */
function applyPattern() {
  const p = pat();
  engine.setKit(kitById(p.kit));
  p.tracks.forEach((tr, i) => engine.setChannel(i, tr));
  seq.pattern = p;
}

// =====================================================================
// Playhead (requestAnimationFrame sincronizzato con ctx.currentTime)
// =====================================================================

let phStep = -1;
function setPlayhead(s) {
  if (phStep >= 0) cols[phStep].forEach((c) => c.classList.remove('ph'));
  phStep = s;
  if (s >= 0) cols[s].forEach((c) => c.classList.add('ph'));
  $$('.pager .page').forEach((b) => b.classList.toggle('lit', s >= 0 && (s >> 3) === +b.dataset.page));
}

function frame() {
  if (seq.playing && engine.ctx) {
    const now = engine.ctx.currentTime;
    let s = null;
    while (seq.queue.length && seq.queue[0].time <= now) s = seq.queue.shift().step;
    if (s !== null) setPlayhead(s);
  } else if (phStep >= 0) {
    setPlayhead(-1);
  }
  requestAnimationFrame(frame);
}

// =====================================================================
// Interazione: griglia (tap + trascinamento)
// =====================================================================

let paint = null;

function setStep(t, s, v) {
  pat().steps[t][s] = v;
  renderCell(t, s);
  save();
}

grid.addEventListener('pointerdown', (e) => {
  const lbl = e.target.closest('.lbl');
  if (lbl) { selectTrack(+lbl.dataset.t); return; }
  const c = e.target.closest('.step');
  if (!c) return;
  e.preventDefault();
  const t = +c.dataset.t, s = +c.dataset.s;
  const v = (pat().steps[t][s] + 1) % 3;   // off → normale → accento → off
  setStep(t, s, v);
  paint = { v, seen: new Set([c]) };
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

// =====================================================================
// Interazione: pad live (latenza minima: pointerdown + currentTime)
// =====================================================================

padsEl.addEventListener('pointerdown', (e) => {
  const pad = e.target.closest('.pad');
  if (!pad || !engine.ctx) return;
  e.preventDefault();
  const t = +pad.dataset.t;
  engine.trigger(t, engine.ctx.currentTime, 1, pat().tracks[t]);
  pad.classList.remove('hit');
  void pad.offsetWidth;            // riavvia l'animazione
  pad.classList.add('hit');
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

$$('#params input[data-param]').forEach((inp) => {
  inp.addEventListener('input', () => {
    const tr = pat().tracks[state.sel];
    tr[inp.dataset.param] = parseFloat(inp.value);
    engine.setChannel(state.sel, tr);
    save();
  });
  // Doppio tap sul cursore → valore di default
  let last = 0;
  inp.addEventListener('pointerdown', () => {
    const now = Date.now();
    if (now - last < 300) {
      const def = { vol: 0.8, tune: 0, decay: 1, pan: kitById(pat().kit).tracks[state.sel].pan || 0 }[inp.dataset.param];
      inp.value = def;
      inp.dispatchEvent(new Event('input'));
    }
    last = now;
  });
});

$('#muteBtn').addEventListener('click', () => {
  const tr = pat().tracks[state.sel];
  tr.mute = !tr.mute;
  renderTrackLabels(); renderParams(); save();
});
$('#soloBtn').addEventListener('click', () => {
  const tr = pat().tracks[state.sel];
  tr.solo = !tr.solo;
  renderTrackLabels(); renderParams(); save();
});

// Campione WAV per traccia (opzionale, solo in memoria)
$('#wavBtn').addEventListener('click', () => $('#wavFile').click());
$('#wavFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    await engine.loadSample(state.sel, await f.arrayBuffer());
    toast(`${f.name} → traccia ${state.sel + 1}`);
  } catch (_) {
    toast('File audio non decodificabile');
  }
  renderTrackLabels(); renderParams();
});

// =====================================================================
// Trasporto, tempo, kit, pattern
// =====================================================================

function togglePlay() {
  if (!engine.ctx) return;
  const on = seq.toggle();
  $('#play').classList.toggle('on', on);
}
$('#play').addEventListener('click', togglePlay);
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !/INPUT|SELECT/.test(e.target.tagName)) { e.preventDefault(); togglePlay(); }
});

function setBpm(v) {
  pat().bpm = Math.min(240, Math.max(40, Math.round(v)));
  $('#bpmVal').textContent = pat().bpm;
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
}
holdRepeat($('#bpmDown'), () => setBpm(pat().bpm - 1));
holdRepeat($('#bpmUp'), () => setBpm(pat().bpm + 1));

$('#swing').addEventListener('input', (e) => {
  pat().swing = +e.target.value;
  $('#swingVal').textContent = pat().swing + '%';
  save();
});

$('#kit').addEventListener('change', (e) => {
  const p = pat(), kit = kitById(e.target.value);
  p.kit = kit.id;
  // Pattern vuoto → carica il groove demo del nuovo kit
  if (isEmpty(p)) { p.steps = parseRows(kit.demo); p.bpm = kit.bpm; p.swing = kit.swing; }
  // Ripristina il pan di default del nuovo kit
  p.tracks.forEach((tr, i) => { tr.pan = kit.tracks[i].pan || 0; });
  applyPattern(); renderAll(); save();
  e.target.blur();
});

$('#slot').addEventListener('change', (e) => {
  state.slot = +e.target.value;
  applyPattern(); renderAll(); save();
  e.target.blur();
});

// Paginazione step (iPhone portrait: 8 step per pagina)
$$('.pager .page').forEach((b) => b.addEventListener('click', () => {
  grid.dataset.page = b.dataset.page;
  $$('.pager .page').forEach((x) => x.classList.toggle('on', x === b));
}));

// Tab pad/parametri (iPhone landscape)
$$('.tabs .tab').forEach((b) => b.addEventListener('click', () => {
  $('.side').dataset.tab = b.dataset.tab;
  $$('.tabs .tab').forEach((x) => x.classList.toggle('on', x === b));
}));
$('.side').dataset.tab = 'pads';

// =====================================================================
// Menu: clear, demo, export/import JSON
// =====================================================================

const menu = $('#menu');
$('#menuBtn').addEventListener('click', () => { menu.hidden = false; });
menu.addEventListener('click', async (e) => {
  const act = e.target.dataset && e.target.dataset.act;
  if (e.target === menu || act === 'close') { menu.hidden = true; return; }
  if (!act) return;
  menu.hidden = true;
  const p = pat();
  switch (act) {
    case 'clear':
      p.steps = p.steps.map((r) => r.map(() => 0));
      break;
    case 'demo': {
      const kit = kitById(p.kit);
      Object.assign(p, { steps: parseRows(kit.demo), bpm: kit.bpm, swing: kit.swing, tracks: defaultTracks(kit) });
      applyPattern();
      break;
    }
    case 'export':
      exportJSON();
      return;
    case 'import':
      $('#importFile').click();
      return;
    case 'resetwav':
      for (let i = 0; i < TRACKS; i++) engine.clearSample(i);
      toast('Campioni WAV rimossi');
      break;
  }
  renderAll(); save();
});

async function exportJSON() {
  const data = JSON.stringify({ app: 'drumbort', version: 1, slot: state.slot, slots: state.slots }, null, 1);
  const name = 'drumbort-patterns.json';
  const file = new File([data], name, { type: 'application/json' });
  // In modalità standalone iOS il download diretto non è affidabile: usa la share sheet
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (standalone && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (_) { /* annullato */ }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

$('#importFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const o = JSON.parse(await f.text());
    if (Array.isArray(o.slots)) {
      for (let i = 0; i < SLOTS; i++) if (o.slots[i]) state.slots[i] = normalizePattern(o.slots[i]);
      toast(`Importati ${Math.min(SLOTS, o.slots.length)} pattern`);
    } else {
      state.slots[state.slot] = normalizePattern(o);
      toast(`Pattern importato in PAT ${state.slot + 1}`);
    }
    applyPattern(); renderAll(); save();
  } catch (_) {
    toast('JSON non valido');
  }
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
      applyPattern();
      engine.ctx.addEventListener('statechange', () => {
        // iOS può sospendere/interrompere il contesto (chiamate, background)
        if (engine.ctx.state !== 'running' && document.visibilityState === 'visible') overlay.hidden = false;
      });
    }
    if (engine.ctx.state === 'running') overlay.hidden = true;
  } catch (_) {
    overlay.hidden = false;
  }
}
overlay.addEventListener('pointerup', startAudio);
overlay.addEventListener('click', startAudio);

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
seq.pattern = pat();
engine.setKit(kitById(pat().kit));
renderAll();
requestAnimationFrame(frame);

// Esposto per debug/test
window.drumbort = { engine, seq, state, version: APP_VERSION };

// =====================================================================
// PWA: service worker (percorso relativo, il sito sta sotto /DrumBort-Machine/)
// =====================================================================

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline non disponibile */ });
  });
}
