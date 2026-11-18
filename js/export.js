/**
 * export.js — Render offline di pattern/song in WAV (OfflineAudioContext).
 * Usa lo stesso motore e la stessa logica di scheduling della riproduzione live.
 */

import { Engine } from './engine.js';
import { kitById } from './kits.js';
import { scheduleTick, stepDuration, swingOffset, STEPS } from './sequencer.js';

/**
 * Renderizza una sequenza di battute.
 * @param {object[]} bars     un pattern per battuta (16 step)
 * @param {object}   o        { fx, samples, lockKit, sampleRate, tail, cache, devs (catene di device) }
 * @returns {Promise<AudioBuffer>}
 */
export async function renderBars(bars, { fx, samples = [], lockKit = null, sampleRate = 44100, tail = 2.5, cache = null, devs = null } = {}) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const start = 0.02;
  const dur = bars.reduce((a, p) => a + STEPS * stepDuration(p.bpm), start) + tail;
  const off = new OAC(2, Math.ceil(dur * sampleRate), sampleRate);
  const eng = new Engine();
  eng.init(off);
  eng.samples = samples.slice();
  if (cache) eng.cache = cache;     // solo benchmark: voci pre-renderizzate

  const kitOf = (p) => kitById(lockKit || p.kit);
  let time = start, tick = 0, prev = null, origin = 0;
  const canSuspend = typeof off.suspend === 'function';

  bars.forEach((p, b) => {
    const kit = kitOf(p);
    if (b === 0) {
      eng.setKit(kit);
      eng.setFx(fx, p.bpm, true);
      eng.applyMix(p, 0);
      if (devs) eng.setAllDevices(devs);
    } else {
      eng.applyMix(p, time);
      // Catena lo-fi e tempo del delay cambiano esattamente all'inizio della battuta
      if (canSuspend && (kitOf(prev) !== kit || prev.bpm !== p.bpm)) {
        const at = time;
        off.suspend(at).then(() => {
          eng.setChainKit(kit);
          eng.setFx({}, p.bpm, true);
          off.resume();
        }).catch(() => {});
      }
    }
    eng.setVoiceKit(kit);   // voci create ora, al momento della pianificazione
    const sd = stepDuration(p.bpm);
    if (p !== prev) origin = tick;     // un pattern di più battute riparte dall'inizio
    for (let i = 0; i < STEPS; i++) {
      scheduleTick(eng, p, tick - origin, time + swingOffset(tick, p.swing, sd));
      time += sd;
      tick++;
    }
    prev = p;
  });

  return off.startRendering();
}

/** Codifica un AudioBuffer in WAV PCM 16 bit. */
export function encodeWav(buf) {
  const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
  const bytes = 44 + len * ch * 2;
  const v = new DataView(new ArrayBuffer(bytes));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, bytes - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, len * ch * 2, true);
  const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([v.buffer], { type: 'audio/wav' });
}
