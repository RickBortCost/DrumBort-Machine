/**
 * newtrack.js — Dialogo "Nuove tracce" come in Logic Pro: si sceglie il tipo di traccia,
 * il numero e lo strumento; con "Apri Libreria" la Libreria si apre a sinistra per scegliere
 * subito il suono della nuova traccia.
 *
 *   • Strumento software: una traccia synth (BASS, LEAD, PAD, KEYS) → suoni della Libreria.
 *   • Batteria: una o più voci del kit (cassa, rullante, …) → suoni e kit della Libreria.
 *   • Kit di batteria: tutte le voci del kit in una volta.
 *
 * Scorciatoia: Ctrl+Alt+N (⌥⌘N su Mac). Il progetto ha 8 canali di batteria e 4 synth:
 * il dialogo propone solo quelli ancora liberi.
 */

import { SYNTH_TRACKS } from './synth.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TYPES = [
  { id: 'inst', icon: '🎹', name: 'Strumento software', desc: 'Synth con i suoni della Libreria (bassi, lead, pad, tastiere).' },
  { id: 'drum', icon: '🥁', name: 'Batteria', desc: 'Una o più voci del kit: cassa, rullante, hi-hat…' },
  { id: 'kit', icon: '◫', name: 'Kit di batteria', desc: 'Tutte le voci libere del kit in un colpo solo.' },
];

/**
 * @param {object} app { state, kitOf, pat, addTracks(list, { library }) }
 */
export function initNewTrack(app) {
  const { state } = app;
  let dlg = null, type = 'inst';

  const freeSynth = () => SYNTH_TRACKS.map((t, k) => 8 + k).filter((i) => !state.tracks.includes(i));
  const freeDrum = () => [...Array(8).keys()].filter((i) => !state.tracks.includes(i));

  function details() {
    const kit = app.kitOf(app.pat());
    if (type === 'inst') {
      const free = freeSynth();
      if (!free.length) return '<p class="nt-none">Tutte e 4 le tracce synth sono già nel progetto.</p>';
      return `<label class="nt-row"><span>Strumento</span><select id="ntWhich">${free.map((i) => `<option value="${i}">${SYNTH_TRACKS[i - 8].name} (${SYNTH_TRACKS[i - 8].short})</option>`).join('')}</select></label>
        <label class="nt-row"><span>Numero di tracce</span><input id="ntCount" type="number" min="1" max="${free.length}" value="1"></label>`;
    }
    if (type === 'drum') {
      const free = freeDrum();
      if (!free.length) return '<p class="nt-none">Tutte le voci del kit sono già nel progetto.</p>';
      return `<label class="nt-row"><span>Voce</span><select id="ntWhich">${free.map((i) => `<option value="${i}">${esc(kit.tracks[i].name)} (${esc(kit.tracks[i].short)})</option>`).join('')}</select></label>
        <label class="nt-row"><span>Numero di tracce</span><input id="ntCount" type="number" min="1" max="${free.length}" value="1"></label>`;
    }
    const free = freeDrum();
    return free.length ? `<p class="nt-info">Kit <b>${esc(kit.name)}</b>: ${free.map((i) => esc(kit.tracks[i].short)).join(' · ')}</p>` : '<p class="nt-none">Tutte le voci del kit sono già nel progetto.</p>';
  }

  function render() {
    dlg.querySelector('.nt-types').innerHTML = TYPES.map((t) => `<button class="nt-type${t.id === type ? ' on' : ''}" data-nt="${t.id}" role="radio" aria-checked="${t.id === type}">
        <span class="nt-ico" aria-hidden="true">${t.icon}</span><b>${t.name}</b><small>${t.desc}</small></button>`).join('');
    dlg.querySelector('.nt-details').innerHTML = details();
    const none = !!dlg.querySelector('.nt-none');
    dlg.querySelector('#ntCreate').disabled = none;
  }

  function open() {
    close();
    type = freeSynth().length ? 'inst' : 'drum';
    dlg = document.createElement('div');
    dlg.className = 'nt-back';
    dlg.innerHTML = `<div class="nt" role="dialog" aria-modal="true" aria-labelledby="ntTitle">
        <h2 id="ntTitle">Nuove tracce</h2>
        <div class="nt-types" role="radiogroup" aria-label="Tipo di traccia"></div>
        <div class="nt-details"></div>
        <label class="nt-check"><input id="ntLib" type="checkbox" checked> Apri Libreria</label>
        <div class="nt-btns"><button class="btn" data-ntx>Annulla</button><button class="btn on" id="ntCreate">Crea</button></div>
      </div>`;
    document.body.appendChild(dlg);
    render();
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg || e.target.closest('[data-ntx]')) { close(); return; }
      const t = e.target.closest('[data-nt]');
      if (t) { type = t.dataset.nt; render(); return; }
      if (e.target.closest('#ntCreate')) create();
    });
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Enter' && !e.target.closest('button')) { e.preventDefault(); create(); }
    });
    dlg.querySelector('#ntCreate').focus();
  }

  function create() {
    if (!dlg || dlg.querySelector('#ntCreate').disabled) return;
    const lib = dlg.querySelector('#ntLib').checked;
    let list = [];
    if (type === 'kit') list = freeDrum();
    else {
      const free = type === 'inst' ? freeSynth() : freeDrum();
      const first = +dlg.querySelector('#ntWhich').value;
      const n = Math.max(1, Math.min(free.length, +dlg.querySelector('#ntCount').value || 1));
      // La traccia scelta per prima, poi le altre libere nell'ordine
      list = [first, ...free.filter((i) => i !== first)].slice(0, n);
    }
    close();
    if (list.length) app.addTracks(list, { library: lib });
  }

  function close() { if (dlg) { dlg.remove(); dlg = null; } }

  return { open, close, get isOpen() { return !!dlg; } };
}
