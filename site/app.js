// meet-nonstop — N-way nonstop route intersection, entirely client-side.

const MAX_ORIGINS = 6;
const CONTINENTS = { EU:'Europe', NA:'North America', SA:'South America',
                     AS:'Asia', AF:'Africa', OC:'Oceania', AN:'Antarctica', XX:'Elsewhere' };
const STATUS = ['year-round', 'seasonal', 'charter', 'seasonal charter'];

let AIRPORTS = [];      // {iata,name,city,country,continent,lat,lon}
let OFFSETS = null;     // Uint32Array, CSR row pointers
let EDGES = null;       // Uint32Array, packed edges
let byIata = new Map();

const state = { origins: [], filter: 'all', sort: 'name' };

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// ------------------------------------------------------------------ data load
async function load() {
  const [aRes, gRes, mRes] = await Promise.all([
    fetch('./data/airports.json'),
    fetch('./data/graph.bin'),
    fetch('./data/meta.json').catch(() => null),
  ]);
  if (!aRes.ok || !gRes.ok) throw new Error('route data unavailable');

  const aJson = await aRes.json();
  AIRPORTS = aJson.airports.map(([iata, name, city, country, continent, lat, lon]) => ({
    iata, name, city, country, continent, lat, lon,
  }));
  AIRPORTS.forEach((a, i) => byIata.set(a.iata, i));

  const buf = await gRes.arrayBuffer();
  const magic = new Uint8Array(buf, 0, 4);
  if (String.fromCharCode(...magic) !== 'MNS1') throw new Error('bad graph format');
  const head = new Uint32Array(buf, 4, 3);
  const n = head[1], e = head[2];
  OFFSETS = new Uint32Array(buf, 16, n + 1);
  EDGES = new Uint32Array(buf, 16 + (n + 1) * 4, e);

  if (mRes && mRes.ok) {
    const m = await mRes.json();
    $('meta').textContent =
      `${m.routes.toLocaleString()} routes · ${m.airports.toLocaleString()} airports · built ${m.builtAt.slice(0, 10)}`;
  }
}

// OurAirports' municipality carries administrative baggage
// ("Paris (Roissy-en-France, Val-d'Oise)", "London, Essex") and is sometimes
// the suburb rather than the city ("Balice" for Krakow). Trim the baggage; the
// airport name is always shown underneath to resolve whatever remains unclear.
const LABEL_FIX = { ADB: 'Izmir', SAW: 'Istanbul', SCR: 'Salen' };
function label(a) {
  if (LABEL_FIX[a.iata]) return LABEL_FIX[a.iata];
  const c = (a.city || '')
    .replace(/\s*\([^)]*\)/g, '')
    .split(',')[0]
    .replace(/\s+Island$/, '')
    .trim();
  return c || a.name;
}

// --------------------------------------------------------------------- geo
function distanceKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

// ------------------------------------------------------------- intersection
function neighbourMap(i) {
  const m = new Map();
  for (let k = OFFSETS[i]; k < OFFSETS[i + 1]; k++) {
    const v = EDGES[k];
    m.set(v & 0xfffff, (v >>> 20) & 3);
  }
  // Deliberately no self-edge: an origin is not a meeting point. Without one,
  // an origin can never survive the intersection, because its own adjacency
  // list does not contain itself.
  return m;
}

function intersect(originIdxs) {
  if (originIdxs.length < 2) return [];
  const maps = originIdxs.map(neighbourMap);
  let smallest = maps[0];
  for (const m of maps) if (m.size < smallest.size) smallest = m;

  const out = [];
  for (const dest of smallest.keys()) {
    const statuses = new Array(maps.length);
    let ok = true;
    for (let i = 0; i < maps.length; i++) {
      const s = maps[i].get(dest);
      if (s === undefined) { ok = false; break; }
      statuses[i] = s;
    }
    if (!ok) continue;
    const airport = AIRPORTS[dest];
    const legs = originIdxs.map((o) => distanceKm(AIRPORTS[o], airport));
    out.push({
      dest, airport, statuses, legs,
      maxLeg: Math.max(...legs),
      totalKm: legs.reduce((s, x) => s + x, 0),
      yearRound: statuses.every((s) => s === 0),
    });
  }
  return out;
}

// ------------------------------------------------------------------ rendering
function bars(statuses) {
  const wrap = el('span', 'bars');
  wrap.setAttribute('aria-hidden', 'true');
  statuses.forEach((s, i) => {
    const b = el('i', 'b');
    b.style.background = s === 0 ? `var(--o${i + 1})` : `var(--o${i + 1}-dim)`;
    wrap.append(b);
  });
  return wrap;
}

function chip(r) {
  const li = el('li', 'chip');
  const a = r.airport;
  li.title = [`${a.name} (${a.iata}), ${a.country}`, ...state.origins.map((o, i) =>
    `${AIRPORTS[o].iata}: ${STATUS[r.statuses[i]]}, ${r.legs[i].toLocaleString()} km`)].join('\n');
  // OurAirports' municipality is occasionally the suburb rather than the city
  // people know (Balice for Krakow), so always show the airport name too.
  li.append(el('span', 'nm', label(a)));
  li.append(el('span', 'apt', a.name));
  const sub = el('span', 'sub');
  sub.append(el('span', null, a.iata));
  sub.append(el('span', null, `${r.maxLeg.toLocaleString()} km max`));
  li.append(sub, bars(r.statuses));
  return li;
}

function group(title, rows) {
  const sec = el('section', 'grp');
  const h = el('div', 'grp-h');
  h.append(el('h2', null, title), el('span', 'count', String(rows.length)));
  const ul = el('ul', 'chips');
  rows.forEach((r) => ul.append(chip(r)));
  sec.append(h, ul);
  return sec;
}

function render() {
  renderOrigins();
  const out = $('out');
  out.replaceChildren();

  if (state.origins.length < 2) {
    $('summary').hidden = true;
    $('hint').textContent = state.origins.length === 1
      ? 'Add at least one more airport to see the overlap.'
      : `Add two or more airports (up to ${MAX_ORIGINS}).`;
    return;
  }
  $('hint').textContent = '';
  $('summary').hidden = false;

  let rows = intersect(state.origins);
  const yearRound = rows.filter((r) => r.yearRound).length;
  const total = rows.length;
  if (state.filter === 'year') rows = rows.filter((r) => r.yearRound);

  // figures
  const figs = $('figures');
  figs.replaceChildren();
  const addFig = (n, t) => {
    const f = el('div', 'fig');
    f.append(el('span', 'n', String(n)), el('span', 't', t));
    figs.append(f);
  };
  addFig(total, 'shared nonstop destinations');
  addFig(yearRound, 'served year-round from every origin');
  if (rows.length) {
    const fairest = rows.reduce((a, b) => (a.maxLeg <= b.maxLeg ? a : b));
    addFig(`${fairest.maxLeg.toLocaleString()}`, `km — shortest possible longest leg (${label(fairest.airport)})`);
  }

  // legend
  const leg = $('legend');
  leg.textContent = 'Each bar is one origin, in the order you added them: ';
  state.origins.forEach((o, i) => {
    const s = el('strong', null, AIRPORTS[o].iata);
    s.style.color = `var(--o${i + 1})`;
    leg.append(s, i < state.origins.length - 1 ? ', ' : '. ');
  });
  leg.append('A solid bar is year-round service, a pale one seasonal or charter.');

  if (!rows.length) {
    out.append(el('p', 'empty', 'No destinations are reachable nonstop from all of these airports.'));
    return;
  }

  if (state.sort === 'name') {
    const buckets = new Map();
    for (const r of rows) {
      const k = r.airport.continent;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(r);
    }
    const order = ['EU', 'AS', 'NA', 'AF', 'SA', 'OC', 'AN', 'XX'];
    for (const k of order) {
      const b = buckets.get(k);
      if (!b) continue;
      b.sort((x, y) => label(x.airport).localeCompare(label(y.airport)));
      out.append(group(CONTINENTS[k] || k, b));
    }
  } else {
    const key = state.sort === 'fair' ? 'maxLeg' : 'totalKm';
    rows.sort((a, b) => a[key] - b[key]);
    out.append(group(
      state.sort === 'fair' ? 'Fairest first — shortest longest leg' : 'Shortest combined distance first',
      rows,
    ));
  }
}

function renderOrigins() {
  const ul = $('origins');
  ul.replaceChildren();
  state.origins.forEach((idx, i) => {
    const a = AIRPORTS[idx];
    const li = el('li', 'origin');
    const sw = el('span', 'swatch');
    sw.style.background = `var(--o${i + 1})`;
    li.append(sw, el('span', 'code', a.iata), el('span', 'where', label(a)));
    const x = el('button', null, '×');
    x.setAttribute('aria-label', `Remove ${a.iata}`);
    x.onclick = () => { state.origins.splice(i, 1); sync(); };
    li.append(x);
    ul.append(li);
  });
  $('search').disabled = state.origins.length >= MAX_ORIGINS;
  $('search').placeholder = state.origins.length >= MAX_ORIGINS
    ? `Maximum ${MAX_ORIGINS} airports`
    : 'Add an airport — try AMS, Arlanda, or Lisbon';
}

// -------------------------------------------------------------------- search
function search(q) {
  q = q.trim().toLowerCase();
  if (q.length < 2) return [];
  const exact = [], starts = [], contains = [];
  for (let i = 0; i < AIRPORTS.length; i++) {
    if (state.origins.includes(i)) continue;
    const a = AIRPORTS[i];
    const iata = a.iata.toLowerCase();
    if (iata === q) { exact.push(i); continue; }
    const hay = `${a.city} ${a.name} ${a.country}`.toLowerCase();
    if (hay.startsWith(q) || iata.startsWith(q)) starts.push(i);
    else if (hay.includes(q)) contains.push(i);
    if (exact.length + starts.length + contains.length > 400) break;
  }
  return [...exact, ...starts, ...contains].slice(0, 8);
}

function initSearch() {
  const input = $('search'), list = $('results');
  let items = [], active = -1;

  const close = () => {
    list.hidden = true; list.replaceChildren();
    input.setAttribute('aria-expanded', 'false'); items = []; active = -1;
  };
  const choose = (idx) => {
    if (idx === undefined) return;
    state.origins.push(idx);
    input.value = '';
    close();
    sync();
  };
  const paint = () => {
    [...list.children].forEach((li, i) =>
      li.setAttribute('aria-selected', String(i === active)));
  };

  input.addEventListener('input', () => {
    items = search(input.value);
    list.replaceChildren();
    if (!items.length) return close();
    items.forEach((idx, i) => {
      const a = AIRPORTS[idx];
      const li = el('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.append(el('span', 'code', a.iata),
                el('span', 'nm', `${a.city ? a.city + ' — ' : ''}${a.name}`),
                el('span', 'cc', a.country));
      li.onmousedown = (e) => { e.preventDefault(); choose(idx); };
      li.onmouseenter = () => { active = i; paint(); };
      list.append(li);
    });
    active = 0; paint();
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(items[active]); }
    else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
}

// ------------------------------------------------------------------ url state
function sync() {
  const codes = state.origins.map((i) => AIRPORTS[i].iata);
  const hash = codes.join(',');
  if (location.hash.slice(1) !== hash) {
    history.replaceState(null, '', hash ? `#${hash}` : location.pathname);
  }
  render();
}

function fromHash() {
  const codes = decodeURIComponent(location.hash.slice(1)).split(',')
    .map((c) => c.trim().toUpperCase()).filter(Boolean);
  state.origins = codes.map((c) => byIata.get(c)).filter((i) => i !== undefined).slice(0, MAX_ORIGINS);
}

// ---------------------------------------------------------------------- boot
function initButtons() {
  document.querySelectorAll('.f').forEach((b) => b.addEventListener('click', () => {
    state.filter = b.dataset.f;
    document.querySelectorAll('.f').forEach((o) =>
      o.setAttribute('aria-pressed', String(o === b)));
    render();
  }));
  document.querySelectorAll('.s').forEach((b) => b.addEventListener('click', () => {
    state.sort = b.dataset.s;
    document.querySelectorAll('.s').forEach((o) =>
      o.setAttribute('aria-pressed', String(o === b)));
    render();
  }));
}

try {
  await load();
  initSearch();
  initButtons();
  fromHash();
  window.addEventListener('hashchange', () => { fromHash(); render(); });
  render();
} catch (err) {
  $('hint').textContent = `Could not load route data: ${err.message}`;
  console.error(err);
}
