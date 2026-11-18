/**
 * export-dsp.mjs — Esporta kit e preset della web app in JSON per il motore desktop (C#).
 *   node tools/export-dsp.mjs          → scrive desktop/Assets/{kits,presets}.json
 *   node tools/export-dsp.mjs --check  → errore se i file non sono aggiornati
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { KITS } from '../js/kits.js';
import { PRESETS } from '../js/presets.js';

const root = new URL('../desktop/Assets/', import.meta.url);
const kits = KITS.map((k) => ({
  id: k.id, name: k.name, group: k.group || null, bpm: k.bpm, swing: k.swing, crush: k.crush || 0, lp: k.lp || 0,
  tracks: k.tracks.map((t) => ({ name: t.name, short: t.short, pan: t.pan || 0, voice: t.play.spec })),
}));
const out = {
  'kits.json': JSON.stringify(kits, null, 1) + '\n',
  'presets.json': JSON.stringify(PRESETS, null, 1) + '\n',
};
const check = process.argv.includes('--check');
let stale = 0;
for (const [f, data] of Object.entries(out)) {
  const url = new URL(f, root);
  if (check) {
    let cur = '';
    try { cur = readFileSync(url, 'utf8'); } catch (_) { /* assente */ }
    if (cur !== data) { console.error(`✗ desktop/Assets/${f} non aggiornato: esegui node tools/export-dsp.mjs`); stale++; }
  } else {
    writeFileSync(url, data);
  }
}
if (check && !stale) console.log('✓ Asset del motore desktop aggiornati');
process.exit(stale ? 1 : 0);
