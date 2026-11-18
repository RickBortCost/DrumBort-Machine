/**
 * engine.js — AudioContext, mixer a 8 canali, effetti e catena master.
 *
 * Catena:
 *   voce → canale (gain → pan) ─┬→ kitIn → [low-pass] → [bit-crusher] → kitOut ─┐
 *                               ├→ mandata riverbero → Convolver → return ──────┤
 *                               └→ mandata delay → Delay (+feedback) → return ──┤
 *   → filtro master (LP → HP) → master gain → DynamicsCompressor → destination ←┘
 *
 * Funziona sia con AudioContext (live) sia con OfflineAudioContext (export WAV).
 */

import { KITS } from './kits.js';
import { PRESETS, playVoice } from './synth.js';

const TRACKS = 8;
const SYNTH_TRACKS = 3;
export const SYNTH_CH = TRACKS;   // canali 8-10: BASS, LEAD, PAD
const CH_IDX = 3;   // Closed Hat
const OH_IDX = 4;   // Open Hat (strozzato dal Closed Hat)

export const DEFAULT_FX = Object.freeze({
  filter: 0,      // -1 low-pass … 0 off … +1 high-pass
  res: 0.7,       // risonanza (Q)
  rev: 0.8,       // livello di ritorno riverbero
  size: 2.2,      // durata riverbero (s)
  dly: 0.7,       // livello di ritorno delay
  fb: 0.35,       // feedback delay
  div: 3,         // tempo delay in sedicesimi (3 = croma puntata)
  master: 0.8,    // volume master
});

const crushCache = new Map();
/** Curva di quantizzazione a N bit per il WaveShaper. */
function crushCurve(bits) {
  if (!crushCache.has(bits)) {
    const n = 65536, c = new Float32Array(n), steps = Math.pow(2, bits - 1);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.round(x * steps) / steps;
    }
    crushCache.set(bits, c);
  }
  return crushCache.get(bits);
}

/** Risposta all'impulso sintetica: rumore stereo con decadimento esponenziale. */
function impulse(ctx, seconds) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  return b;
}

/** Mappa il controllo filtro (-1..1) sulle frequenze di LP e HP. */
export function filterFreqs(f) {
  const lp = f < -0.02 ? 20000 * Math.pow(80 / 20000, -f) : 20000;
  const hp = f > 0.02 ? 20 * Math.pow(6000 / 20, f) : 10;
  return { lp, hp };
}

export class Engine {
  constructor() {
    this.ctx = null;
    this.kit = KITS[0];
    this.samples = new Array(TRACKS).fill(null);   // { buffer, name } per traccia
    this.chokeGains = [];
    this.channels = [];
    this.fx = { ...DEFAULT_FX };
    this.bpm = 120;
  }

  // -------------------------------------------------------------------
  // Inizializzazione (live: dentro un gesto utente su iOS)
  // -------------------------------------------------------------------
  /** @param {BaseAudioContext} [ctx] contesto esistente (es. OfflineAudioContext) */
  init(ctx) {
    if (this.ctx) return this.ctx;
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      // iOS 17+: riproduci anche con l'interruttore silenzioso attivo
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) { /* n/a */ }
      ctx = new AC({ latencyHint: 'interactive' });
    }
    this.ctx = ctx;

    // --- Master ---
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -12;
    this.comp.knee.value = 8;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.2;
    this.master = ctx.createGain();
    this.master.connect(this.comp).connect(ctx.destination);

    // --- Filtro master (DJ filter) ---
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.lp.connect(this.hp).connect(this.master);
    this.fxIn = this.lp;

    // --- Bus kit (inserti lo-fi) ---
    this.kitIn = ctx.createGain();
    this.kitIn.gain.value = 0.85;
    this.kitOut = ctx.createGain();
    this.kitOut.connect(this.fxIn);

    // --- Riverbero ---
    this.revIn = ctx.createGain();
    this.conv = ctx.createConvolver();
    this.revOut = ctx.createGain();
    this.revIn.connect(this.conv).connect(this.revOut).connect(this.fxIn);
    this._revSize = 0;

    // --- Delay con feedback filtrato ---
    this.dlyIn = ctx.createGain();
    this.delay = ctx.createDelay(4);
    this.dlyFb = ctx.createGain();
    this.dlyTone = ctx.createBiquadFilter();
    this.dlyTone.type = 'lowpass';
    this.dlyTone.frequency.value = 4500;
    this.dlyOut = ctx.createGain();
    this.dlyIn.connect(this.delay);
    this.delay.connect(this.dlyTone).connect(this.dlyFb).connect(this.delay);
    this.delay.connect(this.dlyOut).connect(this.fxIn);

    // --- Canali con mandate post-pan (0-7 batteria → bus kit, 8-10 synth → filtro master) ---
    for (let i = 0; i < TRACKS + SYNTH_TRACKS; i++) {
      const gain = ctx.createGain();
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      const post = pan || gain;
      if (pan) gain.connect(pan);
      post.connect(i < TRACKS ? this.kitIn : this.fxIn);
      const rev = ctx.createGain();
      const dly = ctx.createGain();
      rev.gain.value = 0;
      dly.gain.value = 0;
      post.connect(rev).connect(this.revIn);
      post.connect(dly).connect(this.dlyIn);
      this.channels.push({ gain, pan, rev, dly });
    }
    this._buildKitChain();
    this.setFx(this.fx, this.bpm, true);
    return ctx;
  }

  /** Sblocca l'audio su iOS: resume + buffer silenzioso. */
  async unlock() {
    const ctx = this.init();
    const s = ctx.createBufferSource();
    s.buffer = ctx.createBuffer(1, 1, 22050);
    s.connect(ctx.destination);
    s.start(0);
    if (ctx.state !== 'running') await ctx.resume();
    return ctx.state;
  }

  get now() { return this.ctx ? this.ctx.currentTime : 0; }

  // -------------------------------------------------------------------
  // Kit e catena lo-fi
  // -------------------------------------------------------------------
  /** Cambia kit: voci e catena lo-fi insieme. */
  setKit(kit) {
    this.setVoiceKit(kit);
    this.setChainKit(kit);
  }

  /** Kit usato dai trigger successivi (le voci vengono create al momento della pianificazione). */
  setVoiceKit(kit) { this.kit = kit; }

  /** Ricostruisce la catena lo-fi (bit-crush/low-pass) per il kit indicato. */
  setChainKit(kit) {
    if (this._chainKit === kit) return;
    this._chainKit = kit;
    if (this.ctx) this._buildKitChain();
  }

  _buildKitChain() {
    const ctx = this.ctx;
    const kit = this._chainKit || this.kit;
    this.kitIn.disconnect();
    (this._inserts || []).forEach((n) => n.disconnect());
    this._inserts = [];
    let node = this.kitIn;
    if (kit.lp) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = kit.lp;
      lp.Q.value = 0.5;
      node.connect(lp);
      node = lp;
      this._inserts.push(lp);
    }
    if (kit.crush) {
      const ws = ctx.createWaveShaper();
      ws.curve = crushCurve(kit.crush);
      node.connect(ws);
      node = ws;
      this._inserts.push(ws);
    }
    node.connect(this.kitOut);
  }

  // -------------------------------------------------------------------
  // Mixer ed effetti
  // -------------------------------------------------------------------
  /** Imposta volume, pan e mandate di un canale, a partire da `time`. */
  setChannel(i, tr, time) {
    if (!this.ctx) return;
    const ch = this.channels[i];
    const t = Math.max(time || 0, this.ctx.currentTime);
    if (typeof tr.vol === 'number') ch.gain.gain.setTargetAtTime(tr.vol * tr.vol * 1.2, t, 0.01);
    if (ch.pan && typeof tr.pan === 'number') ch.pan.pan.setTargetAtTime(tr.pan, t, 0.01);
    ch.rev.gain.setTargetAtTime(tr.rev || 0, t, 0.01);
    ch.dly.gain.setTargetAtTime(tr.dly || 0, t, 0.01);
  }

  /** Applica il mixer di un intero pattern. */
  applyMix(pattern, time) {
    pattern.tracks.forEach((tr, i) => this.setChannel(i, tr, time));
    if (pattern.synth) pattern.synth.tracks.forEach((tr, k) => this.setChannel(SYNTH_CH + k, tr, time));
  }

  /** Effetti master (globali). `bpm` serve per il tempo del delay. */
  setFx(fx, bpm, immediate = false) {
    this.fx = { ...this.fx, ...fx };
    if (bpm) this.bpm = bpm;
    if (!this.ctx) return;
    const t = this.ctx.currentTime, tc = immediate ? 0.001 : 0.03;
    const f = this.fx, { lp, hp } = filterFreqs(f.filter);
    this.lp.frequency.setTargetAtTime(lp, t, tc);
    this.hp.frequency.setTargetAtTime(hp, t, tc);
    this.lp.Q.value = f.filter < -0.02 ? f.res : 0.7;
    this.hp.Q.value = f.filter > 0.02 ? f.res : 0.7;
    this.master.gain.setTargetAtTime(f.master, t, tc);
    this.revOut.gain.setTargetAtTime(f.rev, t, tc);
    this.dlyOut.gain.setTargetAtTime(f.dly, t, tc);
    this.dlyFb.gain.setTargetAtTime(Math.min(0.9, f.fb), t, tc);
    this.delay.delayTime.setTargetAtTime(Math.min(4, (60 / this.bpm / 4) * f.div), t, immediate ? 0.001 : 0.05);
    if (Math.abs(f.size - this._revSize) > 0.05) {
      this._revSize = f.size;
      this.conv.buffer = impulse(this.ctx, f.size);
    }
  }

  // -------------------------------------------------------------------
  // Trigger
  // -------------------------------------------------------------------
  /**
   * Suona la traccia i all'istante time.
   * @param {number} i      indice traccia 0..7
   * @param {number} time   tempo del contesto audio
   * @param {number} vel    velocity 0..1
   * @param {object} p      { tune, decay }
   */
  trigger(i, time, vel, p) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = Math.max(time, ctx.currentTime);

    // Choke: il closed hat ferma l'open hat ancora in coda
    if (i === CH_IDX) {
      for (const g of this.chokeGains) {
        g.gain.setValueAtTime(1, t);
        g.gain.setTargetAtTime(0, t, 0.008);
      }
      this.chokeGains = [];
    }

    let out = this.channels[i].gain;
    if (i === OH_IDX) {
      const cg = ctx.createGain();
      cg.connect(out);
      out = cg;
      this.chokeGains.push(cg);
      if (this.chokeGains.length > 4) this.chokeGains.shift();
    }

    if (this.samples[i]) this._playSample(this.samples[i].buffer, out, t, vel, p);
    else this.kit.tracks[i].play(ctx, out, t, vel, p);
  }

  _playSample(buf, out, t, vel, p) {
    const ctx = this.ctx;
    const rate = Math.pow(2, (p.tune || 0) / 12);
    const full = buf.duration / rate;
    const len = Math.max(0.02, full * Math.min(1, p.decay ?? 1));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vel, t);
    if (len < full) {
      g.gain.setValueAtTime(vel, t + len * 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    }
    src.connect(g).connect(out);
    src.start(t);
    src.stop(t + len + 0.02);
  }

  // -------------------------------------------------------------------
  // Synth
  // -------------------------------------------------------------------
  /**
   * Suona una nota/accordo sulla traccia synth k (0 BASS, 1 LEAD, 2 PAD).
   * @param {number|null} dur  durata gate (s); null = tenuta fino a handle.release()
   * @returns {{release(time:number):void}|null}
   */
  playSynth(k, time, dur, notes, vel, tr, glideFrom = null) {
    const ctx = this.ctx;
    if (!ctx) return null;
    const pr = PRESETS[tr.preset];
    if (!pr) return null;
    const t = Math.max(time, ctx.currentTime);
    return playVoice(ctx, this.channels[SYNTH_CH + k].gain, t, dur, notes, vel, pr, tr, glideFrom);
  }

  /** Click del metronomo (fuori dalla catena effetti). */
  click(time, accent) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.3, time + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.04);
    o.connect(g).connect(this.comp);
    o.start(time);
    o.stop(time + 0.05);
  }

  // -------------------------------------------------------------------
  // Campioni utente (opzionale)
  // -------------------------------------------------------------------
  /** Decodifica un ArrayBuffer (ne usa una copia: decodeAudioData lo svuota). */
  loadSample(i, arrayBuffer, name = 'sample') {
    const ctx = this.init();
    return new Promise((resolve, reject) => {
      const copy = arrayBuffer.slice(0);
      const ok = (buffer) => { this.samples[i] = { buffer, name }; resolve(buffer); };
      // Firma a callback per compatibilità con Safari meno recenti
      const pr = ctx.decodeAudioData(copy, ok, reject);
      if (pr && pr.catch) pr.catch(reject);
    });
  }

  clearSample(i) { this.samples[i] = null; }
}
