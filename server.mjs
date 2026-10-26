// Local static server for public/ that also re-fetches RIK results periodically.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fetchResults, RESULTS_FILE } from './scripts/fetch-results.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 8080;
const REFRESH_MIN = Number(process.env.REFRESH_MIN) || 3;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.geojson': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
};

async function refresh() {
  try {
    const res = await fetchResults();
    fs.writeFileSync(RESULTS_FILE + '.tmp', JSON.stringify(res));
    fs.renameSync(RESULTS_FILE + '.tmp', RESULTS_FILE);
    console.log(`[${new Date().toLocaleTimeString()}] RIK ${res.updated}: ${res.national.processed}/${res.national.stations} BM`);
  } catch (e) {
    console.warn('RIK refresh failed:', e.message);
  }
}

http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.normalize(path.join(PUBLIC, url === '/' ? 'index.html' : url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, () => console.log(`http://localhost:${PORT}  (RIK refresh every ${REFRESH_MIN} min)`));

if (!fs.existsSync(RESULTS_FILE)) await refresh();
setInterval(refresh, REFRESH_MIN * 60_000);
refresh();
