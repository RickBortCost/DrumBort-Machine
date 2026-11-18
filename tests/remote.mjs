/**
 * remote.mjs — Test end-to-end dell'host desktop (desktop/) con due "dispositivi":
 * un PC (layout Studio) e un telefono (440×956), entrambi su Chromium.
 *
 *   node tests/remote.mjs [percorso/DrumBortHost]
 *
 * 1. Motore nativo C# (--no-audio): entrambi i browser sono controller silenziosi, il progetto
 *    si sincronizza, play/stop e i pad arrivano al motore (stato letto da /host.json).
 * 2. Relay (--mode browser): il browser del PC produce l'audio, il telefono lo comanda.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const BIN = process.argv[2] || new URL('../desktop/bin/Release/net8.0/DrumBortHost' + (process.platform === 'win32' ? '.exe' : ''), import.meta.url).pathname;
if (!existsSync(BIN)) { console.error(`Host non trovato: ${BIN} (dotnet build -c Release in desktop/)`); process.exit(1); }

let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${info ? ` — ${info}` : ''}`);
  if (!ok) failed++;
};

async function startHost(args, port) {
  const p = spawn(BIN, [...args, '--port', String(port), '--no-qr', '--no-browser'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  p.stdout.on('data', (d) => { log += d; });
  p.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/host.json`); if (r.ok) return { p, log: () => log }; } catch (_) { /* in avvio */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  p.kill();
  throw new Error(`L'host non risponde:\n${log}`);
}
const status = async (port) => (await fetch(`http://127.0.0.1:${port}/host.json`)).json();
const waitFor = async (fn, ms = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return false;
};

async function open(browser, url, phone) {
  const ctx = await browser.newContext(phone
    ? { viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }
    : { viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.drumbort);
  await page.click('#overlay');
  await page.waitForFunction(() => drumbort.engine.ctx);
  await page.waitForFunction(() => drumbort.remote && drumbort.remote.role, null, { timeout: 8000 });
  return { ctx, page, errors };
}

const browser = await chromium.launch();

// ---------------------------------------------------------------- nativo
{
  console.log('\n[host] Motore nativo C# (senza scheda audio)');
  const port = 8800 + Math.floor(Math.random() * 500);
  const host = await startHost(['--no-audio'], port);
  try {
    const pc = await open(browser, `http://localhost:${port}/?demo`, false);
    const ph = await open(browser, `http://127.0.0.1:${port}/?full&demo`, true);
    const roles = await Promise.all([pc, ph].map((d) => d.page.evaluate(() => [drumbort.remote.role, drumbort.remote.native, drumbort.engine.silent, document.querySelector('#remoteBadge').textContent])));
    check('PC e telefono sono controller del motore nativo', roles.every((r) => r[0] === 'control' && r[1] && r[2] && r[3] === 'CTRL·C#'), JSON.stringify(roles));

    const same = await waitFor(async () => {
      const [a, b] = await Promise.all([pc, ph].map((d) => d.page.evaluate(() => JSON.stringify(drumbort.state.slots.map((s) => s.steps)))));
      return a === b;
    });
    check('il telefono riceve il progetto del PC', same);

    // Modifica dal telefono → PC e motore
    const before = (await status(port)).engine.steps;
    const cell = await ph.page.evaluate(() => {
      const p = drumbort.state.slots[drumbort.state.slot];
      for (let s = 0; s < 8; s++) if (!p.steps[0][s]) return s;
      return 0;
    });
    await ph.page.locator(`.step[data-t="0"][data-s="${cell}"]`).dispatchEvent('pointerdown', { pointerId: 1, isPrimary: true, button: 0 });
    await ph.page.locator(`.step[data-t="0"][data-s="${cell}"]`).dispatchEvent('pointerup', { pointerId: 1, isPrimary: true, button: 0 });
    const synced = await waitFor(() => pc.page.evaluate((s) => drumbort.state.slots[drumbort.state.slot].steps[0][s] === 1, cell));
    check('step dal telefono → PC', synced);
    const engSteps = await waitFor(async () => (await status(port)).engine.steps === before + 1);
    check('step dal telefono → motore C#', engSteps, `${before} → ${(await status(port)).engine.steps}`);

    // Trasporto
    await ph.page.click('#play');
    const playing = await waitFor(async () => { const s = (await status(port)).engine; return s.playing && s.tick > 8; });
    check('play dal telefono avvia il motore', playing);
    const pcPlay = await pc.page.evaluate(() => drumbort.seq.playing);
    check('play dal telefono → anche il PC segue il trasporto', pcPlay);
    const voices = (await status(port)).engine.voices;
    check('il motore suona le voci del pattern', voices > 0, `${voices} voci`);
    await pc.page.click('#play');
    check('stop dal PC ferma il motore', await waitFor(async () => !(await status(port)).engine.playing));

    // Pad dal vivo
    await ph.page.evaluate(() => drumbort.remote.op('trig', { i: 0, vel: 1 }));
    check('pad dal telefono suonato dal motore', await waitFor(async () => (await status(port)).engine.voices > 0, 2000));

    // Sound Lab sul telefono: un suono salvato arriva al PC e al motore, il progetto del PC resta intatto
    const lab = await open(browser, `http://127.0.0.1:${port}/`, true);
    const pcSteps = await pc.page.evaluate(() => JSON.stringify(drumbort.state.slots.map((s) => s.steps)));
    const lm = await lab.page.evaluate(() => [document.documentElement.dataset.mode, drumbort.engine.silent, document.querySelector('#labBadge').textContent]);
    check('telefono in Sound Lab collegato, con audio locale', lm[0] === 'lab' && !lm[1] && lm[2] === '⇄ PC', JSON.stringify(lm));
    await lab.page.click('[data-ltab="drum"]');
    await lab.page.selectOption('#ldFrom', 't|kick');
    await lab.page.fill('#ldName', 'Kick dal Lab');
    await lab.page.click('#ldSave');
    check('il suono arriva al PC', await waitFor(() => pc.page.evaluate(() => drumbort.state.userSounds.some((s) => s.name === 'Kick dal Lab'))));
    check('il suono arriva al motore C#', await waitFor(async () => (await status(port)).engine.sounds === 1));
    const pcSame = await pc.page.evaluate(() => JSON.stringify(drumbort.state.slots.map((s) => s.steps)));
    check('il Sound Lab non tocca il progetto del PC', pcSame === pcSteps);
    // Il PC lo assegna a una traccia: il kit utente col suono arriva al motore
    await pc.page.evaluate(() => { const s = drumbort.state.userSounds.find((x) => x.name === 'Kick dal Lab'); document.querySelector('[data-btab="kits"]').click(); });
    await pc.page.click('[data-sxv="session"]');
    await pc.page.click('.sx-th[data-sel="0"]');
    await pc.page.click('[data-btab="kits"]');
    await pc.page.click('.bw-item[data-usound]');
    check('kit con il suono del Lab in uso sul motore', await waitFor(async () => (await status(port)).engine.kit.startsWith('u:')));

    const errs = [...pc.errors, ...ph.errors, ...lab.errors];
    check('nessun errore JS', errs.length === 0, errs.join(' | '));
    await pc.ctx.close(); await ph.ctx.close(); await lab.ctx.close();
  } finally { host.p.kill(); }
}

// ---------------------------------------------------------------- relay
{
  console.log('\n[host] Relay: audio dal browser del PC');
  const port = 9400 + Math.floor(Math.random() * 500);
  const host = await startHost(['--mode', 'browser'], port);
  try {
    const pc = await open(browser, `http://localhost:${port}/?demo`, false);
    const ph = await open(browser, `http://127.0.0.1:${port}/?full&demo`, true);
    const r = await Promise.all([pc, ph].map((d) => d.page.evaluate(() => [drumbort.remote.role, drumbort.engine.silent])));
    check('PC = motore audio, telefono = controller', r[0][0] === 'engine' && !r[0][1] && r[1][0] === 'control' && r[1][1], JSON.stringify(r));
    await ph.page.click('#play');
    check('play dal telefono avvia il PC', await waitFor(() => pc.page.evaluate(() => drumbort.seq.playing)));
    await pc.page.evaluate(() => { drumbort.state.slots[drumbort.state.slot].bpm = 133; document.querySelector('#bpmUp').dispatchEvent(new PointerEvent('pointerdown')); document.querySelector('#bpmUp').dispatchEvent(new PointerEvent('pointerup')); });
    check('BPM dal PC → telefono', await waitFor(() => ph.page.evaluate(() => drumbort.state.slots[drumbort.state.slot].bpm === 134)));
    await ph.page.click('#play');
    check('stop dal telefono ferma il PC', await waitFor(() => pc.page.evaluate(() => !drumbort.seq.playing)));
    await pc.ctx.close(); await ph.ctx.close();
  } finally { host.p.kill(); }
}

await browser.close();
console.log(failed ? `\n✗ ${failed} controlli falliti` : '\n✓ Host desktop: tutti i controlli superati');
process.exit(failed ? 1 : 0);
