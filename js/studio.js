/**
 * studio.js — Layout Studio per PC: browser (suoni e kit), griglia delle clip (tracce × pattern)
 * con lancio di clip e scene, mixer con fader, pan, mandate, mute/solo e indicatori di livello.
 * L'editor della clip selezionata è la griglia step/synth esistente; parametri e pad a destra.
 */

import { allKits, kitById } from './kits.js';
import { PRESETS, categories, findPresets } from './presets.js';
import { SYNTH_TRACKS } from './synth.js';
import { SYNTH_CH } from './engine.js';
import { DRUM_TRACKS, SESSION_TRACKS, hasClip } from './session.js';

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
  const grid = $('#session');
  function buildSession() {
    let html = '<div class="sx-row sx-head"><div class="sx-corner">PATTERN</div>';
    for (let i = 0; i < SESSION_TRACKS; i++) html += `<button class="sx-th" data-sel="${i}" style="--tc:${COLORS[i]}"><b></b><i></i></button>`;
    html += '<div class="sx-scene-h">SCENA</div></div>';
    for (let s = 0; s < SLOTS; s++) {
      html += `<div class="sx-row"><div class="sx-rh">P${s + 1}</div>`;
      for (let i = 0; i < SESSION_TRACKS; i++) {
        html += `<div class="sx-cell" data-t="${i}" data-s="${s}" style="--tc:${COLORS[i]}">
          <button class="sx-launch" data-launch aria-label="Lancia clip"><span>▶</span></button>
          <button class="sx-body" data-pick aria-label="Modifica clip"><canvas width="64" height="18"></canvas></button></div>`;
      }
      html += `<button class="sx-scene" data-scene="${s}" aria-label="Lancia scena P${s + 1}">▶ P${s + 1}</button></div>`;
    }
    html += '<div class="sx-row sx-foot"><div class="sx-rh"></div>';
    for (let i = 0; i < SESSION_TRACKS; i++) html += `<button class="sx-stop" data-stop="${i}" aria-label="Ferma traccia">■</button>`;
    html += '<button class="sx-stopall" data-stopall aria-label="Ferma tutte le clip">■ STOP</button></div>';
    grid.innerHTML = html;
  }

  /** Mini anteprima della clip (step della batteria o note del synth). */
  function drawClip(cv, p, i) {
    const g = cv.getContext('2d'), w = cv.width, h = cv.height;
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(0,0,0,.55)';
    if (!isSynth(i)) {
      p.steps[i].forEach((v, s) => { if (v) g.fillRect(s * (w / 16) + 1, v === 2 ? 2 : 6, w / 16 - 2, v === 2 ? h - 4 : h - 8); });
    } else {
      const t = p.synth.tracks[i - DRUM_TRACKS];
      const ns = t.steps.filter(Boolean).map((x) => x.n);
      if (!ns.length) { if (t.arp.on) { g.fillText('ARP', 4, 13); } return; }
      const lo = Math.min(...ns), hi = Math.max(...ns, lo + 6);
      t.steps.forEach((x, s) => { if (x) g.fillRect(s * (w / 16), h - 4 - ((x.n - lo) / (hi - lo)) * (h - 6), Math.max(2, x.g * (w / 16) - 1), 3); });
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
    $$('.sx-scene', grid).forEach((b) => b.classList.toggle('master', +b.dataset.scene === state.session.master));
  }

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
    if (bTab === 'sounds') {
      $('#bwCats').innerHTML = ['Tutti', ...categories()].map((c) => `<button class="btn sm chip-cat${(c === 'Tutti' ? !bCat : c === bCat) ? ' on' : ''}" data-bcat="${esc(c)}">${esc(c)}</button>`).join('');
      const items = findPresets({ cat: q ? null : bCat, text: q });
      list.innerHTML = items.map((p) => `<button class="bw-item" data-preset="${p.id}" title="${esc(p.tags.join(', '))}"><b>${esc(p.name)}</b><small>${esc(p.cat)}</small></button>`).join('');
    } else {
      const kits = allKits().filter((k) => !q || k.name.toLowerCase().includes(q.toLowerCase()));
      const cur = app.kitOf(app.pat()).id;
      list.innerHTML = kits.map((k) => `<button class="bw-item${k.id === cur ? ' cur' : ''}" data-kitid="${k.id}"><b>${esc(k.name)}</b><small>${k.user ? 'personalizzato' : 'kit'}</small></button>`).join('');
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

  buildSession();
  buildMixer();

  return {
    setActive(on) {
      const was = active;
      active = on;
      if (on && !was) requestAnimationFrame(meterLoop);
    },
    render() {
      if (!active) return;
      selTrack = ui.view === 'synth' ? DRUM_TRACKS + (ui.ssel || 0) : state.sel;
      renderSession();
      renderMixer();
      renderBrowser();
    },
  };
}
