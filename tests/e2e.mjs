/**
 * Test end-to-end con Playwright (Chromium e WebKit).
 *   node tests/e2e.mjs                    → chromium
 *   BROWSERS=chromium,webkit node tests/e2e.mjs
 *   BASE_URL=https://…/DrumBort-Machine/ node tests/e2e.mjs   → sito pubblicato
 * Esce con codice 1 se un controllo fallisce.
 */
import { startServer } from './server.mjs';
import * as pw from 'playwright';

const BROWSERS = (process.env.BROWSERS || 'chromium').split(',').map((s) => s.trim()).filter(Boolean);
const VIEWPORTS = [
  { name: 'iPhone portrait', width: 440, height: 956 },
  { name: 'iPhone landscape', width: 956, height: 440 },
  { name: 'iPad portrait', width: 820, height: 1180 },
  { name: 'iPad landscape', width: 1180, height: 820 },
];
const MIN_TOUCH = 43.5;   // 44 pt con tolleranza di arrotondamento

let failures = 0;
function check(label, ok, info = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${info ? ` — ${info}` : ''}`);
  if (!ok) failures++;
}

/** Apre la pagina, raccoglie errori/404 e sblocca l'audio. */
async function openApp(browser, url, viewport, extra = {}) {
  const context = await browser.newContext({ viewport, hasTouch: true, isMobile: browser.browserType().name() !== 'firefox', acceptDownloads: true, ...extra });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto(url);
  await page.waitForFunction(() => window.drumbort);
  await page.tap('#overlay');
  await page.waitForFunction(() => document.querySelector('#overlay').hidden && drumbort.engine.ctx.state === 'running', null, { timeout: 5000 });
  return { context, page, errors };
}

const S = (t, s) => `.step[data-t="${t}"][data-s="${s}"]`;

async function layoutTests(browser, url) {
  for (const vp of VIEWPORTS) {
    console.log(`\n[${browser.browserType().name()}] Layout ${vp.name} ${vp.width}×${vp.height}`);
    const { context, page, errors } = await openApp(browser, url, vp);
    await page.tap('#play');
    await page.waitForTimeout(500);
    const m = await page.evaluate(() => {
      const vis = (e) => e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden';
      const box = (e) => e.getBoundingClientRect();
      const steps = [...document.querySelectorAll('.step')].filter(vis);
      const minStep = steps.reduce((a, e) => { const b = box(e); return Math.min(a, b.width, b.height); }, 1e9);
      const touch = [...document.querySelectorAll('.bar .btn, .bar .sel, .pad, .tools .btn')].filter(vis)
        .filter((e) => { const b = box(e); return b.right > 0 && b.left < innerWidth; });
      const minTouch = touch.reduce((a, e) => { const b = box(e); return Math.min(a, b.width, b.height); }, 1e9);
      const smallest = touch.find((e) => { const b = box(e); return Math.min(b.width, b.height) === minTouch; });
      return {
        scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight,
        steps: steps.length, minStep: Math.round(minStep * 10) / 10, minTouch: Math.round(minTouch * 10) / 10,
        smallest: smallest && (smallest.id || smallest.className),
        playhead: document.querySelectorAll('.step.ph').length,
        drawer: getComputedStyle(document.querySelector('#drawerBtn')).display !== 'none',
      };
    });
    check('nessuno scroll di pagina', m.scrollW <= vp.width && m.scrollH <= vp.height, `${m.scrollW}×${m.scrollH}`);
    check('step ≥ 44 px', m.minStep >= MIN_TOUCH, `${m.minStep} px, ${m.steps} visibili`);
    check('controlli touch ≥ 44 px', m.minTouch >= MIN_TOUCH, `${m.minTouch} px (${m.smallest})`);
    check('playhead visibile', m.playhead === 8);
    if (m.drawer) {
      await page.tap('#drawerBtn');
      await page.waitForTimeout(300);
      const pad = await page.evaluate(() => {
        const b = document.querySelector('.pad').getBoundingClientRect();
        return { w: b.width, h: b.height, inView: b.right <= innerWidth && b.left >= 0 };
      });
      check('cassetto pad aperto e usabile', pad.inView && Math.min(pad.w, pad.h) >= MIN_TOUCH, `${Math.round(pad.w)}×${Math.round(pad.h)}`);
    }
    check('nessun errore o 404', errors.length === 0, errors.join(' | '));
    await context.close();
  }
}

async function functionalTests(browser, url) {
  const name = browser.browserType().name();
  console.log(`\n[${name}] Funzioni (iPhone portrait)`);
  const { context, page, errors } = await openApp(browser, url, VIEWPORTS[0]);
  const step = (t, s, slot) => page.evaluate(([t, s, slot]) => drumbort.state.slots[slot ?? drumbort.state.slot].steps[t][s], [t, s, slot]);

  // Step: off → on → accento, undo/redo
  await page.tap(S(2, 1));
  await page.tap(S(2, 1));
  check('tap step: off → on → accento', (await step(2, 1)) === 2);
  await page.tap('[data-cmd="undo"]');
  check('undo', (await step(2, 1)) === 1);
  await page.tap('[data-cmd="redo"]');
  check('redo', (await step(2, 1)) === 2);

  // Pagina step 9-16
  await page.tap('.page[data-page="1"]');
  const vis = await page.evaluate(() => [...document.querySelectorAll('.row:first-of-type .step')].filter((e) => e.offsetParent).map((e) => +e.dataset.s));
  check('pager 9–16', vis.join() === '8,9,10,11,12,13,14,15', vis.join());
  await page.tap('.page[data-page="0"]');

  // Copia/incolla tra slot
  await page.tap('[data-cmd="copy"]');
  await page.selectOption('#slot', '5');
  await page.tap('[data-cmd="paste"]');
  check('copia/incolla pattern', (await step(2, 1, 5)) === 2);
  await page.tap('[data-cmd="undo"]');
  await page.selectOption('#slot', '0');

  // Lunghezza traccia (poliritmi)
  await page.tap('.pad.c0');
  await page.evaluate(() => { const i = document.querySelector('#sliders input[data-param="len"]'); i.value = 12; i.dispatchEvent(new Event('input', { bubbles: true })); });
  const len = await page.evaluate(() => [drumbort.state.slots[0].tracks[0].len, document.querySelectorAll('.step.out[data-t="0"]').length]);
  check('lunghezza traccia 12', len[0] === 12 && len[1] === 4, `len ${len[0]}, step fuori ${len[1]}`);

  // Editor opzioni step
  await page.tap('[data-cmd="edit"]');
  await page.tap(S(1, 3));
  check('editor step aperto', await page.isVisible('#stepSheet'));
  await page.tap('#stepSheet .seg[data-k="r"] [data-v="3"]');
  await page.tap('#stepSheet .seg[data-k="f"] [data-v="1"]');
  await page.evaluate(() => { const i = document.querySelector('#stepSheet input[data-k="p"]'); i.value = 50; i.dispatchEvent(new Event('input', { bubbles: true })); });
  const opt = await page.evaluate(() => [drumbort.state.slots[0].opts[1][3], drumbort.state.slots[0].steps[1][3]]);
  check('ratchet/flam/probabilità salvati', opt[0] && opt[0].r === 3 && opt[0].f === 1 && opt[0].p === 50 && opt[1] > 0, JSON.stringify(opt));
  await page.tap('#stepSheet [data-close]');
  await page.tap('[data-cmd="edit"]');
  check('indicatore opzioni sullo step', await page.evaluate(() => document.querySelector('.step[data-t="1"][data-s="3"]').classList.contains('opt')));

  // Tap tempo
  for (let i = 0; i < 4; i++) { await page.tap('#tap'); await page.waitForTimeout(500); }
  const bpm = await page.evaluate(() => drumbort.state.slots[0].bpm);
  check('tap tempo ≈ 120 BPM', bpm >= 100 && bpm <= 135, `${bpm}`);

  // FX master
  await page.tap('[data-cmd="fx"]');
  await page.evaluate(() => { const i = document.querySelector('#fxCtl [data-fx="filter"]'); i.value = -0.5; i.dispatchEvent(new Event('input', { bubbles: true })); });
  const fx = await page.evaluate(() => [drumbort.state.fx.filter, Math.round(drumbort.engine.lp.frequency.value)]);
  check('filtro master LP', fx[0] === -0.5, `filter ${fx[0]}`);
  await page.tap('#fxSheet [data-act="fx-reset"]');
  await page.tap('#fxSheet [data-close]');

  // Registrazione dal vivo + metronomo
  await page.tap('[data-cmd="met"]');
  await page.evaluate(() => { const p = drumbort.state.slots[0]; p.steps[7] = p.steps[7].map(() => 0); });
  await page.tap('#rec');
  await page.tap('#play');
  await page.waitForTimeout(400);
  await page.tap('.pad.c7');
  await page.waitForTimeout(200);
  const rec = await page.evaluate(() => drumbort.state.slots[0].steps[7].filter(Boolean).length);
  check('registrazione dal vivo scrive uno step', rec === 1, `${rec} step`);
  await page.tap('#play');
  await page.tap('#rec');
  await page.tap('[data-cmd="met"]');

  // Song mode: P1 ×1 → P2 ×1
  await page.tap('[data-cmd="song"]');
  await page.tap('#songOn');
  await page.tap('#chainAdd [data-add="1"]');
  const chain = await page.evaluate(() => drumbort.state.song.chain.map((c) => `${c.slot}x${c.rep}`).join());
  check('catena song', chain === '0x1,1x1', chain);
  await page.tap('#songSheet [data-close]');
  await page.evaluate(() => { drumbort.state.slots[0].bpm = 240; drumbort.state.slots[1].bpm = 240; });
  await page.tap('#play');
  await page.waitForFunction(() => drumbort.state.slot === 1, null, { timeout: 6000 }).catch(() => {});
  check('song mode passa a PAT 2', (await page.evaluate(() => drumbort.state.slot)) === 1);
  await page.tap('#play');
  await page.tap('[data-cmd="song"]');
  await page.tap('#songOn');
  await page.tap('#songSheet [data-close]');
  await page.selectOption('#slot', '0');

  // Lock kit
  await page.tap('#lockBtn');
  await page.selectOption('#slot', '1');
  const locked = await page.evaluate(() => [document.querySelector('#kit').value, drumbort.state.slots[0].kit]);
  check('kit bloccato al cambio pattern', locked[0] === locked[1], locked.join(' / '));
  await page.tap('#lockBtn');
  await page.selectOption('#slot', '0');

  // Export WAV
  await page.tap('#menuBtn');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.tap('[data-act="wav-pattern"]')]);
  const wavPath = await dl.path();
  const { statSync, readFileSync } = await import('node:fs');
  const wav = readFileSync(wavPath);
  check('export WAV', wav.subarray(0, 4).toString() === 'RIFF' && statSync(wavPath).size > 100000, `${dl.suggestedFilename()} ${statSync(wavPath).size} byte`);

  // Export / import JSON
  await page.tap('#menuBtn');
  const [jdl] = await Promise.all([page.waitForEvent('download'), page.tap('[data-act="export"]')]);
  const json = readFileSync(await jdl.path(), 'utf8');
  await page.tap('#menuBtn');
  await page.tap('[data-act="clear"]');
  check('clear', await page.evaluate(() => drumbort.state.slots[0].steps.flat().every((v) => !v)));
  await page.setInputFiles('#importFile', { name: 'p.json', mimeType: 'application/json', buffer: Buffer.from(json) });
  await page.waitForTimeout(200);
  check('import JSON ripristina il pattern', await page.evaluate(() => drumbort.state.slots[0].steps.flat().some(Boolean)));

  // Tastiera
  await page.focus(S(0, 0));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  const focused = await page.evaluate(() => document.activeElement.dataset.t + ':' + document.activeElement.dataset.s);
  const before = await step(1, 1);
  await page.keyboard.press('Enter');
  check('navigazione da tastiera', focused === '1:1' && (await step(1, 1)) !== before, focused);
  check('aria-pressed sugli step', await page.evaluate(() => document.querySelector('.step').hasAttribute('aria-pressed')));

  // Persistenza
  await page.waitForTimeout(400);
  const saved = await page.evaluate(() => JSON.stringify(drumbort.state.slots[0].steps));
  await page.reload();
  await page.waitForFunction(() => window.drumbort);
  check('persistenza localStorage', (await page.evaluate(() => JSON.stringify(drumbort.state.slots[0].steps))) === saved);

  check('nessun errore o 404', errors.length === 0, errors.join(' | '));
  await context.close();
}

async function audioTests(browser, url) {
  console.log(`\n[${browser.browserType().name()}] Audio (render offline di tutte le voci)`);
  const { context, page } = await openApp(browser, url, VIEWPORTS[3]);
  const res = await page.evaluate(async () => {
    const { KITS } = await import('./js/kits.js');
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const bad = [];
    let n = 0;
    for (const k of KITS) {
      for (const tr of k.tracks) {
        const ctx = new OAC(1, 44100, 44100);
        tr.play(ctx, ctx.destination, 0.01, 1, { tune: 0, decay: 1 });
        const d = (await ctx.startRendering()).getChannelData(0);
        let pk = 0, nan = false;
        for (let i = 0; i < d.length; i++) { if (d[i] !== d[i]) nan = true; pk = Math.max(pk, Math.abs(d[i])); }
        if (nan || pk < 0.05) bad.push(`${k.id}/${tr.short}:${pk.toFixed(3)}${nan ? ' NaN' : ''}`);
        n++;
      }
    }
    return { n, bad };
  });
  check(`${res.n} voci con segnale valido`, res.bad.length === 0, res.bad.join(', '));
  await context.close();
}

async function pwaTests(browser, url) {
  console.log(`\n[${browser.browserType().name()}] PWA`);
  const { context, page, errors } = await openApp(browser, url, VIEWPORTS[0]);
  const sw = await page.evaluate(async () => {
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 8000))]);
    return reg ? reg.scope : null;
  });
  check('service worker registrato con scope relativo', !!sw && sw.endsWith('/DrumBort-Machine/'), sw || 'nessuno');
  if (sw) {
    await page.waitForTimeout(1000);
    const cached = await page.evaluate(async () => (await caches.keys()).find((k) => k.startsWith('drumbort-v')));
    check('cache versionata', cached === `drumbort-v${await page.evaluate(() => drumbort.version)}`, cached);
    // Tutti i file precaricati devono essere in cache
    const missing = await page.evaluate(async () => {
      const src = await (await fetch('./sw.js')).text();
      const list = JSON.parse(src.match(/const ASSETS = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
      const out = [];
      for (const a of list) if (!(await caches.match(new URL(a, location.href).href, { ignoreSearch: true }))) out.push(a);
      return out;
    });
    check('tutti i file in cache', missing.length === 0, missing.join(', '));
    // Reload offline reale: solo Chromium (in WebKit di Playwright setOffline + reload va in errore interno)
    if (browser.browserType().name() === 'chromium') {
      await context.setOffline(true);
      await page.reload();
      check('funziona offline', await page.evaluate(() => !!document.querySelector('.step')));
      await context.setOffline(false);
    }
  }
  const manifest = await page.evaluate(async () => (await fetch('./manifest.webmanifest')).json());
  check('manifest start_url/scope relativi', manifest.start_url === './' && manifest.scope === './');
  check('nessun errore o 404', errors.filter((e) => !e.includes('ERR_INTERNET_DISCONNECTED')).length === 0, errors.join(' | '));
  await context.close();
}

// ---------------------------------------------------------------------
const local = process.env.BASE_URL ? null : await startServer();
const url = process.env.BASE_URL || local.url;
console.log(`URL: ${url}`);

for (const name of BROWSERS) {
  const browser = await pw[name].launch();
  try {
    await layoutTests(browser, url);
    await functionalTests(browser, url);
    await audioTests(browser, url);
    await pwaTests(browser, url);
  } catch (err) {
    check(`[${name}] esecuzione`, false, err.message.split('\n').slice(0, 4).join(' | '));
  } finally {
    await browser.close();
  }
}

if (local) local.server.close();
console.log(failures ? `\n✗ ${failures} controlli falliti` : '\n✓ Tutti i controlli superati');
process.exit(failures ? 1 : 0);
