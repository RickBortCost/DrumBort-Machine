/**
 * recorder.js — Cattura PCM da un nodo audio: registrazione dell'uscita in WAV e
 * campionamento dal microfono. Usa un AudioWorklet (modulo creato al volo);
 * fallback su ScriptProcessorNode dove l'AudioWorklet non è disponibile.
 */

const WORKLET = `
class DrumbortCapture extends AudioWorkletProcessor {
  constructor() { super(); this.on = true; this.port.onmessage = (e) => { if (e.data === 'stop') this.on = false; }; }
  process(inputs) {
    const inp = inputs[0];
    if (inp && inp.length) this.port.postMessage(inp.map((c) => c.slice(0)));
    return this.on;
  }
}
registerProcessor('drumbort-capture', DrumbortCapture);`;

const loaded = new WeakSet();

async function captureNode(ctx, channels, onData) {
  if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    try {
      if (!loaded.has(ctx)) {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
        await ctx.audioWorklet.addModule(url);
        loaded.add(ctx);
      }
      const node = new AudioWorkletNode(ctx, 'drumbort-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: channels, channelCountMode: 'explicit' });
      node.port.onmessage = (e) => onData(e.data);
      return { node, stop: () => node.port.postMessage('stop') };
    } catch (_) { /* fallback */ }
  }
  const sp = ctx.createScriptProcessor(4096, channels, channels);
  sp.onaudioprocess = (e) => {
    const b = e.inputBuffer, out = [];
    for (let c = 0; c < b.numberOfChannels; c++) out.push(b.getChannelData(c).slice(0));
    onData(out);
  };
  return { node: sp, stop: () => { sp.onaudioprocess = null; } };
}

/** Unisce i blocchi catturati in un AudioBuffer. */
function toBuffer(ctx, chunks, channels) {
  const len = chunks.reduce((a, c) => a + c[0].length, 0);
  const buf = ctx.createBuffer(channels, Math.max(1, len), ctx.sampleRate);
  for (let ch = 0; ch < channels; ch++) {
    const d = buf.getChannelData(ch);
    let o = 0;
    for (const c of chunks) { d.set(c[Math.min(ch, c.length - 1)], o); o += c[0].length; }
  }
  return buf;
}

/**
 * Registra ciò che passa da `source` (es. uscita master).
 * @returns {Promise<{ stop(): AudioBuffer, seconds(): number }>}
 */
export async function recordNode(ctx, source, channels = 2, maxSeconds = 600) {
  const chunks = [];
  let frames = 0;
  const cap = await captureNode(ctx, channels, (data) => {
    if (frames > maxSeconds * ctx.sampleRate) return;
    chunks.push(data);
    frames += data[0].length;
  });
  // Il nodo deve essere collegato a una destinazione per essere elaborato: uscita muta
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(cap.node);
  cap.node.connect(mute).connect(ctx.destination);
  return {
    seconds: () => frames / ctx.sampleRate,
    stop() {
      cap.stop();
      try { source.disconnect(cap.node); } catch (_) { /* già scollegato */ }
      cap.node.disconnect();
      mute.disconnect();
      return toBuffer(ctx, chunks, channels);
    },
  };
}

/**
 * Registra dal microfono (mono). Su iOS passa temporaneamente la sessione audio in play-and-record.
 * @returns {Promise<{ stop(): Promise<AudioBuffer> }>}
 */
export async function recordMic(ctx, maxSeconds = 6) {
  const prevSession = navigator.audioSession && navigator.audioSession.type;
  try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch (_) { /* n/a */ }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const src = ctx.createMediaStreamSource(stream);
  const rec = await recordNode(ctx, src, 1, maxSeconds);
  return {
    seconds: rec.seconds,
    async stop() {
      const buf = rec.stop();
      stream.getTracks().forEach((t) => t.stop());
      try { if (navigator.audioSession && prevSession) navigator.audioSession.type = prevSession; } catch (_) { /* n/a */ }
      return trimSample(ctx, buf);
    },
  };
}

/** Taglia silenzio iniziale/finale, normalizza e applica una breve dissolvenza. */
export function trimSample(ctx, buf, threshold = 0.02) {
  const d = buf.getChannelData(0);
  let pk = 0;
  for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
  if (pk < 1e-4) return null;
  const th = Math.max(threshold * pk, 1e-4);
  let a = 0, b = d.length - 1;
  while (a < d.length && Math.abs(d[a]) < th) a++;
  while (b > a && Math.abs(d[b]) < th * 0.5) b--;
  a = Math.max(0, a - Math.floor(ctx.sampleRate * 0.003));
  const len = Math.max(1, b - a + 1);
  const out = ctx.createBuffer(1, len, ctx.sampleRate);
  const o = out.getChannelData(0), g = 0.9 / pk, fade = Math.min(len, Math.floor(ctx.sampleRate * 0.01));
  for (let i = 0; i < len; i++) o[i] = d[a + i] * g * (i > len - fade ? (len - i) / fade : 1);
  return out;
}
