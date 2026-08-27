import { loadAirports, type Airport } from './sources.ts';
import { fetchWikitext, resolveTitles, iataForEntities } from './wiki.ts';
import { parseDestinations, type Status } from './parse.ts';
import { bestStatus, writeOutputs, type Edge } from './emit.ts';
import { buildBasemap } from './basemap.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const MAX = Number(flag('max-airports') ?? Infinity);
const OUT = new URL(`../../${flag('out') ?? 'data'}/`, import.meta.url);

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- 1. airports
log('loading OurAirports…');
let airports: Airport[] = (await loadAirports()).filter((a) => a.wikiTitle);
if (Number.isFinite(MAX)) {
  // Keep a deterministic, useful sample: biggest networks first is unknowable
  // up front, so fall back to alphabetical by IATA for reproducibility.
  airports = airports.slice().sort((a, b) => a.iata.localeCompare(b.iata)).slice(0, MAX);
}
log(`${airports.length} airports with IATA + scheduled service + wiki article`);

// ------------------------------------------------------- 2. fetch article text
log('fetching wikitext…');
const pages = await fetchWikitext(
  airports.map((a) => a.wikiTitle),
  (done, total) => { if (done % 500 === 0) log(`  ${done}/${total}`); },
);
log(`${pages.size} articles retrieved`);

// Canonical article title -> our airport index. Built from what the API
// actually resolved to, so OurAirports' stale titles self-correct.
const titleToIdx = new Map<string, number>();
airports.forEach((a, i) => {
  const p = pages.get(a.wikiTitle);
  if (p) titleToIdx.set(p.title, i);
});

// ------------------------------------------------------------------- 3. parse
log('parsing destination tables…');
type Parsed = { from: number; target: string; status: Status };
const parsed: Parsed[] = [];
let withTable = 0;
airports.forEach((a, i) => {
  const p = pages.get(a.wikiTitle);
  if (!p) return;
  const routes = parseDestinations(p.wikitext);
  if (routes.length) withTable++;
  for (const r of routes) {
    if (r.future) continue; // announced but not yet flying
    parsed.push({ from: i, target: r.target, status: r.status });
  }
});
log(`${withTable} articles had a destination table; ${parsed.length} airline-destination pairs`);

// --------------------------------------------------- 4. resolve link targets
const unknown = [...new Set(parsed.map((p) => p.target))].filter((t) => !titleToIdx.has(t));
log(`resolving ${unknown.length} unmatched link targets…`);
const resolved = await resolveTitles(unknown);

const targetToIdx = new Map<string, number>();
const needQid: string[] = [];
for (const [requested, { canonical, qid }] of resolved) {
  const hit = titleToIdx.get(canonical);
  if (hit !== undefined) targetToIdx.set(requested, hit);
  else if (qid) needQid.push(qid);
}
log(`  ${targetToIdx.size} resolved via redirect to a known article`);

// Wikidata fallback: canonical title unknown, but the entity carries an IATA code.
const iataToIdx = new Map<string, number>();
airports.forEach((a, i) => iataToIdx.set(a.iata, i));
const qidIata = await iataForEntities(needQid);
const looksLikeAirport = (t: string) => /airport|airfield|aerodrome|air ?base|airstrip/i.test(t);
let viaWikidata = 0, rejectedNonAirport = 0;
for (const [requested, { canonical, qid }] of resolved) {
  if (targetToIdx.has(requested) || !qid) continue;
  const hit = qidIata.get(qid);
  if (!hit) continue;
  // Guard against city entities carrying metropolitan-area codes.
  if (!hit.isAirport && !looksLikeAirport(canonical)) { rejectedNonAirport++; continue; }
  const idx = iataToIdx.get(hit.iata);
  if (idx !== undefined) { targetToIdx.set(requested, idx); viaWikidata++; }
}
log(`  ${viaWikidata} resolved via Wikidata P238 (${rejectedNonAirport} rejected as non-airport)`);
for (const [title, idx] of titleToIdx) targetToIdx.set(title, idx);

// -------------------------------------------------------------- 5. build graph
const adjMap: Map<number, Status>[] = airports.map(() => new Map());
let dropped = 0;
for (const p of parsed) {
  const to = targetToIdx.get(p.target);
  if (to === undefined || to === p.from) { dropped++; continue; }
  const cur = adjMap[p.from].get(to);
  adjMap[p.from].set(to, cur ? bestStatus(cur, p.status) : p.status);
}

const adj: Edge[][] = adjMap.map((m) => [...m].map(([to, status]) => ({ to, status })));
const reciprocal = new Set<string>();
for (let i = 0; i < adj.length; i++) {
  for (const e of adj[i]) if (adjMap[e.to]?.has(i)) reciprocal.add(`${i}>${e.to}`);
}
const edgeCount = adj.reduce((s, xs) => s + xs.length, 0);
const recipRate = edgeCount ? reciprocal.size / edgeCount : 0;
log(`${edgeCount} directed routes, ${(recipRate * 100).toFixed(1)}% confirmed by both endpoints`);
log(`${dropped} destination links dropped (not an airport we track)`);

// --------------------------------------------------------------- 6. basemap
const basemap = await buildBasemap(OUT, log);

// ------------------------------------------------------------------- 7. emit
await writeOutputs(OUT, airports, adj, reciprocal, {
  builtAt: new Date().toISOString(),
  airports: airports.length,
  articlesWithTable: withTable,
  routes: edgeCount,
  reciprocalRate: Number(recipRate.toFixed(4)),
  droppedLinks: dropped,
  basemap,
  source: 'English Wikipedia airport articles (CC BY-SA 4.0); OurAirports (public domain); Natural Earth (public domain)',
});
log('wrote data/airports.json, data/graph.bin, data/meta.json');
