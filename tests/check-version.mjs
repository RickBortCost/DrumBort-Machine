/**
 * Verifica che la versione sia coerente in js/version.js, sw.js e CHANGELOG.md.
 * Uscita con codice 1 in caso di disallineamento.
 */
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const app = (read('js/version.js').match(/APP_VERSION\s*=\s*'(\d+\.\d+\.\d+)'/) || [])[1];
const sw = (read('sw.js').match(/const VERSION\s*=\s*'(\d+\.\d+\.\d+)'/) || [])[1];
const changelog = read('CHANGELOG.md').includes(`## [${app}]`);
const desktop = (read('desktop/DrumBort.Desktop.csproj').match(/<Version>(\d+\.\d+\.\d+)<\/Version>/) || [])[1];

const errors = [];
if (!app) errors.push('APP_VERSION non trovata in js/version.js');
if (!sw) errors.push('VERSION non trovata in sw.js');
if (app && sw && app !== sw) errors.push(`js/version.js (${app}) ≠ sw.js (${sw})`);
if (app && !changelog) errors.push(`CHANGELOG.md non contiene la sezione "## [${app}]"`);
if (app && desktop !== app) errors.push(`desktop/DrumBort.Desktop.csproj (${desktop}) ≠ js/version.js (${app})`);

if (errors.length) {
  console.error('✗ Versione incoerente:\n  - ' + errors.join('\n  - '));
  process.exit(1);
}
console.log(`✓ Versione ${app} coerente (version.js, sw.js, CHANGELOG.md, host desktop)`);
