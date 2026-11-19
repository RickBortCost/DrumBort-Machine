/**
 * presetplayer.js — Preset Player (stile ROMpler, come Nexus) per telefono e browser.
 * Stessi dati dell'app per PC: track.preset, parametri della traccia (macro), track.arp e trance
 * gate come automazione del volume per step (pattern.auto["s<k>.vol"]). Collegato al PC, ogni
 * modifica arriva al motore e alla finestra Preset Player dell'app per Windows.
 *
 * Si applica come strumento a una traccia synth, anche vuota (la traccia viene attivata).
 */

import { categories, PRESETS } from './presets.js';
import { SYNTH_TRACKS, isChordTrack, diatonicChord } from './synth.js';
import { trackBase } from './synthpattern.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MACROS = [
  ['cut', 'CUTOFF', -1, 1, 0], ['res', 'RESO', -1, 1, 0], ['env', 'FILTER ENV', 0, 2, 1], ['atk', 'ATTACK', 0.1, 4, 1],
  ['dec', 'DECAY', 0.25, 3, 1], ['rel', 'RELEASE', 0.1, 4, 1], ['lfo', 'LFO DEPTH', 0, 2, 1], ['rate', 'LFO RATE', 0.25, 4, 1],
  ['rev', 'REVERB', 0, 1, 0], ['dly', 'DELAY', 0, 1, 0], ['vol', 'VOLUME', 0, 1, 0.7],
];
const GATES = [['1/8', '1010101010101010'], ['1/4', '1000100010001000'], ['Offbeat', '0010001000100010'], ['Trance', '1011101010111010'], ['Sincopi', '1001001010010010'], ['Pump', '0111011101110111']];
const MODES = [['up', 'Su'], ['down', 'Giù'], ['updown', 'Su-giù'], ['random', 'Casuale']];
const RATES = [[0.5, '1/32'], [1, '1/16'], [2, '1/8'], [4, '1/4']];

/**
 * @param {object} app { engine, state, pat, snapshot, save, openSheet, setToggle, toast, remoteOp, syncPlayback, renderAll }
 */
export function initPresetPlayer(app) {
  const { engine, state } = app;
  const sheet = $('#ppSheet');
  const body = $('#ppBody');
  let k = 0, cat = 'Tutti', q = '', pending = '';
  let gate = '1010101010101010', depth = 0.85;

  const favs = () => state.favs || (state.favs = []);
  const active = (kk = k) => !Array.isArray(state.tracks) || state.tracks.includes(8 + kk);
  const tr = (p = app.pat()) => p.synth.tracks[k];
  const linked = () => active() && !tr().patch;
  const current = () => (linked() ? tr().preset : pending || tr().preset);
  const all = () => Object.entries(PRESETS).filter(([id]) => !id.startsWith('up:') || true)
    .map(([id, p]) => ({ id, name: p.name || id, cat: p.cat || 'Altro', tags: p.tags || [] }));
  const filtered = () => all().filter((p) => (cat === 'Tutti' || (cat === '★' ? favs().includes(p.id) : p.cat === cat))
    && (!q || `${p.name} ${p.cat} ${p.tags.join(' ')}`.toLowerCase().includes(q)));

  /** Cambia la traccia in tutti i pattern e la sincronizza (motore, PC, altri telefoni). */
  function commit(fn, { snapshot = true } = {}) {
    if (snapshot) app.snapshot();
    fn();
    app.syncPlayback();
    app.save();
    app.renderAll();
  }
  function activate() {
    if (active()) return;
    state.tracks.push(8 + k);
    state.tracks.sort((a, b) => a - b);
    state.slots.forEach((p) => { p.synth.tracks[k].mute = false; });
  }

  function apply(id) {
    pending = id;
    commit(() => {
      activate();
      state.slots.forEach((p) => { const t = p.synth.tracks[k]; t.preset = id; delete t.patch; });
    });
    render();
    preview();
  }
  function pick(id) { pending = id; if (linked()) apply(id); else render(); }
  function step(d) {
    const l = filtered();
    if (!l.length) return;
    const i = l.findIndex((p) => p.id === current());
    pick(l[((i < 0 ? 0 : i + d) % l.length + l.length) % l.length].id);
  }

  function preview() {
    if (!linked()) return;
    const syn = app.pat().synth, base = trackBase(syn, k);
    const notes = isChordTrack(k) ? diatonicChord(base, syn.key, syn.scale, 'triad').map((x) => base + x) : [base];
    if (engine.ctx) engine.playSynth(k, engine.ctx.currentTime + 0.02, 0.9, notes, 0.85, tr());
    if (app.remoteOp) app.remoteOp('prev', { k, notes });
  }

  // ----- Trance gate: automazione del volume sul pattern corrente (o su tutti)
  const gateKey = () => `s${k}.vol`;
  function writeGate(allPatterns) {
    commit(() => {
      (allPatterns ? state.slots : [app.pat()]).forEach((p) => {
        const vol = p.synth.tracks[k].vol ?? 0.7, n = 16 * (p.bars || 1);
        p.auto = p.auto || {};
        p.auto[gateKey()] = Array.from({ length: n }, (_, s) => +(gate[s % 16] === '1' ? vol : vol * (1 - depth)).toFixed(3));
      });
    });
    render();
  }
  function clearGate(allPatterns) {
    commit(() => { (allPatterns ? state.slots : [app.pat()]).forEach((p) => { if (p.auto) delete p.auto[gateKey()]; }); });
    render();
  }

  // ----- Disegno
  function render() {
    const cur = current(), info = PRESETS[cur], t = tr(), on = linked();
    const lane = app.pat().auto && app.pat().auto[gateKey()];
    const arp = t.arp || {};
    const cats = ['Tutti', '★', ...categories()];
    body.innerHTML = `
      <div class="seg pp-tracks" role="group" aria-label="Traccia">${SYNTH_TRACKS.map((s, i) => `<button class="btn sm${i === k ? ' on' : ''}${active(i) ? '' : ' empty'}" data-k="${i}" aria-pressed="${i === k}">${esc(s.short)}${active(i) ? '' : ' ·vuota'}</button>`).join('')}</div>
      <div class="pp-lcd">
        <button class="btn pp-nav" data-step="-1" aria-label="Preset precedente">◀</button>
        <div class="pp-screen"><b>${esc(info ? info.name : 'Scegli un preset')}</b><small>${esc(info ? `${(info.cat || '').toUpperCase()} · ${(info.tags || []).join(' · ')}` : '')}</small></div>
        <button class="btn pp-nav" data-step="1" aria-label="Preset successivo">▶</button>
      </div>
      <div class="pp-actions">
        ${on ? '<span class="pp-linked">✓ Collegata: il preset scelto suona subito</span>' : `<button class="btn on" data-act="pp-apply">APPLICA A ${esc(SYNTH_TRACKS[k].short)}</button>`}
        <button class="btn" data-act="pp-play" ${on ? '' : 'disabled'}>▶ ASCOLTA</button>
      </div>
      <div class="pp-cats">${cats.map((c) => `<button class="btn sm chip-cat${c === cat ? ' on' : ''}" data-cat="${esc(c)}">${esc(c === '★' ? '★ Preferiti' : c)}</button>`).join('')}</div>
      <input type="search" class="pp-search" placeholder="Cerca suono o tag" value="${esc(q)}" aria-label="Cerca">
      <div class="pp-list">${filtered().map((p) => `<div class="pp-item${p.id === cur ? ' on' : ''}" data-id="${esc(p.id)}" role="button" tabindex="0">
        <span><b>${esc(p.name)}</b><small>${esc(p.cat)}${p.tags.length ? ' · ' + esc(p.tags.slice(0, 3).join(', ')) : ''}</small></span>
        <button class="pp-fav${favs().includes(p.id) ? ' on' : ''}" data-fav="${esc(p.id)}" aria-label="Preferito">${favs().includes(p.id) ? '★' : '☆'}</button></div>`).join('') || '<p class="hint">Nessun preset.</p>'}</div>
      ${on ? `
      <div class="lock-title">MACRO</div>
      <div class="pp-macros">${MACROS.map(([key, label, min, max, def]) => {
        const v = t[key] ?? def;
        return `<label class="row-ctl"><small>${label}</small><input type="range" data-m="${key}" min="${min}" max="${max}" step="0.01" value="${v}" aria-label="${label}"><output>${(+v).toFixed(2)}</output></label>`;
      }).join('')}</div>
      <div class="lock-title">ARPEGGIATORE</div>
      <div class="pp-row"><button class="btn sm${arp.on ? ' on' : ''}" data-arp="on">${arp.on ? 'ARP ON' : 'ARP OFF'}</button></div>
      <div class="pp-row seg">${MODES.map(([m, l]) => `<button class="btn sm${(arp.mode || 'up') === m ? ' on' : ''}" data-arp="mode" data-v="${m}">${l}</button>`).join('')}</div>
      <div class="pp-row seg">${RATES.map(([r, l]) => `<button class="btn sm${(arp.rate ?? 1) === r ? ' on' : ''}" data-arp="rate" data-v="${r}">${l}</button>`).join('')}</div>
      <div class="pp-row seg">${[1, 2, 3].map((o) => `<button class="btn sm${(arp.oct || 1) === o ? ' on' : ''}" data-arp="oct" data-v="${o}">${o} ott.</button>`).join('')}</div>
      <label class="row-ctl"><small>GATE</small><input type="range" data-arpgate min="0.1" max="1" step="0.01" value="${arp.gate ?? 0.6}"><output>${Math.round((arp.gate ?? 0.6) * 100)}%</output></label>
      <div class="lock-title">TRANCE GATE ${lane ? '· ON' : '· OFF'}</div>
      <div class="pp-gate">${[...gate].map((b, i) => `<button class="pp-g${b === '1' ? ' on' : ''}" data-g="${i}" aria-label="Step ${i + 1}" aria-pressed="${b === '1'}"></button>`).join('')}</div>
      <div class="pp-row seg">${GATES.map(([n, g]) => `<button class="btn sm${g === gate ? ' on' : ''}" data-gp="${g}">${n}</button>`).join('')}</div>
      <label class="row-ctl"><small>DEPTH</small><input type="range" data-depth min="0" max="1" step="0.01" value="${depth}"><output>${Math.round(depth * 100)}%</output></label>
      <div class="pp-row"><button class="btn sm${lane ? ' on' : ''}" data-gate="toggle">${lane ? 'GATE ON' : 'GATE OFF'}</button><button class="btn sm" data-gate="all">SU TUTTI I PATTERN</button></div>` : '<p class="hint">Applica il preset per suonarlo e usare macro, arpeggiatore e trance gate.</p>'}`;
  }

  function readGate() {
    const lane = app.pat().auto && app.pat().auto[gateKey()];
    if (!lane || !lane.length) return;
    const hi = Math.max(...lane), lo = Math.min(...lane);
    gate = Array.from({ length: 16 }, (_, i) => (lane[i % lane.length] >= hi - 1e-6 ? '1' : '0')).join('');
    if (hi > 0) depth = +(1 - lo / hi).toFixed(2);
  }

  // ----- Eventi
  body.addEventListener('click', (e) => {
    const b = e.target.closest('button, .pp-item');
    if (!b) return;
    if (b.dataset.k !== undefined) { k = +b.dataset.k; pending = ''; readGate(); render(); return; }
    if (b.dataset.step) { step(+b.dataset.step); return; }
    if (b.dataset.cat) { cat = b.dataset.cat; render(); return; }
    if (b.dataset.fav) {
      const f = favs(), id = b.dataset.fav, i = f.indexOf(id);
      if (i >= 0) f.splice(i, 1); else f.push(id);
      app.save(); render(); return;
    }
    if (b.classList.contains('pp-item')) { pick(b.dataset.id); return; }
    if (b.dataset.act === 'pp-apply') { apply(current() || all()[0].id); return; }
    if (b.dataset.act === 'pp-play') { preview(); return; }
    if (b.dataset.arp) {
      const key = b.dataset.arp, v = key === 'on' ? !(tr().arp && tr().arp.on) : key === 'mode' ? b.dataset.v : +b.dataset.v;
      commit(() => state.slots.forEach((p) => { const t = p.synth.tracks[k]; t.arp = { on: false, mode: 'up', rate: 1, oct: 1, gate: 0.6, src: 2, ...(t.arp || {}), [key]: v }; }));
      render(); return;
    }
    if (b.dataset.g !== undefined) {
      const i = +b.dataset.g;
      gate = gate.slice(0, i) + (gate[i] === '1' ? '0' : '1') + gate.slice(i + 1);
      if (app.pat().auto && app.pat().auto[gateKey()]) writeGate(false); else render();
      return;
    }
    if (b.dataset.gp) { gate = b.dataset.gp; writeGate(false); return; }
    if (b.dataset.gate === 'toggle') { if (app.pat().auto && app.pat().auto[gateKey()]) clearGate(false); else writeGate(false); return; }
    if (b.dataset.gate === 'all') writeGate(true);
  });

  let gesture = false;
  body.addEventListener('input', (e) => {
    const el = e.target;
    if (el.classList.contains('pp-search')) {
      q = el.value.trim().toLowerCase();
      const pos = el.selectionStart;
      render();
      const s = $('.pp-search', body); s.focus(); s.setSelectionRange(pos, pos);
      return;
    }
    const out = el.parentElement.querySelector('output');
    if (el.dataset.m) {
      if (!gesture) { app.snapshot(); gesture = true; }
      const key = el.dataset.m, v = +el.value;
      state.slots.forEach((p) => { p.synth.tracks[k][key] = v; });
      if (out) out.textContent = v.toFixed(2);
      app.syncPlayback(); app.save();
    } else if (el.dataset.arpgate !== undefined) {
      if (!gesture) { app.snapshot(); gesture = true; }
      const v = +el.value;
      state.slots.forEach((p) => { const t = p.synth.tracks[k]; t.arp = { on: false, mode: 'up', rate: 1, oct: 1, src: 2, ...(t.arp || {}), gate: v }; });
      if (out) out.textContent = `${Math.round(v * 100)}%`;
      app.syncPlayback(); app.save();
    } else if (el.dataset.depth !== undefined) {
      depth = +el.value;
      if (out) out.textContent = `${Math.round(depth * 100)}%`;
    }
  });
  body.addEventListener('change', (e) => {
    gesture = false;
    if (e.target.dataset.depth !== undefined && app.pat().auto && app.pat().auto[gateKey()]) writeGate(false);
    if (e.target.dataset.m) app.renderAll();
  });
  sheet.addEventListener('keydown', (e) => {
    if (e.target.closest('input')) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { step(1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { step(-1); e.preventDefault(); }
  });

  return {
    open(track = 0) {
      k = Math.max(0, Math.min(3, track | 0));
      pending = '';
      readGate();
      render();
      app.openSheet('ppSheet');
    },
    /** Aggiornamento dall'esterno (PC collegato, annulla): ridisegna se aperto. */
    refresh() { if (!sheet.hidden) { readGate(); render(); } },
  };
}
