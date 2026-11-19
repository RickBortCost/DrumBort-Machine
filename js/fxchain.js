/**
 * fxchain.js — Vista dei device della traccia selezionata, come la Device View di Ableton Live.
 *
 *   [Strumento/Voce] → device audio (ordine libero, da sinistra a destra) → [Mixer: volume, pan, mandate]
 *
 * Ogni device ha la barra del titolo con l'attivatore (acceso/spento: spento = segnale invariato),
 * il nome, il pulsante per piegarlo e il menu (anche con il tasto destro): Rinomina, Duplica,
 * Copia, Incolla, Ripristina valori, Piega, Elimina.
 *   • Aggiungere: trascina un effetto dal browser (scheda EFFETTI) nel punto voluto, doppio clic
 *     sull'effetto nel browser (lo accoda) o "＋" nella zona finale.
 *   • Riordinare: trascina un device dalla barra del titolo.
 *   • Eliminare: seleziona il device (clic sul titolo) e premi Canc/Backspace. Ctrl/Cmd+D duplica.
 * Manopole: trascina in verticale (Shift = fine), rotella, frecce, doppio clic = valore iniziale.
 * La catena appartiene alla traccia (vale in tutti i pattern): state.devs[canale] (devices.js).
 */

import { SYNTH_TRACKS, PRESETS } from './synth.js';
import { DEVICES, CATEGORIES, newDevice, filterQ, satCurve } from './devices.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sig = (v) => `${v > 0 ? '+' : ''}${(+v).toFixed(2)}`;

/** Parametri dello strumento (valgono per la traccia in tutti i pattern). */
const INST_SYN = [
  ['cut', 'Cutoff', -1, 1, 0, sig], ['res', 'Reso', -1, 1, 0, sig], ['env', 'Env', 0, 2, 1, (v) => v.toFixed(2)],
  ['dec', 'Decay', 0.25, 3, 1, (v) => v.toFixed(2)], ['atk', 'Attack', 0.1, 4, 1, (v) => v.toFixed(2)], ['rel', 'Release', 0.1, 4, 1, (v) => v.toFixed(2)],
];
const INST_DRUM = [['tune', 'Tune', -12, 12, 0, (v) => `${v > 0 ? '+' : ''}${v} st`], ['decay', 'Decay', 0.2, 2.5, 1, (v) => `×${v.toFixed(2)}`]];
const MIXER = [
  ['vol', 'Volume', 0, 1, 0.8, (v) => `${Math.round(v * 100)}`], ['pan', 'Pan', -1, 1, 0, (v) => (Math.abs(v) < 0.03 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100))],
  ['rev', 'Send A · Rev', 0, 1, 0, (v) => `${Math.round(v * 100)} %`], ['dly', 'Send B · Delay', 0, 1, 0, (v) => `${Math.round(v * 100)} %`],
];
const knobOf = ([k, label, min, max, def, fmt]) => ({ k, label, kind: 'num', min, max, def, fmt, curve: 'lin' });

let clip = null;        // device copiato (Copia / Incolla)

export function initFxChain(app, el, h) {
  const { state, engine } = app;
  let cur = 0, sel = null, menu = null;

  const trOf = (p, i) => (h.isSynth(i) ? p.synth.tracks[i - 8] : p.tracks[i]);
  const tr = () => trOf(state.slots[state.slot], cur);
  const chain = () => state.devs[cur];
  const devById = (id) => chain().find((d) => d.id === id);
  const apply = () => engine.setDevices(cur, chain());

  // ---------------------------------------------------------------
  // Valori ↔ posizione delle manopole (lineare o logaritmica)
  // ---------------------------------------------------------------
  const norm = (d, v) => (d.curve === 'log' ? Math.log(v / d.min) / Math.log(d.max / d.min) : (v - d.min) / (d.max - d.min));
  const denorm = (d, f) => (d.curve === 'log' ? d.min * Math.pow(d.max / d.min, f) : d.min + f * (d.max - d.min));
  function round(d, v) {
    if (d.k === 'bits' || d.k === 'tune') return Math.round(v);
    if (d.curve === 'log') { const m = Math.pow(10, Math.floor(Math.log10(Math.abs(v))) - 2); return Math.round(v / m) * m; }
    const r = d.max - d.min;
    return +(Math.round(v / (r >= 20 ? 0.1 : 0.01)) * (r >= 20 ? 0.1 : 0.01)).toFixed(3);
  }

  // ---------------------------------------------------------------
  // Disegno
  // ---------------------------------------------------------------
  function knob(d, v, owner) {
    const f = clamp(norm(d, v), 0, 1), f0 = d.min < 0 && d.max > 0 && d.curve !== 'log' ? norm(d, 0) : 0;
    return `<div class="kb" data-k="${d.k}" data-o="${owner}"><span class="kb-l">${esc(d.label)}</span>
      <div class="kb-dial" role="slider" tabindex="0" aria-label="${esc(d.label)}" aria-valuemin="${d.min}" aria-valuemax="${d.max}" aria-valuenow="${v}" style="--f:${f};--f0:${f0}"><i style="transform:rotate(${-135 + f * 270}deg)"></i></div>
      <span class="kb-v">${esc(d.fmt(v))}</span></div>`;
  }
  function enumSel(d, v, owner) {
    return `<label class="kb kb-e" data-k="${d.k}" data-o="${owner}"><span class="kb-l">${esc(d.label)}</span>
      <select class="dv-sel" aria-label="${esc(d.label)}">${d.options.map(([o, l]) => `<option value="${o}"${o === String(v) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  }

  function devHTML(dev, i) {
    const D = DEVICES[dev.type] || { name: `VST3 · ${(dev.p && dev.p.name) || 'plugin'}`, params: [] };
    const name = dev.name || D.name;
    return `<section class="dv${dev.on ? '' : ' off'}${dev.fold ? ' fold' : ''}${sel === dev.id ? ' sel' : ''}" data-id="${dev.id}" data-type="${dev.type}" tabindex="-1" aria-label="${esc(name)}">
      <header class="dv-h" draggable="true" title="Trascina per spostare · doppio clic per piegare · tasto destro per il menu">
        <button class="dv-pw${dev.on ? ' on' : ''}" data-pw aria-pressed="${dev.on}" aria-label="Attiva ${esc(name)}"></button>
        <span class="dv-name">${esc(name)}</span>
        <button class="dv-fold" data-fold aria-label="${dev.fold ? 'Espandi' : 'Piega'}" title="${dev.fold ? 'Espandi' : 'Piega'}">${dev.fold ? '▸' : '▾'}</button>
        <button class="dv-menu" data-menu aria-label="Menu del device" aria-haspopup="menu">⋯</button>
      </header>
      <div class="dv-body">
        ${D.graph ? `<canvas class="dv-graph" data-graph="${D.graph}"></canvas>` : ''}
        <div class="dv-knobs">${D.params.map((d) => (d.kind === 'enum' ? enumSel(d, dev.p[d.k], i) : knob(d, dev.p[d.k], i))).join('')}</div>
      </div>
    </section>`;
  }

  function render(i) {
    if (i !== undefined && i !== cur) { cur = i; sel = null; }
    const t = tr(), syn = h.isSynth(cur);
    const inst = (syn ? INST_SYN : INST_DRUM).map(knobOf);
    let instHead = '';
    if (syn) {
      const pr = t.patch && t.patch.wt ? t.patch : PRESETS[t.preset];
      instHead = `<div class="dv-inst"><b>${esc(pr ? pr.name : t.preset)}</b><span><button class="btn sm" data-act="sound" title="Libreria dei suoni">SUONO</button><button class="btn sm wt" data-act="wt">WT</button></span></div>`;
    }
    el.style.setProperty('--tc', h.color(cur));
    el.innerHTML = `<div class="fx-head"><b>${esc(h.short(cur))}</b><i>${esc(h.name(cur))}</i>
        <button class="btn sm${t.mute ? ' on' : ''}" data-ms="mute">M</button><button class="btn sm${t.solo ? ' on' : ''}" data-ms="solo">S</button>
        <button class="btn sm" data-act="notes">✎ NOTE</button></div>
      <div class="dv-chain" id="dvChain">
        <section class="dv dv-fixed" data-dev="inst"><header class="dv-h"><span class="dv-name">${syn ? `${SYNTH_TRACKS[cur - 8].name} · STRUMENTO` : 'VOCE'}</span></header>
          <div class="dv-body">${instHead}<div class="dv-knobs">${inst.map((d) => knob(d, t[d.k] ?? d.def, 'inst')).join('')}</div></div></section>
        ${chain().map((d, k) => devHTML(d, k)).join('')}
        <div class="dv-drop" id="dvDrop"><span>Trascina qui gli effetti audio</span><button class="btn sm" data-add aria-haspopup="menu">＋ EFFETTO</button></div>
        <section class="dv dv-fixed dv-mixer" data-dev="mix"><header class="dv-h"><span class="dv-name">MIXER</span></header>
          <div class="dv-body"><div class="dv-knobs">${MIXER.map(knobOf).map((d) => knob(d, t[d.k] ?? d.def, 'mix')).join('')}</div></div></section>
        <i class="dv-ins" id="dvIns" hidden></i>
      </div>`;
    drawGraphs();
  }

  // ---------------------------------------------------------------
  // Modifiche
  // ---------------------------------------------------------------
  function defOf(kb) {
    const o = kb.dataset.o, k = kb.dataset.k;
    if (o === 'inst') return knobOf((h.isSynth(cur) ? INST_SYN : INST_DRUM).find((x) => x[0] === k));
    if (o === 'mix') return knobOf(MIXER.find((x) => x[0] === k));
    const dev = chain()[+o];
    return DEVICES[dev.type].params.find((x) => x.k === k);
  }
  const valueOf = (kb) => {
    const o = kb.dataset.o, d = defOf(kb);
    if (o === 'inst' || o === 'mix') return tr()[d.k] ?? d.def;
    return chain()[+o].p[d.k];
  };
  function setValue(kb, v) {
    const o = kb.dataset.o, d = defOf(kb);
    v = d.kind === 'enum' ? v : clamp(round(d, v), d.min, d.max);
    if (o === 'inst' || o === 'mix') {
      state.slots.forEach((p) => { trOf(p, cur)[d.k] = v; });
      engine.setChannel(h.channel(cur), tr());
    } else {
      chain()[+o].p[d.k] = v;
      apply();
    }
    if (d.kind !== 'enum') {
      const f = clamp(norm(d, v), 0, 1), dial = $('.kb-dial', kb);
      dial.style.setProperty('--f', f);
      dial.firstElementChild.style.transform = `rotate(${-135 + f * 270}deg)`;
      dial.setAttribute('aria-valuenow', v);
      $('.kb-v', kb).textContent = d.fmt(v);
    }
    if (o !== 'inst' && o !== 'mix') drawGraphs(+o);
  }
  function structural(fn) {
    app.snapshot();
    fn(chain());
    apply();
    app.save();
    render();
    focusSel();
    if (app.onDevices) app.onDevices();
  }
  /** Il device selezionato riceve il focus: Canc e Ctrl+D funzionano subito, come in Live. */
  function focusSel() { const b = sel && $(`.dv[data-id="${sel}"]`, el); if (b) b.focus({ preventScroll: true }); }
  /** Aggiunge un device di tipo `type` alla traccia `ch` nella posizione `at` (fine se assente). */
  function addDevice(type, ch = cur, at = null) {
    if (!DEVICES[type]) return;
    app.snapshot();
    const d = newDevice(type), c = state.devs[ch];
    c.splice(at == null ? c.length : clamp(at, 0, c.length), 0, d);
    engine.setDevices(ch, c);
    app.save();
    if (ch === cur) { sel = d.id; render(); focusSel(); }
    if (app.onDevices) app.onDevices();
    app.toast(`${DEVICES[type].name} → ${h.short(ch)}`);
  }
  const copyOf = (d) => ({ ...JSON.parse(JSON.stringify(d)), id: newDevice(d.type).id });
  function del(id) { structural((c) => { const k = c.findIndex((d) => d.id === id); if (k >= 0) c.splice(k, 1); }); sel = null; render(); }
  function dup(id) { structural((c) => { const k = c.findIndex((d) => d.id === id); if (k >= 0) { const n = copyOf(c[k]); c.splice(k + 1, 0, n); sel = n.id; } }); }

  // ---------------------------------------------------------------
  // Manopole: trascinamento verticale, rotella, tastiera, doppio clic
  // ---------------------------------------------------------------
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    const dial = e.target.closest('.kb-dial');
    if (!dial) return;
    e.preventDefault();
    const kb = dial.parentElement, d = defOf(kb);
    app.snapshot();
    dial.setPointerCapture(e.pointerId);
    dial.focus();
    drag = { kb, d, y: e.clientY, f: clamp(norm(d, valueOf(kb)), 0, 1) };
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const px = e.shiftKey ? 600 : 160;
    setValue(drag.kb, denorm(drag.d, clamp(drag.f + (drag.y - e.clientY) / px, 0, 1)));
  });
  const end = () => { if (drag) { drag = null; app.save(); } };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('wheel', (e) => {
    const kb = e.target.closest('.kb:not(.kb-e)');
    if (!kb) return;
    e.preventDefault();
    const d = defOf(kb);
    setValue(kb, denorm(d, clamp(norm(d, valueOf(kb)) + Math.sign(-e.deltaY) / 50, 0, 1)));
    app.save();
  }, { passive: false });
  el.addEventListener('change', (e) => {
    const kb = e.target.closest('.kb-e');
    if (!kb) return;
    app.snapshot();
    setValue(kb, e.target.value);
    app.save();
  });

  el.addEventListener('dblclick', (e) => {
    const kb = e.target.closest('.kb:not(.kb-e)');
    if (kb) { app.snapshot(); setValue(kb, defOf(kb).def); app.save(); return; }
    const hd = e.target.closest('.dv-h');
    const box = hd && hd.closest('.dv[data-id]');
    if (box && !e.target.closest('button')) { const d = devById(box.dataset.id); structural(() => { d.fold = !d.fold; }); }
  });

  el.addEventListener('keydown', (e) => {
    const kb = e.target.closest('.kb:not(.kb-e)');
    if (kb && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      const d = defOf(kb), dir = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : -1;
      setValue(kb, denorm(d, clamp(norm(d, valueOf(kb)) + dir / (e.shiftKey ? 200 : 50), 0, 1)));
      app.save();
      return;
    }
    if (e.target.closest('input, select, [contenteditable="true"]') || !sel) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); del(sel); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); dup(sel); }
  });

  // ---------------------------------------------------------------
  // Clic: attivatore, piega, menu, selezione, pulsanti
  // ---------------------------------------------------------------
  el.addEventListener('click', (e) => {
    const box = e.target.closest('.dv[data-id]');
    if (e.target.closest('[data-pw]') && box) {
      const d = devById(box.dataset.id);
      structural(() => { d.on = !d.on; });
      return;
    }
    if (e.target.closest('[data-fold]') && box) { const d = devById(box.dataset.id); structural(() => { d.fold = !d.fold; }); return; }
    if (e.target.closest('[data-menu]') && box) { openMenu(box.dataset.id, e.target.closest('[data-menu]')); return; }
    if (e.target.closest('[data-add]')) { addMenu(e.target.closest('[data-add]')); return; }
    if (box && e.target.closest('.dv-h')) {
      sel = box.dataset.id;
      $$('.dv[data-id]', el).forEach((b) => b.classList.toggle('sel', b.dataset.id === sel));
      box.focus();
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
  el.addEventListener('contextmenu', (e) => {
    const box = e.target.closest('.dv[data-id]');
    if (!box || !e.target.closest('.dv-h')) return;
    e.preventDefault();
    openMenu(box.dataset.id, null, e.clientX, e.clientY);
  });

  // ---------------------------------------------------------------
  // Menu del device e menu "＋ EFFETTO"
  // ---------------------------------------------------------------
  function closeMenu() { if (menu) { menu.remove(); menu = null; } }
  function showMenu(html, anchor, x, y, onPick) {
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'tv-menu dv-pop';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = html;
    document.body.appendChild(menu);
    const r = anchor ? anchor.getBoundingClientRect() : { left: x, bottom: y, top: y };
    const mh = menu.offsetHeight, mw = menu.offsetWidth;
    menu.style.left = `${clamp(r.left, 4, innerWidth - mw - 4)}px`;
    menu.style.top = `${r.bottom + mh + 4 > innerHeight ? Math.max(4, r.top - mh - 4) : r.bottom + 4}px`;
    menu.addEventListener('click', (ev) => { const b = ev.target.closest('[data-m]'); if (b && !b.disabled) { closeMenu(); onPick(b.dataset.m); } });
    setTimeout(() => document.addEventListener('pointerdown', function off(ev) { if (menu && !menu.contains(ev.target)) { closeMenu(); document.removeEventListener('pointerdown', off); } }), 0);
    const first = menu.querySelector('button'); if (first) first.focus();
  }
  function openMenu(id, anchor, x, y) {
    const d = devById(id);
    sel = id;
    const items = [['rename', 'Rinomina'], ['dup', 'Duplica  (Ctrl+D)'], ['copy', 'Copia'], ['paste', 'Incolla dopo', !clip], ['reset', 'Ripristina valori'], ['fold', d.fold ? 'Espandi' : 'Piega'], ['on', d.on ? 'Disattiva' : 'Attiva'], ['del', 'Elimina  (Canc)']];
    showMenu(items.map(([m, l, dis]) => `<button class="btn" role="menuitem" data-m="${m}"${dis ? ' disabled' : ''}>${l}</button>`).join(''), anchor, x, y, (m) => {
      if (m === 'del') del(id);
      else if (m === 'dup') dup(id);
      else if (m === 'copy') { clip = JSON.parse(JSON.stringify(d)); app.toast(`${d.name || (DEVICES[d.type] || { name: 'VST3' }).name} copiato`); }
      else if (m === 'paste' && clip) structural((c) => { const k = c.findIndex((x) => x.id === id); const n = copyOf(clip); c.splice(k + 1, 0, n); sel = n.id; });
      else if (m === 'reset') { if (DEVICES[d.type]) structural(() => { const n = newDevice(d.type); d.p = n.p; }); }
      else if (m === 'fold') structural(() => { d.fold = !d.fold; });
      else if (m === 'on') structural(() => { d.on = !d.on; });
      else if (m === 'rename') rename(id);
    });
  }
  function rename(id) {
    const box = $(`.dv[data-id="${id}"]`, el), nm = box && $('.dv-name', box);
    if (!nm) return;
    const d = devById(id);
    nm.contentEditable = 'true';
    nm.focus();
    document.getSelection().selectAllChildren(nm);
    const done = (ok) => {
      nm.contentEditable = 'false';
      const v = nm.textContent.trim().slice(0, 24);
      if (ok) structural(() => { if (v && v !== (DEVICES[d.type] || {}).name) d.name = v; else delete d.name; });
      else render();
    };
    nm.addEventListener('keydown', function k(ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); nm.removeEventListener('keydown', k); done(true); }
      if (ev.key === 'Escape') { nm.removeEventListener('keydown', k); done(false); }
    });
    nm.addEventListener('blur', () => { if (nm.contentEditable === 'true') done(true); }, { once: true });
  }
  function addMenu(anchor) {
    const html = CATEGORIES.map((c) => `<h4>${esc(c)}</h4>${Object.entries(DEVICES).filter(([, d]) => d.cat === c).map(([t, d]) => `<button class="btn" role="menuitem" data-m="${t}" title="${esc(d.desc)}">${esc(d.name)}</button>`).join('')}`).join('');
    showMenu(html, anchor, 0, 0, (t) => addDevice(t));
  }

  // ---------------------------------------------------------------
  // Trascinamento: riordino dei device e inserimento dal browser
  // ---------------------------------------------------------------
  const MOVE = 'text/x-drumbort-dev', NEW = 'text/x-drumbort-newdev';
  el.addEventListener('dragstart', (e) => {
    const hd = e.target.closest('.dv-h');
    const box = hd && hd.closest('.dv[data-id]');
    if (!box) return;
    e.dataTransfer.setData(MOVE, box.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    box.classList.add('dragging');
  });
  el.addEventListener('dragend', () => { $$('.dragging', el).forEach((b) => b.classList.remove('dragging')); hideIns(); });
  /** Posizione di inserimento: numero di device con il centro a sinistra del puntatore. */
  function insAt(x) {
    const boxes = $$('.dv[data-id]', el);
    let k = 0;
    for (const b of boxes) { const r = b.getBoundingClientRect(); if (x > r.left + r.width / 2) k++; }
    return { k, boxes };
  }
  function showIns(x) {
    const ins = $('#dvIns', el), wrap = $('#dvChain', el);
    if (!ins) return 0;
    const { k, boxes } = insAt(x);
    const ref = boxes[k] || $('#dvDrop', el), wr = wrap.getBoundingClientRect(), rr = ref.getBoundingClientRect();
    ins.hidden = false;
    ins.style.left = `${rr.left - wr.left + wrap.scrollLeft - 4}px`;
    return k;
  }
  function hideIns() { const ins = $('#dvIns', el); if (ins) ins.hidden = true; }
  el.addEventListener('dragover', (e) => {
    const types = [...e.dataTransfer.types];
    if (!types.includes(MOVE) && !types.includes(NEW)) return;
    if (!e.target.closest('#dvChain')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = types.includes(MOVE) ? 'move' : 'copy';
    showIns(e.clientX);
  });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) hideIns(); });
  el.addEventListener('drop', (e) => {
    if (!e.target.closest('#dvChain')) return;
    const id = e.dataTransfer.getData(MOVE), type = e.dataTransfer.getData(NEW);
    if (!id && !type) return;
    e.preventDefault();
    const { k } = insAt(e.clientX);
    hideIns();
    if (type) { addDevice(type, cur, k); return; }
    structural((c) => {
      const from = c.findIndex((d) => d.id === id);
      if (from < 0) return;
      const [d] = c.splice(from, 1);
      c.splice(from < k ? k - 1 : k, 0, d);
      sel = id;
    });
  });

  // ---------------------------------------------------------------
  // Grafici: curve di EQ e filtro, curva del compressore e della saturazione
  // ---------------------------------------------------------------
  const N = 140, freqs = new Float32Array(N);
  for (let i = 0; i < N; i++) freqs[i] = 20 * Math.pow(1000, i / (N - 1));
  let probe = null;
  function setup(cv) {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (!r.width) return null;
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#12171b'; g.fillRect(0, 0, r.width, r.height);
    g.strokeStyle = '#262d33'; g.lineWidth = 1;
    return { g, W: r.width, H: r.height };
  }
  function line(g, pts, color) {
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.strokeStyle = color; g.lineWidth = 2; g.stroke();
  }
  function drawGraphs(only) {
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (AC && !probe) probe = new AC(1, 128, 44100);
    $$('.dv[data-id]', el).forEach((box, k) => {
      if (only !== undefined && k !== only) return;
      const cv = $('.dv-graph', box);
      if (!cv) return;
      const dev = chain()[k], s = setup(cv);
      if (!s) return;
      const { g, W, H } = s, col = h.color(cur), p = dev.p;
      if (dev.type === 'eq' || dev.type === 'filter') {
        for (const f of [100, 1000, 10000]) { const x = (Math.log10(f / 20) / 3) * W; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
        g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
        if (!probe) return;
        const mk = (type, f, gain, q) => { const b = probe.createBiquadFilter(); b.type = type; b.frequency.value = f; b.gain.value = gain; b.Q.value = q; return b; };
        const nodes = dev.type === 'eq'
          ? [mk('lowshelf', p.lf, p.lg, 1), mk('peaking', p.mf, p.mg, p.mq), mk('highshelf', p.hf, p.hg, 1)]
          : [mk(p.type, p.f, 0, filterQ(p.type, p.res))];
        const tot = new Float32Array(N), mag = new Float32Array(N), ph = new Float32Array(N);
        for (const n of nodes) { n.getFrequencyResponse(freqs, mag, ph); for (let i = 0; i < N; i++) tot[i] += 20 * Math.log10(Math.max(1e-5, mag[i])); }
        const range = dev.type === 'eq' ? 18 : 30;
        line(g, Array.from(tot, (v, i) => [(i / (N - 1)) * W, H / 2 - (clamp(v, -range, range) / range) * (H / 2 - 3)]), col);
      } else if (dev.type === 'comp') {
        // Curva statica: ingresso −60…0 dB → uscita
        g.beginPath(); g.moveTo(0, H); g.lineTo(W, 0); g.stroke();
        const pts = [];
        for (let i = 0; i <= 60; i++) {
          const x = -60 + i, k = p.knee / 2;
          let y;
          if (x < p.thr - k) y = x;
          else if (x > p.thr + k || k === 0) y = p.thr + (x - p.thr) / p.ratio;
          else { const u = x - p.thr + k; y = x + ((1 / p.ratio - 1) * u * u) / (4 * k); }
          pts.push([(i / 60) * W, H - ((y + p.gain + 60) / 60) * H]);
        }
        line(g, pts, col);
      } else if (dev.type === 'sat') {
        g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.stroke();
        const c = satCurve(p.type, p.drive), out = Math.pow(10, p.out / 20);
        const pts = [];
        for (let i = 0; i < 64; i++) { const j = Math.round((i / 63) * (c.length - 1)); pts.push([(i / 63) * W, H / 2 - clamp(c[j] * out, -1, 1) * (H / 2 - 3)]); }
        line(g, pts, col);
      }
    });
  }

  return { render, redraw: () => drawGraphs(), addDevice, get channel() { return cur; } };
}
