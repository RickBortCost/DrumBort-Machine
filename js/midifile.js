/**
 * midifile.js — Export Standard MIDI File (formato 1, 96 PPQ).
 * Traccia 0: tempo; traccia 1: batteria (canale 10, mappa GM); tracce 2-5: synth (canali 1-4).
 * Gli eventi vengono raccolti eseguendo lo stesso scheduler con un motore "finto".
 */

import { scheduleTick, stepDuration, swingOffset, STEPS } from './sequencer.js';
import { GM_OUT } from './midi.js';
import { SYNTH_TRACKS } from './synth.js';

const PPQ = 96;

function vlq(n) {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}

function trackChunk(events) {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const bytes = [];
  let last = 0;
  for (const e of events) {
    bytes.push(...vlq(Math.max(0, e.tick - last)), ...e.data);
    last = e.tick;
  }
  bytes.push(0, 0xff, 0x2f, 0);   // fine traccia
  const len = bytes.length;
  return [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...bytes];
}

const name = (s) => { const b = [...new TextEncoder().encode(s)]; return [0xff, 0x03, ...vlq(b.length), ...b]; };

/**
 * @param {object[]} bars  un pattern per battuta
 * @returns {Blob} file .mid
 */
export function exportMidi(bars) {
  const tempo = [{ tick: 0, order: 0, data: [0xff, 0x58, 4, 4, 2, 24, 8] }];
  const drums = [{ tick: 0, order: 0, data: name('Drums') }];
  const synth = SYNTH_TRACKS.map((d) => [{ tick: 0, order: 0, data: name(d.name) }]);

  let barTime = 0, barTick = 0, curBpm = null, tick = 0;
  const toTick = (time, bpm) => barTick + Math.round((time - barTime) * (bpm / 60) * PPQ);

  bars.forEach((p) => {
    if (p.bpm !== curBpm) {
      const us = Math.round(60000000 / p.bpm);
      tempo.push({ tick: barTick, order: 1, data: [0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255] });
      curBpm = p.bpm;
    }
    const sd = stepDuration(p.bpm);
    const eng = {
      trigger(i, time, vel) {
        const tk = toTick(time, p.bpm), v = Math.max(1, Math.min(127, Math.round(vel * 127)));
        drums.push({ tick: tk, order: 2, data: [0x99, GM_OUT[i], v] });
        drums.push({ tick: tk + PPQ / 8, order: 1, data: [0x89, GM_OUT[i], 0] });
      },
      playSynth(k, time, dur, notes, vel) {
        const tk = toTick(time, p.bpm), off = toTick(time + dur, p.bpm), v = Math.max(1, Math.min(127, Math.round(vel * 127)));
        for (const n of notes) {
          synth[k].push({ tick: tk, order: 2, data: [0x90 | k, n, v] });
          synth[k].push({ tick: Math.max(tk + 1, off), order: 1, data: [0x80 | k, n, 0] });
        }
      },
    };
    for (let i = 0; i < STEPS; i++) {
      const t = barTime + i * sd + swingOffset(tick, p.swing, sd);
      scheduleTick(eng, p, tick, t, { random: () => 0 });
      tick++;
    }
    barTime += STEPS * sd;
    barTick += STEPS * (PPQ / 4);
  });

  const chunks = [tempo, drums, ...synth].map(trackChunk);
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, chunks.length, (PPQ >> 8) & 255, PPQ & 255];
  return new Blob([new Uint8Array([...header, ...chunks.flat()])], { type: 'audio/midi' });
}
