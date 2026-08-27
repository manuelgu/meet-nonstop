import { mkdir, writeFile } from 'node:fs/promises';
import type { Airport } from './sources.ts';
import type { Status } from './parse.ts';

export const STATUS_BITS: Record<Status, number> = {
  scheduled: 0, seasonal: 1, charter: 2, 'seasonal-charter': 3,
};
// Lower is better; used when several airlines fly the same pair.
const RANK: Record<Status, number> = {
  scheduled: 0, seasonal: 1, 'seasonal-charter': 2, charter: 3,
};

export type Edge = { to: number; status: Status };

export function bestStatus(a: Status, b: Status): Status {
  return RANK[a] <= RANK[b] ? a : b;
}

/**
 * graph.bin layout (little-endian):
 *   magic "MNS1"            4 bytes
 *   uint32 version          1
 *   uint32 airportCount     N
 *   uint32 edgeCount        E
 *   uint32[N+1] offsets     CSR row pointers
 *   uint32[E]  edges        bits 0-19 dest index | 20-21 status | 22 reciprocal
 */
export function packGraph(adj: Edge[][], reciprocal: Set<string>): ArrayBuffer {
  const n = adj.length;
  const e = adj.reduce((s, xs) => s + xs.length, 0);
  const buf = new ArrayBuffer(16 + (n + 1) * 4 + e * 4);
  const bytes = new Uint8Array(buf);
  bytes.set([0x4d, 0x4e, 0x53, 0x31], 0); // "MNS1"
  const head = new Uint32Array(buf, 4, 3);
  head[0] = 1; head[1] = n; head[2] = e;

  const offsets = new Uint32Array(buf, 16, n + 1);
  const edges = new Uint32Array(buf, 16 + (n + 1) * 4, e);

  let k = 0;
  for (let i = 0; i < n; i++) {
    offsets[i] = k;
    for (const edge of [...adj[i]].sort((a, b) => a.to - b.to)) {
      const recip = reciprocal.has(`${i}>${edge.to}`) ? 1 : 0;
      edges[k++] = (edge.to & 0xfffff) | (STATUS_BITS[edge.status] << 20) | (recip << 22);
    }
  }
  offsets[n] = k;
  return buf;
}

export async function writeOutputs(
  dir: URL,
  airports: Airport[],
  adj: Edge[][],
  reciprocal: Set<string>,
  stats: Record<string, unknown>,
) {
  await mkdir(dir, { recursive: true });
  const compact = airports.map((a) => [
    a.iata, a.name, a.city, a.countryName, a.continent,
    Math.round(a.lat * 1e4) / 1e4, Math.round(a.lon * 1e4) / 1e4,
  ]);
  await writeFile(new URL('airports.json', dir), JSON.stringify({ v: 1, airports: compact }));
  await writeFile(new URL('graph.bin', dir), Buffer.from(packGraph(adj, reciprocal)));
  await writeFile(new URL('meta.json', dir), JSON.stringify(stats, null, 2));
}
