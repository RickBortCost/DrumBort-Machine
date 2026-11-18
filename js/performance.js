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
  }
  $('#muteGrid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-g]');
    if (!b) return;
    if (muted.has(b.dataset.g)) muted.delete(b.dataset.g); else muted.add(b.dataset.g);
    applyMutes();
  });

  // ----- Beat repeat (tieni premuto) -----
  const stutBtns = $$('.perf .stut .btn');
  const stutDown = (e) => {
    const b = e.target.closest('[data-st]');
    if (!b) return;
    e.preventDefault();
    seq.startStutter(+b.dataset.st);
    stutBtns.forEach((x) => x.classList.toggle('on', x === b));
  };
  const stutUp = () => { seq.stopStutter(); stutBtns.forEach((x) => x.classList.remove('on')); };
  $('.perf .stut').addEventListener('pointerdown', stutDown);
  window.addEventListener('pointerup', () => { if (seq.stutter) stutUp(); });
  window.addEventListener('pointercancel', stutUp);

  // ----- Fill (tieni premuto) -----
  const fill = $('#fillBtn');
  fill.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    seq.fillPattern = fillPattern(seq.pattern);
    fill.classList.add('on');
  });
  const fillUp = () => { if (seq.fillPattern) { seq.fillPattern = null; fill.classList.remove('on'); } };
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
    engine.setFx({ filter: Math.abs(filter) < 0.06 ? 0 : filter, res }, null);
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
