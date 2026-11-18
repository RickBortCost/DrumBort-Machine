/**
 * export-dsp.mjs — Esporta kit e preset della web app in JSON per il motore desktop (C#).
 *   node tools/export-dsp.mjs          → scrive desktop/Assets/{kits,presets}.json
 *   node tools/export-dsp.mjs --check  → errore se i file non sono aggiornati
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { KITS } from '../js/kits.js';
import { PRESETS } from '../js/presets.js';
import { DEVICES, CATEGORIES } from '../js/devices.js';
import { createPattern } from '../js/sequencer.js';
import { normalizeSession, normalizeArr } from '../js/session.js';

const root = new URL('../desktop/Assets/', import.meta.url);
const kits = KITS.map((k) => ({
  id: k.id, name: k.name, group: k.group || null, bpm: k.bpm, swing: k.swing, crush: k.crush || 0, lp: k.lp || 0,
  tracks: k.tracks.map((t) => ({ name: t.name, short: t.short, pan: t.pan || 0, voice: t.play.spec })),
}));
// Device (catena di effetti) per l'interfaccia Windows: parametri e unità di misura
const unitOf = (x) => {
  if (x.kind === 'enum') return 'enum';
  const t = String(x.fmt(x.def));
  return /Hz/.test(t) ? 'hz' : /dB/.test(t) ? 'db' : /%/.test(t) ? 'pct' : /ms/.test(t) ? 'ms' : /: 1/.test(t) ? 'ratio' : /bit/.test(t) ? 'bit' : / s$/.test(t) ? 's' : 'num';
};
const devices = Object.entries(DEVICES).map(([type, d]) => ({
  type, name: d.name, cat: d.cat, desc: d.desc, graph: d.graph || null,
  params: d.params.map((x) => ({ k: x.k, label: x.label, kind: x.kind, min: x.min ?? null, max: x.max ?? null, def: x.def, curve: x.curve || null, unit: unitOf(x), options: x.options || null })),
}));
// Progetto vuoto (formato della web app): pattern senza note, catene vuote
const pattern = createPattern(KITS[0].id, false, null);
const emptyProject = {
  app: 'drumbort', version: 3, slot: 0, slots: Array.from({ length: 8 }, () => pattern),
  song: { on: false, chain: [] }, fx: { filter: 0, res: 0.7, rev: 0.8, size: 2.2, dly: 0.7, fb: 0.35, div: 3, master: 0.8, sc: 0, scRel: 0.18 },
  lock: null, session: normalizeSession(null), arr: normalizeArr(null), tracks: [], devs: Array.from({ length: 12 }, () => []),
  userKits: [], userPresets: [], userSounds: [],
};
const out = {
  'kits.json': JSON.stringify(kits, null, 1) + '\n',
  'presets.json': JSON.stringify(PRESETS, null, 1) + '\n',
  'devices.json': JSON.stringify({ categories: CATEGORIES, devices }, null, 1) + '\n',
  'empty-project.json': JSON.stringify(emptyProject) + '\n',
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
