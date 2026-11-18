/**
 * voicecache.js — Cache delle voci pre-renderizzate.
 *
 * Una voce (colpo di batteria o nota del sequencer) viene sintetizzata una volta in un
 * OfflineAudioContext e poi riprodotta come AudioBuffer: 1 nodo sorgente invece di decine
 * di oscillatori/filtri. Il render avviene in background, una voce alla volta; finché
 * il buffer non è pronto la voce viene sintetizzata dal vivo.
 * LRU con limite di memoria.
 */

const OAC = typeof window !== 'undefined' && (window.OfflineAudioContext || window.webkitOfflineAudioContext);

/** Rimuove il silenzio in coda (risparmia memoria). */
function trim(ctx, buf) {
  const d = buf.getChannelData(0);
  let end = d.length - 1;
  while (end > 0 && Math.abs(d[end]) < 1e-4) end--;
  const len = Math.min(d.length, end + 256);
  if (len >= d.length - 256) return buf;
  const out = ctx.createBuffer(1, Math.max(1, len), buf.sampleRate);
  out.getChannelData(0).set(d.subarray(0, len));
  return out;
}

/** startRendering con fallback per Safari meno recenti (evento oncomplete). */
function render(octx) {
  return new Promise((resolve, reject) => {
    octx.oncomplete = (e) => resolve(e.renderedBuffer);
    const p = octx.startRendering();
    if (p && p.then) p.then(resolve, reject);
  });
}

export class VoiceCache {
  /**
   * @param {BaseAudioContext} ctx  contesto live (per sampleRate e createBuffer)
   * @param {number} maxBytes      memoria massima dei buffer
   */
  constructor(ctx, maxBytes = 48e6) {
    this.ctx = ctx;
    this.sr = ctx.sampleRate;
    this.max = maxBytes;
    this.map = new Map();       // key → AudioBuffer (ordine = uso recente)
    this.bytes = 0;
    this.pending = new Set();
    this.queue = [];
    this.busy = false;
    this.enabled = !!OAC;
    this.stats = { hit: 0, miss: 0, rendered: 0 };
  }

  get(key) {
    const b = this.map.get(key);
    if (b) {
      this.map.delete(key);
      this.map.set(key, b);
      this.stats.hit++;
      return b;
    }
    this.stats.miss++;
    return null;
  }

  has(key) { return this.map.has(key) || this.pending.has(key); }

  /**
   * Richiede il render di una voce.
   * @param {string} key
   * @param {number} seconds         durata massima da renderizzare
   * @param {(ctx: OfflineAudioContext, out: AudioNode) => void} play
   */
  request(key, seconds, play) {
    if (!this.enabled || this.has(key)) return;
    this.pending.add(key);
    this.queue.push({ key, seconds, play });
    // Coda limitata: scarta le richieste più vecchie (es. trascinando un cursore)
    while (this.queue.length > 128) this.pending.delete(this.queue.shift().key);
    this._pump();
  }

  async _pump() {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    try {
      const octx = new OAC(1, Math.max(1, Math.ceil(job.seconds * this.sr)), this.sr);
      job.play(octx, octx.destination);
      const buf = trim(this.ctx, await render(octx));
      this._put(job.key, buf);
      this.stats.rendered++;
    } catch (_) {
      /* render non riuscito: la voce resta dal vivo */
    } finally {
      this.pending.delete(job.key);
      this.busy = false;
      // Cede il thread tra un render e l'altro
      setTimeout(() => this._pump(), 0);
    }
  }

  _put(key, buf) {
    if (this.map.has(key)) return;
    this.map.set(key, buf);
    this.bytes += buf.length * 4;
    for (const [k, b] of this.map) {
      if (this.bytes <= this.max) break;
      this.map.delete(k);
      this.bytes -= b.length * 4;
    }
  }

  clear() { this.map.clear(); this.bytes = 0; }
}
