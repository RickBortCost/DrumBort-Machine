/**
 * library.js — Browser della libreria di suoni: categorie, ricerca per nome/tag,
 * preferiti, ascolto immediato e assegnazione alla traccia synth selezionata.
 */

import { categories, PRESETS, findPresets } from './presets.js';
import { SYNTH_TRACKS, isChordTrack, diatonicChord } from './synth.js';
import { trackBase } from './synthpattern.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param {object} app  { engine, ui, state, pat, snapshot, save, openSheet, setToggle, onPresetChange }
 */
export function initLibrary(app) {
  const { engine, ui, state } = app;
  const sheet = $('#libSheet');
  const list = $('#libList');
  const cats = $('#libCats');
  const search = $('#libSearch');
  let cat = null;          // categoria attiva (null = tutte, '★' = preferiti)
  let k = 0;               // traccia di destinazione

  const renderCats = () => {
    cats.innerHTML = ['Tutti', '★', ...categories()]
      .map((c) => `<button class="btn sm chip-cat" data-cat="${esc(c)}" aria-pressed="false">${esc(c)}</button>`).join('');
  };

  const favs = () => state.favs || (state.favs = []);

  function render() {
    const tr = app.pat().synth.tracks[k];
    cats.querySelectorAll('.chip-cat').forEach((b) => {
      const c = b.dataset.cat;
      app.setToggle(b, c === 'Tutti' ? cat === null : c === cat);
    });
    // Con un testo di ricerca si cerca in tutta la libreria (i preferiti restano un filtro)
    const text = search.value.trim();
    const items = findPresets({ cat: cat === '★' || text ? null : cat, text, favs: cat === '★' ? favs() : null });
    $('#libTitle').textContent = `LIBRERIA → ${SYNTH_TRACKS[k].name.toUpperCase()}`;
    $('#libCount').textContent = `${items.length} suoni`;
    list.innerHTML = items.map((p) => `
      <div class="lib-row${p.id === tr.preset ? ' cur' : ''}" data-id="${p.id}" role="button" tabindex="0" aria-label="${esc(p.name)}, ${esc(p.cat)}">
        <div class="lib-main"><b>${esc(p.name)}</b><small>${esc(p.cat)} · ${p.tags.map(esc).join(' · ')}</small></div>
        <button class="btn sm fav${favs().includes(p.id) ? ' on' : ''}" data-fav="${p.id}" aria-label="Preferito" aria-pressed="${favs().includes(p.id)}">★</button>
      </div>`).join('') || '<p class="hint">Nessun suono trovato.</p>';
  }

  /** Ascolto: accordo per le tracce polifoniche, breve frase per quelle mono. */
  function preview(id) {
    if (!engine.ctx) return;
    const pr = PRESETS[id];
    const syn = app.pat().synth;
    const base = trackBase(syn, k);
    const tr = { ...syn.tracks[k], preset: id };
    delete tr.patch;
    const now = engine.ctx.currentTime + 0.02;
    if (isChordTrack(k) || ['Pad', 'Strings', 'Choir', 'Organ', 'Piano', 'Keys'].includes(pr.cat)) {
      const ch = diatonicChord(base, syn.key, syn.scale, 'triad');
      engine.playSynth(k, now, 0.9, ch.map((x) => base + x), 0.8, tr);
    } else {
      [0, 7, 12].forEach((iv, i) => engine.playSynth(k, now + i * 0.18, 0.16, [base + iv], i ? 0.7 : 1, tr));
    }
  }

  function choose(id) {
    const tr = app.pat().synth.tracks[k];
    if (tr.preset !== id) {
      app.snapshot();
      tr.preset = id;
      delete tr.patch;           // un nuovo suono sostituisce le modifiche dell'editor
      app.save();
      app.onPresetChange();
    }
    preview(id);
    render();
  }

  list.addEventListener('click', (e) => {
    const fav = e.target.closest('[data-fav]');
    if (fav) {
      const f = favs(), id = fav.dataset.fav, i = f.indexOf(id);
      if (i >= 0) f.splice(i, 1); else f.push(id);
      app.save();
      render();
      return;
    }
    const row = e.target.closest('.lib-row');
    if (row) choose(row.dataset.id);
  });
  list.addEventListener('keydown', (e) => {
    const row = e.target.closest('.lib-row');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); choose(row.dataset.id); }
  });
  cats.addEventListener('click', (e) => {
    const b = e.target.closest('.chip-cat');
    if (!b) return;
    cat = b.dataset.cat === 'Tutti' ? null : b.dataset.cat;
    render();
  });
  search.addEventListener('input', render);

  return {
    open(track, category = null) {
      k = track;
      renderCats();
      const cur = PRESETS[app.pat().synth.tracks[k].preset];
      cat = category || (cur ? cur.cat : null);
      search.value = '';
      render();
      app.openSheet('libSheet');
      const el = list.querySelector('.cur');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
    },
    preview,
  };
}
