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
    // Vista SYNTH
    await page.tap('[data-cmd="view"]');
    await page.waitForTimeout(150);
    const sm = await page.evaluate(() => {
      const vis = (e) => e.offsetParent !== null;
      const min = (sel) => [...document.querySelectorAll(sel)].filter(vis)
        .reduce((a, e) => { const b = e.getBoundingClientRect(); return Math.min(a, b.width, b.height); }, 1e9);
      return {
        view: document.querySelector('#app').dataset.view,
        scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight,
        step: Math.round(min('.sstep') * 10) / 10, pad: Math.round(min('.spad') * 10) / 10,
        ctl: Math.round(min('.keyrow .btn, .keyrow .sel, #sparams .btn, #sparams .sel') * 10) / 10,
        playhead: document.querySelectorAll('.sstep.ph').length,
      };
    });
    check('synth: vista attiva senza scroll', sm.view === 'synth' && sm.scrollW <= vp.width && sm.scrollH <= vp.height, `${sm.scrollW}×${sm.scrollH}`);
    check('synth: step, pad e controlli ≥ 44 px', Math.min(sm.step, sm.pad, sm.ctl) >= MIN_TOUCH, `step ${sm.step}, pad ${sm.pad}, controlli ${sm.ctl}`);
    check('synth: playhead su 4 corsie', sm.playhead === 4);
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

async function synthTests(browser, url) {
  console.log(`\n[${browser.browserType().name()}] Synth (iPhone portrait)`);
  const { context, page, errors } = await openApp(browser, url, VIEWPORTS[0]);
  const SS = (k, s) => `.sstep[data-k="${k}"][data-s="${s}"]`;
  const st = (k, s) => page.evaluate(([k, s]) => drumbort.state.slots[drumbort.state.slot].synth.tracks[k].steps[s], [k, s]);

  await page.tap('[data-cmd="view"]');
  check('vista synth', (await page.evaluate(() => document.querySelector('#app').dataset.view)) === 'synth');

  // Pennello: il pad di grado 2 sulla traccia LEAD, poi tap su uno step vuoto
  await page.tap('.slbl[data-k="1"]');
  await page.evaluate(() => { drumbort.state.slots[drumbort.state.slot].synth.tracks[1].steps[2] = null; });
  await page.tap('.spad[data-d="2"]');
  await page.tap(SS(1, 2));
  const ins = await st(1, 2);
  const exp = await page.evaluate(() => { const s = drumbort.state.slots[drumbort.state.slot].synth; return 12 * (4 + s.tracks[1].oct + 1) + s.key; });
  check('inserimento nota col pennello', ins && ins.n > exp && ins.n <= exp + 5, JSON.stringify(ins));
  await page.tap(SS(1, 2));
  check('tap su nota la cancella', (await st(1, 2)) === null);
  await page.tap('[data-cmd="undo"]');
  check('undo ripristina la nota', !!(await st(1, 2)));

  // Editor step: +1 semitono, gate 3, slide
  await page.tap('[data-cmd="edit"]');
  await page.tap(SS(1, 2));
  check('editor synth aperto', await page.isVisible('#sstepSheet'));
  const before = (await st(1, 2)).n;
  await page.tap('#sstepSheet [data-tr="1"]');
  await page.evaluate(() => { const i = document.querySelector('#sGate'); i.value = 3; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.tap('#sstepSheet .seg[data-k="sl"] [data-v="1"]');
  const ed = await st(1, 2);
  check('nota, gate e slide modificati', ed.n === before + 1 && ed.g === 3 && ed.sl === 1, JSON.stringify(ed));
  check('tie visualizzati', await page.evaluate(() => document.querySelectorAll('.sstep.tie[data-k="1"]').length >= 2));
  await page.tap('#sstepSheet [data-close]');

  // Accordo sul PAD
  await page.tap(SS(2, 5));
  await page.tap('#sstepSheet .seg[data-k="ch"] [data-v="seventh"]');
  const chord = await st(2, 5);
  check('accordo di settima sul pad', chord && chord.ch && chord.ch.length === 4, JSON.stringify(chord && chord.ch));
  await page.tap('#sstepSheet [data-close]');
  await page.tap('[data-cmd="edit"]');

  // Cambio tonalità: traspone
  const n0 = (await st(1, 2)).n;
  const key0 = await page.evaluate(() => drumbort.state.slots[drumbort.state.slot].synth.key);
  await page.selectOption('#keySel', String((key0 + 2) % 12));
  const n1 = (await st(1, 2)).n;
  check('cambio tonalità traspone le note', n1 - n0 === 2 || n1 - n0 === -10, `${n0} → ${n1}`);

  // Preset e parametri
  await page.tap('.slbl[data-k="1"]');
  await page.tap('#presetBtn');
  await page.tap('.lib-row[data-id="mooglead"]');
  await page.tap('#libSheet [data-close]');
  check('preset LEAD cambiato', (await page.evaluate(() => drumbort.state.slots[drumbort.state.slot].synth.tracks[1].preset)) === 'mooglead');

  // Registrazione dal vivo con gate dalla pressione
  await page.evaluate(() => { const t = drumbort.state.slots[drumbort.state.slot].synth.tracks[0]; t.steps = t.steps.map(() => null); });
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.tap('.slbl[data-k="0"]');
  await page.tap('#rec');
  await page.tap('#play');
  await page.waitForTimeout(300);
  await page.tap('.spad[data-d="0"]');
  await page.waitForTimeout(150);
  const recd = await page.evaluate(() => drumbort.state.slots[drumbort.state.slot].synth.tracks[0].steps.filter(Boolean).length);
  check('registrazione synth dai pad', recd === 1, `${recd} note`);
  await page.tap('#play');
  await page.tap('#rec');

  // Persistenza e ritorno alla batteria
  await page.waitForTimeout(400);
  await page.reload();
  await page.waitForFunction(() => window.drumbort);
  check('vista e preset salvati', await page.evaluate(() => document.querySelector('#app').dataset.view === 'synth'
    && drumbort.state.slots[drumbort.state.slot].synth.tracks[1].preset === 'mooglead'));
  check('nessun errore o 404', errors.length === 0, errors.join(' | '));
  await context.close();
}

async function featureTests(browser, url) {
  const name = browser.browserType().name();
  console.log(`\n[${name}] Funzioni 1.3 (iPhone portrait)`);
  const extra = name === 'chromium' ? { permissions: ['microphone'] } : {};
  const { context, page, errors } = await openApp(browser, url, VIEWPORTS[0], extra);
  const { readFileSync } = await import('node:fs');
  const P = () => 'drumbort.state.slots[drumbort.state.slot]';

  // --- Libreria: categoria, ricerca, preferito, assegnazione a KEYS ---
  await page.tap('[data-cmd="view"]');
  await page.tap('.slbl[data-k="3"]');
  await page.tap('#presetBtn');
  check('libreria aperta', await page.isVisible('#libSheet'));
  await page.tap('.chip-cat[data-cat="Piano"]');
  const pianos = await page.evaluate(() => [...document.querySelectorAll('.lib-row')].map((r) => r.dataset.id));
  check('categoria Piano', pianos.includes('grand') && pianos.every((id) => ['grand', 'upright', 'honky'].includes(id)), pianos.join());
  await page.tap('.lib-row[data-id="grand"]');
  check('preset assegnato a KEYS', (await page.evaluate(`${P()}.synth.tracks[3].preset`)) === 'grand');
  await page.tap('.lib-row[data-id="grand"] [data-fav]');
  await page.fill('#libSearch', 'organ');
  const found = await page.evaluate(() => document.querySelectorAll('.lib-row').length);
  await page.tap('.chip-cat[data-cat="★"]');
  await page.fill('#libSearch', '');
  const favRows = await page.evaluate(() => [...document.querySelectorAll('.lib-row')].map((r) => r.dataset.id).join());
  check('ricerca e preferiti', found >= 3 && favRows === 'grand', `organ ${found}, preferiti ${favRows}`);
  await page.tap('#libSheet [data-close]');

  // --- Arpeggiatore su LEAD dagli accordi del PAD ---
  await page.tap('.slbl[data-k="1"]');
  await page.tap('#sarpBtn');
  await page.tap('#arpSheet .seg[data-k="on"] [data-v="1"]');
  await page.tap('#arpSheet .seg[data-k="rate"] [data-v="0.5"]');
  await page.tap('#arpSheet [data-close]');
  const arp = await page.evaluate(async () => {
    const { arpEvents } = await import('./js/sequencer.js');
    const p = drumbort.state.slots[drumbort.state.slot];
    p.synth.tracks[2].steps[0] = { n: 57, g: 16, a: 0, sl: 0, ch: [0, 3, 7] };
    return [0, 1, 2, 3].flatMap((t) => arpEvents(p, 1, t).map((e) => e.notes[0] % 12));
  });
  check('arpeggio a 1/32 sulle note dell\'accordo', arp.length === 8 && arp.every((n) => [9, 0, 4].includes(n)), arp.join());

  // --- Pagine MOD/FX synth e parameter lock synth ---
  await page.tap('#spgBtn');
  check('pagina MOD', (await page.evaluate(() => document.querySelector('#sparams').dataset.pg)) === 'mod');
  await page.evaluate(() => { const i = document.querySelector('#ssliders input[data-sparam="atk"]'); i.value = 2; i.dispatchEvent(new Event('input', { bubbles: true })); });
  check('macro ATTACK salvata', (await page.evaluate(`${P()}.synth.tracks[1].atk`)) === 2);
  await page.tap('.slbl[data-k="0"]');
  await page.tap('[data-cmd="edit"]');
  await page.evaluate(() => { const t = drumbort.state.slots[drumbort.state.slot].synth.tracks[0]; t.steps[5] = { n: 45, g: 1, a: 0, sl: 0, ch: null }; });
  await page.tap('.sstep[data-k="0"][data-s="5"]');
  await page.evaluate(() => { const i = document.querySelector('#sstepSheet input[data-lock="cut"]'); i.value = 0.6; i.dispatchEvent(new Event('input', { bubbles: true })); });
  const lock = await page.evaluate(`${P()}.synth.tracks[0].steps[5].pl`);
  check('parameter lock synth', lock && lock.cut === 0.6, JSON.stringify(lock));
  await page.tap('#sstepSheet [data-close]');
  await page.tap('[data-cmd="edit"]');

  // --- Batteria: parameter lock, insert FX, euclideo ---
  await page.tap('[data-cmd="view"]');   // → perf
  await page.tap('[data-cmd="view"]');   // → drum
  await page.tap('[data-cmd="edit"]');
  await page.tap('.step[data-t="1"][data-s="2"]');
  await page.evaluate(() => { const i = document.querySelector('#stepSheet input[data-dlock="tune"]'); i.value = 5; i.dispatchEvent(new Event('input', { bubbles: true })); });
  const dl = await page.evaluate(`${P()}.opts[1][2]`);
  check('parameter lock batteria', dl && dl.pl && dl.pl.tune === 5, JSON.stringify(dl));
  await page.tap('#stepSheet [data-close]');
  await page.tap('[data-cmd="edit"]');
  await page.tap('.pad.c3');
  await page.tap('#pgBtn'); await page.tap('#pgBtn');
  await page.evaluate(() => { const i = document.querySelector('#sliders input[data-param="crush"]'); i.value = 6; i.dispatchEvent(new Event('input', { bubbles: true })); });
  const ins = await page.evaluate(() => [drumbort.state.slots[drumbort.state.slot].tracks[3].crush, drumbort.engine.channels[3].ins.length]);
  check('bit crusher per traccia', ins[0] === 6 && ins[1] === 1, ins.join());
  await page.tap('#menuBtn'); await page.tap('[data-act="gen"]');
  await page.evaluate(() => { const h = document.querySelector('#genHits'); h.value = 5; h.dispatchEvent(new Event('input')); });
  await page.tap('[data-act="gen-euclid"]');
  const eu = await page.evaluate(`${P()}.steps[3].join('')`);
  check('ritmo euclideo 5/16', eu.split('').filter((x) => x !== '0').length === 5, eu);
  await page.tap('[data-act="gen-vary-drums"]');
  await page.tap('#genSheet [data-close]');

  // --- Sidechain e modalità performance ---
  await page.tap('[data-cmd="view"]'); await page.tap('[data-cmd="view"]');   // → perf
  check('vista performance', await page.isVisible('#xy'));
  await page.evaluate(() => { const i = document.querySelector('#perfSc'); i.value = 0.7; i.dispatchEvent(new Event('input')); });
  check('sidechain impostato', (await page.evaluate(() => drumbort.engine.fx.sc)) === 0.7);
  await page.tap('#muteGrid [data-g="hats"]');
  check('mute rapido HATS', await page.evaluate(() => drumbort.seq.muteD.has(3) && drumbort.seq.muteD.has(4)));
  await page.tap('#muteGrid [data-g="hats"]');
  await page.tap('#play');
  await page.waitForTimeout(300);
  const box = await page.locator('.perf .stut [data-st="2"]').boundingBox();
  await page.mouse.move(box.x + 10, box.y + 10); await page.mouse.down();
  await page.waitForTimeout(400);
  const stut = await page.evaluate(() => !!drumbort.seq.stutter && drumbort.seq.stutter.len === 2);
  await page.mouse.up();
  check('beat repeat 1/8', stut && !(await page.evaluate(() => drumbort.seq.stutter)));
  const xy = await page.locator('#xy').boundingBox();
  await page.mouse.move(xy.x + xy.width * 0.1, xy.y + xy.height * 0.2); await page.mouse.down();
  const xyf = await page.evaluate(() => drumbort.engine.fx.filter);
  await page.mouse.up();
  check('pad XY: filtro LP e ritorno (snap)', xyf < -0.5 && (await page.evaluate(() => drumbort.engine.fx.filter)) === 0, `${xyf.toFixed(2)}`);

  // --- Registrazione dell'uscita ---
  await page.tap('#recOutBtn');
  await page.waitForTimeout(1200);
  const [rec] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.tap('#recOutBtn')]);
  const recBuf = readFileSync(await rec.path());
  check('registrazione uscita WAV', recBuf.subarray(0, 4).toString() === 'RIFF' && recBuf.length > 44100 * 2, `${rec.suggestedFilename()} ${recBuf.length} byte`);
  await page.tap('#play');

  // --- Export MIDI ---
  await page.tap('#menuBtn');
  const [mid] = await Promise.all([page.waitForEvent('download'), page.tap('[data-act="mid-pattern"]')]);
  const midBuf = readFileSync(await mid.path());
  check('export MIDI (MThd, 6 tracce)', midBuf.subarray(0, 4).toString() === 'MThd' && midBuf[11] === 6, `${midBuf.length} byte`);

  // --- Kit personalizzato ---
  await page.tap('#menuBtn'); await page.tap('[data-act="kits"]');
  await page.fill('#kitName', 'Test Kit');
  await page.selectOption('#kitRows select[data-slot="0"]', 'tr909|0');
  await page.tap('[data-act="kit-save"]');
  const kit = await page.evaluate(() => [drumbort.state.slots[drumbort.state.slot].kit, drumbort.engine.kit.name, document.querySelector('#kit').selectedOptions[0].textContent]);
  check('kit personalizzato salvato e in uso', kit[0].startsWith('u:') && kit[2] === 'Test Kit', kit.join(' / '));

  // --- Progetti ---
  await page.tap('#menuBtn'); await page.tap('[data-act="projects"]');
  await page.fill('#projName', 'Prova');
  await page.tap('[data-act="proj-save"]');
  const before = await page.evaluate(`JSON.stringify(${P()}.steps)`);
  await page.tap('[data-act="proj-new"]');
  await page.tap('.proj-row [data-open="Prova"]');
  check('progetto salvato e riaperto', (await page.evaluate(`JSON.stringify(${P()}.steps)`)) === before && (await page.evaluate(() => drumbort.state.projectName)) === 'Prova');
  await page.tap('#projSheet [data-close]');

  // --- Link di condivisione ---
  const link = await page.evaluate(async () => {
    const { shareUrl } = await import('./js/projects.js');
    const p = JSON.parse(JSON.stringify(drumbort.state.slots[drumbort.state.slot]));
    p.bpm = 133;
    return shareUrl(p);
  });
  await page.goto(link);
  await page.waitForFunction(() => window.drumbort);
  await page.waitForTimeout(500);
  check('pattern dal link caricato', (await page.evaluate(`${P()}.bpm`)) === 133 && !(await page.evaluate(() => location.hash)), link.length + ' caratteri');

  // --- Campionamento dal microfono (Chromium con dispositivo finto) ---
  if (name === 'chromium') {
    if (await page.isVisible('#overlay')) await page.tap('#overlay');
    if (!(await page.isVisible('.tools [data-cmd="view"]'))) throw new Error('strumenti non visibili');
    while ((await page.evaluate(() => drumbort.ui.view)) !== 'drum') await page.tap('[data-cmd="view"]');
    await page.tap('.pad.c7');
    await page.tap('#wavBtn');
    await page.tap('#micBtn');
    await page.waitForTimeout(1500);
    await page.tap('#micBtn');
    await page.waitForTimeout(500);
    const smp = await page.evaluate(() => drumbort.engine.samples[7] && drumbort.engine.samples[7].buffer.duration);
    check('campione dal microfono', smp > 0.1, `${smp && smp.toFixed(2)} s`);
  }

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

  // Preset synth: nota (o accordo) con slide e accento, picco valido e senza clipping
  const syn = await page.evaluate(async () => {
    const { PRESETS, playVoice } = await import('./js/synth.js');
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const bad = [];
    let n = 0;
    for (const [id, pr] of Object.entries(PRESETS)) {
      const ctx = new OAC(1, 44100 * 3, 44100);
      const notes = ['Pad', 'Strings', 'Choir', 'Organ', 'Keys', 'Piano'].includes(pr.cat) ? [57, 60, 64] : [pr.cat === 'Bass' ? 45 : 69];
      playVoice(ctx, ctx.destination, 0.01, Math.max(0.4, pr.a * 1.1), notes, 1, pr, {}, notes[0] - 5);
      const d = (await ctx.startRendering()).getChannelData(0);
      let pk = 0, nan = false;
      for (let i = 0; i < d.length; i++) { if (d[i] !== d[i]) nan = true; pk = Math.max(pk, Math.abs(d[i])); }
      if (nan || pk < 0.03 || pk > 1.5) bad.push(`${id}:${pk.toFixed(3)}${nan ? ' NaN' : ''}`);
      n++;
    }
    return { n, bad };
  });
  check(`${syn.n} preset synth con segnale valido`, syn.bad.length === 0, syn.bad.join(', '));

  // Export: la sezione synth finisce nel WAV
  const wav = await page.evaluate(async () => {
    const { renderBars } = await import('./js/export.js');
    const { createPattern } = await import('./js/sequencer.js');
    const p = createPattern('tr808', false, 0);       // batteria vuota, synth demo
    const buf = await renderBars([p], { fx: drumbort.state.fx, tail: 0.5 });
    const d = buf.getChannelData(0);
    let pk = 0;
    for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
    return pk;
  });
  check('export WAV include il synth', wav > 0.05, `picco ${wav.toFixed(3)}`);

  // Prestazioni: in riproduzione le voci arrivano dalla cache pre-renderizzata
  await page.tap('#play');
  await page.waitForTimeout(5000);
  const st = await page.evaluate(() => ({ ...drumbort.engine.cache.stats }));
  await page.tap('#play');
  check('cache voci usata in riproduzione', st.rendered > 0 && st.hit > st.miss, `hit ${st.hit}, miss ${st.miss}, render ${st.rendered}`);
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
    // Ogni modulo JS caricato dalla pagina deve essere nell'elenco del service worker
    const notListed = await page.evaluate(async () => {
      const src = await (await fetch('./sw.js')).text();
      return performance.getEntriesByType('resource').map((e) => new URL(e.name))
        .filter((u) => u.origin === location.origin && /\/js\/[^/]+\.js$/.test(u.pathname))
        .map((u) => './js/' + u.pathname.split('/').pop())
        .filter((f) => !src.includes(`'${f}'`));
    });
    check('moduli JS tutti precaricati', notListed.length === 0, notListed.join(', '));
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
  const args = name === 'chromium' ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] : [];
  const browser = await pw[name].launch({ args });
  try {
    await layoutTests(browser, url);
    await functionalTests(browser, url);
    await synthTests(browser, url);
    await featureTests(browser, url);
    await audioTests(browser, url);
    await pwaTests(browser, url);
  } catch (err) {
    check(`[${name}] esecuzione`, false, err.message.split('\n').slice(0, 14).join(' | '));
  } finally {
    await browser.close();
  }
}

if (local) local.server.close();
console.log(failures ? `\n✗ ${failures} controlli falliti` : '\n✓ Tutti i controlli superati');
process.exit(failures ? 1 : 0);
