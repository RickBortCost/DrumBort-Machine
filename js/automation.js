/**
 * automation.js — Automazione disegnabile per step (stile DAW).
 *
 * pattern.auto = { "<bersaglio>": [valore 0..1 | null] × step del pattern }
 *   d0..d7.(vol|pan|tune|decay|rev|dly)   tracce di batteria
 *   s0..s3.(vol|pan|cut|res|rev|dly)      tracce synth
 *   fx.filter                             filtro master (LP ← → HP)
 * Uno step senza valore usa il parametro della traccia. Lo stesso formato è letto dal motore C#.
 */

import { SYNTH_TRACKS } from './synth.js';

const $ = (sel, root = document) => root.querySelector(sel);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Parametri automatizzabili: valore reale dal valore normalizzato (e viceversa). */
export const PARAMS = {
  vol: { label: 'Volume', to: (v) => v, from: (x) => x },
  pan: { label: 'Pan', to: (v) => v * 2 - 1, from: (x) => (x + 1) / 2 },
  tune: { label: 'Tune', to: (v) => Math.round(v * 24 - 12), from: (x) => (x + 12) / 24 },
  decay: { label: 'Decay', to: (v) => 0.2 + v * 2.3, from: (x) => (x - 0.2) / 2.3 },
  rev: { label: 'Riverbero', to: (v) => v, from: (x) => x },
  dly: { label: 'Delay', to: (v) => v, from: (x) => x },
  cut: { label: 'Cutoff', to: (v) => v * 2 - 1, from: (x) => (x + 1) / 2 },
  res: { label: 'Risonanza', to: (v) => v * 2 - 1, from: (x) => (x + 1) / 2 },
  filter: { label: 'Filtro master', to: (v) => v * 2 - 1, from: (x) => (x + 1) / 2 },
};
const DRUM_P = ['vol', 'pan', 'tune', 'decay', 'rev', 'dly'];
const SYN_P = ['vol', 'pan', 'cut', 'res', 'rev', 'dly'];
const MIX = ['vol', 'pan', 'rev', 'dly'];

/** Valore automatizzato del parametro allo step s (o undefined). */
const at = (pat, key, s) => {
  const lane = pat.auto && pat.auto[key];
  const v = lane ? lane[s % lane.length] : null;
  return v == null ? undefined : v;
};

/** Parametri della traccia di batteria t allo step s, con l'automazione di tune e decay. */
export function drumParams(pat, t, s, base) {
  if (!pat.auto) return base;
  const tune = at(pat, `d${t}.tune`, s), decay = at(pat, `d${t}.decay`, s);
  if (tune === undefined && decay === undefined) return base;
  return { ...base, ...(tune !== undefined ? { tune: PARAMS.tune.to(tune) } : {}), ...(decay !== undefined ? { decay: PARAMS.decay.to(decay) } : {}) };
}

/** Parametri della traccia synth k allo step s, con l'automazione di cutoff e risonanza. */
export function synthParams(pat, k, s, base) {
  if (!pat.auto) return base;
  const cut = at(pat, `s${k}.cut`, s), res = at(pat, `s${k}.res`, s);
  if (cut === undefined && res === undefined) return base;
  return { ...base, ...(cut !== undefined ? { cut: PARAMS.cut.to(cut) } : {}), ...(res !== undefined ? { res: PARAMS.res.to(res) } : {}) };
}

/**
 * Mixer e filtro master allo step (chiamato dallo scheduler a ogni tick).
 * Il motore viene aggiornato solo quando il valore effettivo cambia.
 */
export function applyAuto(engine, pat, tick, time) {
  if (!pat.auto || !engine.setChannel) return;
  const last = engine._autoLast || (engine._autoLast = {});
  const has = Object.keys(pat.auto);
  if (!has.length && !engine._autoActive) return;
  engine._autoActive = has.length > 0;
  const chan = (i, key, base, len) => {
    const s = tick % (len || 16);
    const eff = {};
    let any = false;
    for (const p of MIX) {
      const v = at(pat, `${key}.${p}`, s);
      eff[p] = v === undefined ? base[p] : PARAMS[p].to(v);
      if (v !== undefined) any = true;
    }
    const sig = `${eff.vol}|${eff.pan}|${eff.rev}|${eff.dly}`;
    // Nessuna automazione e nessun valore applicato in precedenza: il mixer resta com'è
    if (!any && last[i] === undefined) return;
    if (last[i] === sig) return;
    last[i] = any ? sig : undefined;
    engine.setChannel(i, { ...base, ...eff }, time);
  };
  pat.tracks.forEach((tr, t) => chan(t, `d${t}`, tr, tr.len));
  if (pat.synth) pat.synth.tracks.forEach((tr, k) => chan(8 + k, `s${k}`, tr, tr.len));
  const f = at(pat, 'fx.filter', tick % (pat.steps[0] ? pat.steps[0].length : 16));
  const fv = f === undefined ? null : PARAMS.filter.to(f);
  if (fv !== (last.fx ?? null) && engine.setFilterAt) {
    last.fx = fv;
    engine.setFilterAt(fv, time);
  }
}

/** Elenco dei bersagli per il selettore (con i nomi delle tracce del kit). */
export function targets(kit) {
  const out = [];
  kit.tracks.forEach((tr, t) => DRUM_P.forEach((p) => out.push({ key: `d${t}.${p}`, group: `${tr.short} · ${tr.name}`, label: PARAMS[p].label })));
  SYNTH_TRACKS.forEach((tr, k) => SYN_P.forEach((p) => out.push({ key: `s${k}.${p}`, group: `${tr.short} · ${tr.name}`, label: PARAMS[p].label })));
  out.push({ key: 'fx.filter', group: 'Master', label: PARAMS.filter.label });
  return out;
}

/** Valore base (normalizzato) del bersaglio, per disegnare la linea di riferimento. */
function baseValue(pat, fx, key) {
  const [who, p] = key.split('.');
  let x;
  if (who === 'fx') x = fx.filter;
  else if (who[0] === 'd') x = pat.tracks[+who.slice(1)][p];
  else x = pat.synth.tracks[+who.slice(1)][p];
  return clamp(PARAMS[p].from(x ?? 0), 0, 1);
}

// =====================================================================
// Editor
// =====================================================================

export function initAutomation(app) {
  const { state } = app;
  const cv = $('#autoCanvas');
  let key = 'd0.vol', drawing = null;

  const N = () => app.pat().steps[0].length;
  const lane = (create = false) => {
    const p = app.pat();
    if (!p.auto) p.auto = {};
    if (!p.auto[key] && create) p.auto[key] = new Array(N()).fill(null);
    return p.auto[key];
  };

  function buildSelect() {
    const list = targets(app.kitOf(app.pat()));
    const groups = [...new Set(list.map((t) => t.group))];
    const used = new Set(Object.keys(app.pat().auto || {}).filter((k) => (app.pat().auto[k] || []).some((v) => v != null)));
    $('#autoTarget').innerHTML = groups.map((g) => `<optgroup label="${g}">${list.filter((t) => t.group === g)
      .map((t) => `<option value="${t.key}">${used.has(t.key) ? '● ' : ''}${t.label}</option>`).join('')}</optgroup>`).join('');
    $('#autoTarget').value = key;
    $('#autoUsed').innerHTML = [...used].map((k) => {
      const t = list.find((x) => x.key === k);
      return t ? `<button class="btn sm${k === key ? ' on' : ''}" data-akey="${k}">${t.group.split(' · ')[0]} ${t.label}</button>` : '';
    }).join('') || '<small class="hint">Nessuna corsia automatizzata in questo pattern.</small>';
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1, r = cv.getBoundingClientRect();
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = r.width, H = r.height, n = N(), cw = W / n, l = lane();
    g.fillStyle = '#1b2025'; g.fillRect(0, 0, W, H);
    for (let s = 0; s < n; s++) {
      g.fillStyle = s % 16 === 0 ? '#0b0e10' : s % 4 === 0 ? '#151a1e' : '#232a30';
      g.fillRect(s * cw, 0, s % 16 === 0 ? 2 : 1, H);
    }
    // Valore base della traccia
    const b = baseValue(app.pat(), state.fx, key);
    g.strokeStyle = 'rgba(203,213,220,.35)'; g.setLineDash([4, 4]);
    g.beginPath(); g.moveTo(0, H - b * H); g.lineTo(W, H - b * H); g.stroke(); g.setLineDash([]);
    // Valori
    if (l) {
      for (let s = 0; s < n; s++) {
        const v = l[s];
        if (v == null) continue;
        g.fillStyle = 'rgba(255,155,61,.35)';
        g.fillRect(s * cw + 2, H - v * H, cw - 4, v * H);
        g.fillStyle = '#ff9b3d';
        g.fillRect(s * cw + 2, H - v * H - 2, cw - 4, 4);
      }
    }
    const [who, p] = key.split('.');
    $('#autoInfo').textContent = `${PARAMS[p].label}${who === 'fx' ? '' : ` · traccia ${who[0] === 'd' ? 'batteria' : 'synth'} ${+who.slice(1) + 1}`} — linea tratteggiata: valore della traccia`;
  }

  function paint(e) {
    const r = cv.getBoundingClientRect(), n = N();
    const s = clamp(Math.floor(((e.clientX - r.left) / r.width) * n), 0, n - 1);
    const v = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
    const l = lane(true);
    if (drawing.erase) l[s] = null;
    else {
      // Trascinando veloce si riempiono gli step saltati (linea continua)
      if (drawing.s != null && Math.abs(s - drawing.s) > 1) {
        const d = s > drawing.s ? 1 : -1;
        for (let i = drawing.s + d; i !== s; i += d) l[i] = +(drawing.v + ((v - drawing.v) * (i - drawing.s)) / (s - drawing.s)).toFixed(3);
      }
      l[s] = +v.toFixed(3);
    }
    drawing.s = s; drawing.v = v;
    draw();
  }

  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (drawing) return;           // un dito solo disegna la curva
    cv.setPointerCapture(e.pointerId);
    app.snapshot();
    drawing = { pid: e.pointerId, erase: e.button === 2 || e.altKey || $('[data-auto="erase"]').classList.contains('on'), s: null, v: 0 };
    paint(e);
  });
  cv.addEventListener('pointermove', (e) => { if (drawing && e.pointerId === drawing.pid) paint(e); });
  const end = (e) => {
    if (!drawing || e.pointerId !== drawing.pid) return;
    drawing = null;
    const p = app.pat();
    if (p.auto && p.auto[key] && p.auto[key].every((v) => v == null)) delete p.auto[key];
    app.save(); buildSelect();
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('contextmenu', (e) => e.preventDefault());

  $('#autoTarget').addEventListener('change', (e) => { key = e.target.value; buildSelect(); draw(); });
  $('#autoSheet').addEventListener('click', (e) => {
    const k = e.target.closest('[data-akey]');
    if (k) { key = k.dataset.akey; buildSelect(); draw(); return; }
    const b = e.target.closest('[data-auto]');
    if (!b) return;
    const p = app.pat();
    if (b.dataset.auto === 'erase') { app.setToggle(b, !b.classList.contains('on')); return; }
    app.snapshot();
    if (b.dataset.auto === 'clear' && p.auto) delete p.auto[key];
    if (b.dataset.auto === 'ramp') { const n = N(); p.auto = p.auto || {}; p.auto[key] = Array.from({ length: n }, (_, s) => +(s / (n - 1)).toFixed(3)); }
    if (b.dataset.auto === 'base') { const n = N(), v = baseValue(p, state.fx, key); p.auto = p.auto || {}; p.auto[key] = new Array(n).fill(+v.toFixed(3)); }
    app.save(); buildSelect(); draw();
  });
  window.addEventListener('resize', () => { if (!$('#autoSheet').hidden) draw(); });

  return {
    open(k) {
      if (k) key = k;
      buildSelect();
      app.openSheet('autoSheet');
      requestAnimationFrame(draw);
    },
  };
}
