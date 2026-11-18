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
import { PRESETS, SYNTH_TRACKS as SYNTH_DEFS, playVoice, voiceParams, releaseTime } from './synth.js';
import { VoiceCache } from './voicecache.js';
import { synthEvent, arpEvents } from './sequencer.js';

const TRACKS = 8;
const SYNTH_TRACKS = SYNTH_DEFS.length;
export const SYNTH_CH = TRACKS;   // canali 8-11: BASS, LEAD, PAD, KEYS
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
  sc: 0,          // sidechain: quanto la cassa abbassa i synth (0-1)
  scRel: 0.18,    // sidechain: tempo di ritorno (s)
});

const driveCache = new Map();
/** Curva di saturazione tanh normalizzata (insert per traccia). */
function driveCurve(amount) {
  const key = Math.round(amount * 20);
  if (!driveCache.has(key)) {
    const n = 2048, c = new Float32Array(n), k = 1 + amount * 12;
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * k) / Math.tanh(k); }
    driveCache.set(key, c);
  }
  return driveCache.get(key);
}

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
    this.voices = new Array(TRACKS).fill(null);   // ultima voce per strumento { g, src }
    this.mono = [null, null];                     // ultima nota BASS / LEAD
    this.polyVoices = [[], [], [], []];           // accordi attivi per traccia synth
    this.cache = null;                            // VoiceCache (solo live)
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
      this.cache = new VoiceCache(ctx);
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

    // --- Sidechain: bus dei synth abbassato dalla cassa ---
    this.duck = ctx.createGain();
    this.duck.connect(this.fxIn);

    // --- Canali con insert e mandate post-pan (0-7 batteria → bus kit, 8-11 synth → sidechain) ---
    for (let i = 0; i < TRACKS + SYNTH_TRACKS; i++) {
      const gain = ctx.createGain();
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
      const post = pan;
      gain.connect(pan);
      post.connect(i < TRACKS ? this.kitIn : this.duck);
      const rev = ctx.createGain();
      const dly = ctx.createGain();
      rev.gain.value = 0;
      dly.gain.value = 0;
      post.connect(rev).connect(this.revIn);
      post.connect(dly).connect(this.dlyIn);
      this.channels.push({ gain, pan: pan.pan ? pan : null, out: pan, ins: [], drv: 0, crush: 0 });
      this.channels[i].rev = rev;
      this.channels[i].dly = dly;
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
    this._setInserts(ch, Math.round((tr.drv || 0) * 20) / 20, tr.crush || 0);
  }

  /** Insert per traccia: drive (saturazione) e bit crusher; ricostruiti solo se cambiano. */
  _setInserts(ch, drv, crush) {
    if (ch.drv === drv && ch.crush === crush) return;
    ch.drv = drv; ch.crush = crush;
    ch.gain.disconnect();
    ch.ins.forEach((n) => n.disconnect());
    ch.ins = [];
    let node = ch.gain;
    if (drv > 0) {
      const ws = this.ctx.createWaveShaper();
      ws.curve = driveCurve(drv);
      ws.oversample = '2x';
      const comp = this.ctx.createGain();
      comp.gain.value = 1 / (1 + drv * 1.5);     // compensa il volume
      node.connect(ws).connect(comp);
      node = comp;
      ch.ins.push(ws, comp);
    }
    if (crush > 0) {
      const ws = this.ctx.createWaveShaper();
      ws.curve = crushCurve(crush);
      node.connect(ws);
      node = ws;
      ch.ins.push(ws);
    }
    node.connect(ch.out);
  }

  /** Applica il mixer di un intero pattern. */
  applyMix(pattern, time) {
    pattern.tracks.forEach((tr, i) => this.setChannel(i, tr, time));
    if (pattern.synth) pattern.synth.tracks.forEach((tr, k) => this.setChannel(SYNTH_CH + k, tr, time));
    this.prewarm(pattern);
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

    // Sidechain: la cassa abbassa i synth e li fa "respirare" a tempo
    if (i === 0 && this.fx.sc > 0) {
      const d = this.duck.gain;
      d.cancelScheduledValues(t);
      d.setValueAtTime(Math.max(0.05, 1 - 0.95 * this.fx.sc * Math.min(1, vel / 0.62)), t);
      d.setTargetAtTime(1, t + 0.01, Math.max(0.02, this.fx.scRel / 3));
    }

    // Una voce per strumento (come le drum machine hardware): il nuovo colpo sfuma il precedente.
    // Il closed hat strozza anche l'open hat.
    if (this.voices[i]) this._kill(this.voices[i], t);
    if (i === CH_IDX && this.voices[OH_IDX]) { this._kill(this.voices[OH_IDX], t, 0.008); this.voices[OH_IDX] = null; }

    const g = ctx.createGain();
    g.connect(this.channels[i].gain);
    const v = { g, src: null };
    this.voices[i] = v;

    if (this.samples[i]) { v.src = this._playSample(this.samples[i].buffer, g, t, vel, p); return; }
    const key = this.cache && this._drumKey(this.kit, i, p);
    const buf = key && this.cache.get(key);
    if (buf) {
      // Voce pre-renderizzata: 1 sorgente invece di oscillatori/filtri
      const src = ctx.createBufferSource();
      src.buffer = buf;
      g.gain.value = vel;
      src.connect(g);
      src.start(t);
      v.src = src;
    } else {
      this.kit.tracks[i].play(ctx, g, t, vel, p);
      if (key) this._prerenderDrum(this.kit, i, p);
    }
  }

  /** Sfuma e ferma una voce (voice stealing). */
  _kill(v, t, tc = 0.004) {
    v.g.gain.setTargetAtTime(0, t, tc);
    if (v.src) { try { v.src.stop(t + tc * 10); } catch (_) { /* già fermo */ } }
    if (v.handle && v.handle.kill) v.handle.kill(t);
  }

  _drumKey(kit, i, p) { return `d|${kit.id}|${i}|${p.tune || 0}|${p.decay ?? 1}`; }

  _prerenderDrum(kit, i, p) {
    const tune = p.tune || 0, decay = p.decay ?? 1;
    this.cache.request(this._drumKey(kit, i, p), Math.min(6, 0.3 + 1.8 * decay),
      (octx, out) => kit.tracks[i].play(octx, out, 0, 1, { tune, decay }));
  }

  /** Pre-renderizza in background le voci del pattern: batteria (kit corrente) e note synth. */
  prewarm(pattern, kit = this.kit) {
    if (!this.cache) return;
    pattern.tracks.forEach((tr, i) => { if (!this.samples[i]) this._prerenderDrum(kit, i, tr); });
    if (!pattern.synth) return;
    pattern.synth.tracks.forEach((tr, k) => {
      if (tr.arp && tr.arp.on) {
        // Note dell'arpeggiatore: un giro completo (fino a 64 tick)
        for (let tick = 0; tick < 64; tick++) for (const e of arpEvents(pattern, k, tick)) this._prerenderSynth(tr, e.notes, e.dur, e.vel, null);
        return;
      }
      for (let s = 0; s < tr.len; s++) {
        const ev = synthEvent(pattern, k, s);
        if (ev) this._prerenderSynth(ev.params, ev.notes, ev.dur, ev.vel, ev.glideFrom);
      }
    });
  }

  _synthKey(tr, notes, dur, vel, glideFrom) {
    const p = voiceParams(tr);
    return `s|${tr.preset}|${notes.join(',')}|${Math.round(dur * 1000)}|${vel.toFixed(3)}|${p.cut}|${p.res}|${p.env}|${p.dec}|${p.atk}|${p.rel}|${p.lfo}|${p.rate}|${glideFrom ?? ''}`;
  }

  _prerenderSynth(tr, notes, dur, vel, glideFrom) {
    const pr = PRESETS[tr.preset];
    if (!pr) return;
    const params = voiceParams(tr);
    const rel = releaseTime(pr, params);
    this.cache.request(this._synthKey(tr, notes, dur, vel, glideFrom), dur + rel * 1.7 + 0.1,
      (octx, o) => playVoice(octx, o, 0, dur, notes, vel, pr, params, glideFrom));
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
    return src;
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
    const out = this.channels[SYNTH_CH + k].gain;

    // Polifonia limitata: BASS e LEAD monofonici, al massimo 3 accordi PAD sovrapposti
    const mono = SYNTH_DEFS[k].mono;
    if (mono) {
      if (this.mono[k]) this._kill(this.mono[k], t, 0.006);
    } else {
      this.polyVoices[k] = this.polyVoices[k].filter((v) => v.end > t);
      while (this.polyVoices[k].length >= 3) this._kill(this.polyVoices[k].shift(), t, 0.04);
    }

    const g = ctx.createGain();
    g.connect(out);
    const rel = releaseTime(pr, voiceParams(tr));
    let v;
    // Note del sequencer (durata nota): cache; note tenute dal vivo: sempre sintetizzate
    const key = dur != null && this.cache ? this._synthKey(tr, notes, dur, vel, glideFrom) : null;
    const buf = key && this.cache.get(key);
    if (buf) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(g);
      src.start(t);
      v = { g, src, end: t + buf.duration };
    } else {
      const handle = playVoice(ctx, g, t, dur, notes, vel, pr, voiceParams(tr), glideFrom);
      v = { g, handle, end: dur != null ? t + dur + rel * 1.7 : Infinity };
      if (key) this._prerenderSynth(tr, notes, dur, vel, glideFrom);
    }
    if (mono) this.mono[k] = v; else this.polyVoices[k].push(v);
    return v.handle || { release() {}, kill: (at) => this._kill(v, at) };
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
