/**
 * waveeditor.js — Editor del synth wavetable: oscillatori con display della forma d'onda,
 * filtri, inviluppi, LFO, step sequencer di modulazione e matrice di modulazione.
 * Le modifiche creano una patch nella traccia (tr.patch); "Salva preset" la aggiunge
 * alla libreria nella categoria Utente.
 */

import { PRESETS, setUserPresets } from './presets.js';
import { SYNTH_TRACKS, presetOf, isChordTrack, diatonicChord } from './synth.js';
import { trackBase } from './synthpattern.js';
import { TABLES, TABLE_LABEL, MOD_SOURCES, MOD_DESTS, FILTER_TYPES, LFO_SHAPES, LFO_SYNC, STEP_DIV, WT_DEFAULT, waveShape, normalizeWTPreset } from './wavetable.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------
// Accesso per percorso ("wt.osc.0.pos")
// ---------------------------------------------------------------------
const getPath = (o, path) => path.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
function setPath(o, path, v) {
  const ks = path.split('.'), last = ks.pop();
  const parent = ks.reduce((x, k) => x[k], o);
  parent[last] = v;
}

// ---------------------------------------------------------------------
// Schema dei controlli
// ---------------------------------------------------------------------
const pct = (v) => `${Math.round(v * 100)}`;
const hz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);
const sec = (v) => (v < 1 ? `${Math.round(v * 1000)}ms` : `${v.toFixed(2)}s`);
const R = (path, label, min, max, step, fmt, log = false) => ({ type: 'range', path, label, min, max, step, fmt, log });
const S = (path, label, options) => ({ type: 'seg', path, label, options });
const SEL = (path, label, options) => ({ type: 'select', path, label, options });
const H = (label) => ({ type: 'head', label });

const FT_LABEL = { none: 'OFF', lowpass: 'LP', bandpass: 'BP', highpass: 'HP', notch: 'NOTCH' };
const SRC_LABEL = { env2: 'MOD ENV', lfo1: 'LFO 1', lfo2: 'LFO 2', step: 'STEP', vel: 'VELOCITY' };
const DST_LABEL = { pos: 'WAVE (tutti)', pos1: 'WAVE 1', pos2: 'WAVE 2', pos3: 'WAVE 3', cut: 'CUTOFF (tutti)', cut1: 'CUTOFF 1', cut2: 'CUTOFF 2', pitch: 'PITCH', amp: 'VOLUME', res: 'RISONANZA 1' };
const SYNC_LABEL = { 0: 'LIBERO', 0.25: '1/16', 0.5: '1/8', 1: '1/4', 2: '1/2', 4: '1 BAR' };
const DIV_LABEL = { 0.5: '1/32', 1: '1/16', 2: '1/8', 4: '1/4' };

const TABS = {
  osc: () => [
    ...[0, 1, 2].flatMap((i) => [
      H(`OSC ${i + 1}`),
      SEL(`wt.osc.${i}.table`, 'TABELLA', TABLES.map((t) => [t, TABLE_LABEL[t]])),
      R(`wt.osc.${i}.pos`, 'WAVE', 0, 1, 0.01, pct),
      R(`wt.osc.${i}.level`, 'LIVELLO', 0, 1, 0.01, pct),
      R(`wt.osc.${i}.semi`, 'SEMITONI', -24, 24, 1, (v) => (v > 0 ? `+${v}` : `${v}`)),
      R(`wt.osc.${i}.fine`, 'FINE', -50, 50, 1, (v) => `${v}c`),
    ]),
    H('UNISONO (OSC 1) E RUMORE'),
    S('wt.uni.voices', 'VOCI', [[1, '1'], [2, '2'], [3, '3']]),
    R('wt.uni.detune', 'DETUNE', 0, 60, 1, (v) => `${v}c`),
    R('wt.noise', 'RUMORE', 0, 1, 0.01, pct),
  ],
  flt: () => [
    H('FILTRO 1'),
    S('wt.f1.type', 'TIPO', FILTER_TYPES.map((t) => [t, FT_LABEL[t]])),
    R('wt.f1.cut', 'CUTOFF', 30, 18000, 0.001, hz, true),
    R('wt.f1.res', 'RISON.', 0.3, 20, 0.1, (v) => v.toFixed(1)),
    H('FILTRO 2'),
    S('wt.f2.type', 'TIPO', ['none', ...FILTER_TYPES].map((t) => [t, FT_LABEL[t]])),
    R('wt.f2.cut', 'CUTOFF', 30, 18000, 0.001, hz, true),
    R('wt.f2.res', 'RISON.', 0.3, 20, 0.1, (v) => v.toFixed(1)),
    H('INSTRADAMENTO'),
    S('wt.route', 'ROUTING', [['serial', 'SERIE'], ['parallel', 'PARALLELO']]),
    R('wt.mix', 'MIX 1↔2', 0, 1, 0.01, pct),
    R('wt.drive', 'DRIVE', 0, 1, 0.01, pct),
  ],
  env: () => [
    H('VOLUME'),
    R('a', 'ATTACK', 0.001, 8, 0.001, sec, true), R('d', 'DECAY', 0.01, 8, 0.001, sec, true),
    R('s', 'SUSTAIN', 0, 1, 0.01, pct), R('r', 'RELEASE', 0.01, 8, 0.001, sec, true),
    R('glide', 'GLIDE', 0, 0.5, 0.005, sec), R('gain', 'GUADAGNO', 0.2, 3, 0.01, (v) => v.toFixed(2)),
    H('INVILUPPO DI MODULAZIONE'),
    R('wt.env2.a', 'ATTACK', 0.001, 8, 0.001, sec, true), R('wt.env2.d', 'DECAY', 0.01, 8, 0.001, sec, true),
    R('wt.env2.s', 'SUSTAIN', 0, 1, 0.01, pct), R('wt.env2.r', 'RELEASE', 0.01, 8, 0.001, sec, true),
  ],
  lfo: () => [1, 2].flatMap((n) => [
    H(`LFO ${n}`),
    S(`wt.lfo${n}.shape`, 'FORMA', LFO_SHAPES.map((s) => [s, { sine: 'SIN', triangle: 'TRI', sawtooth: 'SAW', square: 'SQR' }[s]])),
    SEL(`wt.lfo${n}.sync`, 'TEMPO', LFO_SYNC.map((v) => [v, SYNC_LABEL[v]])),
    R(`wt.lfo${n}.rate`, 'RATE (libero)', 0.02, 30, 0.001, (v) => `${v.toFixed(2)}Hz`, true),
  ]),
  step: () => [
    H('STEP SEQUENCER DI MODULAZIONE'),
    { type: 'steps', path: 'wt.step.values' },
    S('wt.step.div', 'PASSO', STEP_DIV.map((v) => [v, DIV_LABEL[v]])),
  ],
  mod: () => [
    H('MATRICE: SORGENTE → DESTINAZIONE × QUANTITÀ'),
    ...[0, 1, 2, 3, 4, 5].map((i) => ({ type: 'mod', i })),
  ],
};

// Slider logaritmici: posizione 0..1000 ↔ valore
const toSlider = (c, v) => (c.log ? Math.round((Math.log(v / c.min) / Math.log(c.max / c.min)) * 1000) : v);
const fromSlider = (c, x) => (c.log ? c.min * Math.pow(c.max / c.min, x / 1000) : x);

export function initWaveEditor(app) {
  const { engine, seq, state, ui } = app;
  const body = $('#waveBody');
  let k = 0, tab = 'osc', focusOsc = 0, previewTimer = null;

  const tr = () => app.pat().synth.tracks[k];
  const patch = () => presetOf(tr());

  /** Traccia vuota → attiva (strumento della traccia), anche nell'app per PC collegata. */
  function activate() {
    const ch = 8 + k;
    if (!Array.isArray(state.tracks) || state.tracks.includes(ch)) return;
    state.tracks.push(ch);
    state.tracks.sort((a, b) => a - b);
    state.slots.forEach((p) => { p.synth.tracks[k].mute = false; });
  }

  /** Prima modifica: copia il preset di libreria nella traccia. */
  function ensurePatch() {
    activate();
    const t = tr();
    if (!t.patch) {
      const base = PRESETS[t.preset];
      t.patch = normalizeWTPreset(JSON.parse(JSON.stringify(base)), base);
      t.patch.rev = 1;
    }
    return t.patch;
  }

  // ----- Render dei controlli -----
  function ctlHTML(c, P) {
    if (c.type === 'head') return `<div class="lock-title">${esc(c.label)}</div>`;
    if (c.type === 'range') {
      const v = getPath(P, c.path);
      const min = c.log ? 0 : c.min, max = c.log ? 1000 : c.max, step = c.log ? 1 : c.step;
      return `<label class="row-ctl"><small>${c.label}</small><input type="range" data-path="${c.path}" min="${min}" max="${max}" step="${step}" value="${toSlider(c, v)}" aria-label="${c.label}"><output>${c.fmt(v)}</output></label>`;
    }
    if (c.type === 'seg') {
      const v = getPath(P, c.path);
      return `<div class="row-ctl"><small>${c.label}</small><div class="seg" data-path="${c.path}">${
        c.options.map(([val, lab]) => `<button class="btn sm${String(val) === String(v) ? ' on' : ''}" data-v="${val}" aria-pressed="${String(val) === String(v)}">${lab}</button>`).join('')}</div></div>`;
    }
    if (c.type === 'select') {
      const v = getPath(P, c.path);
      return `<label class="row-ctl"><small>${c.label}</small><select class="sel" data-path="${c.path}" aria-label="${c.label}">${
        c.options.map(([val, lab]) => `<option value="${val}"${String(val) === String(v) ? ' selected' : ''}>${lab}</option>`).join('')}</select></label>`;
    }
    if (c.type === 'steps') {
      const vals = getPath(P, c.path);
      return `<div class="step-edit" data-path="${c.path}" role="group" aria-label="Valori dello step sequencer">${
        vals.map((v, i) => `<div class="sbar${i % 4 === 0 ? ' beat' : ''}" data-i="${i}"><i style="height:${Math.round(v * 100)}%"></i></div>`).join('')}</div>`;
    }
    if (c.type === 'mod') {
      const m = P.wt.mod[c.i] || { src: '', dst: 'pos', amt: 0 };
      return `<div class="mod-slot" data-i="${c.i}">
        <select class="sel" data-mod="src" aria-label="Sorgente ${c.i + 1}"><option value="">—</option>${MOD_SOURCES.map((s) => `<option value="${s}"${m.src === s ? ' selected' : ''}>${SRC_LABEL[s]}</option>`).join('')}</select>
        <select class="sel" data-mod="dst" aria-label="Destinazione ${c.i + 1}">${MOD_DESTS.map((d) => `<option value="${d}"${m.dst === d ? ' selected' : ''}>${DST_LABEL[d]}</option>`).join('')}</select>
        <input type="range" data-mod="amt" min="-1" max="1" step="0.01" value="${m.amt}" aria-label="Quantità ${c.i + 1}"><output>${Math.round(m.amt * 100)}</output>
      </div>`;
    }
    return '';
  }

  function render() {
    const t = tr(), P = patch();
    $('#waveTitle').textContent = `EDITOR WAVETABLE · ${SYNTH_TRACKS[k].name.toUpperCase()}`;
    $$('#waveTabs .btn').forEach((b) => app.setToggle(b, b.dataset.tab === tab));
    $$('#waveTracks .btn').forEach((b) => {
      app.setToggle(b, +b.dataset.wtk === k);
      const empty = Array.isArray(state.tracks) && !state.tracks.includes(8 + +b.dataset.wtk);
      b.classList.toggle('empty', empty);
      b.title = empty ? 'Traccia vuota: la prima modifica la attiva con questo strumento' : '';
    });
    const isWT = !!(P && P.wt);
    $('#waveNotWT').hidden = isWT;
    $('#waveMain').hidden = !isWT;
    if (!isWT) return;
    $('#waveName').value = t.patch ? t.patch.name : P.name;
    $('#waveState').textContent = t.patch ? 'Modificato (salvato nel pattern)' : 'Preset di libreria';
    $('[data-act="wave-revert"]').disabled = !t.patch;
    $('[data-act="wave-delete"]').hidden = !t.preset.startsWith('up:');
    body.innerHTML = TABS[tab]().map((c) => ctlHTML(c, P)).join('');
    drawWave();
  }

  function drawWave() {
    const P = patch();
    if (!P || !P.wt) return;
    const cv = $('#waveCanvas'), dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 300, h = cv.clientHeight || 100;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255,255,255,.08)';
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    const o = P.wt.osc[focusOsc];
    const shape = waveShape(o.table, Math.min(1, Math.max(0, o.pos + (tr().pos || 0))), 200);
    g.strokeStyle = o.level ? '#5fd3e6' : '#4b5560';
    g.lineWidth = 2;
    g.beginPath();
    shape.forEach((v, i) => { const x = (i / (shape.length - 1)) * w, y = h / 2 - v * (h * 0.42); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
    g.fillStyle = '#8b8d93';
    g.font = '11px ui-monospace, Menlo, monospace';
    g.fillText(`OSC ${focusOsc + 1} · ${TABLE_LABEL[o.table]} · WAVE ${Math.round(o.pos * 100)}${o.level ? '' : ' · OFF'}`, 8, 14);
  }

  // ----- Modifica -----
  let gesture = false;
  const begin = () => { if (!gesture) { app.snapshot(); gesture = true; } };
  window.addEventListener('pointerup', () => { gesture = false; });

  function commit(path, value, { rerender = false } = {}) {
    begin();
    const P = ensurePatch();
    setPath(P, path, value);
    P.rev = (P.rev || 0) + 1;
    const m = path.match(/^wt\.osc\.(\d)/);
    if (m) focusOsc = +m[1];
    app.save();
    app.onChange();
    $('#waveState').textContent = 'Modificato (salvato nel pattern)';
    $('[data-act="wave-revert"]').disabled = false;
    if (rerender) render(); else drawWave();
  }

  function schedulePreview() {
    if (seq.playing) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(preview, 180);
  }

  function preview() {
    if (!engine.ctx) return;
    const syn = app.pat().synth, base = trackBase(syn, k), now = engine.ctx.currentTime + 0.02;
    if (isChordTrack(k)) {
      const ch = diatonicChord(base, syn.key, syn.scale, 'triad');
      engine.playSynth(k, now, 1.2, ch.map((x) => base + x), 0.8, tr());
    } else {
      [0, 3, 7, 12].forEach((iv, i) => engine.playSynth(k, now + i * 0.2, 0.18, [base + iv], i ? 0.7 : 1, tr()));
    }
  }

  const ctlByPath = (path) => Object.values(TABS).flatMap((f) => f()).find((c) => c.path === path);

  body.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.path && el.type === 'range') {
      const c = ctlByPath(el.dataset.path);
      const v = c.step >= 1 ? Math.round(fromSlider(c, +el.value)) : fromSlider(c, +el.value);
      el.nextElementSibling.textContent = c.fmt(v);
      commit(c.path, v);
    } else if (el.dataset.mod === 'amt') {
      el.nextElementSibling.textContent = Math.round(+el.value * 100);
      setMod();
    }
  });
  body.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.path && el.tagName === 'SELECT') {
      const raw = el.value;
      commit(el.dataset.path, isNaN(+raw) ? raw : +raw);
      schedulePreview();
    } else if (el.dataset.mod === 'src' || el.dataset.mod === 'dst') {
      setMod();
      schedulePreview();
    } else if (el.type === 'range') {
      schedulePreview();
    }
  });
  body.addEventListener('click', (e) => {
    const b = e.target.closest('.seg .btn');
    if (!b) return;
    const path = b.parentElement.dataset.path, raw = b.dataset.v;
    commit(path, isNaN(+raw) ? raw : +raw, { rerender: true });
    schedulePreview();
  });

  /** Matrice: rilegge tutte le righe; una sorgente vuota disattiva lo slot. */
  function setMod() {
    const slots = $$('.mod-slot', body).map((r) => ({
      src: r.querySelector('[data-mod="src"]').value,
      dst: r.querySelector('[data-mod="dst"]').value,
      amt: +r.querySelector('[data-mod="amt"]').value,
    }));
    commit('wt.mod', slots.filter((m) => m.src && MOD_SOURCES.includes(m.src)));
  }

  // Step sequencer: tocca/trascina sulle barre
  let drawing = false;
  function paintStep(e) {
    const ed = body.querySelector('.step-edit');
    if (!ed) return;
    const r = ed.getBoundingClientRect();
    const i = Math.min(15, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * 16)));
    const v = Math.round(Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)) * 20) / 20;
    const P = ensurePatch();
    const vals = P.wt.step.values.slice();
    vals[i] = v;
    commit('wt.step.values', vals);
    ed.children[i].firstElementChild.style.height = `${Math.round(v * 100)}%`;
  }
  body.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.step-edit')) return;
    e.preventDefault();
    drawing = true;
    paintStep(e);
  });
  body.addEventListener('pointermove', (e) => { if (drawing) paintStep(e); });
  window.addEventListener('pointerup', () => { if (drawing) { drawing = false; schedulePreview(); } });

  $('#waveTracks').addEventListener('click', (e) => {
    const b = e.target.closest('[data-wtk]');
    if (!b) return;
    k = +b.dataset.wtk;
    focusOsc = 0;
    if (app.onTrack) app.onTrack(k);
    render();
  });
  $('#waveTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    tab = b.dataset.tab;
    render();
  });
  $('#waveCanvas').addEventListener('click', () => { focusOsc = (focusOsc + 1) % 3; drawWave(); });

  $('#waveSheet .sheet-box').addEventListener('click', (e) => {   // il box può essere spostato nel Sound Lab
    const act = e.target.closest('[data-act]') && e.target.closest('[data-act]').dataset.act;
    if (!act) return;
    const t = tr();
    if (act === 'wave-play') preview();
    else if (act === 'wave-init') {
      app.snapshot();
      activate();
      t.patch = normalizeWTPreset({ name: 'Init Wavetable', wt: JSON.parse(JSON.stringify(WT_DEFAULT)) });
      t.patch.rev = 1;
      app.save(); app.onChange(); render(); preview();
    } else if (act === 'wave-lib') {
      app.closeSheet($('#waveSheet'));
      app.openLibrary(k, 'Wavetable');
    } else if (act === 'wave-revert') {
      app.snapshot();
      delete t.patch;
      app.save(); app.onChange(); render();
    } else if (act === 'wave-save') {
      const P = ensurePatch();
      const name = ($('#waveName').value.trim() || P.name).slice(0, 32);
      const id = `up:${Date.now().toString(36)}`;
      state.userPresets = (state.userPresets || []).concat({ ...JSON.parse(JSON.stringify(P)), name, id });
      setUserPresets(state.userPresets);
      app.snapshot();
      t.preset = id;
      delete t.patch;
      app.save(); app.onChange(); render();
      app.toast(`Preset "${name}" salvato nella libreria (Utente)`);
    } else if (act === 'wave-delete' && t.preset.startsWith('up:')) {
      const id = t.preset;
      state.userPresets = (state.userPresets || []).filter((p) => p.id !== id);
      setUserPresets(state.userPresets);
      // Le tracce che lo usavano tengono il suono come patch
      state.slots.forEach((p) => p.synth.tracks.forEach((x, i) => {
        if (x.preset === id) { x.patch = x.patch || normalizeWTPreset(PRESETS[id] || {}); x.preset = SYNTH_TRACKS[i].preset; }
      }));
      app.save(); app.onChange(); render();
      app.toast('Preset eliminato dalla libreria');
    }
  });
  $('#waveName').addEventListener('change', (e) => {
    const P = ensurePatch();
    P.name = e.target.value.trim().slice(0, 32) || P.name;
    P.rev = (P.rev || 0) + 1;
    app.save(); app.onChange();
  });

  return {
    open(track) {
      k = track;
      focusOsc = 0;
      render();
      app.openSheet('waveSheet');
      requestAnimationFrame(drawWave);
    },
    /** Sound Lab: editor sempre visibile nella pagina (nessun foglio modale). */
    show(track) {
      k = track;
      render();
      requestAnimationFrame(drawWave);
    },
  };
}
