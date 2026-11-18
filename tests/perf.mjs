/**
 * Benchmark prestazioni (Chromium):
 *  - Audio: render offline di 8 battute (batteria + synth + effetti); fattore tempo reale
 *    = secondi audio prodotti per secondo di CPU (più alto = meglio).
 *  - UI: 6 s di riproduzione con CPU rallentata 4× (simula un telefono): tempo di
 *    script/stile/layout/paint del thread principale e frame lenti (> 25 ms).
 *   node tests/perf.mjs
 */
import { startServer } from './server.mjs';
import { chromium } from 'playwright';

const { server, url } = await startServer();
const browser = await chromium.launch();

// ---------------- Audio ----------------
{
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForFunction(() => window.drumbort);
  const r = await page.evaluate(async () => {
    const { renderBars } = await import('./js/export.js');
    const { createPattern } = await import('./js/sequencer.js');
    const p = createPattern('tr909', true, 1);                 // batteria + synth demo
    p.tracks.forEach((t) => { t.rev = 0.2; t.dly = 0.1; });
    const bars = Array.from({ length: 8 }, () => JSON.parse(JSON.stringify(p)));
    let best = Infinity, dur = 0;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const buf = await renderBars(bars, { fx: drumbort.state.fx, tail: 1 });
      best = Math.min(best, performance.now() - t0);
      dur = buf.duration;
    }
    // Con cache calda (come la riproduzione dal secondo giro in poi)
    let cached = null;
    try {
      const { VoiceCache } = await import('./js/voicecache.js');
      const cache = new VoiceCache(new OfflineAudioContext(1, 1, 44100));
      await renderBars(bars, { fx: drumbort.state.fx, tail: 1, cache });          // registra le voci
      while (cache.queue.length || cache.busy) await new Promise((r) => setTimeout(r, 20));
      cached = Infinity;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        await renderBars(bars, { fx: drumbort.state.fx, tail: 1, cache });
        cached = Math.min(cached, performance.now() - t0);
      }
    } catch (_) { /* versione senza cache */ }
    return { dur, ms: best, cached };
  });
  console.log(`Audio senza cache: ${r.dur.toFixed(1)} s in ${r.ms.toFixed(0)} ms → ${(r.dur * 1000 / r.ms).toFixed(1)}× tempo reale`);
  if (r.cached) console.log(`Audio con cache:   ${r.dur.toFixed(1)} s in ${r.cached.toFixed(0)} ms → ${(r.dur * 1000 / r.cached).toFixed(1)}× tempo reale`);
  await page.close();
}

// ---------------- UI ----------------
for (const view of ['drum', 'synth']) {
  const context = await browser.newContext({ viewport: { width: 440, height: 956 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.goto(url);
  await page.waitForFunction(() => window.drumbort);
  await page.tap('#overlay');
  if (view === 'synth') await page.tap('[data-cmd="view"]');
  await cdp.send('Performance.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  await page.evaluate(() => {
    window.__frames = [];
    let last = performance.now();
    const f = (t) => { window.__frames.push(t - last); last = t; requestAnimationFrame(f); };
    requestAnimationFrame(f);
  });
  const m0 = await metrics();
  await page.tap('#play');
  await page.waitForTimeout(6000);
  const m1 = await metrics();
  await page.tap('#play');
  const frames = await page.evaluate(() => window.__frames.slice(5));
  const d = (k) => ((m1[k] - m0[k]) * 1000).toFixed(0);
  const slow = frames.filter((x) => x > 25).length;
  console.log(`UI ${view.padEnd(5)}: script ${d('ScriptDuration')} ms, stile ${d('RecalcStyleDuration')} ms, layout ${d('LayoutDuration')} ms, task totali ${d('TaskDuration')} ms in 6 s — frame lenti ${slow}/${frames.length}`);
  await context.close();
}

await browser.close();
server.close();
