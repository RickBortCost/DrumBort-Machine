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
  const { lab, ...ctxOpts } = extra;
  const context = await browser.newContext({ viewport, hasTouch: true, isMobile: browser.browserType().name() !== 'firefox', acceptDownloads: true, ...ctxOpts });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto(extra.lab ? url : `${url}${url.includes('?') ? '&' : '?'}full&demo`);
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

  // --- Editor wavetable: modifica, salvataggio come preset, ripristino ---
  while ((await page.evaluate(() => drumbort.ui.view)) !== 'synth') await page.tap('[data-cmd="view"]');
  await page.tap('.slbl[data-k="0"]');
  await page.tap('#presetBtn');
  await page.tap('.chip-cat[data-cat="Wavetable"]');
  await page.tap('.lib-row[data-id="wtGrowl"]');
  await page.tap('#libSheet [data-close]');
  await page.tap('#sedBtn');
  check('editor wavetable aperto', await page.isVisible('#waveCanvas'));
  await page.evaluate(() => { const i = document.querySelector('#waveBody input[data-path="wt.osc.0.pos"]'); i.value = 0.8; i.dispatchEvent(new Event('input', { bubbles: true })); });
  const pt = await page.evaluate(`${P()}.synth.tracks[0].patch`);
  check('patch creata dalla modifica', pt && pt.wt.osc[0].pos === 0.8 && pt.rev > 1, pt && `pos ${pt.wt.osc[0].pos} rev ${pt.rev}`);
  await page.tap('#waveTabs [data-tab="mod"]');
  await page.selectOption('.mod-slot[data-i="2"] [data-mod="src"]', 'lfo2');
  await page.selectOption('.mod-slot[data-i="2"] [data-mod="dst"]', 'pitch');
  const mods = await page.evaluate(`${P()}.synth.tracks[0].patch.wt.mod.map((m) => m.src + '>' + m.dst).join()`);
  check('slot di modulazione aggiunto', mods.includes('lfo2>pitch'), mods);
  await page.fill('#waveName', 'Mio Growl');
  await page.tap('[data-act="wave-save"]');
  const saved = await page.evaluate(() => { const t = drumbort.state.slots[drumbort.state.slot].synth.tracks[0]; return [t.preset, !!t.patch, drumbort.state.userPresets.length]; });
  check('salvato come preset utente', saved[0].startsWith('up:') && !saved[1] && saved[2] === 1, saved.join());
  await page.tap('#waveSheet [data-close]');
  await page.tap('#presetBtn');
  check('categoria Utente in libreria', await page.isVisible('.chip-cat[data-cat="Utente"]'));
  await page.tap('#libSheet [data-close]');

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

async function studioTests(browser, url) {
  const name = browser.browserType().name();
  console.log(`\n[${name}] Layout Studio (PC 1440×900)`);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto(`${url}?demo`);
  await page.waitForFunction(() => window.drumbort);
  await page.click('#overlay');
  await page.waitForFunction(() => drumbort.engine.ctx && drumbort.engine.ctx.state === 'running');
  const L = await page.evaluate(() => ({ layout: document.querySelector('#app').dataset.layout, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
    vis: ['#browser', '#session', '#grid', '.side'].every((s) => document.querySelector(s).offsetParent !== null) }));
  check('layout Studio automatico su PC', L.layout === 'studio' && L.vis, L.layout);
  check('Studio senza scroll', L.sw <= 1440 && L.sh <= 900, `${L.sw}×${L.sh}`);

  // Vista TRACCE predefinita (stile Logic): tracce attive del progetto dimostrativo
  const tv = await page.evaluate(() => [!document.querySelector('#sxTracks').hidden, document.querySelectorAll('.tv-hdr').length, drumbort.state.tracks.length]);
  check('vista TRACCE predefinita con le tracce attive', tv[0] && tv[1] === tv[2] && tv[2] > 0, JSON.stringify(tv));
  // Pannelli nascondibili e barra degli effetti della traccia selezionata
  await page.click('#sxBrowser'); await page.click('#sxSide');
  await page.click('.tv-hdr[data-i="1"] .tv-name');
  const pn = await page.evaluate(() => [document.querySelector('.browser').offsetParent === null, document.querySelector('.side').offsetParent === null, document.querySelector('#fxbar').offsetParent !== null]);
  // Catena di device: un riquadro per effetto, manopola dei bassi trascinata in verticale
  const dvs = await page.evaluate(() => [...document.querySelectorAll('#fxbar .dv')].map((d) => d.dataset.dev).join(','));
  check('catena effetti con un riquadro per device', dvs === 'inst,drv,crush,eq,flt,cmp,send,mix', dvs);
  const kb = await page.locator('.kb[data-k="lo"] .kb-dial').boundingBox();
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2); await page.mouse.down();
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2 - 40, { steps: 5 }); await page.mouse.up();
  const lo = await page.evaluate(() => [drumbort.state.slots.every((s) => s.tracks[1].lo === 6), !!drumbort.engine.channels[1].nodes.lo, document.querySelector('[data-dev="eq"]').classList.contains('off')]);
  check('browser e pannello nascosti, effetti della traccia in basso', pn.every(Boolean) && lo[0] && lo[1] && !lo[2], JSON.stringify([pn, lo]));
  await page.click('[data-pw="eq"]');
  const pw = await page.evaluate(() => [drumbort.state.slots[0].tracks[1].lo, document.querySelector('[data-dev="eq"]').classList.contains('off')]);
  await page.click('[data-pw="eq"]');
  const pw2 = await page.evaluate(() => drumbort.state.slots[0].tracks[1].lo);
  check('interruttore del device spegne e ripristina', pw[0] === 0 && pw[1] && pw2 === 6, JSON.stringify([pw, pw2]));
  // Barra inferiore ridimensionabile
  const h0 = await page.evaluate(() => document.querySelector('#fxbar').getBoundingClientRect().height);
  const sp = await page.locator('.sx-split').boundingBox();
  await page.mouse.move(sp.x + sp.width / 2, sp.y + 4); await page.mouse.down();
  await page.mouse.move(sp.x + sp.width / 2, sp.y - 76, { steps: 4 }); await page.mouse.up();
  const h1 = await page.evaluate(() => [document.querySelector('#fxbar').getBoundingClientRect().height, drumbort.state.panels.h]);
  check('barra inferiore ridimensionabile', Math.abs(h1[0] - h0 - 80) < 6 && h1[1] > 0, `${Math.round(h0)} → ${Math.round(h1[0])}`);
  await page.dblclick('.sx-split');
  await page.click('#sxBrowser'); await page.click('#sxSide'); await page.click('[data-bottom="editor"]');
  await page.click('[data-sxv="session"]');

  // Scena e clip
  await page.click('.sx-scene[data-scene="2"]');
  await page.waitForTimeout(300);
  const sc = await page.evaluate(() => [drumbort.seq.playing, drumbort.state.session.map.join(''), drumbort.state.session.master]);
  check('lancio scena P3 avvia la riproduzione', sc[0] && sc[1] === '222222222222' && sc[2] === 2, sc.join(' '));
  await page.click('.sx-cell[data-t="0"][data-s="5"] [data-launch]');
  const queued = await page.evaluate(() => drumbort.ui.queued[0]);
  await page.waitForFunction(() => drumbort.state.session.map[0] === 5, null, { timeout: 8000 }).catch(() => {});
  const launched = await page.evaluate(() => [drumbort.state.session.map[0], drumbort.seq.pattern.steps[0] === drumbort.state.slots[5].steps[0]]);
  check('clip in coda e lanciata al giro di battuta', queued === 5 && launched[0] === 5 && launched[1], `coda ${queued}, ora ${launched[0]}`);
  const live = await page.waitForFunction(() => document.querySelector('.sx-cell[data-t="0"][data-s="5"]').classList.contains('live'), null, { timeout: 3000 }).then(() => true).catch(() => false);
  check('cella in riproduzione evidenziata', live);
  await page.click('.sx-stop[data-stop="3"]');
  await page.waitForFunction(() => drumbort.state.session.map[3] === -1, null, { timeout: 8000 }).catch(() => {});
  check('stop traccia', (await page.evaluate(() => drumbort.state.session.map[3])) === -1);

  // Selezione clip → editor
  await page.click('.sx-cell[data-t="9"][data-s="4"] [data-pick]');
  const pk = await page.evaluate(() => [drumbort.state.slot, drumbort.ui.view, drumbort.ui.ssel]);
  check('selezione clip apre l\'editor giusto', pk[0] === 4 && pk[1] === 'synth' && pk[2] === 1, pk.join(' '));

  // Mixer e livelli
  await page.evaluate(() => { const f = document.querySelector('.mx-strip[data-i="1"] [data-p="vol"]'); f.value = 0.3; f.dispatchEvent(new Event('input', { bubbles: true })); });
  const vol = await page.evaluate(() => { const m = drumbort.state.session.map[1], s = m >= 0 ? m : drumbort.state.session.master; return drumbort.state.slots[s].tracks[1].vol; });
  check('fader del mixer', vol === 0.3, `${vol}`);
  await page.waitForTimeout(500);
  check('indicatori di livello attivi', await page.evaluate(() => [...document.querySelectorAll('.mx-meter i')].some((e) => /scaleY\((0\.0[1-9]|0\.[1-9]|1)/.test(e.style.transform))));

  // Browser
  await page.fill('#bwSearch', 'supersaw');
  await page.click('.bw-item[data-preset="supersaw"]');
  check('browser assegna il suono alla traccia', (await page.evaluate(() => drumbort.state.slots[4].synth.tracks[1].preset)) === 'supersaw');
  await page.fill('#bwSearch', '');
  await page.evaluate(() => document.activeElement.blur());

  // Scorciatoie e stop (non attive mentre si scrive in un campo)
  await page.keyboard.press('2');
  const q2 = await page.evaluate(() => drumbort.ui.queued.every((v) => v === 1) || drumbort.state.session.map.every((v) => v === 1));
  await page.keyboard.press('.');
  check('scorciatoie 1-8 e "."', q2 && (await page.evaluate(() => drumbort.ui.queued.every((v) => v === -1) || drumbort.state.session.map.every((v) => v === -1))));
  await page.click('#play');

  // Quantizzazione del lancio: "Nessuna" → la clip parte allo step successivo
  await page.selectOption('#sxQuant', '0');
  await page.click('.sx-scene[data-scene="0"]');
  await page.click('.sx-cell[data-t="1"][data-s="6"] [data-launch]');
  await page.waitForFunction(() => drumbort.state.session.map[1] === 6, null, { timeout: 1500 }).catch(() => {});
  check('quantizzazione "Nessuna": lancio immediato', (await page.evaluate(() => drumbort.state.session.map[1])) === 6);
  await page.selectOption('#sxQuant', '16');

  // Follow action: P1 → successiva dopo 1 battuta
  await page.selectOption('[data-fa="0"]', 'next');
  await page.selectOption('[data-fn="0"]', '1');
  await page.click('.sx-scene[data-scene="0"]');
  await page.waitForFunction(() => drumbort.state.session.master !== 0, null, { timeout: 9000 }).catch(() => {});
  const fol = await page.evaluate(() => [drumbort.state.session.master, drumbort.state.session.follow[0].a]);
  check('follow action passa alla scena successiva', fol[0] > 0 && fol[1] === 'next', fol.join(' '));
  await page.selectOption('[data-fa="0"]', 'none');
  await page.click('#play');

  // Arrangiamento: registrazione dai lanci, vista, riproduzione
  await page.click('#arrRec');
  await page.click('.sx-scene[data-scene="2"]');
  await page.waitForFunction(() => drumbort.state.arr.bars.length >= 2, null, { timeout: 12000 }).catch(() => {});
  await page.click('#play');
  const ar = await page.evaluate(() => [drumbort.state.arr.bars.length, drumbort.state.arr.on, drumbort.state.arr.bars[0].m.join(''), drumbort.ui.arrRec]);
  check('REC ARR registra le battute della session', ar[0] >= 2 && ar[1] && ar[2] === '222222222222' && !ar[3], ar.join(' '));
  await page.keyboard.press('Tab');
  const av = await page.evaluate(() => [!document.querySelector('#sxArr').hidden, document.querySelectorAll('#arGrid .ar-cell.on').length]);
  check('Tab apre la vista arrangiamento', av[0] && av[1] >= 24, av.join(' '));
  await page.click('[data-ar="add"]');
  const nb = await page.evaluate(() => drumbort.state.arr.bars.length);
  await page.click(`#arGrid .ar-cell[data-ab="${nb - 1}"][data-at="0"]`);
  const pc = await page.evaluate((b) => drumbort.state.arr.bars[b].m[0] === drumbort.state.slot, nb - 1);
  check('+ BAR e pittura delle celle', nb === ar[0] + 1 && pc, `${nb} ${pc}`);
  await page.evaluate(() => { drumbort.state.arr.bars[1].m.fill(4); drumbort.state.arr.bars[1].s = 4; });
  await page.click('#play');
  await page.waitForFunction(() => drumbort.state.session.master === 4, null, { timeout: 9000 }).catch(() => {});
  check('riproduzione dell\'arrangiamento', await page.evaluate(() => drumbort.state.arr.on && drumbort.state.session.map.every((v) => v === 4)));
  await page.keyboard.press('2');
  check('lancio manuale esce dall\'arrangiamento', (await page.evaluate(() => drumbort.state.arr.on)) === false);
  await page.click('#play');
  await page.keyboard.press('Tab');

  // Clip lunghe: 2 battute, contenuto ripetuto, pagina della battuta
  await page.keyboard.press('Escape');
  await page.selectOption('#barsSel', '2');
  const bars = await page.evaluate(() => { const p = drumbort.state.slots[drumbort.state.slot]; return [p.bars, p.steps[0].length, p.tracks[0].len, p.synth.tracks[0].steps.length, JSON.stringify(p.steps[0].slice(0, 16)) === JSON.stringify(p.steps[0].slice(16))]; });
  check('pattern di 2 battute (contenuto ripetuto)', bars[0] === 2 && bars[1] === 32 && bars[2] === 32 && bars[3] === 32 && bars[4], JSON.stringify(bars));
  await page.click('#barSeg [data-bar="1"]');
  await page.click('.step[data-t="2"][data-s="16"]').catch(() => {});
  const b2 = await page.evaluate(() => [drumbort.ui.bar, document.querySelector('.row .step').dataset.s]);
  check('seconda battuta visibile e modificabile', b2[0] === 1 && b2[1] === '16', JSON.stringify(b2));

  // Automazione: corsia disegnata sul volume della cassa, applicata in riproduzione
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.click('#sxAuto');
  await page.selectOption('#autoTarget', 'd0.vol');
  const ab = await page.locator('#autoCanvas').boundingBox();
  await page.mouse.move(ab.x + 5, ab.y + ab.height * 0.8); await page.mouse.down();
  await page.mouse.move(ab.x + ab.width - 5, ab.y + ab.height * 0.2, { steps: 12 }); await page.mouse.up();
  const lane = await page.evaluate(() => { const a = drumbort.state.slots[drumbort.state.slot].auto; return a && a['d0.vol'] && a['d0.vol'].filter((v) => v != null).length; });
  check('corsia di automazione disegnata', lane >= 28, `${lane} step`);
  await page.keyboard.press('Escape');
  await page.click('[data-sxv="session"]');
  await page.evaluate(() => document.querySelector('#play').click());
  await page.waitForTimeout(800);
  const applied = await page.evaluate(() => drumbort.engine._autoLast && drumbort.engine._autoLast[0] !== undefined);
  await page.evaluate(() => document.querySelector('#play').click());
  check('automazione applicata al mixer in riproduzione', applied);
  await page.evaluate(() => { const p = drumbort.state.slots[drumbort.state.slot]; delete p.auto; });
  await page.selectOption('#barsSel', '1');

  // FX per traccia e macro: la macro 1 muove filtro e compressore della cassa
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.click('#sxMacro');
  await page.selectOption('#macroTarget', 'd0.flt');
  await page.click('[data-mact="link"]');
  await page.selectOption('#macroTarget', 'd0.cmp');
  await page.click('[data-mact="link"]');
  await page.evaluate(() => { const r = document.querySelector('[data-mv="0"]'); r.value = 1; r.dispatchEvent(new Event('input', { bubbles: true })); });
  const mac = await page.evaluate(() => {
    const m = drumbort.state.slots, map = drumbort.state.session.map[0], slot = map >= 0 ? map : drumbort.state.session.master;
    const tr = m[slot].tracks[0], ch = drumbort.engine.channels[0];
    return [drumbort.state.macros[0].map.length, tr.flt, tr.cmp, !!ch.nodes.flt, !!ch.nodes.cmp];
  });
  check('macro collegata a filtro e compressore della traccia', mac[0] === 2 && mac[1] === 1 && mac[2] === 1 && mac[3] && mac[4], JSON.stringify(mac));
  await page.keyboard.press('Escape');

  // Piano roll: P apre, clic+trascina crea una nota lunga, clic la elimina
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('p');
  const prOpen = await page.waitForFunction(() => !document.querySelector('#pianoSheet').hidden, null, { timeout: 2000 }).then(() => true).catch(() => false);
  await page.click('#prTracks [data-prk="1"]');
  await page.click('[data-pr="clear"]');
  const prb = await page.locator('#prWrap').boundingBox();
  const prCol = await page.evaluate(() => Math.max(28, Math.floor((document.querySelector('#prWrap').clientWidth - 56) / 16)));
  const pry = prb.y + 100;
  await page.mouse.move(prb.x + 54 + prCol * 2 + 5, pry); await page.mouse.down();
  await page.mouse.move(prb.x + 54 + prCol * 5 + 5, pry, { steps: 4 }); await page.mouse.up();
  const prNote = await page.evaluate(() => { const st = drumbort.state.slots[drumbort.state.slot].synth.tracks[1].steps[2]; return st && [st.g, st.n]; });
  check('piano roll: nota creata con durata trascinata', prOpen && prNote && prNote[0] === 4, JSON.stringify(prNote));
  await page.mouse.click(prb.x + 54 + prCol * 2 + 8, pry);
  check('piano roll: clic sulla nota la elimina', await page.evaluate(() => drumbort.state.slots[drumbort.state.slot].synth.tracks[1].steps[2] === null));
  // Tastiera del computer come tastiera musicale
  await page.click('[data-pr="kb"]');
  const prPlays = await page.evaluate(() => { window.__n = 0; const o = drumbort.engine.playSynth.bind(drumbort.engine); drumbort.engine.playSynth = (...a) => { window.__n++; return o(...a); }; return 0; });
  await page.keyboard.down('a'); await page.keyboard.up('a'); await page.keyboard.down('d'); await page.keyboard.up('d');
  check('tastiera del computer suona il synth', (await page.evaluate(() => window.__n)) >= 2 + prPlays, `${await page.evaluate(() => window.__n)}`);
  await page.click('[data-pr="kb"]');
  await page.keyboard.press('Escape');

  // Editor wavetable raggiungibile da ovunque: pulsante WT, tasto W, scelta traccia
  await page.keyboard.press('w');
  const wk = await page.evaluate(() => !document.querySelector('#waveSheet').hidden);
  await page.keyboard.press('Escape');
  await page.click('#wtBtn');
  await page.click('#waveTracks [data-wtk="3"]');
  const wb = await page.evaluate(() => [!document.querySelector('#waveSheet').hidden, drumbort.ui.ssel]);
  check('editor wavetable da tasto W e pulsante WT', wk && wb[0] && wb[1] === 3, `${wk} ${wb}`);
  await page.keyboard.press('Escape');

  // Export degli stem: ZIP con un WAV per traccia usata
  await page.click('#menuBtn');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), page.click('#menu [data-act="stems"]')]);
  const zpath = await dl.path();
  const zbuf = (await import('node:fs')).readFileSync(zpath);
  const nWav = (zbuf.toString('latin1').match(/\.wav/g) || []).length / 2;
  check('stem esportati in uno ZIP', dl.suggestedFilename().endsWith('.zip') && zbuf.readUInt32LE(0) === 0x04034b50 && nWav >= 4, `${dl.suggestedFilename()} · ${nWav} WAV`);

  // Menu a sezioni e cambio layout
  await page.click('#menuBtn');
  const secs = await page.evaluate(() => [...document.querySelectorAll('#menu .msec h3')].map((h) => h.textContent).join('|'));
  check('menu a sezioni', secs.split('|').length === 4, secs);
  await page.click('#menu [data-act="layout"]');
  check('passaggio al layout compatto', (await page.evaluate(() => document.querySelector('#app').dataset.layout)) === 'compact');
  await page.click('#layoutBtn');
  check('ritorno al layout Studio', (await page.evaluate(() => document.querySelector('#app').dataset.layout)) === 'studio');

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
        const ctx = new OAC(1, 44100 * 3, 44100);
        tr.play(ctx, ctx.destination, 0.01, 1, { tune: 0, decay: 1 });
        const d = (await ctx.startRendering()).getChannelData(0);
        let pk = 0, nan = false;
        for (let i = 0; i < d.length; i++) { if (d[i] !== d[i]) nan = true; pk = Math.max(pk, Math.abs(d[i])); }
        if (nan || pk < 0.05 || pk > 2) bad.push(`${k.id}/${tr.short}:${pk.toFixed(3)}${nan ? ' NaN' : ''}`);
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

async function labTests(browser, url) {
  const name = browser.browserType().name();
  console.log(`\n[${name}] Sound Lab (telefono) → PC`);
  const { context, page, errors } = await openApp(browser, url, VIEWPORTS[0], { lab: true });
  const L = await page.evaluate(() => ({
    mode: document.documentElement.dataset.mode, app: document.querySelector('#app').offsetParent !== null,
    sw: document.documentElement.scrollWidth, tabs: Math.min(...[...document.querySelectorAll('[data-ltab]')].map((b) => b.getBoundingClientRect().height)),
  }));
  check('il telefono apre il Sound Lab senza drum machine', L.mode === 'lab' && !L.app && L.sw <= 440, JSON.stringify(L));
  check('schede ≥ 44 px', L.tabs >= 44, `${L.tabs}`);

  // Synth: editor wavetable nella pagina, suono wavetable pronto, pad a note
  const S = await page.evaluate(() => ({ main: !document.querySelector('#waveMain').hidden, inLab: !!document.querySelector('#labSynth #waveMain'), name: document.querySelector('#labPreset').textContent }));
  check('editor wavetable integrato con un suono wavetable', S.main && S.inLab, JSON.stringify(S));
  await page.locator('#labSynth .spad').first().dispatchEvent('pointerdown', { pointerId: 3, isPrimary: true });
  await page.locator('#labSynth .spad').first().dispatchEvent('pointerup', { pointerId: 3, isPrimary: true });
  await page.fill('#waveName', 'Basso dal telefono');
  await page.dispatchEvent('#waveName', 'change');
  page.once('dialog', (d) => d.accept('Basso dal telefono'));
  await page.tap('[data-act="wave-save"]');
  const up = await page.evaluate(() => drumbort.state.userPresets.map((p) => p.name));
  check('synth salvato tra i miei suoni', up.length === 1, up.join(', '));

  // Batteria: parti dal rullante dubstep, modifica, aggiungi uno strato, salva
  await page.tap('[data-ltab="drum"]');
  await page.selectOption('#ldFrom', 'k|dubstep|1');
  await page.evaluate(() => { const r = document.querySelector('#ldParams input[data-key="tones.0"]'); r.value = 0.8; r.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.tap('#ldLayers [data-layer="add"]');
  await page.tap('#ldPad');
  await page.fill('#ldName', 'Snare telefono');
  await page.tap('#ldSave');
  const snd = await page.evaluate(() => drumbort.state.userSounds[0]);
  check('suono di batteria salvato (4 strati, tono modificato)', snd && snd.name === 'Snare telefono' && snd.spec.type === 'layer' && snd.spec.voices.length === 4 && snd.spec.voices[0].o.tones[0] !== 205, JSON.stringify(snd && snd.spec).slice(0, 120));
  const wave = await page.evaluate(() => document.querySelector('#ldInfo').textContent);
  check('forma d\'onda del suono disegnata', /ms|s ·/.test(wave), wave);

  // Link per il PC
  await page.tap('[data-ltab="mine"]');
  const rows = await page.evaluate(() => document.querySelectorAll('.lm-row').length);
  check('I MIEI SUONI elenca synth e batteria', rows === 2, `${rows}`);
  const link = await page.evaluate(async () => {
    const { encodeShare } = await import('./js/projects.js');
    const s = drumbort.state;
    return `${location.origin}${location.pathname}#snd=${await encodeShare({ app: 'drumbort-sound', v: 1, presets: s.userPresets, sounds: s.userSounds })}`;
  });
  check('nessun errore JS nel Lab', errors.length === 0, errors.join(' | '));
  await context.close();

  // PC: apre il link, il suono va in libreria e su una traccia del kit
  const pc = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p2 = await pc.newPage();
  const e2 = [];
  p2.on('pageerror', (e) => e2.push(e.message));
  await p2.goto(link);
  await p2.waitForFunction(() => window.drumbort);
  await p2.click('#overlay');
  await p2.waitForFunction(() => drumbort.state.userSounds.length === 1, null, { timeout: 5000 }).catch(() => {});
  const imp = await p2.evaluate(() => [drumbort.state.userSounds.length, drumbort.state.userPresets.length, location.hash]);
  check('il PC importa i suoni dal link', imp[0] === 1 && imp[1] === 1 && !imp[2], JSON.stringify(imp));
  await p2.click('[data-btab="kits"]');
  await p2.click('[data-sxv="session"]');
  await p2.click('.sx-th[data-sel="1"]');
  await p2.click('[data-btab="kits"]');
  await p2.click('.bw-item[data-usound]');
  const kit = await p2.evaluate(() => { const p = drumbort.state.slots[drumbort.state.slot]; const k = drumbort.state.userKits.find((d) => d.id === p.kit); return [p.kit, k && k.map[1].sound, document.querySelector('#kit').selectedOptions[0].textContent]; });
  check('un clic mette il suono sulla traccia selezionata (kit utente)', kit[0].startsWith('u:') && kit[1] === snd.id, kit.join(' / '));
  await p2.evaluate(() => drumbort.engine.trigger(1, drumbort.engine.ctx.currentTime, 1, drumbort.seq.pattern.tracks[1]));
  await p2.click('#menuBtn'); await p2.click('#menu [data-act="kits"]');
  const opt = await p2.evaluate(() => [...document.querySelectorAll('#kitRows select[data-slot="1"] option')].some((o) => o.selected && o.value.startsWith('sound|')));
  check('Crea kit mostra il suono del telefono', opt);
  check('nessun errore JS sul PC', e2.length === 0, e2.join(' | '));
  await pc.close();
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
    await studioTests(browser, url);
    await labTests(browser, url);
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
