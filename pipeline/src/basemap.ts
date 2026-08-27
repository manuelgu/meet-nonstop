import { writeFile, mkdir } from 'node:fs/promises';
import { UA } from './sources.ts';

const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson';

// Quantisation scales chosen so the full range fits int16 with room to spare:
// lon x180 -> +/-32400, lat x360 -> +/-32400. Resolution is ~600 m in longitude
// and ~300 m in latitude, far finer than 110m source data warrants.
export const LON_SCALE = 180;
export const LAT_SCALE = 360;

type Ring = number[][];

function ringsOf(geometry: any): Ring[] {
  if (!geometry) return [];
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates]
              : geometry.type === 'MultiPolygon' ? geometry.coordinates
              : [];
  return polys.flat();
}

/** Perpendicular-distance simplification in quantised units. */
function simplify(points: number[][], tol: number): number[][] {
  if (points.length < 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];

  while (stack.length) {
    const [first, last] = stack.pop()!;
    let maxD = -1, idx = -1;
    const [x1, y1] = points[first], [x2, y2] = points[last];
    const dx = x2 - x1, dy = y2 - y1;
    const denom = dx * dx + dy * dy;
    for (let i = first + 1; i < last; i++) {
      const [x, y] = points[i];
      let d: number;
      if (denom === 0) d = (x - x1) ** 2 + (y - y1) ** 2;
      else {
        let t = ((x - x1) * dx + (y - y1) * dy) / denom;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        d = (x - (x1 + t * dx)) ** 2 + (y - (y1 + t * dy)) ** 2;
      }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol * tol && idx > 0) {
      keep[idx] = 1;
      stack.push([first, idx], [idx, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * basemap.bin layout (little-endian):
 *   magic "MNB1"          4 bytes
 *   uint32 version        1
 *   uint32 ringCount      R
 *   uint32 pointCount     P
 *   uint32[R+1] offsets   ring start indices, in points
 *   int16[P*2] coords     lon*180, lat*360, interleaved
 */
export async function buildBasemap(dir: URL, log: (...a: unknown[]) => void) {
  log('fetching Natural Earth 110m country outlines…');
  const res = await fetch(NE, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`basemap fetch failed: ${res.status}`);
  const geo = await res.json() as any;

  const rings: number[][][] = [];
  let rawPoints = 0;
  for (const f of geo.features) {
    for (const ring of ringsOf(f.geometry)) {
      rawPoints += ring.length;
      // Quantise first, then drop points the quantisation made redundant.
      const q: number[][] = [];
      for (const [lon, lat] of ring) {
        const x = Math.round(lon * LON_SCALE), y = Math.round(lat * LAT_SCALE);
        const prev = q[q.length - 1];
        if (!prev || prev[0] !== x || prev[1] !== y) q.push([x, y]);
      }
      const s = simplify(q, 12); // ~0.07 deg, invisible below continental zoom
      if (s.length >= 4) rings.push(s);
    }
  }

  const pointCount = rings.reduce((n, r) => n + r.length, 0);
  const buf = new ArrayBuffer(16 + (rings.length + 1) * 4 + pointCount * 4);
  new Uint8Array(buf).set([0x4d, 0x4e, 0x42, 0x31], 0); // "MNB1"
  const head = new Uint32Array(buf, 4, 3);
  head[0] = 1; head[1] = rings.length; head[2] = pointCount;

  const offsets = new Uint32Array(buf, 16, rings.length + 1);
  const coords = new Int16Array(buf, 16 + (rings.length + 1) * 4, pointCount * 2);
  let k = 0;
  rings.forEach((ring, i) => {
    offsets[i] = k;
    for (const [x, y] of ring) { coords[k * 2] = x; coords[k * 2 + 1] = y; k++; }
  });
  offsets[rings.length] = k;

  await mkdir(dir, { recursive: true });
  await writeFile(new URL('basemap.bin', dir), Buffer.from(buf));
  log(`basemap: ${rings.length} rings, ${pointCount} points ` +
      `(from ${rawPoints}), ${(buf.byteLength / 1024).toFixed(0)} KB`);
  return { rings: rings.length, points: pointCount, bytes: buf.byteLength };
}
