'use strict';

// ---------- helpers ----------
const CYR = { 'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Ђ':'Đ','Е':'E','Ж':'Ž','З':'Z','И':'I','Ј':'J','К':'K','Л':'L','Љ':'Lj','М':'M','Н':'N','Њ':'Nj','О':'O','П':'P','Р':'R','С':'S','Т':'T','Ћ':'Ć','У':'U','Ф':'F','Х':'H','Ц':'C','Ч':'Č','Џ':'Dž','Ш':'Š' };
const lat = (s) => String(s ?? '').replace(/[\u0400-\u04FF]/g, (ch) => {
  const up = CYR[ch]; if (up) return up;
  const l = CYR[ch.toUpperCase()]; return l ? l.toLowerCase() : ch;
});
// Title-case all-caps station names ("ОШ СВЕТИ САВА" -> "OŠ Sveti Sava") but keep short acronyms.
const nice = (s) => lat(s).replace(/\p{L}+/gu, (w) => (w.length <= 3 && w === w.toUpperCase() ? w : w[0] + w.slice(1).toLowerCase()));
const fmt = (n) => Number(n).toLocaleString('sr-Latn-RS');
const pct = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d).replace('.', ',') : '–') + '%';
const norm = (s) => lat(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'dj');
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function mix(hex, t, base = '#ffffff') {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = p(base), b = p(hex);
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

// Colors and short names for the 2026 lists (by ballot number). Unknown lists fall back to RIK names.
const LIST_META = {
  1: { c: '#1d4ed8', s: 'Aleksandar Vučić – Ujedinjena Srbija' },
  2: { c: '#f59e0b', s: 'Ivica Dačić – SPS' },
  3: { c: '#dc2626', s: 'Studentska lista' },
  4: { c: '#a16207', s: 'Rasim Ljajić – Ljudski' },
  5: { c: '#15803d', s: 'Savez vojvođanskih Mađara' },
  6: { c: '#0d9488', s: 'Usame Zukorlić (SPP)' },
  7: { c: '#7c3aed', s: 'Ruska stranka' },
  8: { c: '#78350f', s: 'Autentična desnica – Miloš Jovanović' },
  9: { c: '#ea580c', s: 'Evropska Srbija – Tepić, Ponoš' },
  10: { c: '#16a34a', s: 'SDA Sandžaka' },
  11: { c: '#64748b', s: 'Bogoljub Karić – BK' },
  12: { c: '#65a30d', s: 'Liberalno zelena stranka' },
  13: { c: '#0891b2', s: 'Biram pravdu – Ferid Bulić' },
  14: { c: '#9333ea', s: 'Stranka rusko-srpskog jedinstva' },
  15: { c: '#db2777', s: 'Ćale ovo je za tebe' },
  16: { c: '#4b5563', s: 'Alternativa za Srbiju' },
  17: { c: '#be185d', s: 'Albanska koalicija' },
  18: { c: '#92400e', s: 'Majka Srbija – Gruda' },
};
const FALLBACK_COLORS = ['#0ea5e9', '#84cc16', '#f43f5e', '#8b5cf6', '#14b8a6', '#eab308'];

const LEAD_BINS = [[0, 5, 0.38], [5, 10, 0.55], [10, 20, 0.75], [20, Infinity, 1]];
const NODATA = '#d6d9de';
const REFRESH_MS = 3 * 60 * 1000;

// ---------- state ----------
const S = { data: null, lists: [], munis: {}, geo: null, layer: null, mode: 'pobednik', listN: 3, sel: null, layersByCode: {}, stationsByMuni: {} };

function listColor(n) { return LIST_META[n]?.c || FALLBACK_COLORS[n % FALLBACK_COLORS.length]; }
function listName(n) { return LIST_META[n]?.s || lat(S.lists.find((l) => l.n === n)?.name || `Lista ${n}`); }

function enrich(m) {
  const ranked = m.votes.map((v, i) => ({ n: i + 1, v, p: m.valid ? (v / m.valid) * 100 : 0 })).sort((a, b) => b.v - a.v);
  m.ranked = ranked;
  m.has = m.processed > 0 && m.valid > 0;
  m.winner = m.has ? ranked[0].n : null;
  m.margin = m.has ? ranked[0].p - ranked[1].p : 0;
  m.turnout = m.registered ? (m.voted / m.registered) * 100 : NaN;
  return m;
}

function aggregate(munis) {
  const L = S.lists.length;
  const a = { stations: 0, processed: 0, registered: 0, voted: 0, valid: 0, invalid: 0, votes: new Array(L).fill(0) };
  for (const m of munis) {
    for (const k of ['stations', 'processed', 'registered', 'voted', 'valid', 'invalid']) a[k] += m[k];
    m.votes.forEach((v, i) => (a.votes[i] += v));
  }
  return enrich(a);
}

// ---------- map ----------
const map = L.map('map', { zoomControl: false, minZoom: 6, maxZoom: 13, zoomSnap: 0.25, preferCanvas: false }).setView([44.0, 20.9], 7);
L.control.zoom({ position: 'topright' }).addTo(map);
map.createPane('labels');
map.getPane('labels').style.zIndex = 650;
map.getPane('labels').style.pointerEvents = 'none';
const STATION_ZOOM = 10;
const stationLevel = () => map.getZoom() >= STATION_ZOOM;
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> saradnici · Rezultati: <a href="https://www.rik.parlament.gov.rs/">RIK</a>',
}).addTo(map);
map.createPane('stations');
map.getPane('stations').style.zIndex = 390;

const isMobile = () => window.innerWidth <= 700;
const fitPad = () => (isMobile()
  ? { paddingTopLeft: [10, 10], paddingBottomRight: [10, Math.round(window.innerHeight * 0.48)] }
  : { paddingTopLeft: [420, 20], paddingBottomRight: [20, 20] });

function fillFor(m) {
  if (!m || !m.has) return NODATA;
  if (S.mode === 'pobednik') {
    const t = LEAD_BINS.find(([lo, hi]) => m.margin >= lo && m.margin < hi)[2];
    return mix(listColor(m.winner), t);
  }
  if (S.mode === 'lista') {
    const p = m.votes[S.listN - 1] / m.valid * 100;
    return mix(listColor(S.listN), 0.08 + 0.92 * Math.min(1, p / S.listMax));
  }
  const [lo, hi] = S.turnRange;
  return mix('#4c1d95', 0.08 + 0.92 * Math.max(0, Math.min(1, (m.turnout - lo) / (hi - lo))));
}

function styleFor(f) {
  const m = S.munis[f.properties.code];
  const selected = S.sel === f.properties.code;
  if (stationLevel()) return { fill: false, color: selected ? '#0f172a' : '#334155', weight: selected ? 3.2 : 1.8, opacity: 0.9 };
  return { fill: true, fillColor: fillFor(m), fillOpacity: 0.85, color: selected ? '#0f172a' : '#ffffff', weight: selected ? 2.6 : 0.7, opacity: 1 };
}

// ---------- polling-station areas (approximate Voronoi cells) ----------
function stationAgg(f) {
  if (f._agg && f._agg.v === S.version) return f._agg;
  const sts = f.properties.ids.split(',').map((id) => S.stationById[id]).filter(Boolean);
  const L = S.lists.length;
  const a = { stations: sts.length, processed: 0, registered: 0, voted: 0, valid: 0, invalid: 0, votes: new Array(L).fill(0) };
  for (const s of sts) {
    if (!s.p) continue;
    a.processed++; a.registered += s.reg; a.voted += s.vot; a.valid += s.val; a.invalid += s.inv;
    s.v.forEach((v, i) => (a.votes[i] += v));
  }
  enrich(a);
  a.list = sts; a.v = S.version;
  return (f._agg = a);
}

function stationStyle(f) {
  const a = stationAgg(f);
  const selected = S.selStation === f;
  return { fillColor: fillFor(a), fillOpacity: 0.68, color: selected ? '#0f172a' : '#ffffff', weight: selected ? 2.4 : 0.6, opacity: 1 };
}

async function ensureStationLayer() {
  if (S.stationLayer || S.loadingStations) return;
  S.loadingStations = true;
  const geo = await fetch('data/biracka-mesta.geojson').then((r) => r.json());
  S.stationLayer = L.geoJSON(geo, {
    pane: 'stations',
    style: stationStyle,
    onEachFeature: (f, layer) => {
      layer.on({
        mouseover: (e) => { layer.setStyle({ weight: 2, color: '#0f172a' }); layer.bringToFront(); showStationTip(f, e.originalEvent); },
        mousemove: (e) => moveTip(e.originalEvent),
        mouseout: () => { S.stationLayer.resetStyle(layer); hideTip(); },
        click: () => selectStation(f, layer),
      });
    },
  });
  S.loadingStations = false;
  updateLevel();
}

function updateLevel() {
  const on = stationLevel();
  if (on) ensureStationLayer();
  if (S.stationLayer) {
    if (on && !map.hasLayer(S.stationLayer)) S.stationLayer.addTo(map);
    if (!on && map.hasLayer(S.stationLayer)) map.removeLayer(S.stationLayer);
  }
  if (S.level !== on) { S.level = on; S.layer?.setStyle(styleFor); renderLegend(); }
}

function showStationTip(f, ev) {
  const a = stationAgg(f);
  const m = S.munis[f.properties.m];
  const names = a.list.slice().sort((x, y) => x.no - y.no);
  let html = `<b>${esc(lat(m?.name || ''))}</b><div class="tt-sub">${names.slice(0, 4).map((s) => `BM ${s.no} – ${esc(nice(s.name))}`).join('<br>')}${names.length > 4 ? `<br>+ još ${names.length - 4}` : ''}
    <br>Izlaznost ${pct(a.turnout)} · ${fmt(a.voted)} glasalo${a.processed < a.stations ? ` · obrađeno ${a.processed}/${a.stations}` : ''}</div>`;
  if (a.has) for (const r of a.ranked.slice(0, 4)) {
    if (!r.v) break;
    html += `<div class="tt-row"><i style="background:${listColor(r.n)}"></i><span>${esc(listName(r.n))}</span><span>${pct(r.p)}</span></div>`;
  }
  else html += '<div class="tt-sub">Još nije obrađeno</div>';
  html += '<div class="tt-sub" style="margin:5px 0 0">Oblast je približna (procena po lokaciji BM).</div>';
  tip.innerHTML = html; tip.hidden = false; moveTip(ev);
}

function selectStation(f, layer) {
  const prev = S.selStation;
  S.selStation = f;
  if (S.sel !== f.properties.m) {
    const old = S.sel; S.sel = f.properties.m;
    if (old && S.layersByCode[old]) S.layer.resetStyle(S.layersByCode[old]);
    S.layer.resetStyle(S.layersByCode[S.sel]);
  }
  if (prev) S.stationLayer.eachLayer((l) => l.feature === prev && S.stationLayer.resetStyle(l));
  S.stationLayer.resetStyle(layer); layer.bringToFront();
  renderStation(f);
  writeHash();
  $('#side').classList.remove('collapsed');
}

function renderStation(f, limit = 8) {
  const a = stationAgg(f);
  const m = S.munis[f.properties.m];
  const sts = a.list.slice().sort((x, y) => x.no - y.no);
  let h = `<div class="crumbs"><a data-home>Srbija</a> › <a data-muni="${m.code}">${esc(lat(m.name))}</a></div>
    <h2>${sts.length === 1 ? `Biračko mesto ${sts[0].no}` : `Biračka mesta ${sts.map((s) => s.no).join(', ')}`}</h2>
    <div class="sub">${[...new Set(sts.map((s) => nice(s.name)))].map(esc).join(' · ')}</div>`;
  if (a.has) h += `<span class="winner-badge" style="background:${listColor(a.winner)}">Pobednik: ${esc(listName(a.winner))} · +${pct(a.margin)}</span>`;
  h += statsHtml(a) + (a.has ? rowsHtml(a, limit, 'st') : '<p class="sub">Još nije obrađeno.</p>');
  const docs = sts.filter((s) => s.doc);
  if (docs.length) h += `<div class="section-h">Zapisnici</div>${docs.map((s) => `<a href="${esc(s.doc)}" target="_blank" rel="noopener">Zapisnik BM ${s.no} (PDF)</a>`).join('<br>')}`;
  h += '<p class="sub" style="margin-top:14px">Oblast na mapi je približna: izračunata kao područje najbliže lokaciji biračkog mesta, unutar granica opštine.</p>';
  $('#detail').innerHTML = h;
  bindDetail(() => renderStation(f, 99));
  $('#detail [data-muni]')?.addEventListener('click', () => { clearStation(); select(m.code, false); });
}

async function gotoStation(id) {
  await ensureStationLayer();
  let target = null;
  S.stationLayer.eachLayer((l) => { if (!target && l.feature.properties.ids.split(',').includes(String(id))) target = l; });
  if (!target) return;
  const b = target.getBounds();
  const z = Math.max(STATION_ZOOM, Math.min(14, map.getBoundsZoom(b, false, L.point(isMobile() ? 40 : 460, isMobile() ? window.innerHeight * 0.5 : 60))));
  const centerPx = map.project(b.getCenter(), z).subtract(L.point(isMobile() ? 0 : 210, isMobile() ? -window.innerHeight * 0.24 : 0));
  map.flyTo(map.unproject(centerPx, z), z, { duration: 0.6 });
  map.once('moveend', () => { updateLevel(); selectStation(target.feature, target); });
}

function clearStation() {
  const prev = S.selStation; S.selStation = null;
  if (prev && S.stationLayer) S.stationLayer.eachLayer((l) => l.feature === prev && S.stationLayer.resetStyle(l));
}

function buildLayer() {
  S.layer = L.geoJSON(S.geo, {
    style: styleFor,
    onEachFeature: (f, layer) => {
      S.layersByCode[f.properties.code] = layer;
      layer.on({
        mouseover: (e) => { if (stationLevel()) return; layer.setStyle({ weight: 2.2, color: '#0f172a' }); layer.bringToFront(); showTip(f, e.originalEvent); },
        mousemove: (e) => moveTip(e.originalEvent),
        mouseout: () => { if (stationLevel()) return; S.layer.resetStyle(layer); if (S.sel) S.layersByCode[S.sel]?.bringToFront(); hideTip(); },
        click: () => { clearStation(); select(f.properties.code, false); },
      });
    },
  }).addTo(map);
  map.fitBounds(S.layer.getBounds(), fitPad());
}

function restyle() { S.layer?.setStyle(styleFor); S.stationLayer?.setStyle(stationStyle); if (S.sel) S.layersByCode[S.sel]?.bringToFront(); renderLegend(); }

// ---------- tooltip ----------
const tip = $('#tooltip');
function showTip(f, ev) {
  const code = f.properties.code;
  const m = S.munis[code];
  let html = `<b>${esc(lat(m?.name || f.properties.name))}</b>`;
  if (!m) html += '<div class="tt-sub">Nema biračkih mesta u podacima RIK</div>';
  else {
    html += `<div class="tt-sub">${esc(lat(m.okrug || ''))}<br>Obrađeno ${fmt(m.processed)}/${fmt(m.stations)} BM · izlaznost ${pct(m.turnout)}</div>`;
    if (m.has) {
      for (const r of m.ranked.slice(0, 4)) {
        if (!r.v) break;
        html += `<div class="tt-row"><i style="background:${listColor(r.n)}"></i><span>${esc(listName(r.n))}</span><span>${pct(r.p)}</span></div>`;
      }
      if (S.mode === 'lista' && !m.ranked.slice(0, 4).some((r) => r.n === S.listN)) {
        const r = m.ranked.find((x) => x.n === S.listN);
        html += `<div class="tt-row"><i style="background:${listColor(r.n)}"></i><span>${esc(listName(r.n))}</span><span>${pct(r.p)}</span></div>`;
      }
    }
  }
  tip.innerHTML = html;
  tip.hidden = false;
  moveTip(ev);
}
function moveTip(ev) {
  if (tip.hidden || !ev) return;
  const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + w > window.innerWidth - 4) x = ev.clientX - w - pad;
  if (y + h > window.innerHeight - 4) y = ev.clientY - h - pad;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
function hideTip() { tip.hidden = true; }

// ---------- legend ----------
function renderLegend() {
  const el = $('#legend');
  renderLegendBody(el);
  el.insertAdjacentHTML('beforeend', `<div class="nodata" style="margin-top:4px">${stationLevel() ? 'Prikaz: biračka mesta (približne oblasti)' : 'Zumirajte za prikaz po biračkim mestima'}</div>`);
}
function renderLegendBody(el) {
  if (S.mode === 'pobednik') {
    const winners = [...new Set(Object.values(S.munis).filter((m) => m.has).map((m) => m.winner))]
      .sort((a, b) => (S.national.votes[b - 1] - S.national.votes[a - 1]));
    let g = '<div class="lead-rows">';
    g += `<div class="lr-head"><span></span>${LEAD_BINS.map(([lo, hi]) => `<span>${hi === Infinity ? lo + '+' : lo + '–' + hi}</span>`).join('')}</div>`;
    for (const n of winners) {
      const cnt = Object.values(S.munis).filter((m) => m.has && m.winner === n && S.layersByCode[m.code]).length;
      g += `<div class="lr"><span class="lr-name" title="${esc(listName(n))}">${esc(listName(n))} <small>(${cnt})</small></span>${LEAD_BINS.map(([, , t]) => `<i style="background:${mix(listColor(n), t)}"></i>`).join('')}</div>`;
    }
    g += '</div>';
    el.innerHTML = `<h3>Prednost pobednika (p.p.) · broj opština</h3>${g}<div class="nodata"><i></i>Nema obrađenih podataka</div>`;
  } else if (S.mode === 'lista') {
    el.innerHTML = `<h3>${esc(listName(S.listN))}</h3><div class="ramp" style="background:linear-gradient(90deg,${mix(listColor(S.listN), 0.08)},${listColor(S.listN)})"></div>
      <div class="ramp-lbl"><span>0%</span><span>${S.listMax}%+</span></div><div class="nodata"><i></i>Nema obrađenih podataka</div>`;
  } else {
    el.innerHTML = `<h3>Izlaznost</h3><div class="ramp" style="background:linear-gradient(90deg,${mix('#4c1d95', 0.08)},#4c1d95)"></div>
      <div class="ramp-lbl"><span>${S.turnRange[0]}%</span><span>${S.turnRange[1]}%</span></div><div class="nodata"><i></i>Nema obrađenih podataka</div>`;
  }
}

// ---------- side panel ----------
function statsHtml(a) {
  const proc = a.stations ? (a.processed / a.stations) * 100 : 0;
  return `<div class="stats">
    <div class="stat"><div class="k">Upisani</div><div class="v">${fmt(a.registered)}</div></div>
    <div class="stat"><div class="k">Izlaznost</div><div class="v">${pct(a.turnout)}</div><div class="s">${fmt(a.voted)} glasalo</div></div>
    <div class="stat"><div class="k">Obrađeno BM</div><div class="v">${pct(proc)}</div><div class="s">${fmt(a.processed)} / ${fmt(a.stations)}</div><div class="progress"><i style="width:${proc}%"></i></div></div>
  </div>`;
}

function rowsHtml(a, limit, id) {
  const ranked = a.ranked.filter((r) => r.v > 0 || a.ranked.length <= limit);
  const shown = ranked.slice(0, limit);
  let h = '<ul class="rows">';
  for (const r of shown) {
    h += `<li class="row clickable" data-list="${r.n}" title="Prikaži podršku listi na mapi">
      <span class="sw" style="background:${listColor(r.n)}"></span>
      <span class="nm">${esc(listName(r.n))} <small>#${r.n}</small></span>
      <span class="pc"><span class="vt">${fmt(r.v)}</span>${pct(r.p, 2)}</span>
      <span class="bar"><i style="width:${Math.max(0.5, r.p)}%;background:${listColor(r.n)}"></i></span></li>`;
  }
  h += '</ul>';
  if (ranked.length > limit) h += `<button class="more" data-more="${id}">Prikaži sve liste (${ranked.length})</button>`;
  return h;
}

function regionSummary() {
  const groups = {};
  for (const m of Object.values(S.munis)) (groups[m.region] ??= []).push(m);
  return Object.entries(groups).map(([name, ms]) => ({ name, ms, a: aggregate(ms) })).sort((x, y) => y.a.registered - x.a.registered);
}

function renderNational(limit = 8) {
  const a = S.national;
  const winnerBadge = a.has ? `<span class="winner-badge" style="background:${listColor(a.winner)}">Vodi: ${esc(listName(a.winner))}</span>` : '';
  let h = `<h2>Srbija — ukupno</h2>${winnerBadge}${statsHtml(a)}${rowsHtml(a, limit, 'nat')}`;
  h += '<div class="section-h">Po regionima</div><ul class="rows">';
  for (const r of regionSummary()) {
    const top = r.a.ranked[0];
    h += `<li class="row clickable" data-region="${esc(r.name)}"><span class="sw" style="background:${r.a.has ? listColor(top.n) : NODATA}"></span>
      <span class="nm">${esc(lat(r.name))}</span><span class="pc">${r.a.has ? pct(top.p) : '–'}</span>
      <span class="bar"><i style="width:${r.a.has ? top.p : 0}%;background:${r.a.has ? listColor(top.n) : NODATA}"></i></span></li>`;
  }
  h += '</ul>';
  $('#detail').innerHTML = h;
  bindDetail(() => renderNational(99));
}

function renderMuni(code, limit = 8) {
  const m = S.munis[code];
  const f = S.geo.features.find((x) => x.properties.code === code);
  const name = lat(m?.fullName || m?.name || f?.properties.name || code);
  let h = `<div class="crumbs"><a data-home>Srbija</a>${m?.region ? ' › ' + esc(lat(m.region)) : ''}${m?.okrug && m.okrug !== m.region ? ' › ' + esc(lat(m.okrug)) : ''}</div><h2>${esc(name)}</h2>`;
  if (!m) {
    $('#detail').innerHTML = h + '<p class="sub">RIK nema biračkih mesta za ovu opštinu na ovim izborima.</p>';
    return bindDetail();
  }
  if (m.has) h += `<span class="winner-badge" style="background:${listColor(m.winner)}">Pobednik: ${esc(listName(m.winner))} · +${pct(m.margin)}</span>`;
  h += statsHtml(m) + (m.has ? rowsHtml(m, limit, code) : '<p class="sub">Još nema obrađenih biračkih mesta.</p>');
  h += `<div class="section-h">Biračka mesta (${fmt(m.stations)})</div><div class="st-wrap"><table class="st"><thead><tr><th>#</th><th>Biračko mesto</th><th>Izl.</th><th>Prvi</th><th></th></tr></thead><tbody>`;
  for (const s of (S.stationsByMuni[code] || []).slice().sort((a, b) => a.no - b.no)) {
    if (!s.p) { h += `<tr><td class="n">${s.no}</td><td>${esc(nice(s.name))}</td><td class="n" colspan="3" style="color:var(--muted)">neobrađeno</td></tr>`; continue; }
    let w = 0; s.v.forEach((v, i) => { if (v > s.v[w]) w = i; });
    const wp = s.val ? (s.v[w] / s.val) * 100 : 0;
    h += `<tr class="st-row" data-st="${s.id}"><td class="n">${s.no}</td><td>${esc(nice(s.name))}</td><td class="n">${pct(s.reg ? (s.vot / s.reg) * 100 : NaN, 0)}</td>
      <td class="n"><span class="dot" style="background:${listColor(w + 1)}"></span>${pct(wp, 0)}</td>
      <td>${s.doc ? `<a href="${esc(s.doc)}" target="_blank" rel="noopener" title="Zapisnik (PDF)">PDF</a>` : ''}</td></tr>`;
  }
  h += '</tbody></table></div>';
  $('#detail').innerHTML = h;
  bindDetail(() => renderMuni(code, 99));
  $('#detail').querySelectorAll('.st-row').forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a')) gotoStation(tr.dataset.st); }));
}

function renderOther() {
  const others = Object.values(S.munis).filter((m) => !S.layersByCode[m.code]);
  if (!others.length || S.sel) return;
  const h = `<div class="section-h">Van mape</div><div class="other-links">${others.map((m) => `<button class="chip" data-code="${m.code}">${esc(lat(m.name))}</button>`).join('')}</div>`;
  $('#detail').insertAdjacentHTML('beforeend', h);
  $('#detail').querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => select(b.dataset.code, false)));
}

function bindDetail(showAll) {
  const d = $('#detail');
  d.querySelector('[data-home]')?.addEventListener('click', () => select(null, true));
  d.querySelector('.more')?.addEventListener('click', () => showAll?.());
  d.querySelectorAll('[data-list]').forEach((r) => r.addEventListener('click', () => setMode('lista', Number(r.dataset.list))));
  d.querySelectorAll('[data-region]').forEach((r) => r.addEventListener('click', () => {
    const layers = Object.values(S.munis).filter((m) => m.region === r.dataset.region).map((m) => S.layersByCode[m.code]).filter(Boolean);
    if (layers.length) map.flyToBounds(L.featureGroup(layers).getBounds(), { ...fitPad(), duration: 0.6 });
  }));
}

function renderDetail() {
  if (S.selStation) renderStation(S.selStation);
  else if (S.sel) renderMuni(S.sel); else { renderNational(); renderOther(); }
}

// ---------- routing ----------
function writeHash() {
  let h = '#' + (S.mode === 'lista' ? `lista/${S.listN}` : S.mode);
  if (S.sel) h += `/${S.sel}`;
  if (location.hash !== h) history.replaceState(null, '', h);
}
function readHash() {
  const parts = location.hash.replace(/^#/, '').split('/').filter(Boolean);
  const mode = ['pobednik', 'lista', 'izlaznost'].includes(parts[0]) ? parts[0] : 'pobednik';
  let i = 1;
  if (mode === 'lista' && parts[1] && Number(parts[1]) <= S.lists.length) { S.listN = Number(parts[1]); i = 2; }
  S.mode = mode;
  S.sel = parts[i] && (S.munis[parts[i]] || S.layersByCode[parts[i]]) ? parts[i] : null;
}

function setMode(mode, listN) {
  S.mode = mode;
  if (listN) S.listN = listN;
  document.querySelectorAll('#mode-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#list-select').hidden = mode !== 'lista';
  $('#list-select').value = String(S.listN);
  computeScales();
  restyle();
  writeHash();
}

function select(code, zoom = true) {
  if (code !== S.selStation?.properties.m) clearStation();
  const prev = S.sel;
  S.sel = code;
  if (prev) S.layer && S.layersByCode[prev] && S.layer.resetStyle(S.layersByCode[prev]);
  if (code && S.layersByCode[code]) {
    S.layer.resetStyle(S.layersByCode[code]);
    S.layersByCode[code].bringToFront();
    if (zoom) map.flyToBounds(S.layersByCode[code].getBounds(), { ...fitPad(), maxZoom: 10, duration: 0.6 });
  }
  if (!code && zoom) map.flyToBounds(S.layer.getBounds(), { ...fitPad(), duration: 0.6 });
  renderDetail();
  writeHash();
  $('#side').classList.remove('collapsed');
}

function computeScales() {
  const ms = Object.values(S.munis).filter((m) => m.has && S.layersByCode[m.code]);
  if (S.mode === 'lista') {
    const max = Math.max(...ms.map((m) => (m.votes[S.listN - 1] / m.valid) * 100), 1);
    S.listMax = max >= 10 ? Math.ceil(max / 10) * 10 : Math.ceil(max);
  }
  const t = ms.map((m) => m.turnout).filter(Number.isFinite).sort((a, b) => a - b);
  S.turnRange = t.length ? [Math.floor(t[Math.floor(t.length * 0.05)] / 5) * 5, Math.ceil(t[Math.floor(t.length * 0.95)] / 5) * 5] : [0, 100];
}

// ---------- search ----------
function setupSearch() {
  const input = $('#search'), box = $('#search-results');
  let items = [], active = 0;
  const all = () => {
    const seen = new Set(), out = [];
    for (const m of Object.values(S.munis)) { seen.add(m.code); out.push({ code: m.code, name: lat(m.name), sub: lat(m.okrug || m.region) }); }
    for (const f of S.geo.features) if (!seen.has(f.properties.code)) out.push({ code: f.properties.code, name: lat(f.properties.name), sub: 'KiM' });
    return out;
  };
  const draw = () => {
    box.innerHTML = items.map((it, i) => `<div class="sitem${i === active ? ' active' : ''}" data-i="${i}"><span>${esc(it.name)}</span><small>${esc(it.sub || '')}</small></div>`).join('');
    box.hidden = !items.length;
  };
  input.addEventListener('input', () => {
    const q = norm(input.value.trim());
    items = q ? all().filter((it) => norm(it.name).includes(q)).sort((a, b) => norm(a.name).indexOf(q) - norm(b.name).indexOf(q) || a.name.localeCompare(b.name)).slice(0, 12) : [];
    active = 0; draw();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter' && items[active]) pick(items[active]);
    else if (e.key === 'Escape') { box.hidden = true; }
  });
  box.addEventListener('mousedown', (e) => { const el = e.target.closest('.sitem'); if (el) pick(items[Number(el.dataset.i)]); });
  input.addEventListener('blur', () => setTimeout(() => (box.hidden = true), 150));
  function pick(it) { input.value = ''; items = []; box.hidden = true; select(it.code, true); }
}

// ---------- data ----------
function ingest(data) {
  S.data = data;
  S.version = (S.version || 0) + 1;
  S.lists = data.lists;
  S.munis = {};
  for (const [code, m] of Object.entries(data.municipalities)) S.munis[code] = enrich(m);
  S.stationsByMuni = {};
  S.stationById = {};
  for (const s of data.stations) { (S.stationsByMuni[s.m] ??= []).push(s); S.stationById[s.id] = s; }
  S.national = aggregate(Object.values(S.munis));
  $('#updated').textContent = `RIK: ${data.updated} · obrađeno ${fmt(data.national.processed)}/${fmt(data.national.stations)} BM`;
  $('#src-link').href = data.source;
  const sel = $('#list-select');
  sel.innerHTML = S.lists.map((l) => `<option value="${l.n}">${l.n}. ${esc(listName(l.n))}</option>`).join('');
  sel.value = String(S.listN);
}

async function loadResults() {
  const res = await fetch('data/results.json?t=' + Date.now());
  if (!res.ok) throw new Error('results.json ' + res.status);
  return res.json();
}

async function init() {
  const [geo, data] = await Promise.all([fetch('data/opstine.geojson').then((r) => r.json()), loadResults()]);
  S.geo = geo;
  ingest(data);
  buildLayer();
  map.on('zoomend', updateLevel);
  updateLevel();
  readHash();
  setMode(S.mode);
  if (S.sel) select(S.sel, true); else renderDetail();
  setupSearch();

  document.querySelectorAll('#mode-tabs button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#list-select').addEventListener('change', (e) => setMode('lista', Number(e.target.value)));
  $('#toggle-side').addEventListener('click', () => $('#side').classList.toggle('collapsed'));
  window.addEventListener('hashchange', () => { const prev = S.sel; readHash(); setMode(S.mode); if (S.sel !== prev) select(S.sel, true); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.sel && document.activeElement !== $('#search')) select(null, true); });

  setInterval(async () => {
    try {
      const d = await loadResults();
      if (d.fetchedAt === S.data.fetchedAt) return;
      ingest(d); computeScales(); restyle(); renderDetail();
    } catch (e) { console.warn('refresh failed', e); }
  }, REFRESH_MS);
}

init().catch((e) => { $('#detail').innerHTML = `<p style="color:#b91c1c">Greška pri učitavanju podataka: ${esc(e.message)}</p>`; console.error(e); });
