/**
 * studio.js — Layout Studio per PC: browser (suoni e kit), griglia delle clip (tracce × pattern)
 * con lancio di clip e scene, mixer con fader, pan, mandate, mute/solo e indicatori di livello.
 * L'editor della clip selezionata è la griglia step/synth esistente; parametri e pad a destra.
 */

import { allKits, kitById, USER_SOUNDS, buildVoice } from './kits.js';
import { PRESETS, categories, findPresets } from './presets.js';
import { SYNTH_TRACKS } from './synth.js';
import { SYNTH_CH } from './engine.js';
import { initTracksView } from './tracks.js';
import { initFxChain } from './fxchain.js';
import { initNewTrack } from './newtrack.js';
import { DEVICES, CATEGORIES } from './devices.js';
import { DRUM_TRACKS, SESSION_TRACKS, hasClip, QUANTS, FOLLOW, FOLLOW_BARS, MAX_ARR_BARS } from './session.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SLOTS = 8;
const COLORS = ['#e5432f', '#f08a24', '#f2c230', '#d9d2bd', '#a8c7c0', '#6aa9d8', '#9b8ad6', '#d47bb0', '#f08a24', '#5fd3e6', '#a98be0', '#6fd08c'];

/**
 * @param {object} app  stato e funzioni di ui.js (+ launchClip, launchScene, stopAllClips, setView, selectTrack)
 */
export function initStudio(app) {
  const { engine, seq, state, ui } = app;
  let active = false;
  let selTrack = 0;        // traccia selezionata (0-11)
  let view = 'tracks';     // 'tracks' (predefinita, stile Logic) | 'session' | 'arrange' (Tab)

  const isSynth = (i) => i >= DRUM_TRACKS;
  const trackName = (i, p = app.pat()) => (isSynth(i) ? SYNTH_TRACKS[i - DRUM_TRACKS].name : app.kitOf(p).tracks[i].name);
  const trackShort = (i, p = app.pat()) => (isSynth(i) ? SYNTH_TRACKS[i - DRUM_TRACKS].short : app.kitOf(p).tracks[i].short);
  /** Parametri di mixer della traccia: dalla clip in riproduzione, altrimenti dal pattern principale. */
  const mixSlot = (i) => (state.session.map[i] >= 0 ? state.session.map[i] : state.session.master);
  const mixParams = (i) => {
    const p = state.slots[mixSlot(i)];
    return isSynth(i) ? p.synth.tracks[i - DRUM_TRACKS] : p.tracks[i];
  };
  const channel = (i) => (isSynth(i) ? SYNTH_CH + i - DRUM_TRACKS : i);

  // ===================================================================
  // Griglia delle clip
  // ===================================================================
  const panel = $('#session');
  panel.innerHTML = `<div class="sx-tool">
      <div class="seg sx-views"><button class="btn sm" data-sxv="tracks">TRACCE</button><button class="btn sm" data-sxv="session">SESSION</button><button class="btn sm" data-sxv="arrange">GRIGLIA</button></div>
      <label class="sx-q">LANCIO <select id="sxQuant" aria-label="Quantizzazione del lancio">${QUANTS.map((q) => `<option value="${q.v}">${q.label}</option>`).join('')}</select></label>
      <button id="arrPlay" class="btn sm" aria-pressed="false" title="Riproduci l'arrangiamento">▶ ARR</button>
      <button id="arrRec" class="btn sm" aria-pressed="false" title="Registra i lanci della session nell'arrangiamento">● REC ARR</button>
      <button id="sxAuto" class="btn sm" title="Automazione della clip selezionata (A)">∿ AUTO</button>
      <button id="sxMacro" class="btn sm" title="Macro (M)">◎ MACRO</button>
      <div class="seg sx-bottom" role="group" aria-label="Pannello in basso">
        <button class="btn sm" data-bottom="fx" title="Effetti della traccia selezionata">FX</button>
        <button class="btn sm" data-bottom="editor" title="Note della traccia selezionata">NOTE</button>
      </div>
      <button id="sxBrowser" class="btn sm" aria-pressed="true" title="Mostra/nascondi il browser (B)">◧</button>
      <button id="sxSide" class="btn sm" aria-pressed="true" title="Mostra/nascondi il pannello laterale (I)">◨</button>
      <span class="sx-info" id="sxInfo"></span>
    </div>
    <div class="sx-tracks" id="sxTracks"></div>
    <div class="sx-sess" id="sxSess"></div>
    <div class="sx-arr" id="sxArr" hidden>
      <div class="ar-tools">
        <span class="ar-brush">PENNELLO <b id="arBrush">P1</b></span>
        <button class="btn sm" data-ar="add" title="Aggiungi una battuta (copia dell'ultima)">+ BAR</button>
        <button class="btn sm" data-ar="del" title="Togli l'ultima battuta">− BAR</button>
        <button class="btn sm" data-ar="dup" title="Duplica tutto l'arrangiamento">×2</button>
        <button class="btn sm" data-ar="song" title="Converti la catena del song mode">DA SONG</button>
        <button class="btn sm" data-ar="clear">SVUOTA</button>
        <small class="ar-hint">Clic: dipingi con il pattern selezionato · di nuovo: svuota · righello: punto di partenza</small>
      </div>
      <div class="ar-scroll" id="arScroll"><div class="ar-grid" id="arGrid"></div><div class="ar-head" id="arHead"></div></div>
    </div>`;
  const grid = $('#sxSess');
  const followSel = (s) => `<div class="sx-fol">
      <select data-fa="${s}" aria-label="Follow action P${s + 1}">${FOLLOW.map((f) => `<option value="${f.v}">${f.label}</option>`).join('')}</select>
      <select data-fn="${s}" aria-label="Battute prima della follow action P${s + 1}">${FOLLOW_BARS.map((n) => `<option value="${n}">${n}</option>`).join('')}</select></div>`;
  function buildSession() {
    let html = '<div class="sx-row sx-head"><div class="sx-corner">PATTERN</div>';
    for (let i = 0; i < SESSION_TRACKS; i++) html += `<button class="sx-th" data-sel="${i}" style="--tc:${COLORS[i]}"><b></b><i></i></button>`;
    html += '<div class="sx-scene-h">SCENA</div><div class="sx-scene-h">FOLLOW</div></div>';
    for (let s = 0; s < SLOTS; s++) {
      html += `<div class="sx-row"><div class="sx-rh">P${s + 1}</div>`;
      for (let i = 0; i < SESSION_TRACKS; i++) {
        html += `<div class="sx-cell" data-t="${i}" data-s="${s}" style="--tc:${COLORS[i]}">
          <button class="sx-launch" data-launch aria-label="Lancia clip"><span>▶</span></button>
          <button class="sx-body" data-pick aria-label="Modifica clip"><canvas width="64" height="18"></canvas></button></div>`;
      }
      html += `<button class="sx-scene" data-scene="${s}" aria-label="Lancia scena P${s + 1}">▶ P${s + 1}</button>${followSel(s)}</div>`;
    }
    html += '<div class="sx-row sx-foot"><div class="sx-rh"></div>';
    for (let i = 0; i < SESSION_TRACKS; i++) html += `<button class="sx-stop" data-stop="${i}" aria-label="Ferma traccia">■</button>`;
    html += '<button class="sx-stopall" data-stopall aria-label="Ferma tutte le clip">■ STOP</button><div></div></div>';
    // Volume e pan sotto ogni colonna (come il mixer della session view di Live)
    html += '<div class="sx-row sx-mixrow"><div class="sx-rh">MIX</div>';
    for (let i = 0; i < SESSION_TRACKS; i++) html += `<div class="sx-mx" data-mxcol="${i}" style="--tc:${COLORS[i]}"></div>`;
    html += '<div class="sx-mx sx-mxm" data-mxcol="m"></div><div></div></div>';
    grid.innerHTML = html;
  }

  /** Mini anteprima della clip (step della batteria o note del synth). */
  function drawClip(cv, p, i) {
    const g = cv.getContext('2d'), w = cv.width, h = cv.height;
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(0,0,0,.55)';
    if (!isSynth(i)) {
      const n = p.steps[i].length;
      p.steps[i].forEach((v, s) => { if (v) g.fillRect(s * (w / n) + 1, v === 2 ? 2 : 6, Math.max(1, w / n - 2), v === 2 ? h - 4 : h - 8); });
    } else {
      const t = p.synth.tracks[i - DRUM_TRACKS];
      const ns = t.steps.filter(Boolean).map((x) => x.n);
      if (!ns.length) { if (t.arp.on) { g.fillText('ARP', 4, 13); } return; }
      const lo = Math.min(...ns), hi = Math.max(...ns, lo + 6);
      const n = t.steps.length;
      t.steps.forEach((x, s) => { if (x) g.fillRect(s * (w / n), h - 4 - ((x.n - lo) / (hi - lo)) * (h - 6), Math.max(2, x.g * (w / n) - 1), 3); });
    }
  }

  function renderSession() {
    const map = state.session.map, playing = seq.playing;
    $$('.sx-th', grid).forEach((b) => {
      const i = +b.dataset.sel;
      b.querySelector('b').textContent = trackShort(i);
      b.querySelector('i').textContent = trackName(i);
      b.classList.toggle('picked', i === selTrack);
    });
    $$('.sx-cell', grid).forEach((c) => {
      const i = +c.dataset.t, s = +c.dataset.s, p = state.slots[s];
      const has = hasClip(p, i);
      c.classList.toggle('has', has);
      c.classList.toggle('live', playing && map[i] === s);
      c.classList.toggle('armed', !playing && map[i] === s);
      c.classList.toggle('queued', ui.queued[i] === s);
      c.classList.toggle('stopping', ui.queued[i] === -1 && map[i] === s);
      c.classList.toggle('picked', i === selTrack && s === state.slot);
      c.classList.toggle('edit', s === state.slot);
      drawClip(c.querySelector('canvas'), p, i);
    });
    $$('.sx-scene', grid).forEach((b) => {
      const s = +b.dataset.scene;
      b.classList.toggle('master', s === state.session.master);
      b.classList.toggle('queued', ui.pendingMaster === s);
    });
    state.session.follow.forEach((f, s) => {
      $(`[data-fa="${s}"]`, grid).value = f.a;
      const n = $(`[data-fn="${s}"]`, grid);
      n.value = f.n;
      n.disabled = f.a === 'none';
    });
  }

  grid.addEventListener('change', (e) => {
    const t = e.target, f = t.dataset.fa ?? t.dataset.fn;
    if (f === undefined) return;
    const fo = state.session.follow[+f];
    if (t.dataset.fa !== undefined) fo.a = t.value; else fo.n = +t.value;
    app.save(); renderSession(); renderSessionMix();
  });

  // ===================================================================
  // Barra: vista, quantizzazione, arrangiamento
  // ===================================================================
  function renderTool() {
    $$('[data-sxv]', panel).forEach((b) => app.setToggle(b, b.dataset.sxv === view));
    $('#sxQuant').value = state.session.quant;
    app.setToggle($('#arrPlay'), state.arr.on);
    app.setToggle($('#arrRec'), ui.arrRec);
    const n = state.arr.bars.length;
    $('#sxInfo').textContent = n ? `${n} bar${state.arr.on && seq.playing ? ` · ${ui.arrBar + 1}/${n}` : ''}` : '';
    $('#sxSess').hidden = view !== 'session';
    $('#sxArr').hidden = view !== 'arrange';
    $('#sxTracks').hidden = view !== 'tracks';
    applyPanels();
    // Vista TRACCE: niente controlli da session; il mixer si apre con ▤ MIXER
    panel.dataset.view = view;
    document.getElementById('app').classList.add('mixer-off');   // volumi nelle tracce, niente barra del mixer
  }
  panel.querySelector('.sx-tool').addEventListener('click', (e) => {
    const v = e.target.closest('[data-sxv]');
    if (v) { setView(v.dataset.sxv); return; }
    if (e.target.closest('#arrPlay')) { app.toggleArr(); return; }
    if (e.target.closest('#sxBrowser')) { togglePanel('browser'); return; }
    if (e.target.closest('#sxSide')) { togglePanel('side'); return; }
    const bt = e.target.closest('[data-bottom]');
    if (bt) { setBottom(bt.dataset.bottom); return; }
    if (e.target.closest('#sxMacro')) { app.openMacros(); return; }
    if (e.target.closest('#sxAuto')) { app.openAuto(selTrack < DRUM_TRACKS ? `d${selTrack}.vol` : `s${selTrack - DRUM_TRACKS}.cut`); return; }
    if (e.target.closest('#arrRec')) {
      app.setArrRec(!ui.arrRec);
      if (ui.arrRec) app.toast(seq.playing ? 'Registrazione dalla prossima battuta' : 'REC ARR armato: premi play');
    }
  });
  $('#sxQuant').addEventListener('change', (e) => { state.session.quant = +e.target.value; app.save(); e.target.blur(); });
  function setView(v) {
    view = v;
    renderTool();
    if (v === 'arrange') renderArr(); else if (v === 'tracks') tracks.render(); else renderSession(); renderSessionMix();
  }
  // ===================================================================
  // Volume, pan e livello dentro ogni traccia (vista TRACCE e colonne della SESSION)
  // ===================================================================
  const trOf = (p, i) => (isSynth(i) ? p.synth.tracks[i - DRUM_TRACKS] : p.tracks[i]);
  const volTxt = (v) => (v <= 0.001 ? '−∞' : `${Math.round(v * 100)}`);
  const panTxt = (v) => (Math.abs(v) < 0.03 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100));
  /** Controlli di mix di una traccia (i) o del master ('m'). */
  function mixHTML(i, tr) {
    if (i === 'm') {
      const v = state.fx.master;
      return `<span class="mxi-meter" data-meter="m"><i></i></span>
        <input class="mxi-vol" type="range" min="0" max="1" step="0.01" value="${v}" data-mx="master" aria-label="Volume master">
        <output class="mxi-o" data-mxo="master">${volTxt(v)}</output>`;
    }
    tr = tr || trOf(state.slots[state.slot], i);
    return `<span class="mxi-meter" data-meter="${i}"><i></i></span>
      <input class="mxi-vol" type="range" min="0" max="1" step="0.01" value="${tr.vol}" data-mx="vol" data-mi="${i}" aria-label="Volume ${trackShort(i)}">
      <output class="mxi-o" data-mxo="vol">${volTxt(tr.vol)}</output>
      <input class="mxi-pan" type="range" min="-1" max="1" step="0.05" value="${tr.pan || 0}" data-mx="pan" data-mi="${i}" aria-label="Pan ${trackShort(i)}" title="Pan (doppio clic: centro)">
      <output class="mxi-o pan" data-mxo="pan">${panTxt(tr.pan || 0)}</output>`;
  }
  function renderSessionMix() {
    $$('[data-mxcol]', grid).forEach((el) => {
      const c = el.dataset.mxcol;
      el.innerHTML = c === 'm' ? mixHTML('m') : mixHTML(+c);
    });
  }
  function setMix(inp, v) {
    const k = inp.dataset.mx;
    if (k === 'master') { state.fx.master = v; engine.setFx({ master: v }, null); }
    else {
      const i = +inp.dataset.mi;
      state.slots.forEach((p) => { trOf(p, i)[k] = v; });
      engine.setChannel(channel(i), trOf(state.slots[state.slot], i));
    }
    inp.value = v;
    const o = inp.nextElementSibling;
    if (o && o.matches('.mxi-o')) o.textContent = k === 'pan' ? panTxt(v) : volTxt(v);
  }
  panel.addEventListener('pointerdown', (e) => { if (e.target.matches('[data-mx]')) app.snapshot(); }, true);
  panel.addEventListener('input', (e) => {
    if (!e.target.matches('[data-mx]')) return;
    setMix(e.target, +e.target.value);
    app.save();
  });
  panel.addEventListener('change', (e) => {
    if (e.target.matches('[data-mx]') && state.panels.bottom === 'fx') renderFx();   // allinea il device MIXER
  });
  panel.addEventListener('dblclick', (e) => {
    const inp = e.target.closest('[data-mx]');
    if (!inp) return;
    app.snapshot();
    setMix(inp, inp.dataset.mx === 'pan' ? 0 : 0.8);
    app.save();
  });

  // ===================================================================
  // Nuove tracce e Libreria (come in Logic Pro): dialogo, poi la Libreria a sinistra
  // ===================================================================
  const newTrack = initNewTrack({ ...app, addTracks: (list, o) => tracks.addTracks(list, o) });
  /** Libreria per la traccia i: browser a sinistra sulla scheda dei suoni adatti alla traccia. */
  function openLib(i) {
    selTrack = i;
    state.panels.browser = true;
    applyPanels();
    bTab = isSynth(i) ? 'sounds' : 'kits';
    bCat = null;
    $('#bwSearch').value = '';
    renderBrowser();
    browser.classList.remove('lib-flash'); void browser.offsetWidth; browser.classList.add('lib-flash');
    const cur = $('.bw-item.cur', browser) || $('.bw-item', browser);
    if (cur) { cur.scrollIntoView({ block: 'nearest' }); cur.focus({ preventScroll: true }); }
    app.save();
  }
  document.addEventListener('keydown', (e) => {
    if (!active || !(e.ctrlKey || e.metaKey) || !e.altKey || (e.key !== 'n' && e.key !== 'N' && e.code !== 'KeyN')) return;
    e.preventDefault();
    newTrack.open();
  });

  const tracks = initTracksView({ ...app, mixHTML, newTrack: () => newTrack.open(), openLib: (i) => openLib(i), openLibrary: () => app.openLibrary(), setBottom: (m) => setBottom(m) }, $('#sxTracks'), COLORS);

  // ===================================================================
  // Pannelli: browser e pannello laterale nascondibili; in basso effetti o note
  // ===================================================================
  if (!state.panels) state.panels = { browser: true, side: true, bottom: 'editor' };
  function applyPanels() {
    const a = document.getElementById('app'), P = state.panels;
    a.classList.toggle('no-browser', !P.browser);
    a.classList.toggle('no-side', !P.side);
    a.classList.toggle('bottom-fx', P.bottom === 'fx');
    app.setToggle($('#sxBrowser'), P.browser);
    app.setToggle($('#sxSide'), P.side);
    $$('[data-bottom]', panel).forEach((b) => app.setToggle(b, b.dataset.bottom === P.bottom));
    if (P.bottom === 'fx') renderFx();
  }
  function togglePanel(k) { state.panels[k] = !state.panels[k]; applyPanels(); app.save(); if (view === 'tracks') requestAnimationFrame(() => tracks.render()); }
  function setBottom(m) { state.panels.bottom = m; applyPanels(); app.save(); }
  document.addEventListener('keydown', (e) => {
    if (!active || e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, select, textarea') || (app.kbActive && app.kbActive())) return;
    if (e.key === 'b' || e.key === 'B') { e.preventDefault(); togglePanel('browser'); }
    if (e.key === 'i' || e.key === 'I') { e.preventDefault(); togglePanel('side'); }
  });

  // Catena di effetti della traccia selezionata (fxchain.js): un riquadro per effetto
  const chain = initFxChain(app, $('#fxbar'), {
    isSynth, channel, setBottom,
    color: (i) => COLORS[i], short: (i) => trackShort(i), name: (i) => trackName(i),
  });
  const renderFx = () => chain.render(selTrack);

  // Barra inferiore ridimensionabile: trascina il bordo superiore (doppio clic = altezza iniziale)
  const splitter = document.createElement('div');
  splitter.className = 'sx-split';
  splitter.setAttribute('role', 'separator');
  splitter.setAttribute('aria-orientation', 'horizontal');
  splitter.title = 'Trascina per ridimensionare il pannello in basso';
  document.getElementById('app').appendChild(splitter);
  const applyH = () => {
    const h = state.panels.h;
    document.getElementById('app').style.setProperty('--bottom-h', h ? `${h}px` : '');
  };
  let sp = null;
  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    const cur = ($('#fxbar').offsetParent ? $('#fxbar') : document.querySelector('#app .grid')).getBoundingClientRect().height;
    sp = { y: e.clientY, h: cur };
  });
  splitter.addEventListener('pointermove', (e) => {
    if (!sp) return;
    state.panels.h = Math.round(Math.min(window.innerHeight * 0.7, Math.max(120, sp.h + (sp.y - e.clientY))));
    applyH();
    if (state.panels.bottom === 'fx') chain.redraw();
  });
  const spEnd = () => { if (sp) { sp = null; app.save(); window.dispatchEvent(new Event('resize')); } };
  splitter.addEventListener('pointerup', spEnd);
  splitter.addEventListener('pointercancel', spEnd);
  splitter.addEventListener('dblclick', () => { delete state.panels.h; applyH(); app.save(); window.dispatchEvent(new Event('resize')); });
  applyH();

  // ===================================================================
  // Arrangiamento: tracce × battute; ogni cella = pattern da cui suona la clip
  // ===================================================================
  const arrGrid = $('#arGrid'), arrHead = $('#arHead');
  const CELL = 30, LABEL = 64;
  function renderArr() {
    const bars = state.arr.bars, n = bars.length;
    $('#arBrush').textContent = `P${state.slot + 1}`;
    arrGrid.style.gridTemplateColumns = `${LABEL}px repeat(${Math.max(n, 1)}, ${CELL}px)`;
    let html = '<div class="ar-lbl">BAR</div>';
    for (let b = 0; b < n; b++) html += `<button class="ar-ruler${b === ui.arrStart ? ' start' : ''}" data-rb="${b}">${b + 1}</button>`;
    if (!n) html += '<div></div>';
    for (let i = 0; i < SESSION_TRACKS; i++) {
      html += `<div class="ar-lbl" style="--tc:${COLORS[i]}">${esc(trackShort(i))}</div>`;
      for (let b = 0; b < n; b++) {
        const v = bars[b].m[i];
        html += `<div class="ar-cell${v >= 0 ? ' on' : ''}" data-ab="${b}" data-at="${i}" style="--tc:${COLORS[i]}">${v >= 0 ? v + 1 : ''}</div>`;
      }
      if (!n) html += '<div></div>';
    }
    html += '<div class="ar-lbl">TEMPO</div>';
    for (let b = 0; b < n; b++) html += `<div class="ar-cell ar-master" data-ab="${b}" data-at="m" title="Pattern principale (tempo, swing, tonalità)">${bars[b].s + 1}</div>`;
    arrGrid.innerHTML = html;
    barTick();
  }
  function barTick() {
    if (!active) return;
    renderTool();
    if (view !== 'arrange') return;
    const show = seq.playing && state.arr.bars.length;
    arrHead.hidden = !show;
    if (show) arrHead.style.transform = `translateX(${LABEL + 2 + ui.arrBar * (CELL + 2)}px)`;
  }

  // Pittura con trascinamento: il primo clic decide se scrivere il pattern o svuotare
  const paints = new Map();   // dito (pointerId) → pennello
  let paint = null;           // pennello in uso da paintCell
  function paintCell(el) {
    const b = +el.dataset.ab, bar = state.arr.bars[b];
    if (!bar) return;
    if (el.dataset.at === 'm') { bar.s = state.slot; el.textContent = state.slot + 1; return; }
    const i = +el.dataset.at;
    if (paint.v === undefined) paint.v = bar.m[i] === state.slot ? -1 : state.slot;
    bar.m[i] = paint.v;
    el.classList.toggle('on', paint.v >= 0);
    el.textContent = paint.v >= 0 ? paint.v + 1 : '';
  }
  arrGrid.addEventListener('pointerdown', (e) => {
    const c = e.target.closest('.ar-cell');
    if (c) { e.preventDefault(); paint = {}; paints.set(e.pointerId, paint); paintCell(c); return; }
    const r = e.target.closest('[data-rb]');
    if (r) {
      ui.arrStart = +r.dataset.rb;
      if (seq.playing && state.arr.on) ui.arrBar = (ui.arrStart - 1 + state.arr.bars.length) % state.arr.bars.length;
      renderArr();
    }
  });
  window.addEventListener('pointermove', (e) => {
    paint = paints.get(e.pointerId);
    if (!paint) return;
    const c = document.elementFromPoint(e.clientX, e.clientY);
    const cell = c && c.closest && c.closest('.ar-cell');
    if (cell && arrGrid.contains(cell)) paintCell(cell);
  });
  const arrEnd = (e) => { if (paints.delete(e.pointerId)) { paint = null; app.save(); } };
  window.addEventListener('pointerup', arrEnd);
  window.addEventListener('pointercancel', arrEnd);

  $('#sxArr .ar-tools').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ar]');
    if (!b) return;
    const bars = state.arr.bars;
    switch (b.dataset.ar) {
      case 'add': {
        if (bars.length >= MAX_ARR_BARS) break;
        const last = bars[bars.length - 1];
        bars.push(last ? { m: [...last.m], s: last.s } : { m: new Array(SESSION_TRACKS).fill(state.slot), s: state.slot });
        break;
      }
      case 'del': bars.pop(); break;
      case 'dup': state.arr.bars = bars.concat(bars.map((x) => ({ m: [...x.m], s: x.s }))).slice(0, MAX_ARR_BARS); break;
      case 'song':
        if (!state.song.chain.length) { app.toast('Catena song vuota'); return; }
        if (bars.length && !confirm('Sostituire l\'arrangiamento con la catena del song mode?')) return;
        state.arr.bars = app.songToArr(state.song.chain);
        break;
      case 'clear':
        if (bars.length && !confirm('Svuotare l\'arrangiamento?')) return;
        state.arr.bars = [];
        break;
      default: return;
    }
    if (!state.arr.bars.length) state.arr.on = false;
    ui.arrStart = Math.min(ui.arrStart, Math.max(0, state.arr.bars.length - 1));
    app.save();
    renderArr();
  });

  // iPad: lancio di clip, scene e stop con più dita nello stesso momento
  app.touchTap(grid, '[data-launch], [data-scene], [data-stop], [data-stopall]', (b) => {
    if (b.matches('[data-launch]')) { const cell = b.closest('.sx-cell'); app.launchClip(+cell.dataset.t, +cell.dataset.s); }
    else if (b.matches('[data-scene]')) app.launchScene(+b.dataset.scene);
    else if (b.matches('[data-stop]')) app.launchClip(+b.dataset.stop, -1);
    else app.stopAllClips();
  });
  grid.addEventListener('click', (e) => {
    const cell = e.target.closest('.sx-cell');
    if (cell) {
      const i = +cell.dataset.t, s = +cell.dataset.s;
      if (e.target.closest('[data-launch]')) { app.launchClip(i, s); return; }
      pick(i, s);
      return;
    }
    const th = e.target.closest('[data-sel]');
    if (th) { pick(+th.dataset.sel, state.slot); return; }
    const sc = e.target.closest('[data-scene]');
    if (sc) { app.launchScene(+sc.dataset.scene); return; }
    const st = e.target.closest('[data-stop]');
    if (st) { app.launchClip(+st.dataset.stop, -1); return; }
    if (e.target.closest('[data-stopall]')) app.stopAllClips();
  });
  grid.addEventListener('dblclick', (e) => {
    const cell = e.target.closest('.sx-cell');
    if (cell && e.target.closest('[data-pick]')) app.launchClip(+cell.dataset.t, +cell.dataset.s);
  });

  /** Seleziona la clip da modificare: pattern + traccia + vista giusta. */
  function pick(i, s) {
    selTrack = i;
    state.slot = s;
    if (isSynth(i)) { ui.ssel = i - DRUM_TRACKS; app.setView('synth'); } else { app.setView('drum'); app.selectTrack(i); }
    if (!seq.playing) app.syncPlayback();
    app.renderAll();
    app.save();
  }

  // ===================================================================
  // Mixer
  // ===================================================================
  const mixer = $('#mixer');
  function buildMixer() {
    let html = '';
    for (let i = 0; i < SESSION_TRACKS; i++) {
      html += `<div class="mx-strip" data-i="${i}" style="--tc:${COLORS[i]}">
        <button class="mx-name" data-sel="${i}"><b></b></button>
        <div class="mx-mid">
          <div class="mx-meter"><i></i></div>
          <input class="mx-fader" type="range" min="0" max="1" step="0.01" data-p="vol" aria-label="Volume">
        </div>
        <input class="mx-knob" type="range" min="-1" max="1" step="0.05" data-p="pan" aria-label="Pan">
        <div class="mx-sends">
          <input type="range" min="0" max="1" step="0.01" data-p="rev" aria-label="Mandata riverbero">
          <input type="range" min="0" max="1" step="0.01" data-p="dly" aria-label="Mandata delay">
        </div>
        <div class="mx-ms"><button class="btn sm" data-ms="mute" aria-label="Mute">M</button><button class="btn sm" data-ms="solo" aria-label="Solo">S</button></div>
      </div>`;
    }
    html += `<div class="mx-strip mx-master"><div class="mx-name"><b>MASTER</b></div>
      <div class="mx-mid"><div class="mx-meter"><i></i></div>
      <input class="mx-fader" type="range" min="0" max="1" step="0.01" data-master aria-label="Volume master"></div>
      <small class="mx-lbl">REV / DLY</small><small class="mx-lbl">sopra: pan</small></div>`;
    mixer.innerHTML = html;
  }

  function renderMixer() {
    $$('.mx-strip[data-i]', mixer).forEach((el) => {
      const i = +el.dataset.i, tr = mixParams(i);
      el.querySelector('.mx-name b').textContent = trackShort(i, state.slots[mixSlot(i)]);
      el.classList.toggle('picked', i === selTrack);
      el.hidden = !state.tracks.includes(i);         // solo i canali attivi
      el.querySelectorAll('input[data-p]').forEach((inp) => { inp.value = tr[inp.dataset.p] || 0; });
      app.setToggle(el.querySelector('[data-ms="mute"]'), tr.mute);
      app.setToggle(el.querySelector('[data-ms="solo"]'), tr.solo);
    });
    $('[data-master]', mixer).value = state.fx.master;
  }

  let mixGesture = false;
  mixer.addEventListener('pointerdown', (e) => { if (e.target.matches('input') && !mixGesture) { app.snapshot(); mixGesture = true; } });
  window.addEventListener('pointerup', () => { mixGesture = false; });
  mixer.addEventListener('input', (e) => {
    const inp = e.target;
    if (inp.dataset.master !== undefined) {
      state.fx.master = +inp.value;
      engine.setFx({ master: state.fx.master }, null);
      app.save();
      return;
    }
    const strip = inp.closest('.mx-strip'), i = +strip.dataset.i, tr = mixParams(i);
    tr[inp.dataset.p] = +inp.value;
    engine.setChannel(channel(i), tr);
    app.save();
  });
  mixer.addEventListener('click', (e) => {
    const ms = e.target.closest('[data-ms]');
    if (ms) {
      app.snapshot();
      const i = +ms.closest('.mx-strip').dataset.i, tr = mixParams(i);
      tr[ms.dataset.ms] = !tr[ms.dataset.ms];
      app.save(); app.renderAll();
      return;
    }
    const nm = e.target.closest('[data-sel]');
    if (nm) pick(+nm.dataset.sel, state.slot);
  });

  // Indicatori di livello (requestAnimationFrame, solo con layout Studio attivo)
  const peaks = new Float32Array(SESSION_TRACKS + 1);
  function meterLoop() {
    if (!active) return;
    const m = engine.meters();
    if (m) {
      const bars = $$('.mx-meter i', mixer);
      [...m.ch, m.master].forEach((an, j) => {
        const lv = Math.min(1, engine.level(an));
        peaks[j] = Math.max(lv, peaks[j] * 0.9);
        if (bars[j]) bars[j].style.transform = `scaleY(${peaks[j].toFixed(3)})`;
      });
      // Livelli dentro le tracce (barre orizzontali)
      panel.querySelectorAll('[data-meter]').forEach((el) => {
        const k = el.dataset.meter, j = k === 'm' ? SESSION_TRACKS : +k;
        el.firstElementChild.style.transform = `scaleX(${peaks[j].toFixed(3)})`;
      });
    }
    requestAnimationFrame(meterLoop);
  }

  // ===================================================================
  // Browser: suoni e kit
  // ===================================================================
  const browser = $('#browser');
  let bTab = 'sounds', bCat = null;
  function renderBrowser() {
    $$('#browser .bw-tabs .btn').forEach((b) => app.setToggle(b, b.dataset.btab === bTab));
    const list = $('#bwList'), q = $('#bwSearch').value.trim();
    $('#bwCats').hidden = bTab !== 'sounds';
    if (bTab === 'fx') {
      // Effetti audio (come la categoria Audio Effects di Live): trascina sulla catena o su una traccia, doppio clic = accoda
      const ql = q.toLowerCase();
      list.innerHTML = `<div class="bw-hint">Trascina un effetto nella catena in basso o su una traccia · doppio clic o Invio: aggiungi a ${esc(trackShort(selTrack))}</div>`
        + CATEGORIES.map((c) => {
          const items = Object.entries(DEVICES).filter(([, d]) => d.cat === c && (!ql || d.name.toLowerCase().includes(ql) || d.desc.toLowerCase().includes(ql)));
          return items.length ? `<div class="bw-sep">${esc(c.toUpperCase())}</div>` + items.map(([t, d]) => `<button class="bw-item bw-dev" draggable="true" data-devtype="${t}" title="${esc(d.desc)}"><b>${esc(d.name)}</b><small>${esc(d.desc)}</small></button>`).join('') : '';
        }).join('');
      return;
    }
    if (bTab === 'sounds') {
      $('#bwCats').innerHTML = ['Tutti', ...categories()].map((c) => `<button class="btn sm chip-cat${(c === 'Tutti' ? !bCat : c === bCat) ? ' on' : ''}" data-bcat="${esc(c)}">${esc(c)}</button>`).join('');
      const items = findPresets({ cat: q ? null : bCat, text: q });
      const k = isSynth(selTrack) ? selTrack - DRUM_TRACKS : 0, curP = app.pat().synth.tracks[k].preset;
      list.innerHTML = `<div class="bw-hint">LIBRERIA → ${esc(SYNTH_TRACKS[k].name)}: clic per scegliere il suono</div>`
        + items.map((p) => `<button class="bw-item${p.id === curP ? ' cur' : ''}" data-preset="${p.id}" title="${esc(p.tags.join(', '))}"><b>${esc(p.name)}</b><small>${esc(p.cat)}</small></button>`).join('');
    } else {
      const kits = allKits().filter((k) => !q || k.name.toLowerCase().includes(q.toLowerCase()));
      const cur = app.kitOf(app.pat()).id;
      // Suoni creati nel Sound Lab: un clic li mette sulla traccia di batteria selezionata
      const snds = USER_SOUNDS.filter((s) => !q || s.name.toLowerCase().includes(q.toLowerCase()));
      const t = isSynth(selTrack) ? 0 : selTrack;
      list.innerHTML = (snds.length ? `<div class="bw-sep">I MIEI SUONI → traccia ${t + 1}</div>` + snds.map((s) => `<button class="bw-item bw-snd" data-usound="${esc(s.id)}" title="Assegna alla traccia ${t + 1}"><b>${esc(s.name)}</b><small>suono batteria · ▶ ascolta e assegna</small></button>`).join('') + '<div class="bw-sep">KIT</div>' : '')
        + kits.map((k) => `<button class="bw-item${k.id === cur ? ' cur' : ''}" data-kitid="${k.id}"><b>${esc(k.name)}</b><small>${k.user ? 'personalizzato' : 'kit'}</small></button>`).join('');
    }
  }
  browser.addEventListener('click', (e) => {
    const tb = e.target.closest('[data-btab]');
    if (tb) { bTab = tb.dataset.btab; renderBrowser(); return; }
    const c = e.target.closest('[data-bcat]');
    if (c) { bCat = c.dataset.bcat === 'Tutti' ? null : c.dataset.bcat; renderBrowser(); return; }
    const pr = e.target.closest('[data-preset]');
    if (pr) {
      // Il suono va sulla traccia synth selezionata (o su BASS se è selezionata una traccia batteria)
      const k = isSynth(selTrack) ? selTrack - DRUM_TRACKS : 0;
      const tr = app.pat().synth.tracks[k];
      app.snapshot();
      tr.preset = pr.dataset.preset;
      delete tr.patch;
      if (!isSynth(selTrack)) { selTrack = DRUM_TRACKS; ui.ssel = 0; app.setView('synth'); }
      app.save(); app.syncPlayback(); app.renderAll();
      if (engine.ctx) {
        const base = 12 * (SYNTH_TRACKS[k].oct + 1) + app.pat().synth.key;
        engine.playSynth(k, engine.ctx.currentTime + 0.02, 0.5, [base, base + 7], 0.85, tr);
      }
      app.toast(`${PRESETS[tr.preset].name} → ${SYNTH_TRACKS[k].name}`);
      return;
    }
    const us = e.target.closest('[data-usound]');
    if (us) {
      const snd = USER_SOUNDS.find((s) => s.id === us.dataset.usound);
      if (snd && engine.ctx) engine.audition(buildVoice(snd.spec), 1, { tune: 0, decay: 1 });
      app.useSoundOnTrack(us.dataset.usound, isSynth(selTrack) ? 0 : selTrack);
      return;
    }
    const kb = e.target.closest('[data-kitid]');
    if (kb) {
      app.snapshot();
      const p = app.pat(), kit = kitById(kb.dataset.kitid);
      p.kit = kit.id;
      p.tracks.forEach((tr, i) => { tr.pan = kit.tracks[i].pan || 0; });
      app.save(); app.syncPlayback(); app.renderAll();
      app.toast(`Kit ${kit.name} → P${state.slot + 1}`);
    }
  });
  $('#bwSearch').addEventListener('input', renderBrowser);
  // Effetti: doppio clic o Invio → accodati alla traccia selezionata; trascinamento → punto voluto
  const addToSel = (type) => { chain.addDevice(type, channel(selTrack)); setBottom('fx'); };
  browser.addEventListener('dblclick', (e) => { const d = e.target.closest('[data-devtype]'); if (d) addToSel(d.dataset.devtype); });
  browser.addEventListener('keydown', (e) => { const d = e.target.closest('[data-devtype]'); if (d && e.key === 'Enter') { e.preventDefault(); addToSel(d.dataset.devtype); } });
  browser.addEventListener('dragstart', (e) => {
    const d = e.target.closest('[data-devtype]');
    if (!d) return;
    e.dataTransfer.setData('text/x-drumbort-newdev', d.dataset.devtype);
    e.dataTransfer.effectAllowed = 'copy';
  });
  // Rilascio di un effetto su una traccia (intestazione o corsia) nella vista TRACCE o sulle colonne della SESSION
  panel.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('text/x-drumbort-newdev')) return;
    const t = e.target.closest('.tv-hdr[data-i], .tv-lane[data-i], .sx-th[data-sel]');
    if (!t) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    $$('.drop-on', panel).forEach((x) => x.classList.remove('drop-on'));
    t.classList.add('drop-on');
  });
  panel.addEventListener('dragleave', (e) => { const t = e.target.closest('.drop-on'); if (t && !t.contains(e.relatedTarget)) t.classList.remove('drop-on'); });
  panel.addEventListener('drop', (e) => {
    const type = e.dataTransfer.getData('text/x-drumbort-newdev');
    const t = e.target.closest('.tv-hdr[data-i], .tv-lane[data-i], .sx-th[data-sel]');
    $$('.drop-on', panel).forEach((x) => x.classList.remove('drop-on'));
    if (!type || !t) return;
    e.preventDefault();
    const i = +(t.dataset.i ?? t.dataset.sel);
    pick(i, state.slot);
    chain.addDevice(type, channel(i));
    setBottom('fx');
    app.renderAll();
  });

  buildSession();
  buildMixer();

  return {
    barTick,
    get view() { return view; },
    tick(e) { if (active && view === 'tracks') tracks.tick(e); },
    clearPlayhead() { tracks.clearPlayhead(); },
    toggleView() { setView(view === 'tracks' ? 'session' : view === 'session' ? 'arrange' : 'tracks'); },
    setActive(on) {
      const was = active;
      active = on;
      if (on && !was) requestAnimationFrame(meterLoop);
    },
    render() {
      if (!active) return;
      selTrack = ui.view === 'synth' ? DRUM_TRACKS + (ui.ssel || 0) : state.sel;
      renderTool();
      if (view === 'arrange') renderArr(); else if (view === 'tracks') tracks.render(); else renderSession(); renderSessionMix();
      renderMixer();
      renderBrowser();
      if (state.panels && state.panels.bottom === 'fx') renderFx();
    },
  };
}
