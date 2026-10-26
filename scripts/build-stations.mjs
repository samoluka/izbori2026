// Builds public/data/biracka-mesta.geojson: approximate polling-station areas.
// Each area is the Voronoi cell around the station location, clipped to the
// municipality boundary. Stations at the same location share one cell.
// RIK does not publish coordinates, so locations come from the geocoded list on
// rezultatiizbora.rs (keyed by RIK bm_uid), with fallback to its 2023 list.
// Results themselves are always taken from RIK (results.json).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Delaunay } from 'd3-delaunay';
import polygonClipping from 'polygon-clipping';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const RAW = path.join(ROOT, 'raw');
const DATA = path.join(ROOT, 'public', 'data');
const OUT = path.join(DATA, 'biracka-mesta.geojson');

async function cached(url, file) {
  const p = path.join(RAW, file);
  if (!fs.existsSync(p)) {
    console.log('Downloading', url);
    const res = await fetch(url, { headers: { 'User-Agent': 'izbori2026-map/1.0' } });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    fs.writeFileSync(p, Buffer.from(await res.arrayBuffer()));
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const results = JSON.parse(fs.readFileSync(path.join(DATA, 'results.json'), 'utf8'));
const muniGeo = JSON.parse(fs.readFileSync(path.join(DATA, 'opstine.geojson'), 'utf8'));
const loc26 = (await cached('https://rezultatiizbora.rs/data-2026.json', 'ri-2026.json')).stations;
const loc23 = (await cached('https://rezultatiizbora.rs/data.json', 'ri-2023.json')).stations;

const norm = (s) => String(s || '').toUpperCase().replace(/^\d+\s*-\s*/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const ok = (s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lon) && s.lat > 41 && s.lat < 47 && s.lon > 18 && s.lon < 23.5;

const bySid = new Map(loc26.filter(ok).map((s) => [String(s.sid), s]));
const byName23 = new Map();
const byNo23 = new Map();
for (const s of loc23.filter(ok)) {
  byName23.set(`${s.muni}|${norm(s.name)}`, s);
  byNo23.set(`${s.muni}|${s.no}`, s);
}

const munisByCode = results.municipalities;
const stationsByMuni = {};
let src = { y2026: 0, nameMatch: 0, noMatch: 0, sameName: 0, none: 0 };
for (const st of results.stations) {
  const m = munisByCode[st.m];
  let loc = bySid.get(String(st.id));
  if (loc) src.y2026++;
  else if ((loc = byName23.get(`${m.fullName}|${norm(st.name)}`))) src.nameMatch++;
  else if ((loc = byNo23.get(`${m.fullName}|${st.no}`)) && norm(loc.name).slice(0, 6) === norm(st.name).slice(0, 6)) src.noMatch++;
  else loc = null;
  (stationsByMuni[st.m] ??= []).push({ st, loc: loc ? [loc.lon, loc.lat] : null });
}
// Same building name in the same municipality -> same location.
for (const list of Object.values(stationsByMuni)) {
  const known = new Map(list.filter((x) => x.loc).map((x) => [norm(x.st.name), x.loc]));
  for (const x of list) if (!x.loc && known.has(norm(x.st.name))) { x.loc = known.get(norm(x.st.name)); src.sameName++; }
  for (const x of list) if (!x.loc) src.none++;
}
console.log('Location sources:', src);

function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const polysOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
const inGeom = (pt, g) => polysOf(g).some((p) => pointInRing(pt, p[0]) && !p.slice(1).some((h) => pointInRing(pt, h)));

function bbox(g) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of polysOf(g)) for (const [x, y] of p[0]) b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
  return b;
}

const features = [];
let outside = 0, attached = 0;
for (const f of muniGeo.features) {
  const code = f.properties.code;
  const list = stationsByMuni[code];
  if (!list) continue;
  // Group stations sharing (nearly) the same location.
  const [bx0, by0, bx1, by1] = bbox(f.geometry);
  const near = (p) => p[0] > bx0 - 0.03 && p[0] < bx1 + 0.03 && p[1] > by0 - 0.03 && p[1] < by1 + 0.03;
  const groups = new Map();
  for (const x of list) {
    if (!x.loc) continue;
    if (!inGeom(x.loc, f.geometry) && !near(x.loc)) { outside++; x.loc = null; continue; }
    // Merge points within ~150 m: near-duplicate geocodes otherwise create sliver cells.
    let g = null;
    for (const cand of groups.values()) {
      const dx = (cand.loc[0] - x.loc[0]) * Math.cos((x.loc[1] * Math.PI) / 180), dy = cand.loc[1] - x.loc[1];
      if (dx * dx + dy * dy < 0.00135 ** 2) { g = cand; break; }
    }
    if (!g) { g = { loc: x.loc, ids: [] }; groups.set(groups.size, g); }
    g.ids.push(x.st.id);
    x.g = g;
  }
  // Stations without a usable location join the located station with the closest number.
  const located = list.filter((x) => x.loc);
  for (const x of list) {
    if (x.loc || !located.length) continue;
    const best = located.reduce((a, b) => (Math.abs(b.st.no - x.st.no) < Math.abs(a.st.no - x.st.no) ? b : a));
    best.g.ids.push(x.st.id);
    attached++;
  }
  const gs = [...groups.values()];
  const clipPoly = polysOf(f.geometry);
  if (gs.length === 0) continue;
  if (gs.length === 1) {
    features.push({ type: 'Feature', properties: { m: code, ids: gs[0].ids }, geometry: f.geometry });
    continue;
  }
  const k = Math.cos((gs[0].loc[1] * Math.PI) / 180); // equalise x/y scale
  const [x0, y0, x1, y1] = bbox(f.geometry);
  const del = Delaunay.from(gs, (g) => g.loc[0] * k, (g) => g.loc[1]);
  const vor = del.voronoi([x0 * k - 0.05, y0 - 0.05, x1 * k + 0.05, y1 + 0.05]);
  gs.forEach((g, i) => {
    const cell = vor.cellPolygon(i);
    if (!cell) return;
    const ring = cell.map(([x, y]) => [x / k, y]);
    let clipped;
    try { clipped = polygonClipping.intersection([ring], clipPoly); } catch { return; }
    if (!clipped.length) return;
    features.push({ type: 'Feature', properties: { m: code, ids: g.ids }, geometry: { type: 'MultiPolygon', coordinates: clipped } });
  });
}
console.log(`Cells: ${features.length}, far-off geocodes ignored: ${outside}, unlocated stations attached to neighbours: ${attached}`);

const tmp = path.join(RAW, 'biracka-mesta_raw.geojson');
fs.writeFileSync(tmp, JSON.stringify({ type: 'FeatureCollection', features: features.map((f) => ({ ...f, properties: { m: f.properties.m, ids: f.properties.ids.join(',') } })) }));
const mapshaper = path.join(ROOT, 'node_modules', 'mapshaper', 'bin', 'mapshaper');
execFileSync(process.execPath, [mapshaper, '-i', tmp, '-o', OUT, 'format=geojson', 'precision=0.0001', 'force'], { stdio: 'inherit' });
console.log('Wrote', OUT, (fs.statSync(OUT).size / 1e6).toFixed(1) + ' MB');
