/**
 * engine.js — AudioContext, mixer a 8 canali, catena master e trigger delle voci.
 *
 * Catena: voce → canale (gain → pan) → kitIn → [low-pass] → [bit-crusher] → kitOut
 *         → master gain → DynamicsCompressor → destination
 */

import { KITS } from './kits.js';

const TRACKS = 8;
const CH_IDX = 3;   // Closed Hat
const OH_IDX = 4;   // Open Hat (strozzato dal Closed Hat)

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

export class Engine {
  constructor() {
    this.ctx = null;
    this.kit = KITS[0];
    this.samples = new Array(TRACKS).fill(null); // AudioBuffer utente per traccia
    this.chokeGains = [];
    this.channels = [];
  }

  // -------------------------------------------------------------------
  // Inizializzazione (va chiamata dentro un gesto utente su iOS)
  // -------------------------------------------------------------------
  init() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    // iOS 17+: riproduci anche con l'interruttore silenzioso attivo
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) { /* n/a */ }
    const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));

    // --- Master ---
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -12;
    this.comp.knee.value = 8;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.2;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(this.comp).connect(ctx.destination);

    // --- Bus kit (inserti lo-fi) ---
    this.kitIn = ctx.createGain();
    this.kitIn.gain.value = 0.85;
    this.kitOut = ctx.createGain();
    this.kitOut.connect(this.master);

    // --- Canali ---
    for (let i = 0; i < TRACKS; i++) {
      const gain = ctx.createGain();
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pan) gain.connect(pan).connect(this.kitIn);
      else gain.connect(this.kitIn);
      this.channels.push({ gain, pan });
    }
    this._buildKitChain();
    return ctx;
  }

  /** Sblocca l'audio su iOS: resume + buffer silenzioso. */
  async unlock() {
    const ctx = this.init();
    const b = ctx.createBuffer(1, 1, 22050);
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(ctx.destination);
    s.start(0);
    if (ctx.state !== 'running') await ctx.resume();
    return ctx.state;
  }

  get now() { return this.ctx ? this.ctx.currentTime : 0; }

  // -------------------------------------------------------------------
  // Kit e catena lo-fi
  // -------------------------------------------------------------------
  setKit(kit) {
    this.kit = kit;
    if (this.ctx) this._buildKitChain();
  }

  _buildKitChain() {
    const ctx = this.ctx;
    this.kitIn.disconnect();
    (this._inserts || []).forEach((n) => n.disconnect());
    this._inserts = [];
    let node = this.kitIn;
    if (this.kit.lp) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = this.kit.lp;
      lp.Q.value = 0.5;
      node.connect(lp);
      node = lp;
      this._inserts.push(lp);
    }
    if (this.kit.crush) {
      const ws = ctx.createWaveShaper();
      ws.curve = crushCurve(this.kit.crush);
      node.connect(ws);
      node = ws;
      this._inserts.push(ws);
    }
    node.connect(this.kitOut);
  }

  // -------------------------------------------------------------------
  // Mixer
  // -------------------------------------------------------------------
  setChannel(i, { vol, pan }) {
    if (!this.ctx) return;
    const ch = this.channels[i], t = this.ctx.currentTime;
    if (typeof vol === 'number') ch.gain.gain.setTargetAtTime(vol * vol * 1.2, t, 0.01);
    if (ch.pan && typeof pan === 'number') ch.pan.pan.setTargetAtTime(pan, t, 0.01);
  }

  // -------------------------------------------------------------------
  // Trigger
  // -------------------------------------------------------------------
  /**
   * Suona la traccia i all'istante time.
   * @param {number} i      indice traccia 0..7
   * @param {number} time   tempo AudioContext
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

    if (this.samples[i]) this._playSample(this.samples[i], out, t, vel, p);
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
  // Campioni utente (opzionale)
  // -------------------------------------------------------------------
  loadSample(i, arrayBuffer) {
    const ctx = this.init();
    return new Promise((resolve, reject) => {
      // Firma a callback per compatibilità con Safari meno recenti
      const pr = ctx.decodeAudioData(arrayBuffer, (b) => { this.samples[i] = b; resolve(b); }, reject);
      if (pr && pr.catch) pr.catch(reject);
    });
  }

  clearSample(i) { this.samples[i] = null; }
}
