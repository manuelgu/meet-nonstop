import { parseCsv } from './csv.ts';

const OURAIRPORTS = 'https://davidmegginson.github.io/ourairports-data';

export type Airport = {
  iata: string;
  name: string;
  city: string;
  country: string;      // ISO-2
  countryName: string;
  continent: string;    // EU, NA, AS, AF, SA, OC, AN
  lat: number;
  lon: number;
  wikiTitle: string;    // '' when OurAirports has no wikipedia_link
};

async function text(url: string): Promise<string> {
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r.text();
}

export const UA =
  'meet-nonstop/0.1 (https://github.com/manuelgu/meet-nonstop; open-source route-overlap tool)';

/** Turn a wikipedia_link URL into an article title. */
export function titleFromUrl(url: string): string {
  const m = /\/wiki\/([^#?]+)/.exec(url || '');
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]).replace(/_/g, ' ').trim();
  } catch {
    return m[1].replace(/_/g, ' ').trim();
  }
}

/** Airports with an IATA code and scheduled passenger service. */
export async function loadAirports(): Promise<Airport[]> {
  const [aCsv, cCsv] = await Promise.all([
    text(`${OURAIRPORTS}/airports.csv`),
    text(`${OURAIRPORTS}/countries.csv`),
  ]);

  const countries = new Map<string, string>();
  for (const c of parseCsv(cCsv)) countries.set(c.code, c.name);

  const out: Airport[] = [];
  for (const a of parseCsv(aCsv)) {
    const iata = a.iata_code?.trim().toUpperCase();
    if (!iata || iata.length !== 3) continue;
    if (a.scheduled_service !== 'yes') continue;
    if (a.type === 'closed') continue;
    out.push({
      iata,
      name: a.name.trim(),
      city: a.municipality.trim(),
      country: a.iso_country.trim(),
      countryName: countries.get(a.iso_country.trim()) ?? a.iso_country.trim(),
      continent: a.continent.trim() || 'XX',
      lat: Number(a.latitude_deg),
      lon: Number(a.longitude_deg),
      wikiTitle: titleFromUrl(a.wikipedia_link),
    });
  }

  // A handful of IATA codes appear twice in OurAirports; keep the first.
  const seen = new Set<string>();
  return out.filter((a) => (seen.has(a.iata) ? false : (seen.add(a.iata), true)));
}
