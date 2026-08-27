import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { UA } from './sources.ts';

const EN = 'https://en.wikipedia.org/w/api.php';
const WD = 'https://www.wikidata.org/w/api.php';
const CACHE = new URL('../.cache/', import.meta.url);

let cacheReady = false;
async function cachePath(key: string) {
  if (!cacheReady) { await mkdir(CACHE, { recursive: true }); cacheReady = true; }
  return new URL(createHash('sha1').update(key).digest('hex') + '.json', CACHE);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET with on-disk cache, retry and polite backoff. */
async function api(base: string, params: Record<string, string>, useCache = true): Promise<any> {
  const qs = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  const url = `${base}?${qs}`;
  const file = await cachePath(url);

  if (useCache) {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { /* miss */ }
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-encoding': 'gzip' } });
      if (r.status === 429 || r.status >= 500) throw new Error(`http ${r.status}`);
      if (!r.ok) throw new Error(`http ${r.status}`);
      const j = await r.json();
      if (useCache) await writeFile(file, JSON.stringify(j));
      return j;
    } catch (e) {
      lastErr = e;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw new Error(`giving up on ${url}: ${lastErr}`);
}

export function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export type PageContent = { title: string; wikitext: string };

/** Fetch article wikitext, 50 titles per request, following redirects. */
export async function fetchWikitext(
  titles: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, PageContent>> {
  const out = new Map<string, PageContent>();
  const batches = chunk([...new Set(titles.filter(Boolean))], 50);
  let done = 0;

  for (const batch of batches) {
    const j = await api(EN, {
      action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main',
      redirects: '1', titles: batch.join('|'),
    });

    // Map every alias (requested title -> normalized -> redirect target) back to content.
    const alias = new Map<string, string>();
    for (const n of j.query?.normalized ?? []) alias.set(n.from, n.to);
    for (const r of j.query?.redirects ?? []) alias.set(r.from, r.to);
    const resolve = (t: string) => { let c = t; for (let i = 0; i < 5 && alias.has(c); i++) c = alias.get(c)!; return c; };

    const byTitle = new Map<string, string>();
    for (const p of j.query?.pages ?? []) {
      const content = p.revisions?.[0]?.slots?.main?.content;
      if (content) byTitle.set(p.title, content);
    }
    for (const requested of batch) {
      const canonical = resolve(requested);
      const content = byTitle.get(canonical);
      if (content) out.set(requested, { title: canonical, wikitext: content });
    }

    done += batch.length;
    onProgress?.(done, batches.length * 50);
    await sleep(120);
  }
  return out;
}

/** Resolve arbitrary article titles to canonical title + Wikidata item id. */
export async function resolveTitles(
  titles: string[],
): Promise<Map<string, { canonical: string; qid: string | null }>> {
  const out = new Map<string, { canonical: string; qid: string | null }>();
  for (const batch of chunk([...new Set(titles.filter(Boolean))], 50)) {
    const j = await api(EN, {
      action: 'query', prop: 'pageprops', ppprop: 'wikibase_item',
      redirects: '1', titles: batch.join('|'),
    });
    const alias = new Map<string, string>();
    for (const n of j.query?.normalized ?? []) alias.set(n.from, n.to);
    for (const r of j.query?.redirects ?? []) alias.set(r.from, r.to);
    const resolve = (t: string) => { let c = t; for (let i = 0; i < 5 && alias.has(c); i++) c = alias.get(c)!; return c; };

    const qids = new Map<string, string | null>();
    for (const p of j.query?.pages ?? []) qids.set(p.title, p.pageprops?.wikibase_item ?? null);

    for (const requested of batch) {
      const canonical = resolve(requested);
      out.set(requested, { canonical, qid: qids.get(canonical) ?? null });
    }
    await sleep(120);
  }
  return out;
}

/** Wikidata entities that are instances of an airport-like class. */
const AIRPORT_CLASSES = new Set([
  'Q1248784',  // airport
  'Q644371',   // international airport
  'Q62447',    // aerodrome
  'Q1521623',  // air base
  'Q13218891', // regional airport
  'Q2603116',  // seaplane base
  'Q17084016', // civil airport
]);

/** Wikidata IATA codes (P238), with an airport-ness check from P31.
 *  The check matters because city entities carry metropolitan-area codes
 *  (Paris -> PAR), and a city link must not be read as an airport route. */
export async function iataForEntities(
  qids: string[],
): Promise<Map<string, { iata: string; isAirport: boolean }>> {
  const out = new Map<string, { iata: string; isAirport: boolean }>();
  for (const batch of chunk([...new Set(qids.filter(Boolean))], 50)) {
    const j = await api(WD, {
      action: 'wbgetentities', props: 'claims', languages: 'en', ids: batch.join('|'),
    });
    for (const [qid, ent] of Object.entries<any>(j.entities ?? {})) {
      const code = ent?.claims?.P238?.[0]?.mainsnak?.datavalue?.value;
      if (typeof code !== 'string' || code.length !== 3) continue;
      const isAirport = (ent?.claims?.P31 ?? []).some((c: any) =>
        AIRPORT_CLASSES.has(c?.mainsnak?.datavalue?.value?.id));
      out.set(qid, { iata: code.toUpperCase(), isAirport });
    }
    await sleep(120);
  }
  return out;
}
