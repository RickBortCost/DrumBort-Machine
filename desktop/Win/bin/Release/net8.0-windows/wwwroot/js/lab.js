/**
 * lab.js — Sound Lab: la versione per telefono è un generatore di suoni (niente drum machine).
 *   SYNTH      editor wavetable a tutta pagina + libreria + pad a note
 *   BATTERIA   designer di suoni di batteria (fino a 4 strati, ogni strato è una voce
 *              parametrica dei kit: cassa, rullante, clap, rim, metallo, tom, cowbell, rumore)
 *   I MIEI     suoni salvati, invio al PC (host collegato: automatico; altrimenti link o file)
 *
 * Formato di scambio (link #snd= o file .json):
 *   { app: 'drumbort-sound', v: 1, presets: [preset wavetable utente], sounds: [suono batteria] }
 */

import { KITS, DRUM_TYPES, METALS, buildVoice, normalizeSound, setUserSounds, USER_SOUNDS } from './kits.js';
import { PRESETS, setUserPresets } from './presets.js';
import { SYNTH_TRACKS } from './synth.js';
import { encodeShare } from './projects.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------
// Schema dei parametri per tipo di voce (valori predefiniti = quelli delle factory)
// ---------------------------------------------------------------------
const hz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);
const sec = (v) => (v < 1 ? `${Math.round(v * 1000)}ms` : `${v.toFixed(2)}s`);
const pct = (v) => `${Math.round(v * 100)}`;
const x = (v) => `×${v.toFixed(2)}`;
const R = (key, label, min, max, def, fmt, log = false, step = 0) => ({ key, label, min, max, def, fmt, log, step });
const SEL = (key, label, options, def) => ({ key, label, options, def });
const OSC = ['sine', 'triangle', 'square', 'sawtooth'];
const OSC_L = { sine: 'SINE', triangle: 'TRI', square: 'SQR', sawtooth: 'SAW' };
const FILT = ['highpass', 'bandpass', 'lowpass', 'notch'];
const FILT_L = { highpass: 'HP', bandpass: 'BP', lowpass: 'LP', notch: 'NOTCH' };

export const TYPE_LABEL = { kick: 'Cassa', snare: 'Rullante', clap: 'Clap', rim: 'Rim / click', metal: 'Hat / piatto', tom: 'Tom / perc', cowbell: 'Cowbell', noiseHit: 'Rumore / FX' };

const SCHEMA = {
  kick: [R('start', 'PITCH INIZIO', 40, 1000, 150, hz, true), R('end', 'PITCH FINE', 20, 300, 50, hz, true), R('sweep', 'SWEEP', 0.005, 1, 0.05, sec, true),
    R('decay', 'DECAY', 0.05, 3, 0.5, sec, true), R('click', 'CLICK', 0, 1, 0, pct), R('drive', 'DRIVE', 0, 1, 0, pct),
    R('noise', 'RUMORE', 0, 1, 0, pct), R('noiseFreq', 'FREQ. RUMORE', 200, 8000, 1500, hz, true), R('level', 'LIVELLO', 0.1, 1.5, 1, pct),
    SEL('type', 'ONDA', OSC, 'sine')],
  snare: [R('tones.0', 'TONO 1', 60, 800, 180, hz, true), R('tones.1', 'TONO 2', 60, 1200, 330, hz, true), SEL('oscType', 'ONDA', OSC, 'triangle'),
    R('drop', 'DROP', 1, 3, 1.4, x), R('sweep', 'SWEEP', 0.005, 0.2, 0.03, sec, true), R('toneDecay', 'DECAY TONO', 0.02, 1, 0.12, sec, true),
    R('toneLevel', 'LIV. TONO', 0, 1.5, 0.6, pct), SEL('nType', 'FILTRO', FILT, 'highpass'), R('nFreq', 'FREQ. RUMORE', 200, 12000, 1800, hz, true),
    R('nQ', 'Q RUMORE', 0.3, 8, 0.7, (v) => v.toFixed(1)), R('nDecay', 'DECAY RUMORE', 0.02, 1.5, 0.18, sec, true), R('noiseLevel', 'LIV. RUMORE', 0, 1.5, 0.7, pct)],
  clap: [R('freq', 'FREQ', 300, 6000, 1100, hz, true), R('q', 'Q', 0.3, 6, 1.2, (v) => v.toFixed(1)), R('bursts', 'RAFFICHE', 1, 6, 3, (v) => `${v}`, false, 1),
    R('spacing', 'SPAZIATURA', 0.003, 0.03, 0.011, sec), R('burstDecay', 'DECAY RAFFICA', 0.002, 0.03, 0.008, sec), R('tail', 'CODA', 0.05, 1.5, 0.18, sec, true),
    R('level', 'LIVELLO', 0.1, 1.5, 0.9, pct)],
  rim: [R('freqs.0', 'FREQ 1', 100, 5000, 500, hz, true), R('freqs.1', 'FREQ 2', 100, 8000, 1700, hz, true), SEL('type', 'ONDA', OSC, 'square'),
    R('decay', 'DECAY', 0.005, 0.6, 0.035, sec, true), R('hp', 'PASSA-ALTO', 0, 4000, 600, hz), R('level', 'LIVELLO', 0.1, 1.5, 0.5, pct)],
  metal: [SEL('set', 'CIRCUITO', ['m808', 'm909'], 'm808'), R('mult', 'ACCORDATURA', 0.3, 4, 1, x, true), R('bp', 'PASSA-BANDA', 1000, 16000, 10000, hz, true),
    R('bpQ', 'Q BANDA', 0.2, 5, 1, (v) => v.toFixed(1)), R('hp', 'PASSA-ALTO', 500, 14000, 7000, hz, true), R('decay', 'DECAY', 0.01, 3, 0.06, sec, true),
    R('attack', 'ATTACK', 0.001, 0.2, 0.001, sec, true), R('noise', 'RUMORE', 0, 1, 0, pct), R('level', 'LIVELLO', 0.1, 1.2, 0.5, pct), SEL('type', 'ONDA', OSC, 'square')],
  tom: [R('start', 'PITCH INIZIO', 40, 2600, 200, hz, true), R('end', 'PITCH FINE', 20, 1000, 120, hz, true), R('sweep', 'SWEEP', 0.005, 0.6, 0.15, sec, true),
    R('decay', 'DECAY', 0.03, 2, 0.4, sec, true), R('noise', 'RUMORE', 0, 1, 0, pct), R('noiseFreq', 'FREQ. RUMORE', 200, 8000, 1200, hz, true),
    R('level', 'LIVELLO', 0.1, 1.5, 0.9, pct), SEL('type', 'ONDA', OSC, 'sine')],
  cowbell: [R('freqs.0', 'FREQ 1', 200, 2000, 540, hz, true), R('freqs.1', 'FREQ 2', 200, 3000, 800, hz, true), R('bp', 'PASSA-BANDA', 500, 8000, 2640, hz, true),
    R('q', 'Q', 0.3, 6, 1.2, (v) => v.toFixed(1)), R('decay', 'DECAY', 0.05, 2, 0.35, sec, true), R('level', 'LIVELLO', 0.1, 1.2, 0.45, pct)],
  noiseHit: [SEL('type', 'FILTRO', FILT, 'highpass'), R('freq', 'FREQ', 50, 16000, 6000, hz, true), R('q', 'Q', 0.3, 12, 0.7, (v) => v.toFixed(1)),
    R('to', 'SWEEP A (0 = off)', 0, 16000, 0, (v) => (v ? hz(v) : 'OFF')), R('attack', 'ATTACK', 0.001, 4, 0.001, sec, true),
    R('decay', 'DECAY', 0.01, 4, 0.1, sec, true), R('drive', 'DRIVE', 0, 1, 0, pct), R('level', 'LIVELLO', 0.1, 1.5, 0.6, pct)],
};

const getK = (o, key) => key.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function setK(o, key, v) {
  const ks = key.split('.'), last = ks.pop();
  let cur = o;
  for (const k of ks) { if (cur[k] == null) cur[k] = /^\d+$/.test(last) ? [] : {}; cur = cur[k]; }
  cur[last] = v;
}

/** Valore del parametro nello strato (con i default della factory e il circuito del metallo). */
function paramValue(layer, p) {
  if (p.key === 'set') return layer.o.freqs && layer.o.freqs[0] === METALS.m909[0] ? 'm909' : 'm808';
  const v = getK(layer.o, p.key);
  return v ?? p.def;
}

export function initLab(app) {
  const { engine, state, ui } = app;
  const root = $('#lab');
  let tab = 'synth';

  // =================================================================
  // Struttura: l'editor wavetable e i pad a note vengono spostati nel Lab
  // =================================================================
  ui.ssel = 0;          // il Lab parte sempre dal BASS (poi resta la scelta dell'utente)
  const synthPane = $('#labSynth');
  synthPane.append($('#waveSheet .sheet-box'));
  synthPane.append($('#spads'));

  function showTab(t) {
    tab = t;
    $$('[data-ltab]', root).forEach((b) => app.setToggle(b, b.dataset.ltab === t));
    $$('.lab-pane', root).forEach((p) => { p.hidden = p.dataset.pane !== t; });
    if (t === 'synth') { ensureWT(); app.synthUI.render(); app.synthUI.showEditor(); renderSynthHead(); }
    if (t === 'drum') { renderDrum(); }
    if (t === 'mine') renderMine();
  }
  $('.lab-tabs', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-ltab]');
    if (b) showTab(b.dataset.ltab);
  });

  // =================================================================
  // SYNTH
  // =================================================================
  const trk = () => app.pat().synth.tracks[ui.ssel || 0];
  function renderSynthHead() {
    const t = trk(), pr = t.patch && t.patch.wt ? t.patch : PRESETS[t.preset];
    $('#labPreset').textContent = pr ? pr.name : t.preset;
    $('#labRole').value = String(ui.ssel || 0);
  }
  $('#labRole').innerHTML = SYNTH_TRACKS.map((t, k) => `<option value="${k}">${t.name.toUpperCase()}${t.mono ? ' · mono' : ' · accordi'}</option>`).join('');
  // Nel Lab ogni ruolo parte da un suono wavetable (modificabile nell'editor)
  const WT_START = ['wtGrowl', 'wtSyncLead', 'wtEvolve', 'wtGlassKeys'];
  function ensureWT() {
    const t = trk();
    if (!(t.patch && t.patch.wt) && !(PRESETS[t.preset] && PRESETS[t.preset].wt)) { t.preset = WT_START[ui.ssel || 0]; delete t.patch; app.save(); }
  }
  $('#labRole').addEventListener('change', (e) => { ui.ssel = +e.target.value; ensureWT(); app.synthUI.render(); app.synthUI.showEditor(); renderSynthHead(); });
  $('#labPreset').addEventListener('click', () => app.synthUI.openLibrary('Wavetable'));
  $('#labInit').addEventListener('click', () => { $('[data-act="wave-init"]').click(); app.synthUI.showEditor(); renderSynthHead(); });

  // =================================================================
  // BATTERIA: designer a strati
  // =================================================================
  let edit = { id: null, name: '', layers: [{ type: 'kick', o: {} }] };
  let cur = 0;          // strato selezionato
  const wave = $('#ldWave');

  const specOf = () => (edit.layers.length === 1 ? { type: edit.layers[0].type, o: edit.layers[0].o } : { type: 'layer', voices: edit.layers.map((l) => ({ type: l.type, o: l.o })) });

  // Punti di partenza: voci di tutti i kit e tipi vuoti
  $('#ldFrom').innerHTML = '<option value="">Parti da…</option>'
    + `<optgroup label="Vuoto">${DRUM_TYPES.map((t) => `<option value="t|${t}">${TYPE_LABEL[t]}</option>`).join('')}</optgroup>`
    + KITS.map((k) => `<optgroup label="${esc(k.name)}">${k.tracks.map((t, i) => `<option value="k|${k.id}|${i}">${esc(t.name)}</option>`).join('')}</optgroup>`).join('');
  $('#ldFrom').addEventListener('change', (e) => {
    const v = e.target.value;
    e.target.value = '';
    if (!v) return;
    const [kind, a, b] = v.split('|');
    if (kind === 't') edit = { id: null, name: TYPE_LABEL[a], layers: [{ type: a, o: {} }] };
    else {
      const k = KITS.find((x) => x.id === a), t = k.tracks[+b], sp = JSON.parse(JSON.stringify(t.play.spec));
      const layers = sp.type === 'layer' ? sp.voices : [sp];
      edit = { id: null, name: `${t.name} (${k.name.split(' ').slice(-1)[0]})`, layers: layers.map((l) => ({ type: l.type, o: l.o || {} })) };
    }
    cur = 0;
    renderDrum();
    audition();
  });
  $('#ldType').innerHTML = DRUM_TYPES.map((t) => `<option value="${t}">${TYPE_LABEL[t]}</option>`).join('');
  $('#ldType').addEventListener('change', (e) => { edit.layers[cur] = { type: e.target.value, o: {} }; renderDrum(); audition(); });

  function renderLayers() {
    $('#ldLayers').innerHTML = edit.layers.map((l, i) => `<button class="btn sm${i === cur ? ' on' : ''}" data-layer="${i}" aria-pressed="${i === cur}">${i + 1} · ${TYPE_LABEL[l.type].split(' ')[0].toUpperCase()}</button>`).join('')
      + (edit.layers.length < 4 ? '<button class="btn sm" data-layer="add" aria-label="Aggiungi strato">+ STRATO</button>' : '')
      + (edit.layers.length > 1 ? '<button class="btn sm" data-layer="del" aria-label="Rimuovi strato">− STRATO</button>' : '');
  }
  $('#ldLayers').addEventListener('click', (e) => {
    const b = e.target.closest('[data-layer]');
    if (!b) return;
    if (b.dataset.layer === 'add') { edit.layers.push({ type: 'noiseHit', o: {} }); cur = edit.layers.length - 1; }
    else if (b.dataset.layer === 'del') { edit.layers.splice(cur, 1); cur = Math.max(0, cur - 1); }
    else cur = +b.dataset.layer;
    renderDrum();
    if (b.dataset.layer === 'add') audition();
  });

  const toSlider = (p, v) => (p.log ? Math.log(v / p.min) / Math.log(p.max / p.min) : (v - p.min) / (p.max - p.min));
  const fromSlider = (p, s) => {
    let v = p.log ? p.min * Math.pow(p.max / p.min, s) : p.min + s * (p.max - p.min);
    if (p.step) v = Math.round(v / p.step) * p.step;
    return +v.toPrecision(4);
  };

  function renderParams() {
    const L = edit.layers[cur];
    $('#ldType').value = L.type;
    $('#ldParams').innerHTML = SCHEMA[L.type].map((p) => {
      const v = paramValue(L, p);
      if (p.options) {
        return `<div class="ld-ctl"><span>${p.label}</span><div class="seg">${p.options.map((o) => `<button class="btn sm${o === v ? ' on' : ''}" data-opt="${p.key}" data-v="${o}">${OSC_L[o] || FILT_L[o] || (o === 'm808' ? '808' : o === 'm909' ? '909' : o)}</button>`).join('')}</div></div>`;
      }
      return `<label class="ld-ctl"><span>${p.label}</span><input type="range" min="0" max="1" step="0.001" value="${toSlider(p, Math.max(p.min, Math.min(p.max, v)))}" data-key="${p.key}"><b>${p.fmt(v)}</b></label>`;
    }).join('');
  }

  function renderDrum() {
    $('#ldName').value = edit.name || '';
    renderLayers();
    renderParams();
    drawWave();
  }

  $('#ldParams').addEventListener('input', (e) => {
    const inp = e.target.closest('input[data-key]');
    if (!inp) return;
    const L = edit.layers[cur], p = SCHEMA[L.type].find((q) => q.key === inp.dataset.key);
    const v = fromSlider(p, +inp.value);
    if (p.key.includes('.')) {
      // Array (toni, frequenze): completa con i valori predefiniti
      const [arr] = p.key.split('.');
      if (!Array.isArray(L.o[arr])) L.o[arr] = SCHEMA[L.type].filter((q) => q.key.startsWith(`${arr}.`)).map((q) => q.def);
    }
    setK(L.o, p.key, v);
    inp.nextElementSibling.textContent = p.fmt(v);
    drawWaveSoon();
  });
  $('#ldParams').addEventListener('change', () => audition());
  $('#ldParams').addEventListener('click', (e) => {
    const b = e.target.closest('[data-opt]');
    if (!b) return;
    const L = edit.layers[cur];
    if (b.dataset.opt === 'set') L.o.freqs = METALS[b.dataset.v].slice();
    else L.o[b.dataset.opt] = b.dataset.v;
    renderParams();
    drawWave();
    audition();
  });
  $('#ldName').addEventListener('input', (e) => { edit.name = e.target.value; });

  // Ascolto
  const tune = () => +$('#ldTune').value, dec = () => +$('#ldDecay').value;
  function audition(vel = 1) {
    if (!engine.ctx) return;
    engine.audition(buildVoice(specOf()), vel, { tune: tune(), decay: dec() });
  }
  $('#ldPad').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    // Più in alto sul pad = più forte
    audition(Math.max(0.3, Math.min(1, 1.15 - (e.clientY - r.top) / r.height)));
    e.currentTarget.animate([{ filter: 'brightness(1.6)' }, { filter: 'none' }], { duration: 160 });
  });
  ['#ldTune', '#ldDecay'].forEach((s) => $(s).addEventListener('input', () => {
    $('#ldTuneV').textContent = `${tune() > 0 ? '+' : ''}${tune()}`;
    $('#ldDecayV').textContent = x(dec());
    drawWaveSoon();
  }));

  // Forma d'onda (render offline, inviluppo per colonna)
  let waveTimer = null;
  const drawWaveSoon = () => { clearTimeout(waveTimer); waveTimer = setTimeout(drawWave, 90); };
  async function drawWave() {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC || !wave.isConnected) return;
    const sr = 22050, secs = 2;
    let buf;
    try {
      const off = new OAC(1, sr * secs, sr);
      buildVoice(specOf())(off, off.destination, 0, 1, { tune: tune(), decay: dec() });
      buf = (await off.startRendering()).getChannelData(0);
    } catch (_) { return; }
    const r = wave.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    wave.width = Math.max(1, Math.round(r.width * dpr)); wave.height = Math.max(1, Math.round(r.height * dpr));
    const g = wave.getContext('2d'), W = wave.width, Hh = wave.height;
    g.clearRect(0, 0, W, Hh);
    let end = buf.length;
    while (end > 1 && Math.abs(buf[end - 1]) < 0.002) end--;
    const len = Math.max(Math.floor(sr * 0.25), end), per = Math.max(1, Math.floor(len / W));
    let pk = 0; for (let i = 0; i < len; i++) pk = Math.max(pk, Math.abs(buf[i]));
    g.fillStyle = getComputedStyle(root).getPropertyValue('--lab-wave').trim() || '#f08a24';
    for (let c = 0; c < W; c++) {
      let m = 0;
      for (let i = c * per; i < Math.min(len, (c + 1) * per); i++) m = Math.max(m, Math.abs(buf[i]));
      const h = (m / (pk || 1)) * (Hh / 2 - 2);
      g.fillRect(c, Hh / 2 - h, 1, Math.max(1, 2 * h));
    }
    $('#ldInfo').textContent = `${sec(len / sr)} · picco ${pk.toFixed(2)}`;
  }

  // Salvataggio
  $('#ldSave').addEventListener('click', () => {
    const name = ($('#ldName').value || '').trim() || `Suono ${USER_SOUNDS.length + 1}`;
    const id = edit.id || `us:${Date.now().toString(36)}`;
    const snd = normalizeSound({ id, name, spec: specOf() });
    if (!snd) { app.toast('Suono non valido'); return; }
    state.userSounds = (state.userSounds || []).filter((s) => s.id !== id).concat(snd);
    setUserSounds(state.userSounds);
    edit.id = id; edit.name = name;
    app.save();
    app.toast(app.remote && app.remote() ? `"${name}" salvato e inviato al PC` : `"${name}" salvato in I MIEI SUONI`);
  });
  $('#ldNew').addEventListener('click', () => { edit = { id: null, name: '', layers: [{ type: 'kick', o: {} }] }; cur = 0; renderDrum(); });

  // =================================================================
  // I MIEI SUONI
  // =================================================================
  function renderMine() {
    const rem = app.remote && app.remote();
    $('#lmStatus').textContent = rem
      ? 'Collegato al PC: i suoni salvati arrivano da soli nella libreria del PC.'
      : 'Per portarli sul PC: CONDIVIDI LINK (aprilo sul PC) o FILE (Menu → Importa JSON sul PC). Con DrumBort Host i suoni arrivano da soli.';
    const ups = state.userPresets || [], us = state.userSounds || [];
    $('#lmSynth').innerHTML = ups.length ? ups.map((p) => `<div class="lm-row"><b>${esc(p.name)}</b><small>synth</small>
      <button class="btn sm" data-play-p="${esc(p.id)}" aria-label="Ascolta">▶</button>
      <button class="btn sm" data-edit-p="${esc(p.id)}" aria-label="Modifica">✎</button>
      <button class="btn sm" data-share-p="${esc(p.id)}" aria-label="Condividi">⤴</button>
      <button class="btn sm" data-del-p="${esc(p.id)}" aria-label="Elimina">✕</button></div>`).join('')
      : '<p class="hint">Nessun synth salvato: nella scheda SYNTH usa "Salva come preset".</p>';
    $('#lmDrum').innerHTML = us.length ? us.map((s) => `<div class="lm-row"><b>${esc(s.name)}</b><small>${s.spec.type === 'layer' ? `${s.spec.voices.length} strati` : TYPE_LABEL[s.spec.type]}</small>
      <button class="btn sm" data-play-s="${esc(s.id)}" aria-label="Ascolta">▶</button>
      <button class="btn sm" data-edit-s="${esc(s.id)}" aria-label="Modifica">✎</button>
      <button class="btn sm" data-share-s="${esc(s.id)}" aria-label="Condividi">⤴</button>
      <button class="btn sm" data-del-s="${esc(s.id)}" aria-label="Elimina">✕</button></div>`).join('')
      : '<p class="hint">Nessun suono di batteria: crealo nella scheda BATTERIA.</p>';
  }

  $('#labMine').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    const findP = (id) => (state.userPresets || []).find((p) => p.id === id);
    const findS = (id) => (state.userSounds || []).find((s) => s.id === id);
    if (d.playP && engine.ctx) {
      const k = ui.ssel || 0, base = 12 * (SYNTH_TRACKS[k].oct + 1) + app.pat().synth.key;
      const tr = { ...app.pat().synth.tracks[k], preset: d.playP };
      delete tr.patch;
      engine.playSynth(k, engine.ctx.currentTime + 0.02, 0.6, SYNTH_TRACKS[k].mono ? [base + 12] : [base + 12, base + 15, base + 19], 0.85, tr);
    } else if (d.editP) {
      const t = app.pat().synth.tracks[ui.ssel || 0];
      t.preset = d.editP; delete t.patch;
      app.save();
      showTab('synth');
    } else if (d.delP) {
      const p = findP(d.delP);
      if (!p || !confirm(`Eliminare "${p.name}"?`)) return;
      state.userPresets = state.userPresets.filter((x) => x.id !== d.delP);
      setUserPresets(state.userPresets);
      state.slots.forEach((pat) => pat.synth.tracks.forEach((t, i) => { if (t.preset === d.delP) { t.patch = t.patch || JSON.parse(JSON.stringify(p)); t.preset = SYNTH_TRACKS[i].preset; } }));
      app.save(); renderMine();
    } else if (d.playS && engine.ctx) {
      const s = findS(d.playS);
      if (s) engine.audition(buildVoice(s.spec), 1, { tune: 0, decay: 1 });
    } else if (d.editS) {
      const s = findS(d.editS);
      if (!s) return;
      const sp = JSON.parse(JSON.stringify(s.spec));
      edit = { id: s.id, name: s.name, layers: (sp.type === 'layer' ? sp.voices : [sp]).map((l) => ({ type: l.type, o: l.o || {} })) };
      cur = 0;
      showTab('drum');
    } else if (d.delS) {
      const s = findS(d.delS);
      if (!s || !confirm(`Eliminare "${s.name}"?`)) return;
      state.userSounds = state.userSounds.filter((x) => x.id !== d.delS);
      setUserSounds(state.userSounds);
      app.save(); renderMine();
    } else if (d.shareP) {
      await sharePack({ presets: [findP(d.shareP)].filter(Boolean), sounds: [] });
    } else if (d.shareS) {
      await sharePack({ presets: [], sounds: [findS(d.shareS)].filter(Boolean) });
    } else if (b.id === 'lmShareAll') {
      await sharePack({ presets: state.userPresets || [], sounds: state.userSounds || [] });
    } else if (b.id === 'lmFile') {
      const pack = { app: 'drumbort-sound', v: 1, presets: state.userPresets || [], sounds: state.userSounds || [] };
      app.deliver(new File([JSON.stringify(pack)], 'drumbort-suoni.json', { type: 'application/json' }));
    } else if (b.id === 'lmImport') {
      $('#importFile').click();
    }
  });

  /** Link con i suoni nell'hash (#snd=): aprendolo sul PC i suoni entrano nella libreria. */
  async function sharePack(sel) {
    if (!sel.presets.length && !sel.sounds.length) { app.toast('Nessun suono da condividere'); return; }
    const base = location.origin + location.pathname;
    const url = `${base}#snd=${await encodeShare({ app: 'drumbort-sound', v: 1, ...sel })}`;
    const n = sel.presets.length + sel.sounds.length;
    if (navigator.share) {
      try { await navigator.share({ title: `DrumBort: ${n} suoni`, url }); return; } catch (_) { /* annullato */ }
    }
    try { await navigator.clipboard.writeText(url); app.toast('Link copiato: aprilo sul PC'); } catch (_) { prompt('Copia il link e aprilo sul PC:', url); }
  }

  return {
    showTab,
    /** kind 'edit': modifica dall'editor (non ridisegnarlo mentre si trascina un controllo). */
    render(kind) {
      if (tab === 'mine') renderMine();
      if (tab === 'synth') { renderSynthHead(); if (kind !== 'edit') app.synthUI.showEditor(); }
    },
    get tab() { return tab; },
    get edit() { return edit; },
  };
}

/** Pacchetto di suoni valido? (link o file) */
export const isSoundPack = (o) => !!o && o.app === 'drumbort-sound' && (Array.isArray(o.presets) || Array.isArray(o.sounds));
