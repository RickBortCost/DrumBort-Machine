/**
 * tracks.js — Vista TRACCE del layout Studio (stile Logic/Ableton arrangement):
 * a sinistra le tracce attive in colonna (colore, nome, M/S), a destra la timeline con le
 * regioni. Una regione è una clip (un pattern P1…P8) che suona su quella traccia per una o più
 * battute; il contenuto si modifica nell'editor sotto (rack o piano roll).
 *
 * Il progetto parte senza tracce: "+" aggiunge un canale di batteria (una voce del kit) o synth.
 * Dati: state.tracks = canali attivi in ordine (0-7 batteria, 8-11 synth);
 *       state.arr.bars[b].m[canale] = pattern della regione in quella battuta (−1 = vuota).
 */

import { SYNTH_TRACKS, PRESETS } from './synth.js';
import { DRUM_TRACKS, SESSION_TRACKS, MAX_ARR_BARS } from './session.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const BW = 44;           // larghezza di una battuta (px)

export function initTracksView(app, root, COLORS) {
  const { state, ui, seq } = app;
  let selReg = null;     // { i, b0, b1 }
  let drag = null;

  const isSynth = (i) => i >= DRUM_TRACKS;
  const name = (i) => {
    if (!isSynth(i)) return app.kitOf(app.pat()).tracks[i].name;
    const t = app.pat().synth.tracks[i - DRUM_TRACKS];
    const pr = t.patch && t.patch.wt ? t.patch : PRESETS[t.preset];
    return `${SYNTH_TRACKS[i - DRUM_TRACKS].name} · ${pr ? pr.name : ''}`;
  };
  const short = (i) => (isSynth(i) ? SYNTH_TRACKS[i - DRUM_TRACKS].short : app.kitOf(app.pat()).tracks[i].short);
  /** Parametri (mute/solo) della traccia nel pattern della regione selezionata o in quello corrente. */
  const params = (i) => (isSynth(i) ? app.pat().synth.tracks[i - DRUM_TRACKS] : app.pat().tracks[i]);
  const bars = () => state.arr.bars;
  // Battute mostrate: almeno lo spazio visibile, sempre qualcuna oltre la fine dell'arrangiamento
  const nBars = () => Math.max(16, Math.ceil(((root.clientWidth || 900) - 210) / BW), bars().length + 8);

  /** Regioni della traccia i: battute consecutive con lo stesso pattern. */
  function regions(i) {
    const out = [];
    const B = bars();
    for (let b = 0; b < B.length; b++) {
      const s = B[b].m[i];
      if (s < 0) continue;
      const last = out[out.length - 1];
      if (last && last.slot === s && last.b1 === b - 1) last.b1 = b;
      else out.push({ i, slot: s, b0: b, b1: b });
    }
    return out;
  }

  function ensureBars(n) {
    const B = bars();
    while (B.length < Math.min(n, MAX_ARR_BARS)) B.push({ m: new Array(SESSION_TRACKS).fill(-1), s: B.length ? B[B.length - 1].s : state.slot });
  }
  /** Scrive il pattern `slot` (−1 = vuoto) sulla traccia i dalle battute b0 a b1. */
  function setCells(i, b0, b1, slot) {
    ensureBars(b1 + 1);
    for (let b = Math.max(0, b0); b <= b1 && b < bars().length; b++) {
      bars()[b].m[i] = slot;
      if (slot >= 0 && bars()[b].m.filter((v) => v >= 0).length === 1) bars()[b].s = slot;   // tempo dal primo pattern della battuta
    }
  }
  /** Toglie le battute vuote in coda. */
  function trim() {
    const B = bars();
    while (B.length && B[B.length - 1].m.every((v) => v < 0)) B.pop();
    if (!B.length) state.arr.on = false;
  }

  // ---------------------------------------------------------------
  // Disegno
  // ---------------------------------------------------------------
  function render() {
    const act = state.tracks;
    const W = nBars() * BW;
    let html = `<div class="tv-scroll" id="tvScroll"><div class="tv-grid" style="--bw:${BW}px; width:${W + 210}px">`;
    html += `<div class="tv-corner"><button class="btn sm tv-add" id="tvAdd" aria-haspopup="menu" title="Aggiungi traccia">＋ TRACCIA</button></div>`;
    html += `<div class="tv-ruler" style="width:${W}px">${Array.from({ length: nBars() }, (_, b) => `<button class="tv-bar${b === ui.arrStart ? ' start' : ''}${b < bars().length ? ' used' : ''}" data-rb="${b}">${b + 1}</button>`).join('')}</div>`;
    for (const i of act) {
      const p = params(i);
      html += `<div class="tv-hdr${(isSynth(i) ? ui.view === 'synth' && ui.ssel === i - DRUM_TRACKS : ui.view === 'drum' && state.sel === i) ? ' picked' : ''}" data-i="${i}" style="--tc:${COLORS[i]}">
        <span class="tv-ico">${isSynth(i) ? '♫' : '●'}</span>
        <span class="tv-name"><b>${esc(short(i))}</b><i>${esc(name(i))}</i></span>
        <button class="tv-ms${p.mute ? ' on' : ''}" data-ms="mute" aria-label="Mute">M</button>
        <button class="tv-ms${p.solo ? ' on solo' : ''}" data-ms="solo" aria-label="Solo">S</button>
        <button class="tv-x" data-rm aria-label="Togli la traccia">×</button>
      </div>`;
      html += `<div class="tv-lane" data-i="${i}" style="--tc:${COLORS[i]}; width:${W}px">${regions(i).map((r) => `
        <div class="tv-reg${selReg && selReg.i === i && selReg.b0 === r.b0 ? ' sel' : ''}" data-i="${i}" data-b0="${r.b0}" data-b1="${r.b1}" style="left:${r.b0 * BW}px; width:${(r.b1 - r.b0 + 1) * BW - 2}px">
          <span class="tv-rn">P${r.slot + 1}</span><canvas width="${(r.b1 - r.b0 + 1) * BW}" height="26"></canvas><i class="tv-rz" title="Trascina per allungare"></i>
        </div>`).join('')}</div>`;
    }
    if (!act.length) html += `<div class="tv-empty">Nessuna traccia. Premi <b>＋ TRACCIA</b> per aggiungere un canale di batteria o un synth.</div>`;
    html += `<div class="tv-ph" id="tvPh" hidden></div></div></div>`;
    const keep = $('#tvScroll', root) ? [$('#tvScroll', root).scrollLeft, $('#tvScroll', root).scrollTop] : [0, 0];
    root.innerHTML = html;
    const sc = $('#tvScroll', root);
    sc.scrollLeft = keep[0]; sc.scrollTop = keep[1];
    $$('.tv-reg', root).forEach(drawRegion);
  }

  /** Anteprima della regione: step della batteria o note del synth, ripetuti sulle battute. */
  function drawRegion(el) {
    const cv = el.querySelector('canvas'), g = cv.getContext('2d');
    const i = +el.dataset.i, b0 = +el.dataset.b0, b1 = +el.dataset.b1;
    const slot = bars()[b0].m[i], p = state.slots[slot];
    if (!p) return;
    g.fillStyle = 'rgba(0,0,0,.55)';
    const W = cv.width, H = cv.height, total = (b1 - b0 + 1) * 16;
    if (!isSynth(i)) {
      const row = p.steps[i], len = p.tracks[i].len || row.length;
      for (let s = 0; s < total; s++) { const v = row[s % len]; if (v) g.fillRect((s / total) * W + 1, v === 2 ? 3 : 8, Math.max(1, W / total - 2), v === 2 ? H - 6 : H - 12); }
    } else {
      const t = p.synth.tracks[i - DRUM_TRACKS], len = t.len || t.steps.length;
      const ns = t.steps.filter(Boolean).flatMap((st) => (st.ch || [0]).map((c) => st.n + c));
      if (!ns.length) return;
      const lo = Math.min(...ns), hi = Math.max(...ns, lo + 8);
      for (let s = 0; s < total; s++) {
        const st = t.steps[s % len];
        if (!st) continue;
        for (const n of (st.ch || [0]).map((c) => st.n + c)) g.fillRect((s / total) * W, H - 3 - ((n - lo) / (hi - lo)) * (H - 6), Math.max(2, (st.g / total) * W - 1), 2);
      }
    }
  }

  // ---------------------------------------------------------------
  // Tracce: aggiungi, togli, seleziona, mute/solo
  // ---------------------------------------------------------------
  function addMenu(anchor) {
    const old = $('.tv-menu');
    if (old) { old.remove(); return; }
    const kit = app.kitOf(app.pat());
    const m = document.createElement('div');
    m.className = 'tv-menu';
    m.setAttribute('role', 'menu');
    m.innerHTML = '<h4>BATTERIA</h4>' + kit.tracks.map((t, i) => `<button class="btn sm" data-addt="${i}" ${state.tracks.includes(i) ? 'disabled' : ''}><b>${esc(t.short)}</b> ${esc(t.name)}</button>`).join('')
      + '<h4>SYNTH</h4>' + SYNTH_TRACKS.map((t, k) => `<button class="btn sm" data-addt="${DRUM_TRACKS + k}" ${state.tracks.includes(DRUM_TRACKS + k) ? 'disabled' : ''}><b>${t.short}</b> ${t.name}</button>`).join('');
    const r = anchor.getBoundingClientRect();
    m.style.left = `${r.left}px`; m.style.top = `${r.bottom + 4}px`;
    document.body.appendChild(m);
    m.addEventListener('click', (e) => {
      const b = e.target.closest('[data-addt]');
      if (!b) return;
      addTrack(+b.dataset.addt);
      m.remove();
    });
    setTimeout(() => document.addEventListener('pointerdown', function off(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', off); } }), 0);
  }

  function addTrack(i) {
    app.snapshot();
    if (!state.tracks.includes(i)) state.tracks.push(i);
    // La traccia torna udibile in tutti i pattern
    state.slots.forEach((p) => { (isSynth(i) ? p.synth.tracks[i - DRUM_TRACKS] : p.tracks[i]).mute = false; });
    pick(i);
    app.save();
    app.renderAll();
    if (isSynth(i)) app.openLibrary();          // come in una DAW: scegli subito lo strumento
  }

  function removeTrack(i) {
    if (!confirm(`Togliere la traccia ${short(i)}? Le note restano nei pattern, la traccia viene silenziata.`)) return;
    app.snapshot();
    state.tracks = state.tracks.filter((x) => x !== i);
    state.slots.forEach((p) => { (isSynth(i) ? p.synth.tracks[i - DRUM_TRACKS] : p.tracks[i]).mute = true; });
    bars().forEach((b) => { b.m[i] = -1; });
    trim();
    app.save(); app.syncPlayback(); app.renderAll();
  }

  function pick(i) {
    if (isSynth(i)) { ui.ssel = i - DRUM_TRACKS; app.setView('synth'); } else { app.setView('drum'); app.selectTrack(i); }
  }

  root.addEventListener('click', (e) => {
    if (e.target.closest('#tvAdd')) { addMenu(e.target.closest('#tvAdd')); return; }
    const hdr = e.target.closest('.tv-hdr');
    if (hdr) {
      const i = +hdr.dataset.i;
      const ms = e.target.closest('[data-ms]');
      if (ms) {
        app.snapshot();
        const k = ms.dataset.ms;
        // Mute/solo valgono per la traccia in tutti i pattern (come in una DAW)
        const v = !params(i)[k];
        state.slots.forEach((p) => { (isSynth(i) ? p.synth.tracks[i - DRUM_TRACKS] : p.tracks[i])[k] = v; });
        app.save(); app.syncPlayback(); app.renderAll();
        return;
      }
      if (e.target.closest('[data-rm]')) { removeTrack(i); return; }
      pick(i);
      if (app.setBottom) app.setBottom('fx');      // traccia selezionata → i suoi effetti in basso
      app.renderAll();
      return;
    }
    const rb = e.target.closest('[data-rb]');
    if (rb) {
      ui.arrStart = +rb.dataset.rb;
      if (seq.playing && state.arr.on && bars().length) ui.arrBar = (ui.arrStart - 1 + bars().length) % bars().length;
      render();
    }
  });

  // ---------------------------------------------------------------
  // Regioni: crea (clic + trascina), seleziona, sposta, allunga, cancella
  // ---------------------------------------------------------------
  const barAt = (lane, x) => clamp(Math.floor((x - lane.getBoundingClientRect().left) / BW), 0, MAX_ARR_BARS - 1);

  root.addEventListener('pointerdown', (e) => {
    const lane = e.target.closest('.tv-lane');
    if (!lane || e.button === 2) return;
    e.preventDefault();
    const i = +lane.dataset.i, b = barAt(lane, e.clientX);
    const reg = e.target.closest('.tv-reg');
    app.snapshot();
    if (reg) {
      const b0 = +reg.dataset.b0, b1 = +reg.dataset.b1, slot = bars()[b0].m[i];
      selReg = { i, b0, b1 };
      if (state.slot !== slot) { state.slot = slot; }
      pick(i);
      if (app.setBottom) app.setBottom('editor');   // regione → le sue note in basso
      drag = e.target.closest('.tv-rz') ? { mode: 'len', i, b0, b1, slot } : { mode: 'move', i, b0, b1, slot, grab: b, moved: false };
    } else {
      setCells(i, b, b, state.slot);
      selReg = { i, b0: b, b1: b };
      drag = { mode: 'len', i, b0: b, b1: b, slot: state.slot };
      pick(i);
    }
    lane.setPointerCapture(e.pointerId);
    app.renderAll();
  });

  root.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const lane = $(`.tv-lane[data-i="${drag.i}"]`, root);
    if (!lane) return;
    const b = barAt(lane, e.clientX);
    if (drag.mode === 'len') {
      const end = Math.max(drag.b0, b);
      if (end === drag.b1) return;
      if (end < drag.b1) setCells(drag.i, end + 1, drag.b1, -1); else setCells(drag.i, drag.b1 + 1, end, drag.slot);
      drag.b1 = end;
    } else {
      const d = b - drag.grab;
      if (!d) return;
      const len = drag.b1 - drag.b0, nb0 = Math.max(0, drag.b0 + d);
      setCells(drag.i, drag.b0, drag.b1, -1);
      setCells(drag.i, nb0, nb0 + len, drag.slot);
      drag.b0 = nb0; drag.b1 = nb0 + len; drag.grab = b; drag.moved = true;
    }
    selReg = { i: drag.i, b0: drag.b0, b1: drag.b1 };
    trim();
    render();
  });

  const end = () => {
    if (!drag) return;
    drag = null;
    trim();
    app.save();
    app.renderAll();
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);

  // Tasto destro / Canc: elimina la regione
  root.addEventListener('contextmenu', (e) => {
    const reg = e.target.closest('.tv-reg');
    if (!reg) return;
    e.preventDefault();
    deleteRegion(+reg.dataset.i, +reg.dataset.b0, +reg.dataset.b1);
  });
  function deleteRegion(i, b0, b1) {
    app.snapshot();
    setCells(i, b0, b1, -1);
    trim();
    selReg = null;
    app.save(); app.renderAll();
  }
  document.addEventListener('keydown', (e) => {
    if (!selReg || !root.offsetParent || e.target.closest('input, select, textarea')) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteRegion(selReg.i, selReg.b0, selReg.b1); }
  });

  // ---------------------------------------------------------------
  // Playhead
  // ---------------------------------------------------------------
  function tick(e) {
    const ph = $('#tvPh', root);
    if (!ph) return;
    const B = bars().length;
    if (!seq.playing || !state.arr.on || !B) { ph.hidden = true; return; }
    const pos = (ui.arrStart + (e.abs ?? e.tick) / 16) % B;
    ph.hidden = false;
    ph.style.transform = `translateX(${210 + pos * BW}px)`;
  }

  return { render, tick, clearPlayhead() { const ph = $('#tvPh', root); if (ph) ph.hidden = true; } };
}
