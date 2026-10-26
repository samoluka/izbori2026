// Builds public/data/opstine.geojson: municipality polygons keyed by the same
// "matični broj" (sifra_opstine) that RIK uses in its results export.
// Source of geometry: OpenStreetMap (ref:RS:opstina / ref:RS:grad tags).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import osmtogeojson from 'osmtogeojson';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const RAW = path.join(ROOT, 'raw');
const OUT = path.join(ROOT, 'public', 'data', 'opstine.geojson');
fs.mkdirSync(RAW, { recursive: true });

const SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

async function overpass(query, cacheFile) {
  const cache = path.join(RAW, cacheFile);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = SERVERS[attempt % SERVERS.length];
    try {
      console.log(`Overpass (${url}) -> ${cacheFile}`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'izbori2026-map/1.0' },
        body: 'data=' + encodeURIComponent(query),
      });
      const text = await res.text();
      if (!res.ok || !text.trim().startsWith('{')) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
      fs.writeFileSync(cache, text);
      return JSON.parse(text);
    } catch (e) {
      console.warn('  failed:', e.message);
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    }
  }
  throw new Error('Overpass unavailable');
}

// Kosovo i Metohija: OSM has the post-2008 municipalities; RIK still reports
// results for the old (pre-2008) ones, so new ones are merged into the old code.
// Codes prefixed with "KM-" have no polling stations in RIK data.
const KOSOVO = {
  1332162: ['90140', 'Косовска Каменица'], 6903238: ['90140', 'Косовска Каменица'],
  1332163: ['90107', 'Исток'],
  1332164: ['90026', 'Вучитрн'],
  1332165: ['90212', 'Ораховац'], 1332196: ['90212', 'Ораховац'],
  1332166: ['KM-SR', 'Сува Река'],
  1332167: ['90298', 'Косовска Митровица'], 7426353: ['90298', 'Косовска Митровица'],
  1332168: ['KM-GL', 'Глоговац'],
  1332169: ['KM-DJ', 'Ђаковица'],
  1332170: ['KM-DE', 'Дечани'], 1332191: ['KM-DE', 'Дечани'],
  1332171: ['90328', 'Штрпце'],
  1332172: ['90042', 'Гњилане'], 6901844: ['90042', 'Гњилане'],
  1332173: ['90093', 'Зубин Поток'],
  1332174: ['90255', 'Призрен'], 1332193: ['90255', 'Призрен'],
  1332175: ['KM-ST', 'Штимље'],
  1332176: ['90158', 'Лепосавић'],
  1332177: ['90182', 'Ново Брдо'],
  1332178: ['90204', 'Обилић'],
  1332179: ['90123', 'Клина'],
  1332180: ['KM-KA', 'Качаник'], 1332197: ['KM-KA', 'Качаник'],
  1332181: ['90263', 'Приштина'], 6901830: ['90263', 'Приштина'],
  1332182: ['90247', 'Подујево'],
  1332183: ['90271', 'Србица'],
  1332187: ['90239', 'Пећ'],
  1332188: ['90166', 'Липљан'],
  1332190: ['90131', 'Косово Поље'],
  1332192: ['90301', 'Урошевац'],
  1332194: ['90018', 'Витина'], 6901841: ['90018', 'Витина'],
  1332195: ['90352', 'Звечан'],
  1332198: ['90336', 'Гора'],
};

const tags = await overpass(
  '[out:json][timeout:120];area["ISO3166-1"="RS"][admin_level=2]->.a;rel(area.a)[boundary=administrative][admin_level~"^(7|8)$"];out tags;',
  'osm_tags.json',
);

// Prefer the finest level: if a city (grad) is split into gradske opštine,
// RIK reports per gradska opština, and those carry their own ref.
const relCode = new Map();
for (const el of tags.elements) {
  const t = el.tags || {};
  const code = t['ref:RS:opstina'] || t['ref:RS:grad'];
  if (code) relCode.set(el.id, { code, name: (t.name || '').replace(/^(Општина|Град|Градска општина)\s+/, '') });
}
for (const [id, [code, name]] of Object.entries(KOSOVO)) relCode.set(Number(id), { code, name });
// RIK reports Врањска Бања together with Град Врање.
for (const v of relCode.values()) if (v.code === '71358') Object.assign(v, { code: '70432', name: 'Врање' });

const ids = [...relCode.keys()];
const geo = await overpass(`[out:json][timeout:300];rel(id:${ids.join(',')});out body;>;out skel qt;`, 'osm_geom.json');
const fc = osmtogeojson(geo);

// Drop parent units (e.g. Град Београд) that are subdivided into units we also have.
const parents = new Set();
for (const el of geo.elements) {
  if (el.type !== 'relation' || !relCode.has(el.id)) continue;
  if ((el.members || []).some((m) => m.type === 'relation' && m.role === 'subarea' && relCode.has(m.ref))) parents.add(el.id);
}
console.log('Parent units dropped:', [...parents].map((id) => relCode.get(id).name).join(', '));

const features = [];
for (const f of fc.features) {
  if (!/Polygon/.test(f.geometry?.type)) continue;
  const id = Number(String(f.id).split('/')[1]);
  const info = relCode.get(id);
  if (!info || parents.has(id)) continue;
  features.push({ type: 'Feature', properties: { code: info.code, osm: id, name: info.name }, geometry: f.geometry });
}
const rawFile = path.join(RAW, 'opstine_raw.geojson');
fs.writeFileSync(rawFile, JSON.stringify({ type: 'FeatureCollection', features }));
console.log(`Raw polygons: ${features.length}`);

// Dissolve by code, then simplify (topology-preserving), keep small shapes.
const mapshaper = path.join(ROOT, 'node_modules', 'mapshaper', 'bin', 'mapshaper');
execFileSync(process.execPath, [
  mapshaper, '-i', rawFile,
  '-dissolve', 'code', 'copy-fields=name',
  '-simplify', '6%', 'keep-shapes', 'weighted',
  '-o', OUT, 'format=geojson', 'precision=0.00001', 'force',
], { stdio: 'inherit' });
console.log('Wrote', OUT);
