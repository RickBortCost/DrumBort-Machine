/**
 * devices.js — Effetti audio come "device" (stile Ableton Live): ogni traccia ha una catena
 * ordinata di device dopo lo strumento; ogni device ha un attivatore, parametri e, dove serve,
 * Dry/Wet. Il segnale scorre da sinistra a destra.
 *
 *   state.devs[canale] = [{ id, type, on, p: { parametro: valore } }]
 *
 * Questo modulo definisce i tipi di device (parametri, valori iniziali, formattazione), converte
 * gli effetti per traccia delle versioni precedenti (drv, crush, lo, hi, flt, cmp) e costruisce i
 * nodi Web Audio di ogni device. Il motore desktop C# (desktop/Engine/Devices.cs) ha gli stessi
 * tipi e gli stessi parametri.
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const db2a = (d) => Math.pow(10, d / 20);

// ---------------------------------------------------------------------------
// Formati
// ---------------------------------------------------------------------------
const hz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${Math.round(v)} Hz`);
const dB = (v) => `${v > 0 ? '+' : ''}${(+v).toFixed(1)} dB`;
const pct = (v) => `${Math.round(v * 100)} %`;
const ms = (v) => (v >= 100 ? `${Math.round(v)} ms` : `${(+v).toFixed(1)} ms`);
const sec = (v) => `${(+v).toFixed(2)} s`;
const ratio = (v) => (v >= 19.9 ? '∞ : 1' : `${(+v).toFixed(1)} : 1`);
const num = (d) => (v) => (+v).toFixed(d);

/** Parametro numerico. curve 'log' per frequenze e tempi. */
const N = (k, label, min, max, def, fmt, curve = 'lin') => ({ k, label, kind: 'num', min, max, def, fmt, curve });
/** Parametro a scelta (menu). */
const E = (k, label, options, def) => ({ k, label, kind: 'enum', options, def });

const MIX = N('mix', 'Dry/Wet', 0, 1, 1, pct);
export const DIVS = [['1/32', 0.5], ['1/16', 1], ['1/16.', 1.5], ['1/8', 2], ['1/8.', 3], ['1/4', 4], ['1/4.', 6], ['1/2', 8], ['1', 16]];

/**
 * Tipi di device. cat = categoria nel browser; graph = disegno nel riquadro (curva EQ, filtro,
 * compressore o saturazione).
 */
export const DEVICES = {
  eq: {
    name: 'EQ Three', cat: 'EQ e filtri', graph: 'eq', desc: 'Equalizzatore a tre bande: shelf basso, campana, shelf alto',
    params: [
      N('lf', 'Low Freq', 30, 800, 200, hz, 'log'), N('lg', 'Low', -15, 15, 0, dB),
      N('mf', 'Mid Freq', 150, 10000, 1000, hz, 'log'), N('mg', 'Mid', -15, 15, 0, dB), N('mq', 'Mid Q', 0.3, 8, 1, num(2), 'log'),
      N('hf', 'High Freq', 1500, 18000, 5000, hz, 'log'), N('hg', 'High', -15, 15, 0, dB),
    ],
  },
  filter: {
    name: 'Auto Filter', cat: 'EQ e filtri', graph: 'filter', desc: 'Filtro passa-basso, passa-alto, passa-banda o notch con LFO',
    params: [
      E('type', 'Tipo', [['lowpass', 'Low-pass'], ['highpass', 'High-pass'], ['bandpass', 'Band-pass'], ['notch', 'Notch']], 'lowpass'),
      N('f', 'Freq', 20, 20000, 2000, hz, 'log'), N('res', 'Res', 0, 1, 0.2, pct),
      N('lfo', 'LFO Amount', 0, 1, 0, pct), N('rate', 'LFO Rate', 0.05, 20, 1, (v) => `${(+v).toFixed(2)} Hz`, 'log'), MIX,
    ],
  },
  comp: {
    name: 'Compressor', cat: 'Dinamica', graph: 'comp', desc: 'Compressore con soglia, rapporto, attacco, rilascio e guadagno',
    params: [
      N('thr', 'Threshold', -60, 0, -18, dB), N('ratio', 'Ratio', 1, 20, 4, ratio, 'log'),
      N('atk', 'Attack', 0.1, 100, 5, ms, 'log'), N('rel', 'Release', 10, 1000, 150, ms, 'log'),
      N('knee', 'Knee', 0, 24, 6, dB), N('gain', 'Output', -12, 24, 0, dB), MIX,
    ],
  },
  limiter: {
    name: 'Limiter', cat: 'Dinamica', desc: 'Limitatore: alza il livello senza superare il tetto',
    params: [N('gain', 'Gain', 0, 24, 0, dB), N('ceil', 'Ceiling', -12, 0, -0.3, dB), N('rel', 'Release', 10, 1000, 100, ms, 'log')],
  },
  sat: {
    name: 'Saturator', cat: 'Distorsione', graph: 'curve', desc: 'Saturazione con sovracampionamento: analogica, dura, valvolare, wavefold',
    params: [
      E('type', 'Tipo', [['soft', 'Analog'], ['hard', 'Hard Clip'], ['tube', 'Tube'], ['fold', 'Fold']], 'soft'),
      N('drive', 'Drive', 0, 36, 6, dB), N('out', 'Output', -36, 6, 0, dB), MIX,
    ],
  },
  redux: {
    name: 'Bit Reduction', cat: 'Distorsione', desc: 'Riduzione di bit con filtro di uscita',
    params: [N('bits', 'Bit', 2, 16, 8, (v) => `${Math.round(v)} bit`), N('tone', 'Filtro', 500, 20000, 20000, hz, 'log'), MIX],
  },
  delay: {
    name: 'Delay', cat: 'Delay e riverberi', desc: 'Delay a tempo con feedback e filtro',
    params: [
      E('div', 'Tempo', DIVS.map(([l], i) => [String(i), l]), '4'),
      N('fb', 'Feedback', 0, 0.95, 0.4, pct), N('tone', 'Filtro', 500, 16000, 5000, hz, 'log'), N('mix', 'Dry/Wet', 0, 1, 0.3, pct),
    ],
  },
  reverb: {
    name: 'Reverb', cat: 'Delay e riverberi', desc: 'Riverbero a convoluzione',
    params: [
      N('size', 'Decay', 0.3, 8, 2, sec, 'log'), N('pre', 'Predelay', 0, 100, 10, ms),
      N('tone', 'Hi Cut', 1000, 20000, 9000, hz, 'log'), N('mix', 'Dry/Wet', 0, 1, 0.3, pct),
    ],
  },
  chorus: {
    name: 'Chorus', cat: 'Modulazione', desc: 'Chorus stereo: due linee di ritardo modulate in controfase',
    params: [N('rate', 'Rate', 0.05, 5, 0.8, (v) => `${(+v).toFixed(2)} Hz`, 'log'), N('depth', 'Depth', 0, 1, 0.5, pct), N('dly', 'Delay', 5, 30, 12, ms), N('mix', 'Dry/Wet', 0, 1, 0.5, pct)],
  },
  utility: {
    name: 'Utility', cat: 'Utilità', desc: 'Guadagno, ampiezza stereo e inversione di fase',
    params: [N('gain', 'Gain', -36, 12, 0, dB), N('width', 'Width', 0, 2, 1, (v) => `${Math.round(v * 100)} %`), E('phase', 'Fase', [['0', 'Normale'], ['1', 'Invertita']], '0')],
  },
};
export const CATEGORIES = ['EQ e filtri', 'Dinamica', 'Distorsione', 'Delay e riverberi', 'Modulazione', 'Utilità'];

let seq = 0;
const uid = () => `d${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Nuovo device con i valori iniziali. */
export function newDevice(type, p = {}) {
  const d = DEVICES[type];
  const params = {};
  for (const x of d.params) params[x.k] = x.def;
  return { id: uid(), type, on: true, p: { ...params, ...p } };
}

/** Valida una catena (progetti salvati, sincronizzazione). */
export function normalizeChain(a) {
  if (!Array.isArray(a)) return [];
  return a.filter((d) => d && DEVICES[d.type]).slice(0, 16).map((d) => {
    const def = DEVICES[d.type];
    const p = {};
    for (const x of def.params) {
      const v = d.p ? d.p[x.k] : undefined;
      if (x.kind === 'enum') p[x.k] = x.options.some(([o]) => o === String(v)) ? String(v) : x.def;
      else p[x.k] = Number.isFinite(+v) && v !== null && v !== '' ? clamp(+v, x.min, x.max) : x.def;
    }
    return { id: typeof d.id === 'string' && d.id ? d.id.slice(0, 24) : uid(), type: d.type, on: d.on !== false, p, ...(d.name ? { name: String(d.name).slice(0, 24) } : {}), ...(d.fold ? { fold: true } : {}) };
  });
}

// ---------------------------------------------------------------------------
// Effetti delle versioni precedenti (drv, crush, lo, hi, flt, cmp) ↔ device
// ---------------------------------------------------------------------------
const lpOf = (f) => 20000 * Math.pow(80 / 20000, -f);
const hpOf = (f) => 20 * Math.pow(6000 / 20, f);

/** Catena equivalente agli effetti per traccia delle versioni precedenti. */
export function legacyChain(tr) {
  const out = [];
  const drv = tr.drv || 0, crush = tr.crush || 0, lo = tr.lo || 0, hi = tr.hi || 0, flt = tr.flt || 0, cmp = tr.cmp || 0;
  if (drv > 0) out.push(newDevice('sat', { drive: +(20 * Math.log10(1 + drv * 12)).toFixed(1), out: +(20 * Math.log10(1 / (1 + drv * 1.5))).toFixed(1) }));
  if (crush > 0) out.push(newDevice('redux', { bits: crush }));
  if (lo || hi) out.push(newDevice('eq', { lg: lo, hg: hi }));
  if (Math.abs(flt) > 0.02) out.push(newDevice('filter', flt < 0 ? { type: 'lowpass', f: Math.round(lpOf(flt)), res: 0.04 } : { type: 'highpass', f: Math.round(hpOf(flt)), res: 0.04 }));
  if (cmp > 0) out.push(newDevice('comp', { thr: Math.round(-6 - 30 * cmp), ratio: +(1.5 + 8.5 * cmp).toFixed(1), atk: 5, rel: 150, knee: 6 }));
  return out;
}
export const LEGACY_KEYS = ['drv', 'crush', 'lo', 'hi', 'flt', 'cmp'];
const QUICK = { drv: 'sat', crush: 'redux', lo: 'eq', hi: 'eq', flt: 'filter', cmp: 'comp' };

/** Valore "rapido" (cursori del telefono, macro) letto dalla catena. */
export function quickGet(chain, k) {
  const d = (chain || []).find((x) => x.type === QUICK[k] && x.on);
  if (!d) return 0;
  const p = d.p;
  switch (k) {
    case 'drv': return clamp((Math.pow(10, p.drive / 20) - 1) / 12, 0, 1);
    case 'crush': return Math.round(p.bits) > 12 ? 0 : Math.round(p.bits);
    case 'lo': return p.lg;
    case 'hi': return p.hg;
    case 'flt':
      if (p.type === 'lowpass') return clamp(-Math.log(p.f / 20000) / Math.log(20000 / 80), -1, 0);
      if (p.type === 'highpass') return clamp(Math.log(p.f / 20) / Math.log(300), 0, 1);
      return 0;
    case 'cmp': return clamp((-6 - p.thr) / 30, 0, 1);
    default: return 0;
  }
}

/** Scrive un valore "rapido" nella catena (crea il device se manca, lo spegne a zero). */
export function quickSet(chain, k, v) {
  const type = QUICK[k];
  let d = chain.find((x) => x.type === type);
  const neutral = k === 'crush' ? v < 4 : Math.abs(v) < (k === 'flt' ? 0.02 : 1e-6);
  if (!d) {
    if (neutral) return chain;
    d = newDevice(type);
    if (type === 'eq') { d.p.lg = 0; d.p.hg = 0; }
    chain.push(d);
  }
  const p = d.p;
  switch (k) {
    case 'drv': p.drive = +(20 * Math.log10(1 + v * 12)).toFixed(1); p.out = +(20 * Math.log10(1 / (1 + v * 1.5))).toFixed(1); p.type = 'soft'; break;
    case 'crush': p.bits = Math.round(v) || 8; break;
    case 'lo': p.lg = v; break;
    case 'hi': p.hg = v; break;
    case 'flt': if (!neutral) { p.type = v < 0 ? 'lowpass' : 'highpass'; p.f = Math.round(v < 0 ? lpOf(v) : hpOf(v)); } break;
    case 'cmp': p.thr = Math.round(-6 - 30 * v); p.ratio = +(1.5 + 8.5 * v).toFixed(1); break;
    default: break;
  }
  d.on = type === 'eq' ? (p.lg !== 0 || p.hg !== 0 || p.mg !== 0) : !neutral;
  return chain;
}

// ---------------------------------------------------------------------------
// Curve di saturazione e quantizzazione
// ---------------------------------------------------------------------------
const curves = new Map();
/** Curva del Saturator: x ∈ [−1, 1] → y, con guadagno di ingresso `drive` dB. */
export function satCurve(type, drive) {
  const key = `${type}|${Math.round(drive * 10)}`;
  if (curves.has(key)) return curves.get(key);
  const n = 4096, c = new Float32Array(n), g = db2a(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, u = x * g;
    let y;
    if (type === 'hard') y = clamp(u, -1, 1);
    else if (type === 'tube') y = ((Math.tanh(u + 0.25) - Math.tanh(0.25)) / (1 - Math.tanh(0.25))) * 0.7;   // asimmetrica: armoniche pari
    else if (type === 'fold') y = Math.sin(u * Math.PI / 2);
    else y = Math.tanh(u);
    c[i] = y;
  }
  if (curves.size > 200) curves.clear();
  curves.set(key, c);
  return c;
}
const crushes = new Map();
export function bitCurve(bits) {
  const b = Math.round(bits);
  if (!crushes.has(b)) {
    const n = 65536, c = new Float32Array(n), steps = Math.pow(2, b - 1);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.round(x * steps) / steps; }
    crushes.set(b, c);
  }
  return crushes.get(b);
}

/** Risposta all'impulso del Reverb (come quella delle mandate). */
function impulse(ctx, seconds) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  return b;
}

/** Fattore Q dei filtri dell'Auto Filter dalla risonanza 0..1. */
export const filterQ = (type, res) => (type === 'lowpass' || type === 'highpass' ? res * 24 : 0.5 + res * 15);
/** Secondi del Delay per la suddivisione `div` (indice in DIVS). */
export const delaySec = (div, bpm) => Math.min(4, (60 / bpm / 4) * DIVS[clamp(+div | 0, 0, DIVS.length - 1)][1]);

// ---------------------------------------------------------------------------
// Costruzione Web Audio
// ---------------------------------------------------------------------------
/**
 * Crea i nodi di un device. Ritorna { input, output, set(p, t, env), stop() }.
 * Il Dry/Wet è un incrocio lineare tra il segnale diretto e quello elaborato.
 */
export function buildDevice(ctx, dev, env) {
  const input = ctx.createGain(), output = ctx.createGain();
  const nodes = [];
  const mk = (n) => { nodes.push(n); return n; };
  let dry = null, wet = null;
  /** Ingresso/uscita della parte elaborata, con il Dry/Wet. */
  const wetPath = (first, last) => {
    dry = mk(ctx.createGain()); wet = mk(ctx.createGain());
    input.connect(dry).connect(output);
    input.connect(first); last.connect(wet).connect(output);
  };
  const setMix = (m, t) => { if (dry) { dry.gain.setTargetAtTime(1 - m, t, 0.02); wet.gain.setTargetAtTime(m, t, 0.02); } };
  const tc = 0.02;
  let set;
  let srcs = [];

  switch (dev.type) {
    case 'eq': {
      const lo = mk(ctx.createBiquadFilter()), mid = mk(ctx.createBiquadFilter()), hi = mk(ctx.createBiquadFilter());
      lo.type = 'lowshelf'; mid.type = 'peaking'; hi.type = 'highshelf';
      input.connect(lo).connect(mid).connect(hi).connect(output);
      set = (p, t) => {
        lo.frequency.setTargetAtTime(p.lf, t, tc); lo.gain.setTargetAtTime(p.lg, t, tc);
        mid.frequency.setTargetAtTime(p.mf, t, tc); mid.gain.setTargetAtTime(p.mg, t, tc); mid.Q.setTargetAtTime(p.mq, t, tc);
        hi.frequency.setTargetAtTime(p.hf, t, tc); hi.gain.setTargetAtTime(p.hg, t, tc);
      };
      break;
    }
    case 'filter': {
      const f = mk(ctx.createBiquadFilter()), lfo = mk(ctx.createOscillator()), amt = mk(ctx.createGain());
      lfo.connect(amt).connect(f.detune);
      lfo.start(); srcs = [lfo];
      wetPath(f, f);
      set = (p, t) => {
        f.type = p.type;
        f.frequency.setTargetAtTime(p.f, t, tc);
        f.Q.setTargetAtTime(filterQ(p.type, p.res), t, tc);
        lfo.frequency.setTargetAtTime(p.rate, t, tc);
        amt.gain.setTargetAtTime(p.lfo * 2400, t, tc);
        setMix(p.mix, t);
      };
      break;
    }
    case 'comp': {
      const c = mk(ctx.createDynamicsCompressor()), g = mk(ctx.createGain());
      c.connect(g);
      wetPath(c, g);
      set = (p, t) => {
        c.threshold.setTargetAtTime(p.thr, t, tc); c.ratio.setTargetAtTime(p.ratio, t, tc); c.knee.setTargetAtTime(p.knee, t, tc);
        c.attack.setTargetAtTime(p.atk / 1000, t, tc); c.release.setTargetAtTime(p.rel / 1000, t, tc);
        g.gain.setTargetAtTime(db2a(p.gain), t, tc);
        setMix(p.mix, t);
      };
      break;
    }
    case 'limiter': {
      const pre = mk(ctx.createGain()), c = mk(ctx.createDynamicsCompressor());
      c.knee.value = 0; c.ratio.value = 20; c.attack.value = 0.001;
      input.connect(pre).connect(c).connect(output);
      set = (p, t) => {
        pre.gain.setTargetAtTime(db2a(p.gain), t, tc);
        c.threshold.setTargetAtTime(p.ceil, t, tc); c.release.setTargetAtTime(p.rel / 1000, t, tc);
      };
      break;
    }
    case 'sat': {
      const ws = mk(ctx.createWaveShaper()), g = mk(ctx.createGain());
      ws.oversample = '4x';
      ws.connect(g);
      wetPath(ws, g);
      set = (p, t) => {
        ws.curve = satCurve(p.type, p.drive);
        g.gain.setTargetAtTime(db2a(p.out), t, tc);
        setMix(p.mix, t);
      };
      break;
    }
    case 'redux': {
      const ws = mk(ctx.createWaveShaper()), f = mk(ctx.createBiquadFilter());
      f.type = 'lowpass'; f.Q.value = 0;
      ws.connect(f);
      wetPath(ws, f);
      set = (p, t) => {
        ws.curve = bitCurve(p.bits);
        f.frequency.setTargetAtTime(p.tone, t, tc);
        setMix(p.mix, t);
      };
      break;
    }
    case 'delay': {
      const d = mk(ctx.createDelay(4)), fb = mk(ctx.createGain()), tone = mk(ctx.createBiquadFilter());
      tone.type = 'lowpass';
      d.connect(tone).connect(fb).connect(d);
      wetPath(d, tone);
      set = (p, t, e) => {
        d.delayTime.setTargetAtTime(delaySec(p.div, e.bpm), t, 0.05);
        fb.gain.setTargetAtTime(p.fb, t, tc);
        tone.frequency.setTargetAtTime(p.tone, t, tc);
        setMix(p.mix, t);
      };
      break;
    }
    case 'reverb': {
      const pre = mk(ctx.createDelay(0.2)), conv = mk(ctx.createConvolver()), tone = mk(ctx.createBiquadFilter());
      tone.type = 'lowpass'; tone.Q.value = 0;
      pre.connect(conv).connect(tone);
      wetPath(pre, tone);
      let size = -1;
      set = (p, t) => {
        if (Math.abs(p.size - size) > 0.05) { size = p.size; conv.buffer = impulse(ctx, p.size); }
        pre.delayTime.setTargetAtTime(p.pre / 1000, t, tc);
        tone.frequency.setTargetAtTime(p.tone, t, tc);
        setMix(p.mix, t);
      };
      break;
    }
    case 'chorus': {
      // Due ritardi (sinistro e destro) modulati dallo stesso LFO in controfase
      const up = mk(ctx.createGain());
      up.channelCount = 2; up.channelCountMode = 'explicit'; up.channelInterpretation = 'speakers';
      const split = mk(ctx.createChannelSplitter(2)), merge = mk(ctx.createChannelMerger(2));
      const dl = mk(ctx.createDelay(0.1)), dr = mk(ctx.createDelay(0.1));
      const lfo = mk(ctx.createOscillator()), al = mk(ctx.createGain()), ar = mk(ctx.createGain());
      lfo.connect(al).connect(dl.delayTime); lfo.connect(ar).connect(dr.delayTime);
      lfo.start(); srcs = [lfo];
      up.connect(split);
      split.connect(dl, 0); split.connect(dr, 1);
      dl.connect(merge, 0, 0); dr.connect(merge, 0, 1);
      wetPath(up, merge);
      set = (p, t) => {
        lfo.frequency.setTargetAtTime(p.rate, t, tc);
        const base = p.dly / 1000, depth = p.depth * Math.min(base * 0.8, 0.006);
        dl.delayTime.setTargetAtTime(base, t, tc); dr.delayTime.setTargetAtTime(base, t, tc);
        al.gain.setTargetAtTime(depth, t, tc); ar.gain.setTargetAtTime(-depth, t, tc);
        setMix(p.mix, t);
      };
      break;
    }
    case 'utility': {
      // Matrice di ampiezza stereo: L' = a·L + b·R, R' = b·L + a·R (a = (1 + w) / 2, b = (1 − w) / 2)
      const up = mk(ctx.createGain());
      up.channelCount = 2; up.channelCountMode = 'explicit'; up.channelInterpretation = 'speakers';
      const split = mk(ctx.createChannelSplitter(2)), merge = mk(ctx.createChannelMerger(2));
      const ll = mk(ctx.createGain()), rl = mk(ctx.createGain()), lr = mk(ctx.createGain()), rr = mk(ctx.createGain());
      const g = mk(ctx.createGain());
      input.connect(up).connect(split);
      split.connect(ll, 0); split.connect(rl, 1); split.connect(lr, 0); split.connect(rr, 1);
      ll.connect(merge, 0, 0); rl.connect(merge, 0, 0); lr.connect(merge, 0, 1); rr.connect(merge, 0, 1);
      merge.connect(g).connect(output);
      set = (p, t) => {
        const a = (1 + p.width) / 2, b = (1 - p.width) / 2;
        ll.gain.setTargetAtTime(a, t, tc); rr.gain.setTargetAtTime(a, t, tc);
        rl.gain.setTargetAtTime(b, t, tc); lr.gain.setTargetAtTime(b, t, tc);
        g.gain.setTargetAtTime(db2a(p.gain) * (p.phase === '1' ? -1 : 1), t, tc);
      };
      break;
    }
    default:
      input.connect(output);
      set = () => {};
  }
  return {
    input, output, type: dev.type,
    set: (p, t, e) => set(p, t, e),
    stop() {
      srcs.forEach((s) => { try { s.stop(); } catch (_) { /* già fermo */ } });
      [input, output, ...nodes].forEach((n) => { try { n.disconnect(); } catch (_) { /* già scollegato */ } });
    },
  };
}
