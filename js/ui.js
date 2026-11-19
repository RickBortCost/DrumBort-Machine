/**
 * ui.js — Interfaccia: griglia, pad, parametri, strumenti, fogli modali,
 * salvataggio locale, undo/redo, song mode, registrazione, export, MIDI, PWA.
 * La sezione SYNTH è in synthui.js.
 */

import { initPresetPlayer } from './presetplayer.js';
import { normalizeChain, legacyChain, LEGACY_KEYS, quickGet, quickSet } from './devices.js';
import { KITS, USER_KITS, kitById, findKit, setUserKits, setUserSounds, normalizeSound, USER_SOUNDS, kitWithSound } from './kits.js';
import { setUserPresets } from './presets.js';
import { Engine, DEFAULT_FX } from './engine.js';
import { Sequencer, createPattern, normalizePattern, normalizeOpt, parseRows, defaultTrack,
  isEmpty, clonePattern, STEPS, TRACKS, STEP_DEFAULT, patSteps, setPatternBars } from './sequencer.js';
import { renderBars, encodeWav } from './export.js';
import { Midi } from './midi.js';
import { saveSample, loadSamples, clearSamples } from './idb.js';
import { APP_VERSION } from './version.js';
import { initSynthUI } from './synthui.js';
import { initPanels } from './panels.js';
import { initPerformance } from './performance.js';
import { composePattern, SESSION_TRACKS, normalizeSession, normalizeArr, followTarget, songToArr, MAX_ARR_BARS } from './session.js';
import { initStudio } from './studio.js';
import { initRemote, hostInfo } from './remote.js';
import { initLab, isSoundPack } from './lab.js';
import { initPianoRoll } from './pianoroll.js';
import { makeZip } from './zip.js';
import { initAutomation } from './automation.js';
import { initAudioOut } from './audioout.js';
import { initMacros, normalizeMacros, defaultMacros } from './macros.js';
import { decodeShare } from './projects.js';
import { fillPattern } from './generate.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Sound Lab: sul telefono l'app è un generatore di suoni (niente drum machine).
 * ?lab forza il Lab, ?full forza la drum machine completa.
 */
const QS = new URLSearchParams(location.search);

/*
 * Touch (iPhone e iPad): Safari non genera dblclick in modo affidabile al doppio tocco, e con
 * più dita sullo schermo spesso non genera neppure i click. Il doppio tocco viene quindi
 * tradotto in un dblclick (quello nativo, se arriva, viene ignorato per non contare due volte).
 * Step, pad e manopole hanno una gestione propria e sono esclusi.
 */
{
  let last = null, synthAt = 0;
  window.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch' || !(e.target instanceof Element)) return;
    const t = e.target, now = performance.now();
    if (t.closest('.kb, .step, .pad, .spad, .sstep')) { last = null; return; }
    if (last && last.t === t && now - last.at < 350 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 30) {
      last = null; synthAt = now;
      t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2, clientX: e.clientX, clientY: e.clientY }));
      return;
    }
    last = { t, at: now, x: e.clientX, y: e.clientY };
  }, true);
  window.addEventListener('dblclick', (e) => { if (e.isTrusted && performance.now() - synthAt < 600) e.stopImmediatePropagation(); }, true);
}

/**
 * Pulsanti da suonare con più dita insieme (clip, scene, mute): al tocco agiscono subito sul
 * pointerdown, il click che segue viene ignorato; col mouse resta il click.
 */
function touchTap(root, selector, fn) {
  const done = new WeakMap();
  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    const b = e.target.closest(selector);
    if (!b || !root.contains(b)) return;
    e.preventDefault();
    done.set(b, performance.now());
    fn(b, e);
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest(selector);
    if (!b || !root.contains(b)) return;
    const t = done.get(b);
    if (t && performance.now() - t < 1000) { done.delete(b); e.stopImmediatePropagation(); return; }
  }, true);
}
const LAB = QS.has('lab') || (!QS.has('full') && matchMedia('(pointer: coarse) and (max-width: 600px), (pointer: coarse) and (max-height: 500px)').matches);
let lab = null;
let piano = null;       // piano roll (pianoroll.js)
let auto = null;        // editor dell'automazione (automation.js)
let macros = null;      // macro di progetto (macros.js)
let audioOut = null;    // scelta dell'uscita audio (audioout.js)

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
  view: 'drum',                     // 'drum' | 'synth' | 'perf'
  favs: [],                         // preset preferiti della libreria
  userKits: [],                     // definizioni dei kit personalizzati
  userPresets: [],                  // preset synth salvati dall'editor wavetable
  userSounds: [],                   // suoni di batteria creati nel Sound Lab
  macros: defaultMacros(),          // 4 macro di progetto (macros.js)
  devs: emptyDevs(),                // catene di device per canale (devices.js)
  tracks: [],                       // canali attivi, in ordine (0-7 batteria, 8-11 synth): vista TRACCE
  projectName: '',                  // progetto aperto
  layout: null,                     // 'compact' | 'studio' (null = scelta automatica al primo avvio)
  session: normalizeSession(null),  // clip in riproduzione per traccia, quantizzazione, follow action
  arr: normalizeArr(null),          // arrangiamento: { on, bars: [{ m: clip per traccia, s: pattern principale }] }
};

/** Stato solo di interfaccia (non salvato). */
const ui = { edit: false, rec: false, met: false, clip: null, songIdx: -1, songPos: null, view: 'drum' };
let synthUI = null;
let panels = null;      // fogli secondari (panels.js)
let studio = null;      // layout Studio (studio.js)
ui.queued = new Array(SESSION_TRACKS).fill(null);    // clip in attesa del prossimo giro (-1 = stop)
ui.pendingMaster = null;  // scena in attesa (diventa il pattern principale)
ui.curScene = null;       // ultima scena lanciata (per le follow action)
ui.sceneBars = 0;         // battute suonate dalla scena corrente
ui.arrBar = 0;            // battuta corrente dell'arrangiamento (avanza anche se non lo si ascolta)
ui.arrStart = 0;          // battuta da cui parte la riproduzione dell'arrangiamento
ui.arrRec = false;        // registrazione session → arrangiamento armata
ui.arrRecOn = false;      // registrazione in corso (prima battuta già scritta)
let perf = null;        // vista performance (performance.js)
let presetPlayer = null; // Preset Player (presetplayer.js)
let remote = null;      // controllo remoto tramite l'host desktop (remote.js)
const remoteOp = (op, data) => { if (remote) remote.op(op, data); };

function normalizeFx(o) {
  const fx = { ...DEFAULT_FX };
  if (o && typeof o === 'object') {
    for (const k of Object.keys(fx)) if (typeof o[k] === 'number' && isFinite(o[k])) fx[k] = o[k];
  }
  fx.filter = clamp(fx.filter, -1, 1); fx.res = clamp(fx.res, 0.5, 15);
  fx.rev = clamp(fx.rev, 0, 1); fx.size = clamp(fx.size, 0.3, 6);
  fx.dly = clamp(fx.dly, 0, 1); fx.fb = clamp(fx.fb, 0, 0.9);
  fx.div = clamp(fx.div, 0.5, 8); fx.master = clamp(fx.master, 0, 1);
  fx.sc = clamp(fx.sc, 0, 1); fx.scRel = clamp(fx.scRel, 0.05, 0.8);
  return fx;
}

function normalizeSong(o) {
  const chain = (o && Array.isArray(o.chain) ? o.chain : [])
    .map((e) => ({ slot: clamp(e.slot | 0, 0, SLOTS - 1), rep: clamp(e.rep | 0 || 1, 1, MAX_REP) }))
    .slice(0, 64);
  return { on: !!(o && o.on), chain };
}

/**
 * Canali attivi della vista TRACCE. Progetti senza l'elenco (versioni precedenti): i canali che
 * hanno note in almeno un pattern.
 */
function normalizeTracks(t) {
  if (Array.isArray(t)) return [...new Set(t.filter((i) => Number.isInteger(i) && i >= 0 && i < 12))];
  const used = [];
  for (let i = 0; i < 12; i++) {
    const has = state.slots.some((p) => (i < 8 ? p.steps[i].some(Boolean) : p.synth.tracks[i - 8].steps.some(Boolean) || p.synth.tracks[i - 8].arp.on));
    if (has) used.push(i);
  }
  return used;
}

/** Parametro di una traccia: gli effetti rapidi (drv, crush, lo, hi, flt, cmp) vivono nella catena di device. */
function paramGet(ch, tr, k) { return LEGACY_KEYS.includes(k) ? +quickGet(state.devs[ch], k).toFixed(3) : tr[k]; }
function paramSet(ch, tr, k, v) {
  if (LEGACY_KEYS.includes(k)) { quickSet(state.devs[ch], k, v); engine.setDevices(ch, state.devs[ch]); return; }
  tr[k] = v;
}

/** Catene vuote per i 12 canali. */
function emptyDevs() { return Array.from({ length: 12 }, () => []); }
/**
 * Catene di device. Progetti delle versioni precedenti (nessun elenco): gli effetti per traccia
 * drv/crush/lo/hi/flt/cmp del pattern corrente diventano device equivalenti.
 */
function normalizeDevs(d) {
  if (Array.isArray(d)) return emptyDevs().map((_, i) => normalizeChain(d[i]));
  const p = state.slots[state.slot] || state.slots[0];
  const out = emptyDevs().map((_, i) => legacyChain(i < 8 ? p.tracks[i] : p.synth.tracks[i - 8]));
  stripLegacy();
  return out;
}
/** Azzera gli effetti per traccia delle versioni precedenti (ora sono device). */
function stripLegacy() {
  for (const p of state.slots) for (const t of [...p.tracks, ...p.synth.tracks]) for (const k of LEGACY_KEYS) if (t[k]) t[k] = 0;
}

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY));
    if (raw && Array.isArray(raw.slots) && raw.slots.length === SLOTS) {
      // I kit utente vanno registrati prima di leggere i pattern che li usano
      state.userKits = Array.isArray(raw.userKits) ? raw.userKits : [];
      setUserKits(state.userKits);
      state.userPresets = Array.isArray(raw.userPresets) ? raw.userPresets : [];
      setUserPresets(state.userPresets);
      setUserSounds(Array.isArray(raw.userSounds) ? raw.userSounds : []);
      state.userSounds = USER_SOUNDS.slice();
      state.slots = raw.slots.map(normalizePattern);
      state.favs = Array.isArray(raw.favs) ? raw.favs.filter((x) => typeof x === 'string') : [];
      state.projectName = typeof raw.projectName === 'string' ? raw.projectName : '';
      state.slot = clamp(raw.slot | 0, 0, SLOTS - 1);
      state.fx = normalizeFx(raw.fx);
      state.song = normalizeSong(raw.song);
      state.lock = KITS.some((k) => k.id === raw.lock) ? raw.lock : null;
      state.view = ['synth', 'perf'].includes(raw.view) ? raw.view : 'drum';
      state.layout = ['compact', 'studio'].includes(raw.layout) ? raw.layout : null;
      state.session = normalizeSession(raw.session);
      state.arr = normalizeArr(raw.arr);
      state.macros = normalizeMacros(raw.macros);
      state.tracks = normalizeTracks(raw.tracks);
      state.devs = normalizeDevs(raw.devs);
      if (raw.panels && typeof raw.panels === 'object') state.panels = { browser: raw.panels.browser !== false, side: raw.panels.side !== false, bottom: raw.panels.bottom === 'fx' ? 'fx' : 'editor', ...(Number.isFinite(raw.panels.h) ? { h: raw.panels.h } : {}) };
      if (raw.midi && raw.midi.opts) {
        state.midi = { opts: { ...state.midi.opts, ...raw.midi.opts }, input: raw.midi.input || '', output: raw.midi.output || '' };
      }
      return;
    }
  } catch (_) { /* storage non disponibile o dati corrotti */ }
  // Primo avvio: progetto vuoto, senza tracce (con ?demo i groove dimostrativi di ogni kit)
  if (new URLSearchParams(location.search).has('demo')) {
    state.slots = Array.from({ length: SLOTS }, (_, i) => createPattern(KITS[i % KITS.length].id, true, i % 3));
    state.tracks = normalizeTracks(null);
    state.devs = normalizeDevs(null);
  } else {
    state.slots = Array.from({ length: SLOTS }, () => createPattern(KITS[0].id, false, null));
    state.tracks = [];
  }
}

let saveTimer = null;
function save() {
  if (remote) remote.sync();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        slot: state.slot, slots: state.slots, fx: state.fx, song: state.song, lock: state.lock, midi: state.midi, view: state.view,
        favs: state.favs, userKits: state.userKits, userPresets: state.userPresets, userSounds: state.userSounds, projectName: state.projectName,
        layout: state.layout, session: state.session, arr: state.arr, macros: state.macros, tracks: state.tracks, panels: state.panels, devs: state.devs,
      }));
    } catch (_) { /* quota / navigazione privata */ }
    // Le modifiche cambiano le voci: pre-renderizza in background quelle nuove
    if (engine.ctx) engine.prewarm(seq.pattern);
  }, 250);
}

const pat = () => state.slots[state.slot];
const kitOf = (p) => kitById(state.lock || p.kit);
/** Il pattern `p` è (anche in parte) in riproduzione? In session: se una traccia suona una sua clip. */
const isPlayingPattern = (p) => {
  if (state.layout === 'studio' && seq.pattern && seq.pattern.composite) {
    const i = state.slots.indexOf(p);
    return i >= 0 && (state.session.master === i || state.session.map.includes(i));
  }
  return seq.pattern === p;
};

/** Layout Studio effettivamente visibile (schermo abbastanza grande). */
const studioMQ = matchMedia('(min-width: 1000px) and (min-height: 600px)');
const sessionActive = () => state.layout === 'studio' && studioMQ.matches;

/** Pattern composto dalle clip in riproduzione (modalità session). */
const composeSession = () => composePattern(state.slots, state.session.map, state.session.master, state.lock);

/** Pattern che fornisce tempo e swing: in session il pattern "principale" (ultima scena lanciata). */
const tempoPattern = () => (sessionActive() ? state.slots[state.session.master] : pat());

/** Allinea il motore al pattern in riproduzione (o a quello visualizzato se fermo). */
function syncPlayback() {
  if (sessionActive()) {
    seq.pattern = composeSession();
    engine.setKit(kitById(seq.pattern.kit));
    engine.applyMix(seq.pattern);
    engine.setFx(state.fx, seq.pattern.bpm);
    return;
  }
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
  undoStack.push({ slot: state.slot, p: JSON.stringify(pat()), d: JSON.stringify(state.devs) });
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
  renderUndo();
}

function restore(from, to) {
  const e = from.pop();
  if (!e) return;
  to.push({ slot: e.slot, p: JSON.stringify(state.slots[e.slot]), d: JSON.stringify(state.devs) });
  const wasPlaying = isPlayingPattern(state.slots[e.slot]);
  state.slots[e.slot] = JSON.parse(e.p);
  if (e.d) { state.devs = normalizeDevs(JSON.parse(e.d)); engine.setAllDevices(state.devs); }
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

function buildKitSelect() {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const group = (label, list) => `<optgroup label="${label}">${list.map((k) => `<option value="${k.id}">${k.name}</option>`).join('')}</optgroup>`;
  $('#kit').innerHTML = group('Drum machine classiche', KITS.filter((k) => !k.group))
    + group('Generi: EDM, dubstep, trap…', KITS.filter((k) => k.group === 'genre'))
    + (USER_KITS.length ? `<optgroup label="Kit personalizzati">${USER_KITS.map((k) => `<option value="${k.id}">${esc(k.name)}</option>`).join('')}</optgroup>` : '');
  $('#kit').value = kitOf(pat()).id;
}

function buildSelects() {
  buildKitSelect();
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
  { k: 'drv', label: 'DRIVE', min: 0, max: 1, step: 0.05, fmt: pct, pg: 'fx' },
  { k: 'crush', label: 'CRUSH', min: 0, max: 12, step: 1, fmt: (v) => (v < 4 ? 'OFF' : `${v}bit`), pg: 'fx' },
  { k: 'flt', label: 'FILTER', min: -1, max: 1, step: 0.02, fmt: (v) => (Math.abs(v) < 0.03 ? 'OFF' : (v < 0 ? 'LP' : 'HP') + Math.round(Math.abs(v) * 100)), pg: 'fx' },
  { k: 'lo', label: 'LOW', min: -12, max: 12, step: 0.5, fmt: (v) => `${v > 0 ? '+' : ''}${v}dB`, pg: 'fx' },
  { k: 'hi', label: 'HIGH', min: -12, max: 12, step: 0.5, fmt: (v) => `${v > 0 ? '+' : ''}${v}dB`, pg: 'fx' },
  { k: 'cmp', label: 'COMP', min: 0, max: 1, step: 0.05, fmt: (v) => (v ? `${Math.round(v * 100)}` : 'OFF'), pg: 'fx' },
];

function buildSliders() {
  const box = $('#sliders');
  const make = (d, pg) => {
    const l = document.createElement('label');
    l.dataset.pg = pg;
    l.innerHTML = `<small>${d.label}</small><input type="range" data-param="${d.k}" min="${d.min}" max="${d.max}" step="${d.step}" aria-label="${d.label}"><output></output>`;
    box.appendChild(l);
  };
  for (const pg of ['snd', 'mix', 'fx']) {
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
  { k: 'sc', label: 'SIDECHAIN', min: 0, max: 1, step: 0.01, fmt: pct },
  { k: 'scRel', label: 'SC REL', min: 0.05, max: 0.8, step: 0.01, fmt: (v) => `${Math.round(v * 1000)}ms` },
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

/** Primo step della battuta visibile. */
const off = () => ui.bar * STEPS;

function renderCell(t, s) {
  const col = s - off();
  if (col < 0 || col >= STEPS) return;
  const p = pat(), v = p.steps[t][s], c = cells[t][col];
  c.dataset.s = s;
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

function renderRow(t) { for (let c = 0; c < STEPS; c++) renderCell(t, off() + c); }

// ----- Battute del pattern (clip lunghe) -----
ui.bar = 0;
function renderBarsCtl() {
  const n = pat().bars || 1;
  if (ui.bar >= n) ui.bar = 0;
  $('#barsSel').value = String(n);
  const seg = $('#barSeg');
  if (seg.childElementCount !== n) seg.innerHTML = Array.from({ length: n }, (_, i) => `<button class="btn sm" data-bar="${i}" aria-label="Battuta ${i + 1}">${i + 1}</button>`).join('');
  $$('[data-bar]', seg).forEach((b) => setToggle(b, +b.dataset.bar === ui.bar));
  $('.bars-ctl').classList.toggle('multi', n > 1);
}
/** Mostra la battuta `b` del pattern nella griglia, nelle corsie synth e nel piano roll. */
function setBar(b) {
  const n = pat().bars || 1;
  b = clamp(b, 0, n - 1);
  if (b === ui.bar) return;
  ui.bar = b;
  clearPlayhead();
  for (let t = 0; t < TRACKS; t++) renderRow(t);
  renderBarsCtl();
  if (synthUI) synthUI.render();
}
$('#barSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-bar]');
  if (b) { ui.follow = !seq.playing; setBar(+b.dataset.bar); }
});
$('#barsSel').addEventListener('change', (e) => {
  snapshot();
  setPatternBars(pat(), +e.target.value, true);
  ui.bar = Math.min(ui.bar, pat().bars - 1);
  syncPlayback(); renderAll(); save();
  toast(`Pattern di ${pat().bars} ${pat().bars > 1 ? 'battute (contenuto ripetuto)' : 'battuta'}`);
  e.target.blur();
});
ui.follow = true;

function renderTrackLabels() {
  const p = pat(), kit = kitOf(p);
  const anySolo = p.tracks.some((t) => t.solo);
  for (let t = 0; t < TRACKS; t++) {
    const tr = p.tracks[t], k = kit.tracks[t];
    const wav = engine.samples[t] ? '•' : '';
    labels[t].querySelector('b').textContent = k.short + wav;
    labels[t].querySelector('i').textContent = k.name + (tr.len < patSteps(p) ? ` /${tr.len}` : '');
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
    if (d.k === 'len') inp.max = patSteps(p);
    const v = paramGet(t, tr, d.k);
    inp.value = v;
    inp.nextElementSibling.textContent = d.fmt(v);
  });
}

function renderTransport() {
  const p = pat(), tp = tempoPattern();
  $('#bpmVal').textContent = tp.bpm;
  $('#swing').value = tp.swing;
  $('#swingVal').textContent = tp.swing + '%';
  $('#kit').value = kitOf(p).id;
  $('#slot').value = state.slot;
  setToggle($('#lockBtn'), !!state.lock);
  $('#lockBtn').textContent = state.lock ? '🔒' : '🔓';
}

function renderTools() {
  setToggle($('[data-cmd="edit"]'), ui.edit);
  setToggle($('[data-cmd="met"]'), ui.met);
  const vb = $('[data-cmd="view"]');
  const next = { drum: 'synth', synth: 'perf', perf: 'drum' }[ui.view];
  vb.textContent = { drum: 'DRM▸', synth: 'SYN▸', perf: 'PRF▸' }[ui.view];
  vb.setAttribute('aria-label', `Vista ${{ drum: 'batteria', synth: 'synth', perf: 'performance' }[ui.view]}; tocca per ${{ drum: 'batteria', synth: 'synth', perf: 'performance' }[next]}`);
  vb.classList.toggle('on', ui.view !== 'drum');
  $('[data-cmd="song"]').classList.toggle('on', state.song.on);
  const fxOn = state.fx.filter !== 0 || state.fx.sc > 0 || pat().tracks.some((t) => t.rev > 0 || t.dly > 0) || state.devs.some((c) => c.some((d) => d.on));
  $('[data-cmd="fx"]').classList.toggle('on', fxOn);
  $('[data-cmd="paste"]').disabled = !ui.clip;
  grid.classList.toggle('editing', ui.edit);
  renderUndo();
}

function renderAll() {
  renderBarsCtl();
  for (let t = 0; t < TRACKS; t++) renderRow(t);
  // Layout Studio: nell'editor solo i canali attivi
  const studioOn = sessionActive();
  for (let t = 0; t < TRACKS; t++) labels[t].parentElement.classList.toggle('inactive', studioOn && !state.tracks.includes(t));
  for (let k = 0; k < 4; k++) { const r = $(`.srow.sk${k}`); if (r) r.classList.toggle('inactive', studioOn && !state.tracks.includes(8 + k)); }
  renderTrackLabels();
  renderParams();
  renderTransport();
  renderTools();
  if (synthUI) synthUI.render();
  if (perf) perf.render();
  if (studio) studio.render();
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

const posVal = document.getElementById('posVal');
let lastPos = '';
/** Contatore di posizione stile DAW (battuta · quarto · sedicesimo). */
function showPos(tick) {
  const t = Math.max(0, tick);
  const s = `${Math.floor(t / 16) + 1}.${Math.floor((t % 16) / 4) + 1}.${(t % 4) + 1}`;
  if (s !== lastPos) { lastPos = s; posVal.textContent = s; }
}

function showTick(e) {
  showPos(e.abs ?? e.tick);
  // Song mode: la vista segue il pattern in riproduzione
  if (state.song.on && e.pattern !== pat()) {
    const i = state.slots.indexOf(e.pattern);
    if (i >= 0) { state.slot = i; renderAll(); }
  }
  if (e.meta !== ui.songIdx) { ui.songIdx = e.meta; if (!$('#songSheet').hidden) renderSong(); }
  const p = pat();
  if (ui.follow && (p.bars || 1) > 1 && (e.pattern === p || e.pattern.composite)) setBar(Math.floor((e.tick % patSteps(p)) / STEPS));
  for (let t = 0; t < TRACKS; t++) {
    const col = (e.tick % p.tracks[t].len) - off();
    const c = col >= 0 && col < STEPS ? cells[t][col] : null;
    if (phCells[t] !== c) {
      if (phCells[t]) phCells[t].classList.remove('ph');
      if (c) c.classList.add('ph');
      phCells[t] = c;
    }
  }
  const page = ((e.tick % patSteps(p)) % STEPS) >> 3;
  if (page !== litPage) {
    litPage = page;
    pagerBtns.forEach((b) => b.classList.toggle('lit', +b.dataset.page === page));
  }
  if (synthUI) synthUI.showTick(e);
  if (piano) piano.tick(e.tick);
  if (studio) studio.tick(e);
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

const paints = new Map();      // dito (pointerId) → pennello sugli step
const padFingers = new Map();  // dito → pad sotto il dito (scivolando su un altro pad lo suona)

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
  // Multitouch: ogni dito dipinge per conto suo
  if (v !== null) paints.set(e.pointerId, { v, seen: new Set([c]) });
});

grid.addEventListener('pointermove', (e) => {
  const paint = paints.get(e.pointerId);
  if (!paint) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const c = el && el.closest && el.closest('.step');
  if (!c || paint.seen.has(c)) return;
  paint.seen.add(c);
  setStep(+c.dataset.t, +c.dataset.s, paint.v);
});

const endPaint = (e) => { paints.delete(e.pointerId); padFingers.delete(e.pointerId); };
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
      case 'ArrowRight': s = Math.min(patSteps(pat()) - 1, s + 1); break;
      case 'ArrowLeft': s = Math.max(0, s - 1); break;
      case 'ArrowDown': t = Math.min(TRACKS - 1, t + 1); break;
      case 'ArrowUp': t = Math.max(0, t - 1); break;
      case 'Home': s = off(); break;
      case 'End': s = off() + STEPS - 1; break;
      case 'Enter': case ' ':
        e.preventDefault(); e.stopPropagation();
        activateStep(t, s);
        return;
      default: return;
    }
    e.preventDefault();
    if ((s >> 4) !== ui.bar) { ui.follow = false; setBar(s >> 4); }
    if (narrow && String((s & 15) >> 3) !== grid.dataset.page) setPage((s & 15) >> 3);
    setFocusCell(cells[t][s & 15]);
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
  remoteOp('trig', { i: t, vel });
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
  padFingers.set(e.pointerId, t);
  if (t !== state.sel) selectTrack(t);
});
// Dita che scivolano da un pad all'altro (rullate con più dita)
padsEl.addEventListener('pointermove', (e) => {
  if (!padFingers.has(e.pointerId) || !engine.ctx) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const pad = el && el.closest && el.closest('.pad');
  if (!pad || !padsEl.contains(pad)) return;
  const t = +pad.dataset.t;
  if (t === padFingers.get(e.pointerId)) return;
  padFingers.set(e.pointerId, t);
  hitPad(t, 0.85);
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
  let v = parseFloat(inp.value);
  if (k === 'len') v = Math.round(v);
  if (k === 'crush') v = v < 4 ? 0 : Math.round(v);
  paramSet(state.sel, tr, k, v);
  $$(`#sliders input[data-param="${k}"]`).forEach((x) => {
    if (x !== inp) x.value = inp.value;
    x.nextElementSibling.textContent = PARAMS.find((d) => d.k === k).fmt(v);
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
  const PG = ['snd', 'mix', 'fx'];
  box.dataset.pg = PG[(PG.indexOf(box.dataset.pg) + 1) % PG.length];
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
$('#wavBtn').addEventListener('click', () => panels.openSample());
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

function startPlayback(fromRemote = false) {
  if (!engine.ctx || seq.playing) return;
  if (!fromRemote) remoteOp('play');
  if (sessionActive()) {
    // Vista TRACCE: si ascolta la timeline (se ha regioni)
    if (studio && studio.view === 'tracks' && state.arr.bars.length && !ui.arrRec) state.arr.on = true;
    // Clip in attesa partono subito; senza clip si lancia la scena del pattern selezionato
    ui.sceneBars = 0;
    if (state.arr.on && state.arr.bars.length && !ui.arrRec) {
      ui.queued.fill(null); ui.pendingMaster = null;
      ui.arrBar = clamp(ui.arrStart, 0, state.arr.bars.length - 1);
      loadArrBar(ui.arrBar);
    } else {
      ui.arrBar = 0;
      applyQueued();
      if (state.session.map.every((v) => v < 0)) { state.session.map.fill(state.slot); state.session.master = state.slot; }
    }
    if (ui.arrRec) recordBar();
    seq.meta = null;
  } else if (state.song.on && state.song.chain.length) {
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
  ui.follow = true;
  seq.start();
  setToggle($('#play'), true);
  $('#play').setAttribute('aria-label', 'Stop');
}

function stopPlayback(fromRemote = false) {
  showPos(0);
  if (!fromRemote && seq.playing) remoteOp('stop');
  seq.stop();
  ui.queued.fill(null);
  ui.pendingMaster = null;
  if (ui.arrRec) endArrRec();
  ui.songIdx = -1;
  setToggle($('#play'), false);
  $('#play').setAttribute('aria-label', 'Play');
  if (!$('#songSheet').hidden) renderSong();
}

const togglePlay = () => (seq.playing ? stopPlayback() : startPlayback());
$('#play').addEventListener('click', togglePlay);

document.addEventListener('keyup', (e) => { if (piano) piano.key(e, false); });
document.addEventListener('keydown', (e) => {
  if (piano && piano.key(e, true)) { e.preventDefault(); return; }
  if (e.key === 'Escape') { $$('.sheet').forEach((s) => { s.hidden = true; }); return; }
  if (e.code === 'Space' && !e.target.closest('input, select, button, .step, .lbl, [role="button"]')) {
    e.preventDefault();
    togglePlay();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  if (e.key.toLowerCase() === 'm' && !LAB && sessionActive() && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target.closest('input, select, textarea') && $('#macroSheet').hidden) {
    e.preventDefault();
    macros.open();
  }
  if (e.key.toLowerCase() === 'a' && !LAB && sessionActive() && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target.closest('input, select, textarea') && $('#autoSheet').hidden) {
    e.preventDefault();
    auto.open();
  }
  if (e.key.toLowerCase() === 'p' && !LAB && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target.closest('input, select, textarea') && $('#pianoSheet').hidden) {
    e.preventDefault();
    piano.open();
  }
  if (e.key.toLowerCase() === 'w' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target.closest('input, select, textarea') && $('#waveSheet').hidden) {
    e.preventDefault();
    synthUI.openEditor();
  }
  // Studio: 1-8 lancia la scena, "." ferma tutte le clip
  if (sessionActive() && !e.ctrlKey && !e.metaKey && !e.target.closest('input, select, textarea')) {
    if (/^[1-8]$/.test(e.key)) { e.preventDefault(); launchScene(+e.key - 1); }
    else if (e.key === '.') { e.preventDefault(); stopAllClips(); }
    else if (e.key === 'Tab' && !e.shiftKey && !e.target.closest('.sheet')) { e.preventDefault(); studio.toggleView(); }
  }
});

function setBpm(v) {
  const p = tempoPattern();
  p.bpm = clamp(Math.round(v), 40, 240);
  $('#bpmVal').textContent = p.bpm;
  if (sessionActive()) { if (seq.pattern.composite) seq.pattern.bpm = p.bpm; engine.setFx({}, p.bpm); }
  else if (isPlayingPattern(p)) engine.setFx({}, p.bpm);
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
holdRepeat($('#bpmDown'), () => setBpm(tempoPattern().bpm - 1));
holdRepeat($('#bpmUp'), () => setBpm(tempoPattern().bpm + 1));

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
  tempoPattern().swing = +e.target.value;
  if (sessionActive() && seq.pattern.composite) seq.pattern.swing = +e.target.value;
  $('#swingVal').textContent = e.target.value + '%';
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
/** Layout compatto (touch) o Studio (PC). */
function applyLayout() {
  const studioOn = sessionActive();
  $('#app').dataset.layout = studioOn ? 'studio' : 'compact';
  $('#layoutBtn').classList.toggle('on', state.layout === 'studio');
  $('#layoutBtn').setAttribute('aria-pressed', state.layout === 'studio');
  if (studioOn && ui.view === 'perf') setView('drum');
  if (studio) studio.setActive(studioOn);
  if (seq.playing) syncPlayback();
  renderAll();
}

function toggleLayout() {
  state.layout = state.layout === 'studio' ? 'compact' : 'studio';
  if (state.layout === 'studio' && state.session.map.every((v) => v < 0)) {
    state.session.map.fill(state.slot);
    state.session.master = state.slot;
  }
  if (seq.playing) stopPlayback();
  applyLayout();
  save();
  if (state.layout === 'studio' && !studioMQ.matches) toast('Il layout Studio richiede una finestra di almeno 1000×600');
}

function setView(v) {
  ui.view = state.view = v;
  $('#app').dataset.view = v;
  if (v === 'perf' && perf) perf.render();
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
      remoteOp('met', { on: ui.met });
      break;
    case 'song': renderSong(); openSheet('songSheet'); break;
    case 'fx': renderFx(); openSheet('fxSheet'); break;
    case 'view': setView({ drum: 'synth', synth: 'perf', perf: 'drum' }[ui.view]); break;
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
  // Niente focus sui campi di testo: su iOS aprirebbe la tastiera
  const f = s.querySelector('button, input:not([type="search"]):not([type="text"]), select');
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
  const tr = p.tracks[t], pl = o.pl || {};
  [['tune', tr.tune, (v) => (v > 0 ? '+' : '') + v], ['decay', tr.decay, (v) => v.toFixed(2)], ['vel', p.steps[t][s] === 2 ? 1 : 0.62, (v) => `${Math.round(v * 100)}`]]
    .forEach(([key, def, fmt]) => {
      const inp = $(`input[data-dlock="${key}"]`, sheet);
      inp.value = pl[key] ?? def;
      inp.nextElementSibling.textContent = pl[key] != null ? fmt(pl[key]) : '—';
    });
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
  const lk = e.target.dataset.dlock;
  if (lk) {
    const { t, s } = editing, p = pat();
    const o = p.opts[t][s] || { ...STEP_DEFAULT };
    p.opts[t][s] = normalizeOpt({ ...o, pl: { ...(o.pl || {}), [lk]: +e.target.value } });
    if (!p.steps[t][s]) p.steps[t][s] = 1;
    renderCell(t, s); renderStepEditor(); save();
  }
});

// =====================================================================
// Song mode
// =====================================================================

/** Chiamato dal sequencer all'inizio di ogni battuta (16 tick). */
// =====================================================================
// Session: lancio di clip e scene (quantizzato alla battuta)
// =====================================================================

function applyQueued() {
  let changed = false;
  ui.queued.forEach((q, i) => {
    if (q === null) return;
    state.session.map[i] = q;
    ui.queued[i] = null;
    changed = true;
  });
  if (ui.pendingMaster != null) {
    state.session.master = ui.curScene = ui.pendingMaster;
    ui.pendingMaster = null;
    ui.sceneBars = 0;
    changed = true;
  }
  return changed;
}
const hasQueued = () => ui.pendingMaster != null || ui.queued.some((q) => q !== null);

/** Un lancio manuale durante la riproduzione dell'arrangiamento torna alla session (come in Live). */
function leaveArr() {
  if (state.arr.on && seq.playing) { state.arr.on = false; toast('Session: arrangiamento in pausa (▶ ARR per tornare)'); }
}

/** Lancia la clip `slot` sulla traccia `i` (-1 = ferma la traccia). */
function launchClip(i, slot, fromRemote = false) {
  if (!fromRemote) remoteOp('launch', { i, s: slot });
  leaveArr();
  if (!seq.playing) {
    state.session.map[i] = slot;
    if (slot >= 0 && state.session.map.filter((v) => v >= 0).length === 1) state.session.master = slot;
    if (slot >= 0) startPlayback(true); else syncPlayback();
  } else {
    ui.queued[i] = slot;
  }
  save();
  if (studio) studio.render();
}

/** Lancia la scena `slot` (stessa riga su tutte le tracce); diventa il pattern principale. */
function launchScene(slot, fromRemote = false) {
  if (!fromRemote) remoteOp('scene', { s: slot });
  leaveArr();
  if (!seq.playing) {
    state.session.map.fill(slot);
    state.session.master = ui.curScene = slot;
    ui.sceneBars = 0;
    startPlayback(true);
  } else {
    ui.queued.fill(slot);
    ui.pendingMaster = slot;
  }
  save();
  if (studio) studio.render();
}

function stopAllClips(fromRemote = false) {
  if (!fromRemote) remoteOp('stopall');
  leaveArr();
  ui.curScene = null;
  ui.pendingMaster = null;
  if (!seq.playing) state.session.map.fill(-1); else ui.queued.fill(-1);
  save();
  if (studio) studio.render();
}

// ----- Arrangiamento -----

function loadArrBar(b) {
  const e = state.arr.bars[b];
  if (!e) return;
  e.m.forEach((v, i) => { state.session.map[i] = v; });
  state.session.master = e.s;
}

/** Scrive la battuta corrente della session nell'arrangiamento. */
function recordBar() {
  if (!ui.arrRecOn) { state.arr.bars = []; state.arr.on = false; ui.arrRecOn = true; }
  if (state.arr.bars.length >= MAX_ARR_BARS) { endArrRec(); return; }
  state.arr.bars.push({ m: [...state.session.map], s: state.session.master });
}

function endArrRec() {
  const n = ui.arrRecOn ? state.arr.bars.length : 0;
  ui.arrRec = ui.arrRecOn = false;
  if (n) { state.arr.on = true; ui.arrStart = 0; toast(`Arrangiamento registrato: ${n} battute`); }
  save();
  if (studio) studio.render();
}

function setArrRec(on, fromRemote = false) {
  if (!fromRemote) remoteOp('arrrec', { on });
  ui.arrRec = on;
  if (!on && ui.arrRecOn) endArrRec();
  if (studio) studio.render();
}

/** ▶ ARR: riproduce l'arrangiamento (durante la riproduzione riprende dalla battuta successiva). */
function toggleArr(fromRemote = false) {
  if (!state.arr.bars.length) { if (!fromRemote) toast('Arrangiamento vuoto: registra con ● REC ARR o disegna le battute'); return; }
  if (!fromRemote) remoteOp('arr');
  state.arr.on = !state.arr.on;
  if (state.arr.on) { ui.queued.fill(null); ui.pendingMaster = null; }
  save();
  if (studio) studio.render();
}

/** Ogni step (session): arrangiamento, follow action, lanci quantizzati, registrazione. */
seq.onStep = (tick, time) => {
  if (!sessionActive()) return null;
  let changed = false;
  const bar = tick > 0 && tick % STEPS === 0;
  if (bar) {
    const len = state.arr.bars.length;
    ui.arrBar = len ? (ui.arrBar + 1) % len : 0;
    if (state.arr.on && len) {
      loadArrBar(ui.arrBar);
      changed = true;
    } else {
      ui.sceneBars++;
      const sc = ui.curScene, f = sc != null ? state.session.follow[sc] : null;
      if (f && f.a !== 'none' && ui.sceneBars >= f.n && !hasQueued()) {
        const t = followTarget(f.a, sc, state.slots, () => ((Math.imul(tick + 1, 2654435761) >>> 0) % 1000) / 1000);
        if (t === -1) { ui.queued.fill(-1); ui.curScene = null; } else if (t != null) { ui.queued.fill(t); ui.pendingMaster = t; }
        changed = applyQueued() || changed;
        ui.sceneBars = 0;
      }
    }
  }
  if (hasQueued() && tick % Math.max(1, state.session.quant) === 0) changed = applyQueued() || changed;
  if (bar && ui.arrRec) recordBar();
  const delay = Math.max(0, (time - engine.ctx.currentTime) * 1000);
  if (bar && studio) setTimeout(() => studio.barTick(), delay);
  if (!changed) return null;
  const next = composeSession();
  engine.setVoiceKit(kitById(next.kit));
  engine.applyMix(next, time);
  engine.setFx({}, next.bpm);
  setTimeout(() => {
    engine.setChainKit(kitById(next.kit));
    if (studio) studio.render();
    save();
  }, delay);
  return next;
};

seq.onBar = (tick, time) => {
  if (sessionActive()) return null;
  const chain = state.song.chain;
  if (!state.song.on || !chain.length || !ui.songPos) return null;
  const pos = ui.songPos;
  pos.r++;
  if (pos.i >= chain.length) pos.i = 0;
  // Ripetizioni contate in battute: un pattern di 2 battute ripetuto 2 volte dura 4 battute
  if (pos.r >= chain[pos.i].rep * (state.slots[chain[pos.i].slot].bars || 1)) { pos.i = (pos.i + 1) % chain.length; pos.r = 0; }
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
  const btn = e.target.closest('[data-act]');
  const act = btn && btn.dataset.act;
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
    case 'wav-pattern': exportAudio(new Array(4 * (p.bars || 1)).fill(clonePattern(p)), `pat${state.slot + 1}`); return;
    case 'stems': {
      const bars = [];
      if (state.song.on) state.song.chain.forEach((c) => { const cp = clonePattern(state.slots[c.slot]); for (let r = 0; r < c.rep * (cp.bars || 1); r++) bars.push(cp); });
      if (!bars.length) { const cp = clonePattern(p); for (let r = 0; r < 4 * (p.bars || 1); r++) bars.push(cp); }
      exportStems(bars, state.song.on && state.song.chain.length ? 'song' : `pat${state.slot + 1}`);
      return;
    }
    case 'wav-song': {
      const bars = [];
      state.song.chain.forEach((c) => { const cp = clonePattern(state.slots[c.slot]); for (let r = 0; r < c.rep * (cp.bars || 1); r++) bars.push(cp); });
      if (!bars.length) { toast('Catena song vuota'); return; }
      exportAudio(bars, 'song');
      return;
    }
    case 'export': exportJSON(); return;
    case 'projects': panels.openProjects(); return;
    case 'layout': toggleLayout(); return;
    case 'share': panels.share(); return;
    case 'gen': panels.openGen(); return;
    case 'kits': panels.openKits(); return;
    case 'macro': macros.open(); return;
    case 'audioout': audioOut.open(); return;
    case 'phone': openPhone(); return;
    case 'auto': auto.open(ui.view === 'synth' ? `s${ui.ssel || 0}.cut` : `d${state.sel}.vol`); return;
    case 'wt': synthUI.openEditor(); return;
    case 'pp': presetPlayer.open(ui.ssel || 0); return;
    case 'recout': panels.recordOutput(); return;
    case 'mid-pattern': panels.exportMid(new Array(4 * (p.bars || 1)).fill(clonePattern(p)), `pat${state.slot + 1}`); return;
    case 'mid-song': {
      const bars = [];
      state.song.chain.forEach((c) => { const cp = clonePattern(state.slots[c.slot]); for (let r = 0; r < c.rep * (cp.bars || 1); r++) bars.push(cp); });
      if (!bars.length) { toast('Catena song vuota'); return; }
      panels.exportMid(bars, 'song');
      return;
    }
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
    const buf = await renderBars(bars, { fx: state.fx, samples: engine.samples, lockKit: state.lock, devs: state.devs });
    const blob = encodeWav(buf);
    await deliver(new File([blob], `drumbort-${name}-${bars[0].bpm}bpm.wav`, { type: 'audio/wav' }));
    toast(`WAV pronto (${buf.duration.toFixed(1)} s)`);
  } catch (err) {
    toast('Export audio non riuscito');
  }
}

/**
 * Stem: un WAV per traccia (8 batteria + 4 synth) con gli effetti master, in uno ZIP.
 * Le tracce mute o vuote vengono saltate.
 */
async function exportStems(bars, name) {
  const SY = ['BASS', 'LEAD', 'PAD', 'KEYS'];
  const used = (i) => bars.some((p) => (i < TRACKS ? p.steps[i].some(Boolean) && !p.tracks[i].mute
    : (p.synth.tracks[i - TRACKS].steps.some(Boolean) || p.synth.tracks[i - TRACKS].arp.on) && !p.synth.tracks[i - TRACKS].mute));
  const list = Array.from({ length: TRACKS + 4 }, (_, i) => i).filter(used);
  if (!list.length) { toast('Nessuna traccia da esportare'); return; }
  const files = [];
  try {
    for (const [n, i] of list.entries()) {
      toast(`Stem ${n + 1}/${list.length}…`);
      const made = new Map();
      const solo = bars.map((src) => {
        if (made.has(src)) return made.get(src);
        const p = clonePattern(src);
        p.tracks.forEach((t, j) => { t.solo = false; t.mute = j !== i; });
        p.synth.tracks.forEach((t, k) => { t.solo = false; t.mute = TRACKS + k !== i; });
        made.set(src, p);
        return p;
      });
      const buf = await renderBars(solo, { fx: state.fx, samples: engine.samples, lockKit: state.lock, devs: state.devs });
      const label = i < TRACKS ? kitOf(bars[0]).tracks[i].name : SY[i - TRACKS];
      const fname = `${String(n + 1).padStart(2, '0')}-${label.replace(/[^A-Za-z0-9]+/g, '_')}.wav`;
      files.push({ name: fname, data: new Uint8Array(await encodeWav(buf).arrayBuffer()) });
    }
    await deliver(new File([makeZip(files)], `drumbort-${name}-stem-${bars[0].bpm}bpm.zip`, { type: 'application/zip' }));
    toast(`${files.length} stem pronti`);
  } catch (err) {
    toast('Export degli stem non riuscito');
  }
}

/** Dati completi del progetto (export JSON, progetti salvati). */
function exportData() {
  return {
    app: 'drumbort', version: 3, appVersion: APP_VERSION,
    slot: state.slot, slots: state.slots, song: state.song, fx: state.fx, lock: state.lock, userKits: state.userKits,
    userPresets: state.userPresets, userSounds: state.userSounds, session: state.session, arr: state.arr, macros: state.macros,
    tracks: state.tracks, devs: state.devs,
  };
}

/** Sostituisce il progetto corrente con i dati forniti. */
function importData(o) {
  mergeUserPresets(o.userPresets);
  mergeUserSounds(o.userSounds);
  if (Array.isArray(o.userKits)) {
    const ids = new Set(state.userKits.map((d) => d.id));
    state.userKits = state.userKits.concat(o.userKits.filter((d) => d && !ids.has(d.id)));
    setUserKits(state.userKits);
    buildKitSelect();
  }
  for (let i = 0; i < SLOTS; i++) state.slots[i] = o.slots[i] ? normalizePattern(o.slots[i]) : createPattern(KITS[0].id, false);
  state.song = normalizeSong(o.song);
  state.fx = normalizeFx(o.fx);
  state.lock = o.lock && kitById(o.lock).id === o.lock ? o.lock : null;
  state.slot = clamp(o.slot | 0, 0, SLOTS - 1);
  if (o.session) state.session = normalizeSession(o.session);
  if (o.macros) state.macros = normalizeMacros(o.macros);
  state.tracks = normalizeTracks(o.tracks);
  state.devs = normalizeDevs(o.devs);
  engine.setAllDevices(state.devs);
  state.arr = normalizeArr(o.arr);
  undoStack.length = 0; redoStack.length = 0;
  if (seq.playing) stopPlayback();
  syncPlayback(); renderAll(); save();
}

/** Aggiunge o aggiorna i suoni di batteria utente (prima dei kit che li usano). */
function mergeUserSounds(list) {
  if (!Array.isArray(list)) return 0;
  const add = list.map(normalizeSound).filter(Boolean);
  const ids = new Set(add.map((s) => s.id));
  state.userSounds = (state.userSounds || []).filter((s) => !ids.has(s.id)).concat(add);
  setUserSounds(state.userSounds);
  if (add.length) { setUserKits(state.userKits); if (engine.cache) engine.cache.clear(); }
  return add.length;
}

/** Pacchetto di suoni dal Sound Lab (link #snd= o file): entra nella libreria. */
function importSoundPack(o) {
  const before = state.userPresets.length;
  mergeUserPresets(o.presets);
  const np = state.userPresets.length - before;
  const ns = mergeUserSounds(o.sounds);
  buildKitSelect();
  renderAll(); save();
  toast(`Importati ${np} synth e ${ns} suoni di batteria${LAB ? '' : ' (browser: SUONI → Utente, KIT → I miei suoni)'}`);
}

async function handleSoundHash() {
  const m = location.hash.match(/^#snd=([jz][A-Za-z0-9_-]+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const o = await decodeShare(m[1]);
    if (!isSoundPack(o)) throw new Error('formato');
    importSoundPack(o);
  } catch (_) { toast('Link dei suoni non valido'); }
}

/** Assegna un suono utente alla traccia di batteria `t` del pattern corrente (crea/aggiorna un kit utente). */
function useSoundOnTrack(soundId, t) {
  snapshot();
  const def = kitWithSound(pat().kit, t, soundId);
  state.userKits = (state.userKits || []).filter((d) => d.id !== def.id).concat(def);
  setUserKits(state.userKits);
  if (engine.cache) engine.cache.clear();
  pat().kit = def.id;
  buildKitSelect();
  syncPlayback(); renderAll(); save();
  toast(`Suono sulla traccia ${t + 1} · kit "${def.name}"`);
}

/** Aggiunge i preset utente non ancora presenti (prima di leggere i pattern che li usano). */
function mergeUserPresets(list) {
  if (!Array.isArray(list)) return;
  const ids = new Set(state.userPresets.map((p) => p.id));
  state.userPresets = state.userPresets.concat(list.filter((p) => p && typeof p.id === 'string' && !ids.has(p.id)));
  setUserPresets(state.userPresets);
}

/** Nuovo progetto: vuoto, nessuna traccia, nessun groove o preset dimostrativo. */
function newProject() {
  for (let i = 0; i < SLOTS; i++) state.slots[i] = createPattern(KITS[0].id, false, null);
  state.tracks = [];
  state.macros = defaultMacros();
  state.devs = emptyDevs();
  engine.setAllDevices(state.devs);
  ui.arrStart = 0;
  state.song = normalizeSong(null);
  state.fx = { ...DEFAULT_FX };
  state.lock = null;
  state.slot = 0;
  state.session = normalizeSession(null);
  state.session.map.fill(0);
  state.arr = normalizeArr(null);
  undoStack.length = 0; redoStack.length = 0;
  if (seq.playing) stopPlayback();
  syncPlayback(); renderAll(); save();
}

function exportJSON() {
  deliver(new File([JSON.stringify(exportData())], 'drumbort-patterns.json', { type: 'application/json' }));
}

$('#importFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const o = JSON.parse(await f.text());
    if (isSoundPack(o)) { importSoundPack(o); return; }
    if (LAB) { toast('Nel Sound Lab si importano solo file di suoni'); return; }
    snapshot();
    if (Array.isArray(o.slots)) {
      mergeUserPresets(o.userPresets);
      if (Array.isArray(o.userKits)) {
        const ids = new Set(state.userKits.map((d) => d.id));
        state.userKits = state.userKits.concat(o.userKits.filter((d) => d && !ids.has(d.id)));
        setUserKits(state.userKits);
        buildKitSelect();
      }
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
/** QR code e indirizzi per collegare il telefono (solo con l'app per PC). */
async function openPhone() {
  try {
    const r = await fetch('./connect.json', { cache: 'no-store' });
    if (!r.ok) throw new Error();
    const { urls } = await r.json();
    if (!urls.length) { toast('Nessuna rete locale: collega il PC al Wi-Fi'); return; }
    $('#phoneQr').src = `./qr.svg?t=${Date.now()}`;
    $('#phoneUrls').innerHTML = urls.map((u) => `<code>${u.replace(/[<>&"]/g, '')}</code>`).join('');
    openSheet($('#phoneSheet'));
  } catch (_) {
    toast("Disponibile nell'app DrumBort per PC");
  }
}

// Avvio audio (overlay "Tocca per iniziare") e ripresa su iOS
// =====================================================================

const overlay = $('#overlay');
/**
 * Finestra di programma dell'app per PC (?app, motore audio nativo C#): l'interfaccia non produce
 * audio, quindi niente schermata "Tocca per iniziare".
 */
const APP_WINDOW = new URLSearchParams(location.search).has('app')
  && (document.querySelector('meta[name="drumbort-host"]') || {}).content === 'native';
let unlocked = false;

async function startAudio() {
  try {
    await engine.unlock();
    if (!unlocked) {
      unlocked = true;
      syncPlayback();
      restoreSamples();
      if (audioOut) audioOut.restore();
      engine.ctx.addEventListener('statechange', () => {
        // iOS può sospendere/interrompere il contesto (chiamate, background)
        if (engine.ctx.state !== 'running' && document.visibilityState === 'visible' && !APP_WINDOW) overlay.hidden = false;
      });
      if (midi.supported && (state.midi.input || state.midi.output)) {
        midi.enable().then(() => { midi.setInput(state.midi.input); midi.setOutput(state.midi.output); }).catch(() => {});
      }
    }
    if (engine.ctx.state === 'running' || APP_WINDOW) overlay.hidden = true;
  } catch (_) {
    overlay.hidden = APP_WINDOW;
  }
}
overlay.addEventListener('pointerup', startAudio);
overlay.addEventListener('click', startAudio);
overlay.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startAudio(); } });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && engine.ctx && engine.ctx.state !== 'running') {
    engine.ctx.resume().catch(() => {}).finally(() => {
      if (engine.ctx.state !== 'running' && !APP_WINDOW) overlay.hidden = false;
    });
  }
});
if (APP_WINDOW) {
  overlay.hidden = true;
  startAudio();
  document.addEventListener('pointerdown', () => { if (engine.ctx && engine.ctx.state !== 'running') engine.ctx.resume().catch(() => {}); }, { once: true });
}

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
// Controllo remoto (host desktop): parti del progetto e azioni dal vivo
// =====================================================================

/** Parti del progetto sincronizzate (layout e vista restano per dispositivo). */
function remoteParts() {
  if (LAB) return { userPresets: state.userPresets, userSounds: state.userSounds };
  const parts = {
    slot: state.slot, fx: state.fx, song: state.song, lock: state.lock,
    session: { quant: state.session.quant, follow: state.session.follow },
    arr: state.arr, userKits: state.userKits, userPresets: state.userPresets,
    mode: sessionActive() ? 'session' : 'pattern',
    tracks: state.tracks, devs: state.devs,
  };
  state.slots.forEach((p, i) => { parts[`p${i}`] = p; });
  parts.userSounds = state.userSounds;
  return parts;
}

function applyRemoteParts(parts, full) {
  if (parts.userPresets) mergeUserPresets(parts.userPresets);
  if (parts.userSounds) mergeUserSounds(parts.userSounds);
  if (LAB) { if (lab) lab.render(); save(); return; }
  if (parts.userKits) {
    state.userKits = parts.userKits;
    setUserKits(state.userKits);
    buildKitSelect();
  }
  for (let i = 0; i < SLOTS; i++) {
    const p = parts[`p${i}`];
    if (p) { try { state.slots[i] = normalizePattern(p); } catch (_) { /* pattern non valido */ } }
  }
  if (typeof parts.slot === 'number') state.slot = clamp(parts.slot | 0, 0, SLOTS - 1);
  if (parts.fx) state.fx = normalizeFx(parts.fx);
  if (parts.tracks) state.tracks = normalizeTracks(parts.tracks);
  if (parts.devs) { state.devs = normalizeDevs(parts.devs); engine.setAllDevices(state.devs); }
  if (parts.song) state.song = normalizeSong(parts.song);
  if ('lock' in parts) state.lock = parts.lock && findKit(parts.lock) ? parts.lock : null;
  if (parts.session) {
    const n = normalizeSession({ ...state.session, ...parts.session });
    state.session.quant = n.quant;
    state.session.follow = n.follow;
  }
  if (parts.arr) {
    const on = state.arr.on;
    state.arr = normalizeArr(parts.arr);
    if (!full) state.arr.on = parts.arr.on ?? on;
  }
  if (full) { undoStack.length = 0; redoStack.length = 0; toast('Progetto sincronizzato'); }
  syncPlayback();
  renderAll();
  if (presetPlayer) presetPlayer.refresh();
  save();
}

const remoteHeld = new Map();   // note synth tenute da un altro dispositivo

function onRemoteOp(m) {
  if (LAB) return;    // il Sound Lab non segue il trasporto né i pad degli altri dispositivi
  const now = engine.ctx ? engine.ctx.currentTime : 0;
  switch (m.op) {
    case 'play': startPlayback(true); break;
    case 'stop': if (seq.playing) stopPlayback(true); break;
    case 'launch': launchClip(m.i | 0, m.s | 0, true); break;
    case 'scene': launchScene(m.s | 0, true); break;
    case 'stopall': stopAllClips(true); break;
    case 'arr': toggleArr(true); break;
    case 'arrrec': setArrRec(!!m.on, true); break;
    case 'met': ui.met = seq.metronome = !!m.on; renderTools(); break;
    case 'trig':
      if (engine.ctx && m.i >= 0 && m.i < TRACKS) engine.trigger(m.i, now, clamp(+m.vel || 0.8, 0, 1), seq.pattern.tracks[m.i]);
      break;
    case 'prev':
      if (engine.ctx && Array.isArray(m.notes)) engine.playSynth(m.k | 0, now, 0.22, m.notes, 0.8, pat().synth.tracks[m.k | 0]);
      break;
    case 'non': {
      if (!engine.ctx || !Array.isArray(m.notes)) break;
      const prev = remoteHeld.get(`${m.cid}:${m.id}`);
      if (prev) prev.release(now);
      remoteHeld.set(`${m.cid}:${m.id}`, engine.playSynth(m.k | 0, now, null, m.notes, clamp(+m.vel || 0.85, 0, 1), pat().synth.tracks[m.k | 0]));
      break;
    }
    case 'noff': {
      const h = remoteHeld.get(`${m.cid}:${m.id}`);
      if (h) { h.release(now); remoteHeld.delete(`${m.cid}:${m.id}`); }
      break;
    }
    case 'stut': if (m.len > 0) seq.startStutter(m.len | 0); else seq.stopStutter(); break;
    case 'fill': seq.fillPattern = m.on ? fillPattern(seq.pattern) : null; break;
    case 'mutes':
      seq.muteD = new Set(Array.isArray(m.d) ? m.d : []);
      seq.muteS = new Set(Array.isArray(m.s) ? m.s : []);
      break;
    case 'fxl': if (m.fx) engine.setFx(m.fx, null); break;
    default: break;
  }
}

function onRemoteRole(role, native) {
  if (LAB) { engine.silent = false; toast('Collegato al PC: i suoni salvati arrivano nella sua libreria'); if (lab) lab.render(); return; }
  engine.silent = role === 'control';
  toast(role === 'control'
    ? (native ? 'Collegato: l\'audio è generato dal motore nativo del PC' : 'Collegato come controller: l\'audio esce dal PC')
    : 'Collegato: questo dispositivo produce l\'audio');
}

function renderRemote(s) {
  const b = $(LAB ? '#labBadge' : '#remoteBadge');
  if (LAB) {
    b.hidden = false;
    b.className = `remote-badge ${s.connected ? 'engine' : 'off'}`;
    b.textContent = s.connected ? '⇄ PC' : 'PC…';
    b.title = s.connected ? 'Collegato a DrumBort Host' : 'Connessione all\'host…';
    return;
  }
  b.hidden = false;
  b.className = `remote-badge ${s.connected ? s.role : 'off'}`;
  b.textContent = !s.connected ? 'HOST…' : s.role === 'control' ? (s.native ? 'CTRL·C#' : 'CTRL') : 'AUDIO';
  b.title = !s.connected ? 'Connessione all\'host desktop…' : `${s.peers} dispositivi collegati`;
}

// =====================================================================
// Init
// =====================================================================

loadState();
engine.setAllDevices(state.devs);
$('#version').textContent = `DrumBort Machine v${APP_VERSION}`;
buildSelects();
buildGrid();
buildPads();
buildSliders();
buildFx();
synthUI = initSynthUI({
  engine, seq, ui, state, pat, save, snapshot, toast, setToggle, isPlayingPattern, remoteOp,
  openSheet, closeSheet, setPage: (n) => setPage(n), paramGet, paramSet,
  onSoundChange: (kind) => { if (lab) lab.render(kind); },
});
const app = {
  engine, seq, ui, state, pat, kitOf, save, snapshot, toast, setToggle, isPlayingPattern, remoteOp,
  openSheet, closeSheet, deliver, syncPlayback, renderAll, buildKitSelect, exportData, importData, newProject,
  paramGet, paramSet, touchTap,
};
panels = initPanels(app);
auto = initAutomation(app);
audioOut = initAudioOut({ ...app, remoteRole: () => remote && remote.role });
macros = initMacros({
  ...app, renderParams: () => { renderParams(); synthUI.render(); if (studio) studio.render(); },
  /** Pattern che contiene i parametri della traccia i (0-7 batteria, 8-11 synth) in riproduzione. */
  trackPattern: (i) => (sessionActive() ? state.slots[state.session.map[i] >= 0 ? state.session.map[i] : state.session.master] : pat()),
});
studio = initStudio({ ...app, openAuto: (k) => auto.open(k), openMacros: () => macros.open(), launchClip, launchScene, stopAllClips, setView, selectTrack: (t) => selectTrack(t), tempoPattern, useSoundOnTrack,
  openLibrary: () => synthUI.openLibrary(), openWave: () => synthUI.openEditor(), kbActive: () => !!(piano && piano.kb),
  toggleArr, setArrRec, songToArr, startPlayback });
if (state.layout === null) state.layout = matchMedia('(pointer: fine) and (min-width: 1200px)').matches ? 'studio' : 'compact';
if (state.layout === 'studio' && state.session.map.every((v) => v < 0)) { state.session.map.fill(state.slot); state.session.master = state.slot; }
$('#layoutBtn').addEventListener('click', toggleLayout);
$('#wtBtn').addEventListener('click', () => synthUI.openEditor());
presetPlayer = initPresetPlayer(app);
piano = initPianoRoll({ ...app, synthUI });
$('#srollBtn').addEventListener('click', () => piano.open());
$('#kbBtn').addEventListener('click', () => piano.toggleKb());
studioMQ.addEventListener('change', applyLayout);
applyLayout();
app.recordOutput = () => panels.recordOutput();
perf = initPerformance(app);
ui.view = state.view;
$('#app').dataset.view = ui.view;
seq.pattern = pat();
engine.setKit(kitOf(pat()));
engine.fx = { ...state.fx };
renderAll();
requestAnimationFrame(frame);

if (LAB) {
  document.documentElement.dataset.mode = 'lab';
  $('#lab').hidden = false;
  $('#overlay .logo span').textContent = 'SOUND LAB';
  lab = initLab({ ...app, synthUI, remote: () => !!(remote && remote.role) });
  lab.showTab('synth');
}
remote = initRemote({ getParts: remoteParts, applyParts: applyRemoteParts, onOp: onRemoteOp, onRole: onRemoteRole, onAudio: (d) => audioOut.changed(d) });
if (remote) remote.onStatus(renderRemote);

// Esposto per debug/test
window.drumbort = { engine, seq, state, ui, midi, version: APP_VERSION, undo, redo, panels, renderAll, get remote() { return remote; } };
if (!LAB) panels.handleShareHash();
handleSoundHash();
window.addEventListener('hashchange', () => { if (!LAB) panels.handleShareHash(); handleSoundHash(); });

// =====================================================================
// PWA: service worker + avviso di aggiornamento
// =====================================================================

if ('serviceWorker' in navigator && !hostInfo()) {   // servita dall'host desktop: niente cache offline
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
