// Build = copy. The site is dependency-free ES modules, so there is nothing
// to bundle; keeping it that way makes CI a single Node invocation.
import { cp, mkdir, rm, stat } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const dist = new URL('dist/', root);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(new URL('site/', root), dist, { recursive: true });

try {
  await stat(new URL('data/graph.bin', root));
  await cp(new URL('data/', root), new URL('data/', dist), { recursive: true });
} catch {
  console.error('\n  No data/graph.bin found. Run `npm run pipeline` first.\n');
  process.exit(1);
}
console.log('built -> dist/');
