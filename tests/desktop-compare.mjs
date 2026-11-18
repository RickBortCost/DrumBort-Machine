/**
 * desktop-compare.mjs — Confronta il motore desktop (C#) con la web app, voce per voce.
 *   node tests/desktop-compare.mjs <voices.json>   (generato da DrumBortHost --render-voices)
 * Per ogni voce: rapporto di RMS, picco e correlazione dell'inviluppo (RMS ogni 10 ms).
 * Il rumore è casuale: si confrontano livelli e forma dell'inviluppo, non i campioni.
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const cs = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { server, url } = await startServer();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(url);
const { out: web, comp: wComp, rev: wRev } = await page.evaluate(async () => {
  const { KITS } = await import('./js/kits.js');
  const { PRESETS, playVoice } = await import('./js/synth.js');
  const SR = 48000, out = {};
  const measure = async (ctx) => {
    const d = (await ctx.startRendering()).getChannelData(0);
    let pk = 0, sum = 0, es = 0, en = 0; const env = [];
    for (let i = 0; i < d.length; i++) {
      const v = d[i]; pk = Math.max(pk, Math.abs(v)); sum += v * v; es += v * v;
      if (++en === SR / 100) { env.push(Math.sqrt(es / en)); es = 0; en = 0; }
    }
    return { peak: pk, rms: Math.sqrt(sum / d.length), env: env.slice(0, 150) };
  };
  for (const k of KITS) for (const tr of k.tracks) {
    const ctx = new OfflineAudioContext(1, SR * 3, SR);
    tr.play(ctx, ctx.destination, 0.01, 1, { tune: 0, decay: 1 });
    out[`d|${k.id}|${tr.short}`] = await measure(ctx);
  }
  for (const [id, pr] of Object.entries(PRESETS)) {
    const ctx = new OfflineAudioContext(1, SR * 3, SR);
    const notes = ['Pad', 'Strings', 'Choir', 'Organ', 'Keys', 'Piano'].includes(pr.cat) ? [57, 60, 64] : [pr.cat === 'Bass' ? 45 : 69];
    playVoice(ctx, ctx.destination, 0.01, Math.max(0.4, pr.a * 1.1), notes, 1, pr, { bpm: 120 }, notes[0] - 5);
    out[`s|${id}`] = await measure(ctx);
  }
  // Compressore master: curva statica (sinusoide) e transitorio
  const comp = {};
  const mk = (c) => { c.threshold.value = -12; c.knee.value = 8; c.ratio.value = 6; c.attack.value = 0.003; c.release.value = 0.2; return c; };
  for (const amp of [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2]) {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const o = ctx.createOscillator(), g = ctx.createGain(); g.gain.value = amp;
    o.connect(g).connect(mk(ctx.createDynamicsCompressor())).connect(ctx.destination); o.start();
    const d = (await ctx.startRendering()).getChannelData(0);
    let pk = 0; for (let i = SR / 2; i < SR; i++) pk = Math.max(pk, Math.abs(d[i]));
    comp[String(amp)] = pk / amp;
  }
  {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const o = ctx.createOscillator(), g = ctx.createGain();
    g.gain.setValueAtTime(0, 0); g.gain.setValueAtTime(0.5, 0.1); g.gain.setTargetAtTime(0, 0.1, 0.03);
    o.connect(g).connect(mk(ctx.createDynamicsCompressor())).connect(ctx.destination); o.start();
    const d = (await ctx.startRendering()).getChannelData(0);
    let pk = 0, s = 0; for (let i = SR / 10; i < SR / 10 + SR * 0.3; i++) { pk = Math.max(pk, Math.abs(d[i])); s += d[i] * d[i]; }
    comp.burstPeak = pk; comp.burstRms = Math.sqrt(s / (SR * 0.3));
  }
  // Riverbero: rullante 909 con mandata piena, senza compressore
  const rev = {};
  const { Engine, DEFAULT_FX } = await import('./js/engine.js');
  const { kitById } = await import('./js/kits.js');
  const { createPattern } = await import('./js/sequencer.js');
  for (const size of [1, 2.2, 4]) {
    const ctx = new OfflineAudioContext(2, SR * 3, SR);
    const eng = new Engine(); eng.init(ctx);
    const pat = createPattern('tr909', false, null); pat.tracks[1].rev = 1;
    eng.setKit(kitById('tr909')); eng.setFx({ ...DEFAULT_FX, size }, 120, true); eng.applyMix(pat, 0);
    eng.master.disconnect(); eng.master.connect(ctx.destination);
    eng.trigger(1, 0.03, 1, pat.tracks[1]);
    const buf = await ctx.startRendering(), L = buf.getChannelData(0), R = buf.getChannelData(1);
    const win = (a, z) => { let s = 0, n = 0; for (let i = Math.floor(a * SR); i < z * SR; i++) { s += L[i] * L[i] + R[i] * R[i]; n += 2; } return Math.sqrt(s / n); };
    rev[String(size)] = [win(0.02, 0.3), win(0.4, 0.8), win(0.8, 1.4), win(1.4, 2.2)];
  }
  return { out, comp, rev };
});
await browser.close();
server.close();

const corr = (a, b) => {
  const n = Math.min(a.length, b.length);
  const la = a.slice(0, n).map((x) => Math.log10(x + 1e-4)), lb = b.slice(0, n).map((x) => Math.log10(x + 1e-4));
  const ma = la.reduce((s, x) => s + x, 0) / n, mb = lb.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (la[i] - ma) * (lb[i] - mb); saa += (la[i] - ma) ** 2; sbb += (lb[i] - mb) ** 2; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 1;
};
const rows = [];
for (const [k, w] of Object.entries(web)) {
  const c = cs[k];
  if (!c) { rows.push({ k, miss: true }); continue; }
  rows.push({ k, rms: c.rms / (w.rms || 1e-9), peak: c.peak / (w.peak || 1e-9), corr: corr(c.env, w.env) });
}
const db = (r) => 20 * Math.log10(r);
const bad = rows.filter((r) => r.miss || Math.abs(db(r.rms)) > 3 || r.corr < 0.9);
bad.sort((a, b) => Math.abs(db(b.rms || 1)) - Math.abs(db(a.rms || 1)));
for (const r of bad) console.log(r.miss ? `✗ ${r.k} mancante` : `✗ ${r.k}  RMS ${db(r.rms).toFixed(1)} dB  picco ${db(r.peak).toFixed(1)} dB  corr ${r.corr.toFixed(2)}`);
// Compressore e riverbero
let fxBad = 0;
const near = (name, a, b, tolDb) => {
  const d = db(a / b);
  const ok = Math.abs(d) <= tolDb;
  if (!ok) fxBad++;
  console.log(`${ok ? '✓' : '✗'} ${name}: ${d >= 0 ? '+' : ''}${d.toFixed(1)} dB`);
};
for (const k of Object.keys(wComp)) near(`compressore ${k}`, cs._comp[k], wComp[k], 1.5);
for (const [size, w] of Object.entries(wRev)) {
  const c = cs._rev[size];
  // size 1: la coda della IR originale finisce a 1 s, si confrontano solo le prime finestre
  const n = size === '1' ? 2 : 4;
  for (let i = 0; i < n; i++) near(`riverbero ${size} s, finestra ${i}`, c[i], w[i], 3);
}
const ok = rows.length - bad.length;
console.log(`${ok}/${rows.length} voci entro ±3 dB e correlazione ≥ 0,9 · velocità motore C#: ${cs._speed}× tempo reale`);
process.exit(bad.length / rows.length > 0.05 || fxBad ? 1 : 0);
