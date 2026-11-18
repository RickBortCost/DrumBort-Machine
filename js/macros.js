/**
 * macros.js — 4 macro di progetto (come i rack delle DAW): ogni macro muove insieme più
 * parametri di tracce, effetti o master, ciascuno nel proprio intervallo.
 *
 * state.macros = [{ name, v (0..1), map: [{ t: bersaglio, a: valore a 0, b: valore a 1 }] }] × 4
 * Bersagli: d0..d7.<param> (batteria), s0..s3.<param> (synth), fx.<param> (master).
 * La macro scrive i parametri nel pattern in riproduzione (in session: la clip di quella traccia),
 * quindi il risultato vale anche per l'export e per il motore desktop.
 */

import { SYNTH_TRACKS } from './synth.js';
import { LEGACY_KEYS, quickSet } from './devices.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const $$mc = () => [...document.querySelectorAll('#macroKnobs .mc')];

/** Parametri controllabili: [etichetta, min, max]. */
export const MACRO_PARAMS = {
  vol: ['Volume', 0, 1], pan: ['Pan', -1, 1], rev: ['Riverbero', 0, 1], dly: ['Delay', 0, 1],
  drv: ['Drive', 0, 1], flt: ['Filtro', -1, 1], lo: ['EQ basse', -12, 12], hi: ['EQ alte', -12, 12], cmp: ['Compressore', 0, 1],
  tune: ['Tune', -12, 12], decay: ['Decay', 0.2, 2.5],
  cut: ['Cutoff', -1, 1], res: ['Risonanza', -1, 1], env: ['Inviluppo filtro', 0, 2], pos: ['Posizione wavetable', -1, 1],
};
const DRUM = ['vol', 'pan', 'tune', 'decay', 'rev', 'dly', 'drv', 'flt', 'lo', 'hi', 'cmp'];
const SYN = ['vol', 'pan', 'cut', 'res', 'env', 'pos', 'rev', 'dly', 'drv', 'flt', 'lo', 'hi', 'cmp'];
const FX = { filter: ['Filtro master', -1, 1], rev: ['Riverbero master', 0, 1], dly: ['Delay master', 0, 1], sc: ['Sidechain', 0, 1], master: ['Volume master', 0, 1] };

export const defaultMacros = () => [1, 2, 3, 4].map((i) => ({ name: `MACRO ${i}`, v: 0, map: [] }));

export function normalizeMacros(o) {
  const d = defaultMacros();
  if (!Array.isArray(o)) return d;
  return d.map((m, i) => {
    const s = o[i] || {};
    return {
      name: typeof s.name === 'string' && s.name.trim() ? s.name.slice(0, 16) : m.name,
      v: clamp(+s.v || 0, 0, 1),
      map: (Array.isArray(s.map) ? s.map : []).filter((x) => x && typeof x.t === 'string' && isFinite(x.a) && isFinite(x.b)).slice(0, 8)
        .map((x) => ({ t: x.t, a: +x.a, b: +x.b })),
    };
  });
}

/** Informazioni sul bersaglio: etichetta, intervallo. */
export function targetInfo(t, kit) {
  const [who, p] = t.split('.');
  if (who === 'fx') return FX[p] ? { label: FX[p][0], min: FX[p][1], max: FX[p][2] } : null;
  const P = MACRO_PARAMS[p];
  if (!P) return null;
  const name = who[0] === 'd' ? kit.tracks[+who.slice(1)].short : SYNTH_TRACKS[+who.slice(1)].short;
  return { label: `${name} · ${P[0]}`, min: P[1], max: P[2] };
}

export function initMacros(app) {
  const { state, engine } = app;
  let sel = 0;

  /** Traccia (oggetto dei parametri) per il bersaglio, nel pattern in riproduzione. */
  function trackOf(who) {
    const isS = who[0] === 's', idx = +who.slice(1);
    const p = app.trackPattern(isS ? 8 + idx : idx);
    return { tr: isS ? p.synth.tracks[idx] : p.tracks[idx], ch: isS ? 8 + idx : idx, p };
  }

  /** Applica il valore della macro i ai suoi parametri. */
  function apply(i) {
    const m = state.macros[i];
    let fx = null;
    for (const x of m.map) {
      const v = x.a + (x.b - x.a) * m.v;
      const [who, p] = x.t.split('.');
      if (who === 'fx') { fx = fx || {}; fx[p] = v; state.fx[p] = v; continue; }
      const { tr, ch } = trackOf(who);
      if (LEGACY_KEYS.includes(p)) { quickSet(state.devs[ch], p, v); engine.setDevices(ch, state.devs[ch]); continue; }
      tr[p] = p === 'tune' ? Math.round(v) : +v.toFixed(3);
      engine.setChannel(ch, tr);
    }
    if (fx) engine.setFx(fx, null);
  }

  // ---------------------------------------------------------------
  // Foglio
  // ---------------------------------------------------------------
  function targetOptions() {
    const kit = app.kitOf(app.pat());
    const g = (label, items) => `<optgroup label="${esc(label)}">${items.map(([v, n]) => `<option value="${v}">${esc(n)}</option>`).join('')}</optgroup>`;
    return kit.tracks.map((t, i) => g(`${t.short} · ${t.name}`, DRUM.map((p) => [`d${i}.${p}`, MACRO_PARAMS[p][0]]))).join('')
      + SYNTH_TRACKS.map((t, k) => g(`${t.short} · ${t.name}`, SYN.map((p) => [`s${k}.${p}`, MACRO_PARAMS[p][0]]))).join('')
      + g('Master', Object.entries(FX).map(([k, v]) => [`fx.${k}`, v[0]]));
  }

  function render() { renderKnobs(); renderMap(); }
  function renderKnobs() {
    $('#macroKnobs').innerHTML = state.macros.map((m, i) => `
      <div class="mc${i === sel ? ' sel' : ''}" data-mi="${i}">
        <input class="mc-name" data-mname="${i}" value="${esc(m.name)}" maxlength="16" aria-label="Nome macro ${i + 1}">
        <input type="range" min="0" max="1" step="0.005" value="${m.v}" data-mv="${i}" aria-label="${esc(m.name)}">
        <b>${Math.round(m.v * 100)}</b>
        <small>${m.map.length ? `${m.map.length} parametri` : 'nessun parametro'}</small>
      </div>`).join('');
  }
  function renderMap() {
    const kit = app.kitOf(app.pat());
    $$mc().forEach((x) => x.classList.toggle('sel', +x.dataset.mi === sel));
    const m = state.macros[sel];
    $('#macroMapTitle').textContent = `${m.name}: parametri collegati`;
    $('#macroMap').innerHTML = m.map.map((x, j) => {
      const info = targetInfo(x.t, kit);
      return `<div class="mc-row"><span>${esc(info ? info.label : x.t)}</span>
        <label>da <input type="number" step="any" value="${x.a}" data-ma="${j}"></label>
        <label>a <input type="number" step="any" value="${x.b}" data-mb="${j}"></label>
        <button class="btn sm" data-mdel="${j}" aria-label="Scollega">✕</button></div>`;
    }).join('') || '<small class="hint">Scegli un parametro qui sotto e premi COLLEGA.</small>';
  }

  $('#macroTarget').innerHTML = targetOptions();
  $('#macroSheet').addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.mv !== undefined) {
      const i = +t.dataset.mv;
      state.macros[i].v = +t.value;
      t.nextElementSibling.textContent = Math.round(state.macros[i].v * 100);
      apply(i);
      app.save();
      app.renderParams();
    } else if (t.dataset.mname !== undefined) {
      state.macros[+t.dataset.mname].name = t.value.slice(0, 16) || `MACRO ${+t.dataset.mname + 1}`;
      app.save();
    }
  });
  $('#macroSheet').addEventListener('change', (e) => {
    const t = e.target, m = state.macros[sel];
    if (t.dataset.ma !== undefined) m.map[+t.dataset.ma].a = +t.value;
    else if (t.dataset.mb !== undefined) m.map[+t.dataset.mb].b = +t.value;
    else return;
    apply(sel); app.save();
  });
  // Selezione della macro da modificare (senza ridisegnare i cursori in uso)
  const pick = (e) => {
    const c = e.target.closest('[data-mi]');
    if (c && +c.dataset.mi !== sel) { sel = +c.dataset.mi; renderMap(); }
  };
  $('#macroSheet').addEventListener('pointerdown', pick);
  $('#macroSheet').addEventListener('focusin', pick);
  $('#macroSheet').addEventListener('click', (e) => {
    const m = state.macros[sel];
    const del = e.target.closest('[data-mdel]');
    if (del) { m.map.splice(+del.dataset.mdel, 1); app.save(); render(); return; }
    if (e.target.closest('[data-mact="link"]')) {
      const t = $('#macroTarget').value, kit = app.kitOf(app.pat()), info = targetInfo(t, kit);
      if (!info || m.map.some((x) => x.t === t) || m.map.length >= 8) { app.toast(m.map.length >= 8 ? 'Massimo 8 parametri per macro' : 'Parametro già collegato'); return; }
      // Intervallo iniziale: dal valore attuale al massimo (o al minimo se già al massimo)
      const [who, p] = t.split('.');
      const cur = who === 'fx' ? state.fx[p] : trackOf(who).tr[p];
      const a = cur ?? info.min, b = Math.abs(info.max - a) > 1e-6 ? info.max : info.min;
      m.map.push({ t, a: +(+a).toFixed(3), b });
      app.save(); render();
    }
  });

  return {
    open() { $('#macroTarget').innerHTML = targetOptions(); render(); app.openSheet('macroSheet'); },
    apply,
  };
}
