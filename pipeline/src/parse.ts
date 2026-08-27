/** Parser for the "Airlines and destinations" tables on English Wikipedia
 *  airport articles. Extracts wikilink *targets* (article titles), never the
 *  display text, because display text varies between articles for the same
 *  airport while the link target is stable. */

export type Status = 'scheduled' | 'seasonal' | 'charter' | 'seasonal-charter';

export type RawRoute = {
  airline: string;
  target: string;   // linked article title of the destination airport
  status: Status;
  future: boolean;  // "begins 30 June 2026" — announced but not yet flying
  ending: boolean;  // "ends 4 January"
};

const SECTION_RE = /^(airlines?\s*(and|&|&amp;)\s*destinations?|destinations)$/i;
const CARGO_RE = /cargo|freight/i;

function stripNoise(s: string): string {
  s = s.replace(/<ref[^>]*\/>/gi, '');
  s = s.replace(/<ref[\s\S]*?<\/ref>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Remove templates innermost-first so nesting unwinds; keeps [[links]] intact.
  for (let i = 0; i < 8; i++) {
    const next = s.replace(/\{\{[^{}]*\}\}/g, '');
    if (next === s) break;
    s = next;
  }
  return s;
}

function normalizeStatus(label: string): Status {
  const l = label.toLowerCase();
  const charter = /charter/.test(l);
  const seasonal = /seasonal|summer|winter/.test(l);
  if (charter && seasonal) return 'seasonal-charter';
  if (charter) return 'charter';
  if (seasonal) return 'seasonal';
  return 'scheduled';
}

/** Pull the destination section out of a full article, dropping cargo subsections. */
function destinationSection(wikitext: string): string[] {
  const lines = wikitext.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^==\s*([^=].*?)\s*==\s*$/.exec(lines[i]);
    if (m && SECTION_RE.test(m[1].replace(/\[\[|\]\]/g, '').trim())) { start = i; break; }
  }
  if (start === -1) return [];

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^==[^=]/.test(lines[i])) { end = i; break; }
  }

  const out: string[] = [];
  let skipping = false;
  for (const line of lines.slice(start + 1, end)) {
    const h = /^={3,}\s*(.*?)\s*={3,}\s*$/.exec(line);
    if (h) { skipping = CARGO_RE.test(h[1]); continue; }
    if (!skipping) out.push(line);
  }
  return out;
}

export function parseDestinations(wikitext: string): RawRoute[] {
  const lines = destinationSection(wikitext);
  if (!lines.length) return [];

  // Re-join rows that wrap onto continuation lines.
  const rows: string[] = [];
  let buf: string | null = null;
  for (const line of lines) {
    if (line.startsWith('|')) { if (buf !== null) rows.push(buf); buf = line; }
    else if (buf !== null && !line.startsWith('{{') && !line.startsWith('}}')) buf += ' ' + line;
  }
  if (buf !== null) rows.push(buf);

  const out: RawRoute[] = [];
  for (const raw of rows) {
    const clean = stripNoise(raw);
    const parts = clean.split('|');
    if (parts.length < 3) continue;
    const airlineField = parts[1];
    const destField = parts.slice(2).join('|');

    const am = /\[\[([^\]\[|]+)(?:\|([^\]\[]*))?\]\]/.exec(airlineField);
    if (!am) continue;
    const airline = (am[2] || am[1]).trim();

    // Split the destination cell on bold status markers ('''Seasonal:''' etc).
    let cursor = 0;
    let status: Status = 'scheduled';
    const segments: [Status, string][] = [];
    const marker = /'''\s*(.*?)\s*:?\s*'''\s*:?/g;
    let m: RegExpExecArray | null;
    while ((m = marker.exec(destField))) {
      segments.push([status, destField.slice(cursor, m.index)]);
      status = normalizeStatus(m[1]);
      cursor = m.index + m[0].length;
    }
    segments.push([status, destField.slice(cursor)]);

    for (const [segStatus, seg] of segments) {
      const link = /\[\[([^\]\[|]+)(?:\|([^\]\[]*))?\]\]/g;
      let lm: RegExpExecArray | null;
      while ((lm = link.exec(seg))) {
        const target = lm[1].trim();
        if (!target || /^(File|Image|Category|wikt):/i.test(target)) continue;
        const tail = seg.slice(lm.index + lm[0].length, lm.index + lm[0].length + 70);
        const note = /^\s*\(([^)]*)\)/.exec(tail)?.[1] ?? '';
        out.push({
          airline,
          target,
          status: segStatus,
          future: /begins|resumes|from \d|will (begin|resume)/i.test(note),
          ending: /ends|until/i.test(note),
        });
      }
    }
  }
  return out;
}
