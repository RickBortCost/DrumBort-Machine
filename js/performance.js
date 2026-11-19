/**
 * performance.js — Vista PERFORMANCE: pad XY (filtro/risonanza), beat repeat, fill,
 * mute rapidi per gruppi, sidechain e registrazione dell'uscita.
 */

import { fillPattern } from './generate.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Gruppi di mute: d = tracce batteria, s = tracce synth. */
const GROUPS = [
  { id: 'kick', label: 'KICK', d: [0] }, { id: 'snare', label: 'SNARE', d: [1, 2] },
  { id: 'hats', label: 'HATS', d: [3, 4, 6] }, { id: 'perc', label: 'PERC', d: [5, 7] },
  { id: 'bass', label: 'BASS', s: [0] }, { id: 'lead', label: 'LEAD', s: [1] },
  { id: 'pad', label: 'PAD', s: [2] }, { id: 'keys', label: 'KEYS', s: [3] },
];

/**
 * @param {object} app { engine, seq, state, save, setToggle, toast, recordOutput }
 */
export function initPerformance(app) {
  const { engine, seq, state } = app;
  const muted = new Set();

  // ----- Mute rapidi -----
  $('#muteGrid').innerHTML = GROUPS.map((g) => `<button class="btn" data-g="${g.id}" aria-pressed="false">${g.label}</button>`).join('');
  function applyMutes() {
    seq.muteD.clear(); seq.muteS.clear();
    for (const g of GROUPS) {
      if (!muted.has(g.id)) continue;
      (g.d || []).forEach((t) => seq.muteD.add(t));
      (g.s || []).forEach((k) => seq.muteS.add(k));
    }
    $$('#muteGrid .btn').forEach((b) => app.setToggle(b, muted.has(b.dataset.g)));
    if (app.remoteOp) app.remoteOp('mutes', { d: [...seq.muteD], s: [...seq.muteS] });
  }
  const toggleMute = (b) => {
    if (muted.has(b.dataset.g)) muted.delete(b.dataset.g); else muted.add(b.dataset.g);
    applyMutes();
  };
  app.touchTap($('#muteGrid'), '[data-g]', toggleMute);   // più gruppi insieme con più dita
  $('#muteGrid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-g]');
    if (b) toggleMute(b);
  });

  // ----- Beat repeat (tieni premuto) -----
  const stutBtns = $$('.perf .stut .btn');
  let stutFinger = null;   // dito che tiene il beat repeat: un altro dito cambia lunghezza
  const stutDown = (e) => {
    const b = e.target.closest('[data-st]');
    if (!b) return;
    e.preventDefault();
    stutFinger = e.pointerId;
    seq.startStutter(+b.dataset.st);
    if (app.remoteOp) app.remoteOp('stut', { len: +b.dataset.st });
    stutBtns.forEach((x) => x.classList.toggle('on', x === b));
  };
  const stutUp = () => {
    seq.stopStutter();
    if (app.remoteOp) app.remoteOp('stut', { len: 0 });
    stutBtns.forEach((x) => x.classList.remove('on'));
  };
  $('.perf .stut').addEventListener('pointerdown', stutDown);
  const stutEnd = (e) => { if (e.pointerId === stutFinger) { stutFinger = null; stutUp(); } };
  window.addEventListener('pointerup', stutEnd);
  window.addEventListener('pointercancel', stutEnd);

  // ----- Fill (tieni premuto) -----
  const fill = $('#fillBtn');
  let fillFinger = null;
  fill.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    fillFinger = e.pointerId;
    seq.fillPattern = fillPattern(seq.pattern);
    if (app.remoteOp) app.remoteOp('fill', { on: true });
    fill.classList.add('on');
  });
  const fillUp = (e) => {
    if (!seq.fillPattern || (e && e.pointerId !== fillFinger)) return;
    fillFinger = null;
    seq.fillPattern = null;
    if (app.remoteOp) app.remoteOp('fill', { on: false });
    fill.classList.remove('on');
  };
  window.addEventListener('pointerup', fillUp);
  window.addEventListener('pointercancel', fillUp);

  // ----- Pad XY: X = filtro master (LP ← → HP), Y = risonanza -----
  const xy = $('#xy'), dot = $('.xy-dot', xy);
  let saved = null, active = null;
  const snap = () => $('#snapBtn').classList.contains('on');
  function moveXY(e) {
    const r = xy.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    dot.style.transform = `translate(${x * r.width}px, ${y * r.height}px)`;
    const filter = x * 2 - 1;
    const res = 0.7 * Math.pow(18 / 0.7, 1 - y);
    const fxl = { filter: Math.abs(filter) < 0.06 ? 0 : filter, res };
    engine.setFx(fxl, null);
    if (app.remoteOp) app.remoteOp('fxl', { fx: fxl });
    xy.dataset.v = `${filter < -0.06 ? 'LP' : filter > 0.06 ? 'HP' : 'OFF'} ${Math.round(Math.abs(filter) * 100)} · Q ${res.toFixed(1)}`;
  }
  xy.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    active = e.pointerId;
    saved = { filter: state.fx.filter, res: state.fx.res };
    xy.classList.add('on');
    moveXY(e);
  });
  xy.addEventListener('pointermove', (e) => { if (e.pointerId === active) moveXY(e); });
  const xyUp = (e) => {
    if (e.pointerId !== active) return;
    active = null;
    xy.classList.remove('on');
    if (snap()) {
      engine.setFx(saved, null);
      if (app.remoteOp) app.remoteOp('fxl', { fx: saved });
      dot.style.transform = '';
      delete xy.dataset.v;
    } else {
      state.fx.filter = engine.fx.filter;
      state.fx.res = engine.fx.res;
      app.save();
    }
  };
  window.addEventListener('pointerup', xyUp);
  window.addEventListener('pointercancel', xyUp);
  $('#snapBtn').addEventListener('click', (e) => {
    const on = !e.currentTarget.classList.contains('on');
    app.setToggle(e.currentTarget, on);
  });

  // ----- Sidechain -----
  const sc = $('#perfSc');
  sc.addEventListener('input', () => {
    state.fx.sc = +sc.value;
    engine.setFx({ sc: state.fx.sc }, null);
    sc.nextElementSibling.textContent = `${Math.round(state.fx.sc * 100)}`;
    app.save();
  });

  // ----- Registrazione uscita -----
  $('#recOutBtn').addEventListener('click', () => app.recordOutput());

  return {
    render() {
      sc.value = state.fx.sc || 0;
      sc.nextElementSibling.textContent = `${Math.round((state.fx.sc || 0) * 100)}`;
      applyMutes();
    },
    clearMutes() { muted.clear(); applyMutes(); },
  };
}
