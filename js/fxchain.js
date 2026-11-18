/**
 * fxchain.js — Catena degli effetti della traccia selezionata, stile "device" delle DAW:
 * ogni effetto ha il suo riquadro con interruttore, manopole rotative e (EQ/filtro) la curva.
 *
 *   Strumento/Voce → Drive → Bit crush → EQ → Filtro → Compressore → Mandate → Mixer
 *
 * I valori valgono per la traccia in tutti i pattern (come un canale di una DAW).
 * Manopole: trascina in verticale (Shift = fine), rotella, frecce, doppio clic = valore iniziale.
 */

import { SYNTH_TRACKS, PRESETS } from './synth.js';
import { filterFreqs } from './engine.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pct = (v) => `${Math.round(v * 100)}%`;
const db = (v) => `${v > 0 ? '+' : ''}${(+v).toFixed(1)} dB`;
const hz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);
const K = (k, label, min, max, step, def, fmt) => ({ k, label, min, max, step, def, fmt });

/** Dispositivi: chiave dell'interruttore (parametri azzerati quando spento) e manopole. */
function devices(isSynth) {
  const inst = isSynth
    ? { id: 'inst', title: 'STRUMENTO', knobs: [
      K('cut', 'Cutoff', -1, 1, 0.01, 0, (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`), K('res', 'Reso', -1, 1, 0.01, 0, (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`),
      K('env', 'Env', 0, 2, 0.01, 1, (v) => v.toFixed(2)), K('dec', 'Decay', 0.25, 3, 0.01, 1, (v) => v.toFixed(2)),
      K('atk', 'Attack', 0.1, 4, 0.01, 1, (v) => v.toFixed(2)), K('rel', 'Release', 0.1, 4, 0.01, 1, (v) => v.toFixed(2))] }
    : { id: 'inst', title: 'VOCE', knobs: [
      K('tune', 'Tune', -12, 12, 0.5, 0, (v) => `${v > 0 ? '+' : ''}${v} st`), K('decay', 'Decay', 0.2, 2.5, 0.01, 1, (v) => `×${v.toFixed(2)}`)] };
  return [
    inst,
    { id: 'drv', title: 'DRIVE', power: ['drv'], knobs: [K('drv', 'Amount', 0, 1, 0.05, 0, pct)] },
    { id: 'crush', title: 'BIT CRUSH', power: ['crush'], knobs: [K('crush', 'Bit', 0, 12, 1, 0, (v) => (v < 4 ? 'OFF' : `${v} bit`))] },
    { id: 'eq', title: 'EQ', power: ['lo', 'hi'], graph: 'eq', knobs: [K('lo', 'Bassi', -12, 12, 0.5, 0, db), K('hi', 'Alti', -12, 12, 0.5, 0, db)] },
    { id: 'flt', title: 'FILTRO', power: ['flt'], graph: 'flt', knobs: [K('flt', 'LP ← → HP', -1, 1, 0.02, 0, (v) => (Math.abs(v) < 0.03 ? 'OFF' : v < 0 ? `LP ${hz(filterFreqs(v).lp)}` : `HP ${hz(filterFreqs(v).hp)}`))] },
    { id: 'cmp', title: 'COMPRESSORE', power: ['cmp'], knobs: [K('cmp', 'Amount', 0, 1, 0.05, 0, (v) => (v ? `${Math.round(-6 - 30 * v)} dB · ${(1.5 + 8.5 * v).toFixed(1)}:1` : 'OFF'))] },
    { id: 'send', title: 'MANDATE', power: ['rev', 'dly'], knobs: [K('rev', 'Riverbero', 0, 1, 0.01, 0, pct), K('dly', 'Delay', 0, 1, 0.01, 0, pct)] },
    { id: 'mix', title: 'MIXER', knobs: [K('vol', 'Volume', 0, 1, 0.01, 0.8, pct), K('pan', 'Pan', -1, 1, 0.05, 0, (v) => (Math.abs(v) < 0.03 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100)))] },
  ];
}

export function initFxChain(app, el, h) {
  const { state, engine } = app;
  const saved = new Map();       // valori prima dello spegnimento di un dispositivo: "canale|chiave" → valore
  let cur = 0, dev = [];

  const trOf = (p, i) => (h.isSynth(i) ? p.synth.tracks[i - 8] : p.tracks[i]);
  const tr = () => trOf(state.slots[state.slot], cur);

  /** Scrive il parametro in tutti i pattern e aggiorna il canale. */
  function set(k, v) {
    state.slots.forEach((p) => { trOf(p, cur)[k] = v; });
    engine.setChannel(h.channel(cur), tr());
  }

  function knobHTML(d) {
    const v = tr()[d.k] ?? d.def;
    return `<div class="kb" data-k="${d.k}"><span class="kb-l">${d.label}</span>
      <div class="kb-dial" role="slider" tabindex="0" aria-label="${d.label}" aria-valuemin="${d.min}" aria-valuemax="${d.max}" aria-valuenow="${v}"><i></i></div>
      <span class="kb-v">${d.fmt(v)}</span></div>`;
  }

  function render(i) {
    cur = i;
    dev = devices(h.isSynth(i));
    const t = tr();
    let instExtra = '';
    if (h.isSynth(i)) {
      const pr = t.patch && t.patch.wt ? t.patch : PRESETS[t.preset];
      instExtra = `<div class="dv-inst"><b>${esc(pr ? pr.name : t.preset)}</b><span><button class="btn sm" data-act="sound">SUONO</button><button class="btn sm wt" data-act="wt">WT</button></span></div>`;
    }
    el.style.setProperty('--tc', h.color(i));
    el.innerHTML = `<div class="fx-head"><b>${esc(h.short(i))}</b><i>${esc(h.name(i))}</i>
        <button class="btn sm${t.mute ? ' on' : ''}" data-ms="mute">M</button><button class="btn sm${t.solo ? ' on' : ''}" data-ms="solo">S</button>
        <button class="btn sm" data-act="notes">✎ NOTE</button></div>
      <div class="dv-chain">${dev.map((d) => {
        const on = !d.power || d.power.some((k) => (t[k] || 0) !== 0);
        return `<section class="dv${on ? '' : ' off'}" data-dev="${d.id}">
          <header>${d.power ? `<button class="dv-pw${on ? ' on' : ''}" data-pw="${d.id}" aria-pressed="${on}" aria-label="Accendi o spegni ${d.title}"></button>` : ''}<span>${d.title}</span></header>
          ${d.id === 'inst' ? instExtra : ''}
          ${d.graph ? `<canvas class="dv-graph" data-graph="${d.graph}"></canvas>` : ''}
          <div class="dv-knobs">${d.knobs.map(knobHTML).join('')}</div>
        </section>`;
      }).join('')}</div>`;
    $$('.kb', el).forEach(paintKnob);
    drawGraphs();
  }

  function knobDef(k) { for (const d of dev) for (const x of d.knobs) if (x.k === k) return x; return null; }
  function paintKnob(kb) {
    const d = knobDef(kb.dataset.k), v = tr()[d.k] ?? d.def;
    const f = (v - d.min) / (d.max - d.min);
    kb.querySelector('i').style.transform = `rotate(${-135 + f * 270}deg)`;
    kb.querySelector('.kb-dial').style.setProperty('--f', f);
    if (d.min < 0 && d.max > 0) kb.querySelector('.kb-dial').style.setProperty('--f0', -d.min / (d.max - d.min));
    kb.querySelector('.kb-dial').setAttribute('aria-valuenow', v);
    kb.querySelector('.kb-v').textContent = d.fmt(v);
  }

  function change(k, v) {
    const d = knobDef(k);
    v = clamp(Math.round(v / d.step) * d.step, d.min, d.max);
    v = +v.toFixed(4);
    if (k === 'crush') v = v < 4 ? 0 : Math.round(v);
    set(k, v);
    $$(`.kb[data-k="${k}"]`, el).forEach(paintKnob);
    // Interruttore del dispositivo segue i valori
    const dv = dev.find((x) => x.knobs.some((y) => y.k === k));
    if (dv && dv.power) {
      const on = dv.power.some((p) => (tr()[p] || 0) !== 0);
      const box = $(`[data-dev="${dv.id}"]`, el);
      box.classList.toggle('off', !on);
      const pw = $('.dv-pw', box);
      pw.classList.toggle('on', on); pw.setAttribute('aria-pressed', on);
    }
    if (dv && dv.graph) drawGraphs();
  }

  // ---------------------------------------------------------------
  // Manopole: trascinamento verticale, rotella, tastiera, doppio clic
  // ---------------------------------------------------------------
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    const dial = e.target.closest('.kb-dial');
    if (!dial) return;
    e.preventDefault();
    const k = dial.parentElement.dataset.k;
    app.snapshot();
    dial.setPointerCapture(e.pointerId);
    dial.focus();
    drag = { k, y: e.clientY, v: tr()[k] ?? knobDef(k).def };
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const d = knobDef(drag.k);
    const range = d.max - d.min, px = e.shiftKey ? 600 : 160;
    change(drag.k, drag.v + ((drag.y - e.clientY) / px) * range);
  });
  const end = () => { if (drag) { drag = null; app.save(); } };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', (e) => {
    const kb = e.target.closest('.kb');
    if (!kb) return;
    app.snapshot();
    change(kb.dataset.k, knobDef(kb.dataset.k).def);
    app.save();
  });
  el.addEventListener('wheel', (e) => {
    const kb = e.target.closest('.kb');
    if (!kb) return;
    e.preventDefault();
    const d = knobDef(kb.dataset.k);
    change(d.k, (tr()[d.k] ?? d.def) + Math.sign(-e.deltaY) * Math.max(d.step, (d.max - d.min) / 50));
    app.save();
  }, { passive: false });
  el.addEventListener('keydown', (e) => {
    const kb = e.target.closest('.kb');
    if (!kb || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const d = knobDef(kb.dataset.k), dir = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : -1;
    change(d.k, (tr()[d.k] ?? d.def) + dir * Math.max(d.step, (d.max - d.min) / 50));
    app.save();
  });

  el.addEventListener('click', (e) => {
    const pw = e.target.closest('[data-pw]');
    if (pw) {
      app.snapshot();
      const d = dev.find((x) => x.id === pw.dataset.pw), t = tr();
      const on = d.power.some((k) => (t[k] || 0) !== 0);
      for (const k of d.power) {
        const key = `${cur}|${k}`;
        if (on) { saved.set(key, t[k] || 0); set(k, 0); }
        else {
          // Riaccensione: valori precedenti o un valore udibile
          const def = { drv: 0.4, crush: 8, lo: 3, hi: 3, flt: -0.4, cmp: 0.5, rev: 0.25, dly: 0.2 }[k];
          set(k, saved.get(key) || def);
        }
      }
      app.save();
      render(cur);
      return;
    }
    const ms = e.target.closest('[data-ms]');
    if (ms) {
      app.snapshot();
      const k = ms.dataset.ms, v = !tr()[k];
      state.slots.forEach((p) => { trOf(p, cur)[k] = v; });
      app.save(); app.syncPlayback(); app.renderAll();
      return;
    }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'notes') h.setBottom('editor');
    if (a.dataset.act === 'sound') app.openLibrary();
    if (a.dataset.act === 'wt') app.openWave();
  });

  // ---------------------------------------------------------------
  // Curve di EQ e filtro (risposta in frequenza calcolata da un BiquadFilter)
  // ---------------------------------------------------------------
  const N = 120, freqs = new Float32Array(N);
  for (let i = 0; i < N; i++) freqs[i] = 20 * Math.pow(1000, i / (N - 1));
  let probe = null;
  function response(nodes) {
    const tot = new Float32Array(N).fill(0), mag = new Float32Array(N), ph = new Float32Array(N);
    for (const n of nodes) { n.getFrequencyResponse(freqs, mag, ph); for (let i = 0; i < N; i++) tot[i] += 20 * Math.log10(Math.max(1e-5, mag[i])); }
    return tot;
  }
  function drawGraphs() {
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!AC) return;
    if (!probe) probe = new AC(1, 128, 44100);
    const t = tr();
    $$('.dv-graph', el).forEach((cv) => {
      const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      if (!r.width) return;
      cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const W = r.width, H = r.height;
      g.fillStyle = '#12171b'; g.fillRect(0, 0, W, H);
      g.strokeStyle = '#262d33'; g.lineWidth = 1;
      for (const f of [100, 1000, 10000]) { const x = (Math.log10(f / 20) / 3) * W; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
      g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
      let nodes = [];
      if (cv.dataset.graph === 'eq') {
        const lo = probe.createBiquadFilter(); lo.type = 'lowshelf'; lo.frequency.value = 200; lo.gain.value = t.lo || 0;
        const hi = probe.createBiquadFilter(); hi.type = 'highshelf'; hi.frequency.value = 5000; hi.gain.value = t.hi || 0;
        nodes = [lo, hi];
      } else if (Math.abs(t.flt || 0) > 0.02) {
        const f = probe.createBiquadFilter(), fq = filterFreqs(t.flt);
        f.type = t.flt < 0 ? 'lowpass' : 'highpass'; f.frequency.value = t.flt < 0 ? fq.lp : fq.hp; f.Q.value = 1;
        nodes = [f];
      }
      const resp = nodes.length ? response(nodes) : new Float32Array(N);
      const range = 18;
      g.beginPath();
      for (let i = 0; i < N; i++) {
        const x = (i / (N - 1)) * W, y = H / 2 - (clamp(resp[i], -range, range) / range) * (H / 2 - 3);
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.strokeStyle = h.color(cur); g.lineWidth = 2; g.stroke();
      g.lineTo(W, H); g.lineTo(0, H); g.closePath();
      g.fillStyle = 'rgba(255,255,255,.06)'; g.fill();
    });
  }

  return { render, redraw: drawGraphs };
}
