/**
 * Server statico minimale per i test: serve la root del repo sotto /DrumBort-Machine/
 * (stesso sottopercorso di GitHub Pages). Nessuna dipendenza.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const BASE = '/DrumBort-Machine/';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

export function startServer(port = 0) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith(BASE)) { res.writeHead(404).end(); return; }
    let rel = decodeURIComponent(url.pathname.slice(BASE.length)) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(ROOT, rel));
    if (!file.startsWith(ROOT) || /(^|[\\/])(\.git|node_modules|tests)([\\/]|$)/.test(rel)) { res.writeHead(404).end(); return; }
    try {
      if (!(await stat(file)).isFile()) throw new Error('dir');
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(await readFile(file));
    } catch (_) {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    resolve({ server, url: `http://127.0.0.1:${server.address().port}${BASE}` });
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await startServer(Number(process.env.PORT) || 8080);
  console.log(`DrumBort su ${url}`);
}
