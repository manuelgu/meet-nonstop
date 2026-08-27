# meet-nonstop

Pick two or more airports and see every destination **all** of you can reach
without a layover — plus how far each person has to fly to get there.

Answers the question "where can we actually meet?" for a group scattered across
different cities, which the existing route-map sites handle poorly: they compare
two airports at a time and ignore how the travel burden is split.

## How it works

The whole thing is a set intersection over an adjacency list, so there is no
backend. The route graph for every airport on earth with scheduled service is
about 300 KB packed — small enough to ship to the browser and intersect
client-side in under a millisecond.

```
Wikipedia airport articles ─┐
                            ├─→  pipeline  ─→  data/graph.bin  ─→  static site
OurAirports (metadata)  ────┘    (weekly)         + airports.json     on Workers
```

### The pipeline (`pipeline/`)

Runs weekly in CI; nothing runs at request time.

1. **Airport universe** — OurAirports `airports.csv`, filtered to entries with an
   IATA code and `scheduled_service=yes` (~4,100 airports).
2. **Fetch** — article wikitext from the MediaWiki API, 50 titles per request,
   following redirects (~83 requests total).
3. **Parse** — the `{{Airport destination list}}` tables, taking each wikilink's
   **target** (the airport's article title) rather than its display text, which
   varies between articles for the same airport. Cargo subsections are skipped
   and announced-but-not-yet-flying routes are dropped.
4. **Resolve** — this is the part that matters. Article titles are not stable
   identifiers: OurAirports points at `Stockholm-Arlanda Airport` while the real
   article is `Stockholm Arlanda Airport`, and articles link to each other
   through a thicket of redirects. Every link target is canonicalised through
   the API, then matched against known articles, then — as a fallback — through
   its Wikidata entity's IATA code (`P238`). The Wikidata step checks `P31` for
   airport-ness first, because city entities carry metropolitan-area codes
   (`Paris → PAR`) and a city link must not be read as an airport route.
5. **Validate** — a route should appear in *both* endpoints' articles. Edges
   confirmed from both ends are flagged; the reciprocity rate is a free
   staleness signal for the dataset as a whole.
6. **Emit** — `airports.json` plus `graph.bin`, a CSR adjacency structure.

### The site (`site/`)

Dependency-free ES modules. No framework, no bundler — the build step is a file
copy. Origins live in the URL hash (`#AMS,ARN,LIS`) so any comparison is a
shareable link.

## Local development

```bash
npm install                 # only dependency is wrangler, for deploys
npm run pipeline            # rebuild data/ from scratch (~15 min, cached)
npm run pipeline:sample     # 250 airports, for a quick check
npm test                    # parser + graph packing tests
npm run dev                 # serve locally via wrangler
npm run deploy              # manual deploy
```

The pipeline caches every API response under `pipeline/.cache/`, so re-runs are
fast. Delete that directory to force a cold rebuild.

## Deployment

Cloudflare **Workers Builds** is connected to this repository through
Cloudflare's GitHub App, so every push to `main` builds and deploys itself.
No Cloudflare credentials are stored in GitHub.

| Setting | Value |
| --- | --- |
| Build command | `node scripts/build.js` |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |
| Node version | from `.node-version` |

`.github/workflows/ci.yml` runs the tests and a build on every push and pull
request — it needs no secrets, and it is a signal rather than a gate, since
Cloudflare builds independently.

`.github/workflows/refresh-data.yml` rebuilds the route graph every Monday and
commits `data/` only when something actually changed. That push fires GitHub's
webhook, so Cloudflare redeploys on its own.

> To deploy from GitHub Actions instead, add `CLOUDFLARE_API_TOKEN` and
> `CLOUDFLARE_ACCOUNT_ID` as repository secrets and append a
> `cloudflare/wrangler-action@v3` step with `command: deploy` to `ci.yml`,
> then disconnect the build in the Cloudflare dashboard so the two do not race.

## What this is not

- **Not a schedule.** "Seasonal" carries no dates, and a once-weekly summer
  charter is indistinguishable from a five-a-day trunk route. Getting either
  requires commercial schedule data (OAG, Cirium) rather than Wikipedia.
- **Not authoritative.** Community-maintained tables are excellent for large
  airports and patchy for small ones. The reciprocity flag exposes where the two
  ends disagree.
- **Nonstop, not direct.** A "direct" flight may stop en route under one flight
  number; those are excluded.

## Licence

Code is MIT. Route data derives from English Wikipedia (CC BY-SA 4.0) and
OurAirports (public domain) — attribution is carried in the site footer, and
redistributing the built data means honouring CC BY-SA.
