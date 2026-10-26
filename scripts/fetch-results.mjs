// Fetches official RIK results for "Парламентарни 2026" and aggregates them
// per municipality (sifra_opstine) into public/data/results.json.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const OUT = path.join(ROOT, 'public', 'data', 'results.json');
const RIK = 'https://www.rik.parlament.gov.rs';
const ELECTION_TYPE = 2; // Парламентарни
const ELECTION_ROUND = 680072; // Парламентарни 2026
const HEADERS = {
  'X-Requested-With': 'XMLHttpRequest',
  Referer: `${RIK}/542645/rezultati/`,
  'User-Agent': 'Mozilla/5.0 izbori2026-map',
};

async function post(url, data) {
  const res = await fetch(RIK + url, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const num = (s) => Number(String(s).replace(/\./g, '')) || 0;

export async function fetchResults() {
  const summary = await post('/get_results/', {
    should_update_pies: 1, type: ELECTION_TYPE, election_round: ELECTION_ROUND,
    region: 0, municipality: 0, election_station: 0,
  });
  const lists = summary.table_data.map((t) => ({
    n: t.count_number,
    name: t.list_name.replace(/^\d+\.\s*ИЗБОРНА ЛИСТА\s*[-–]?\s*/u, '').trim(),
    fullName: t.list_name,
    votes: num(t.won_number),
    pct: t.won_percent,
  }));
  const L = lists.length;

  const csvRes = await fetch(`${RIK}/export-results/${ELECTION_ROUND}/2`, { headers: HEADERS });
  const ctype = csvRes.headers.get('content-type') || '';
  if (!csvRes.ok || !ctype.includes('csv')) throw new Error(`CSV export failed: ${csvRes.status} ${ctype}`);
  const [header, ...data] = parseCsv((await csvRes.text()).replace(/^\uFEFF/, ''));
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const listCols = Array.from({ length: L }, (_, i) => col[`lista_${i + 1}`]);

  const munis = {};
  const stations = [];
  for (const r of data) {
    if (r.length < header.length) continue;
    const code = r[col.sifra_opstine];
    const [region, okrug] = r[col.okrug_region].split('/');
    const processed = r[col.vreme_unosa_rezultata] && r[col.vreme_unosa_rezultata] !== '-';
    const m = (munis[code] ??= {
      code, name: r[col.opstina].replace(/^(Град|Градска општина)\s+/, ''), fullName: r[col.opstina],
      region, okrug, stations: 0, processed: 0, registered: 0, voted: 0, valid: 0, invalid: 0,
      votes: new Array(L).fill(0),
    });
    const votes = listCols.map((c) => num(r[c]));
    const st = {
      id: num(r[col.bm_uid]), no: num(r[col.bm_broj]), name: r[col.bm_naziv], m: code, p: processed ? 1 : 0,
      reg: num(r[col.upisani_biraci]), vot: num(r[col.glasali_biraci]),
      val: num(r[col.vazeci_glasovi]), inv: num(r[col.nevazeci_listici]), v: votes,
      doc: (r[col.zapisnik_link].split('|')[1] || ''),
    };
    stations.push(st);
    m.stations++;
    if (!processed) continue;
    m.processed++;
    m.registered += st.reg; m.voted += st.vot; m.valid += st.val; m.invalid += st.inv;
    votes.forEach((v, i) => (m.votes[i] += v));
  }

  const s = summary.stat_sum_numbers;
  return {
    election: s.election_title,
    updated: s.datetime,
    fetchedAt: new Date().toISOString(),
    source: `${RIK}/542645/rezultati/`,
    national: {
      registered: num(s.total_voters), voted: num(s.available),
      stations: num(s.number_of_stations), processed: num(s.processed_stations),
    },
    lists,
    municipalities: munis,
    stations,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
if (isMain) {
  const res = await fetchResults();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(res));
  console.log(`RIK ${res.updated}: ${res.national.processed}/${res.national.stations} stations, ${Object.keys(res.municipalities).length} municipalities -> ${OUT}`);
}

export { OUT as RESULTS_FILE };
