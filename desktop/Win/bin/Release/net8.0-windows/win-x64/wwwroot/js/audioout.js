/**
 * audioout.js — Scelta dell'uscita audio (cuffie, casse, scheda esterna).
 *   - Motore nativo (DrumBort Host): elenco e scelta via /audio; "Predefinito di sistema" segue
 *     le cuffie collegate o scollegate.
 *   - Audio nel browser: AudioContext.setSinkId (Chrome/Edge); altrove segue l'uscita di sistema.
 */

import { hostInfo } from './remote.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KEY = 'drumbort.sink';

export function initAudioOut(app) {
  const { engine } = app;
  const list = $('#aoList'), info = $('#aoInfo');
  const native = () => hostInfo() === 'native' && app.remoteRole && app.remoteRole() === 'control';

  /** Applica all'avvio l'uscita scelta in precedenza (solo audio nel browser). */
  async function restore() {
    let id = '';
    try { id = localStorage.getItem(KEY) || ''; } catch (_) { /* storage non disponibile */ }
    if (id && engine.ctx && engine.ctx.setSinkId) { try { await engine.ctx.setSinkId(id); } catch (_) { /* dispositivo non più presente */ } }
  }

  async function renderNative() {
    const r = await (await fetch('./audio', { cache: 'no-store' })).json();
    if (!r.available) { info.textContent = 'Il motore del PC gira senza scheda audio (--no-audio).'; list.innerHTML = ''; return; }
    info.textContent = `L'audio esce dal PC. In uso: ${r.current}`;
    list.innerHTML = `<button class="btn ao-item${r.follow ? ' on' : ''}" data-dev=""><b>Predefinito di sistema</b><small>segue cuffie e casse collegate</small></button>`
      + r.devices.map((d) => `<button class="btn ao-item${!r.follow && d.name === r.current ? ' on' : ''}" data-dev="${esc(d.name)}"><b>${esc(d.name)}</b><small>${d.isDefault ? 'predefinito del sistema' : ''}</small></button>`).join('');
  }

  async function renderBrowser() {
    const ctx = engine.ctx;
    if (!ctx || !ctx.setSinkId || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      info.textContent = 'Questo browser usa l\'uscita audio del sistema: scegli cuffie o casse nelle impostazioni audio del dispositivo.';
      list.innerHTML = '';
      return;
    }
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    const cur = ctx.sinkId || '';
    const named = devs.some((d) => d.label);
    info.textContent = named ? 'Uscita del browser.' : 'Uscita del browser. Per vedere i nomi dei dispositivi tocca MOSTRA NOMI (chiede l\'accesso al microfono, che non viene usato).';
    list.innerHTML = `<button class="btn ao-item${!cur ? ' on' : ''}" data-sink=""><b>Predefinito di sistema</b><small>segue cuffie e casse collegate</small></button>`
      + devs.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => `<button class="btn ao-item${d.deviceId === cur ? ' on' : ''}" data-sink="${esc(d.deviceId)}"><b>${esc(d.label || `Uscita ${i + 1}`)}</b></button>`).join('')
      + (named ? '' : '<button class="btn sm" data-ao="names">MOSTRA NOMI</button>');
  }

  const render = () => (native() ? renderNative() : renderBrowser()).catch(() => { info.textContent = 'Elenco delle uscite non disponibile.'; });

  $('#audioSheet').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-dev], [data-sink], [data-ao]');
    if (!b) return;
    try {
      if (b.dataset.dev !== undefined) {
        info.textContent = 'Cambio uscita…';
        await fetch('./audio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: b.dataset.dev || null }) });
      } else if (b.dataset.sink !== undefined) {
        await engine.ctx.setSinkId(b.dataset.sink);
        try { localStorage.setItem(KEY, b.dataset.sink); } catch (_) { /* privata */ }
      } else if (b.dataset.ao === 'refresh') {
        if (native()) { info.textContent = 'Rilettura dei dispositivi…'; await fetch('./audio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh: true }) }); }
      } else if (b.dataset.ao === 'names') {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
      }
    } catch (err) {
      app.toast('Uscita non disponibile');
    }
    render();
  });
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => { if (!$('#audioSheet').hidden) render(); });
  }

  return {
    restore,
    open() { app.openSheet('audioSheet'); info.textContent = '…'; list.innerHTML = ''; render(); },
    /** Il motore del PC ha cambiato uscita (es. cuffie collegate). */
    changed(name) { app.toast(`Uscita audio del PC: ${name}`); if (!$('#audioSheet').hidden) render(); },
  };
}
