/**
 * panels.js — Fogli secondari: generatore, kit personalizzati, progetti, campionatore,
 * condivisione via link, export MIDI e registrazione dell'uscita.
 */

import { KITS, USER_KITS, setUserKits, findKit } from './kits.js';
import { euclid, varyDrums, varySynth } from './generate.js';
import { exportMidi } from './midifile.js';
import { recordNode, recordMic } from './recorder.js';
import { encodeWav } from './export.js';
import { listProjects, saveProject, deleteProject, getProject, shareUrl, decodeShare } from './projects.js';
import { saveSample, deleteSample } from './idb.js';
import { clonePattern, normalizePattern } from './sequencer.js';
import { PRESETS } from './presets.js';
import { SYNTH_TRACKS } from './synth.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * @param {object} app  funzioni e stato condivisi da ui.js
 */
export function initPanels(app) {
  const { engine, seq, state } = app;

  // ===================================================================
  // Generatore: euclideo, variazioni, humanize
  // ===================================================================
  const gen = { hits: $('#genHits'), rot: $('#genRot'), amt: $('#genAmt'), human: $('#genHuman') };
  function renderGen() {
    const p = app.pat(), t = state.sel, len = p.tracks[t].len;
    $('#genTrack').textContent = `RITMO EUCLIDEO · ${app.kitOf(p).tracks[t].name.toUpperCase()}`;
    gen.hits.max = len; gen.rot.max = Math.max(0, len - 1);
    if (+gen.hits.value > len) gen.hits.value = len;
    gen.hits.nextElementSibling.textContent = `${gen.hits.value}/${len}`;
    gen.rot.nextElementSibling.textContent = gen.rot.value;
    gen.amt.nextElementSibling.textContent = `${Math.round(gen.amt.value * 100)}%`;
    gen.human.value = p.human || 0;
    gen.human.nextElementSibling.textContent = `${Math.round((p.human || 0) * 100)}%`;
  }
  [gen.hits, gen.rot, gen.amt].forEach((i) => i.addEventListener('input', renderGen));
  gen.human.addEventListener('input', () => {
    app.pat().human = +gen.human.value;
    renderGen(); app.save();
  });
  $('#genSheet').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]') && e.target.closest('[data-act]').dataset.act;
    if (!act) return;
    const p = app.pat();
    app.snapshot();
    if (act === 'gen-euclid') {
      const t = state.sel, len = p.tracks[t].len;
      const row = euclid(+gen.hits.value, len, +gen.rot.value);
      for (let s = 0; s < 16; s++) p.steps[t][s] = s < len ? row[s] : 0;
      app.toast(`Euclideo ${gen.hits.value}/${len} su ${app.kitOf(p).tracks[t].short}`);
    } else if (act === 'gen-vary-drums') {
      varyDrums(p, +gen.amt.value);
      app.toast('Batteria variata (↶ per annullare)');
    } else if (act === 'gen-vary-synth') {
      varySynth(p, +gen.amt.value);
      app.toast('Synth variato (↶ per annullare)');
    }
    app.renderAll(); app.save();
  });

  // ===================================================================
  // Kit personalizzati
  // ===================================================================
  const voiceOptions = KITS.map((k) => `<optgroup label="${esc(k.name)}">${
    k.tracks.map((t, i) => `<option value="${k.id}|${i}">${esc(k.name.split(' ').slice(-1)[0])} · ${esc(t.name)}</option>`).join('')}</optgroup>`).join('');
  const ROLE = ['Kick', 'Snare', 'Clap/Rim', 'Closed Hat', 'Open Hat', 'Tom', 'Cymbal', 'Perc'];
  $('#kitRows').innerHTML = ROLE.map((r, i) => `
    <div class="row-ctl kit-row"><small>${i + 1} ${r}</small>
      <select class="sel" data-slot="${i}" aria-label="Voce ${r}">${voiceOptions}</select>
      <button class="btn sm" data-prev="${i}" aria-label="Ascolta ${r}">▶</button>
    </div>`).join('');
  let editingKit = null;

  function openKits() {
    const cur = findKit(app.pat().kit);
    editingKit = cur && cur.user ? cur.def : null;
    const base = cur && !cur.user ? cur : KITS[0];
    $('#kitName').value = editingKit ? editingKit.name : '';
    $('#kitCrush').value = String(editingKit ? editingKit.crush || 0 : 0);
    document.querySelectorAll('#kitRows select').forEach((sel, i) => {
      const m = editingKit ? editingKit.map[i] : { kit: base.id, track: i };
      sel.value = `${m.kit}|${m.track}`;
    });
    $('[data-act="kit-delete"]').disabled = !editingKit;
    app.openSheet('kitSheet');
  }
  $('#kitSheet').addEventListener('click', (e) => {
    const prev = e.target.closest('[data-prev]');
    if (prev && engine.ctx) {
      const [kid, ti] = document.querySelector(`#kitRows select[data-slot="${prev.dataset.prev}"]`).value.split('|');
      const k = KITS.find((x) => x.id === kid);
      const g = engine.ctx.createGain();
      g.connect(engine.channels[+prev.dataset.prev].gain);
      k.tracks[+ti].play(engine.ctx, g, engine.ctx.currentTime + 0.01, 1, { tune: 0, decay: 1 });
      return;
    }
    const act = e.target.closest('[data-act]') && e.target.closest('[data-act]').dataset.act;
    if (act === 'kit-save') {
      const map = [...document.querySelectorAll('#kitRows select')].map((s) => { const [kit, t] = s.value.split('|'); return { kit, track: +t }; });
      const name = $('#kitName').value.trim() || `Kit ${(state.userKits || []).length + 1}`;
      const def = { id: editingKit ? editingKit.id : `u:${Date.now().toString(36)}`, name, crush: +$('#kitCrush').value, map };
      state.userKits = (state.userKits || []).filter((d) => d.id !== def.id).concat(def);
      setUserKits(state.userKits);
      if (engine.cache) engine.cache.clear();       // le voci del kit sono cambiate
      app.snapshot();
      app.pat().kit = def.id;
      app.buildKitSelect();
      app.syncPlayback(); app.renderAll(); app.save();
      app.closeSheet($('#kitSheet'));
      app.toast(`Kit "${name}" salvato`);
    } else if (act === 'kit-delete' && editingKit) {
      state.userKits = (state.userKits || []).filter((d) => d.id !== editingKit.id);
      setUserKits(state.userKits);
      state.slots.forEach((p) => { if (p.kit === editingKit.id) p.kit = KITS[0].id; });
      app.buildKitSelect();
      app.syncPlayback(); app.renderAll(); app.save();
      app.closeSheet($('#kitSheet'));
      app.toast('Kit eliminato');
    }
  });

  // ===================================================================
  // Progetti
  // ===================================================================
  function renderProjects() {
    $('#projName').value = state.projectName || '';
    const list = listProjects();
    $('#projList').innerHTML = list.map((p) => `
      <div class="proj-row${p.name === state.projectName ? ' cur' : ''}">
        <div class="lib-main"><b>${esc(p.name)}</b><small>${new Date(p.updated).toLocaleString()}</small></div>
        <button class="btn sm" data-open="${esc(p.name)}">Apri</button>
        <button class="btn sm" data-del="${esc(p.name)}" aria-label="Elimina ${esc(p.name)}">✕</button>
      </div>`).join('') || '<p class="hint">Nessun progetto salvato.</p>';
  }
  $('#projSheet').addEventListener('click', (e) => {
    const t = e.target.closest('[data-open], [data-del], [data-act]');
    if (!t) return;
    if (t.dataset.act === 'proj-save') {
      const name = $('#projName').value.trim() || 'Senza titolo';
      state.projectName = name;
      app.toast(saveProject(name, app.exportData()) ? `Progetto "${name}" salvato` : 'Spazio di archiviazione esaurito');
      app.save();
    } else if (t.dataset.act === 'proj-new') {
      saveProject('Auto-salvataggio', app.exportData());
      app.newProject();
      state.projectName = '';
      app.toast('Nuovo progetto (il precedente è in Auto-salvataggio)');
    } else if (t.dataset.open) {
      const pr = getProject(t.dataset.open);
      if (!pr) return;
      if (state.projectName !== pr.name) saveProject(state.projectName || 'Auto-salvataggio', app.exportData());
      app.importData(pr.data);
      state.projectName = pr.name;
      app.save();
      app.toast(`Aperto "${pr.name}"`);
    } else if (t.dataset.del) {
      deleteProject(t.dataset.del);
      if (state.projectName === t.dataset.del) state.projectName = '';
    }
    renderProjects();
  });

  // ===================================================================
  // Campionatore (file o microfono) sulla traccia batteria selezionata
  // ===================================================================
  let mic = null, micTimer = null;
  async function useSample(buf, name) {
    const t = state.sel;
    engine.samples[t] = { buffer: buf, name };
    const wav = await encodeWav(buf).arrayBuffer();
    const ok = await saveSample(t, name, wav);
    if (engine.cache) engine.cache.clear();
    app.renderAll();
    app.toast(`${name} → ${app.kitOf(app.pat()).tracks[t].short}${ok ? '' : ' (non salvato)'}`);
  }
  async function toggleMic() {
    const btn = $('#micBtn');
    if (mic) {
      clearInterval(micTimer);
      const m = mic; mic = null;
      app.setToggle(btn, false);
      btn.textContent = '● Registra dal microfono';
      const buf = await m.stop();
      if (!buf) { app.toast('Nessun suono registrato'); return; }
      await useSample(buf, `Mic ${new Date().toLocaleTimeString().slice(0, 5)}`);
      $('#micStatus').textContent = `Registrato ${buf.duration.toFixed(2)} s`;
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { app.toast('Microfono non disponibile'); return; }
    try {
      mic = await recordMic(engine.init(), 6);
      app.setToggle(btn, true);
      btn.textContent = '■ Ferma registrazione';
      micTimer = setInterval(() => {
        if (!mic) return;
        const s = mic.seconds();
        $('#micStatus').textContent = `Registrazione… ${s.toFixed(1)} s`;
        if (s >= 6) toggleMic();
      }, 100);
    } catch (_) {
      mic = null;
      app.toast('Accesso al microfono negato');
    }
  }
  $('#sampleSheet').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]') && e.target.closest('[data-act]').dataset.act;
    if (act === 'smp-file') { app.closeSheet($('#sampleSheet')); $('#wavFile').click(); }
    else if (act === 'smp-mic') toggleMic();
    else if (act === 'smp-clear') {
      engine.clearSample(state.sel);
      await deleteSample(state.sel);
      if (engine.cache) engine.cache.clear();
      app.renderAll();
      app.toast('Campione rimosso');
    }
  });

  // ===================================================================
  // Registrazione dell'uscita (WAV)
  // ===================================================================
  let rec = null, recTimer = null;
  async function recordOutput() {
    if (!engine.ctx) return;
    const badge = $('#recBadge');
    if (rec) {
      clearInterval(recTimer);
      const r = rec; rec = null;
      badge.hidden = true;
      app.setToggle($('#recOutBtn'), false);
      const buf = r.stop();
      if (buf.duration < 0.2) { app.toast('Registrazione troppo breve'); return; }
      await app.deliver(new File([encodeWav(buf)], `drumbort-live-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.wav`, { type: 'audio/wav' }));
      app.toast(`Registrazione salvata (${fmtTime(buf.duration)})`);
      return;
    }
    try {
      rec = await recordNode(engine.ctx, engine.comp, 2, 600);
    } catch (_) {
      app.toast('Registrazione non disponibile');
      return;
    }
    badge.hidden = false;
    app.setToggle($('#recOutBtn'), true);
    recTimer = setInterval(() => { if (rec) $('#recTime').textContent = fmtTime(rec.seconds()); }, 250);
    app.toast('Registrazione dell\'uscita avviata: tocca di nuovo per fermare');
  }
  $('#recBadge').addEventListener('click', recordOutput);

  // ===================================================================
  // Condivisione via link
  // ===================================================================
  async function share() {
    // I preset utente non esistono su altri dispositivi: viaggiano come patch
    const p = clonePattern(app.pat());
    p.synth.tracks.forEach((t, i) => {
      if (t.preset.startsWith('up:') && !t.patch && PRESETS[t.preset]) {
        t.patch = JSON.parse(JSON.stringify(PRESETS[t.preset]));
        t.preset = SYNTH_TRACKS[i].preset;
      }
    });
    const url = await shareUrl(p);
    if (navigator.share) {
      try { await navigator.share({ title: 'DrumBort pattern', url }); return; } catch (_) { /* annullato */ }
    }
    try {
      await navigator.clipboard.writeText(url);
      app.toast('Link copiato negli appunti');
    } catch (_) {
      prompt('Copia il link:', url);
    }
  }

  /** All'avvio: pattern condiviso nell'hash → caricato nello slot corrente (annullabile). */
  async function handleShareHash() {
    const m = location.hash.match(/^#p=([jz][A-Za-z0-9_-]+)$/);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    try {
      const o = await decodeShare(m[1]);
      app.snapshot();
      state.slots[state.slot] = normalizePattern(o.pattern);
      app.syncPlayback(); app.renderAll(); app.save();
      app.toast(`Pattern condiviso caricato in P${state.slot + 1} (↶ per annullare)`);
    } catch (_) {
      app.toast('Link non valido');
    }
  }

  // ===================================================================
  // Export MIDI
  // ===================================================================
  function exportMid(bars, name) {
    const blob = exportMidi(bars);
    app.deliver(new File([blob], `drumbort-${name}-${bars[0].bpm}bpm.mid`, { type: 'audio/midi' }));
    app.toast('File MIDI pronto');
  }

  return {
    openGen() { renderGen(); app.openSheet('genSheet'); },
    openKits,
    openProjects() { renderProjects(); app.openSheet('projSheet'); },
    openSample() { $('#micStatus').textContent = 'Tocca per iniziare, tocca di nuovo per fermare (max 6 s). Il silenzio iniziale viene tagliato.'; app.openSheet('sampleSheet'); },
    recordOutput,
    share,
    handleShareHash,
    exportMid,
    userKitCount: () => USER_KITS.length,
  };
}
