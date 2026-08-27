import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDestinations } from './src/parse.ts';
import { packGraph, bestStatus, type Edge } from './src/emit.ts';
import { parseCsv } from './src/csv.ts';
import { titleFromUrl } from './src/sources.ts';

const article = (body: string) => `Intro text.\n==Airlines and destinations==\n${body}\n==Statistics==\nmore`;

test('extracts destinations and keeps link targets, not display text', () => {
  const r = parseDestinations(article(
    `{{Airport-dest-list\n| [[KLM]] | [[Athens International Airport|Athens]], [[Charles de Gaulle Airport|Paris–CDG]]\n}}`,
  ));
  assert.deepEqual(r.map((x) => x.target),
    ['Athens International Airport', 'Charles de Gaulle Airport']);
  assert.equal(r[0].airline, 'KLM');
  assert.equal(r[0].status, 'scheduled');
});

test('bold markers set seasonal and charter status for following links only', () => {
  const r = parseDestinations(article(
    `| [[TUI]] | [[A Airport|A]] <br> '''Seasonal:''' [[B Airport|B]] <br> '''Seasonal charter''': [[C Airport|C]]`,
  ));
  assert.deepEqual(r.map((x) => [x.target, x.status]), [
    ['A Airport', 'scheduled'],
    ['B Airport', 'seasonal'],
    ['C Airport', 'seasonal-charter'],
  ]);
});

test('strips refs and citation templates without losing links', () => {
  const r = parseDestinations(article(
    `| [[X Air]] | [[Y Airport|Y]]<ref>{{cite web|url=http://e.com|title=Nested {{tmpl}} here}}</ref>{{cn|date=May 2026}}`,
  ));
  assert.deepEqual(r.map((x) => x.target), ['Y Airport']);
});

test('ignores cargo subsections', () => {
  const r = parseDestinations(article(
    `===Passenger===\n| [[P Air]] | [[Keep Airport|Keep]]\n===Cargo===\n| [[C Air]] | [[Drop Airport|Drop]]`,
  ));
  assert.deepEqual(r.map((x) => x.target), ['Keep Airport']);
});

test('flags announced-but-not-yet-flying routes', () => {
  const r = parseDestinations(article(
    `| [[Z Air]] | [[Q Airport|Q]] (begins 30 June 2026), [[R Airport|R]] (ends 4 January)`,
  ));
  assert.equal(r[0].future, true);
  assert.equal(r[1].future, false);
  assert.equal(r[1].ending, true);
});

test('returns nothing when the article has no destination section', () => {
  assert.deepEqual(parseDestinations('==History==\nSome prose.'), []);
});

test('bestStatus prefers year-round service', () => {
  assert.equal(bestStatus('seasonal', 'scheduled'), 'scheduled');
  assert.equal(bestStatus('charter', 'seasonal'), 'seasonal');
});

test('graph packs and unpacks losslessly', () => {
  const adj: Edge[][] = [
    [{ to: 1, status: 'scheduled' }, { to: 2, status: 'seasonal' }],
    [{ to: 0, status: 'scheduled' }],
    [],
  ];
  const buf = packGraph(adj, new Set(['0>1', '1>0']));
  assert.equal(String.fromCharCode(...new Uint8Array(buf, 0, 4)), 'MNS1');
  const head = new Uint32Array(buf, 4, 3);
  assert.equal(head[1], 3);
  assert.equal(head[2], 3);
  const offsets = new Uint32Array(buf, 16, 4);
  const edges = new Uint32Array(buf, 16 + 16, 3);
  assert.deepEqual([...offsets], [0, 2, 3, 3]);
  assert.equal(edges[0] & 0xfffff, 1);
  assert.equal((edges[0] >>> 22) & 1, 1, '0>1 is reciprocal');
  assert.equal((edges[1] >>> 20) & 3, 1, '0>2 is seasonal');
  assert.equal((edges[1] >>> 22) & 1, 0, '0>2 is not reciprocal');
});

test('csv reader handles quoted commas and doubled quotes', () => {
  const rows = parseCsv('a,b\n"x,1","he said ""hi"""\nplain,2');
  assert.deepEqual(rows, [
    { a: 'x,1', b: 'he said "hi"' },
    { a: 'plain', b: '2' },
  ]);
});

test('extracts article titles from wikipedia urls', () => {
  assert.equal(titleFromUrl('https://en.wikipedia.org/wiki/Stockholm-Arlanda_Airport'),
               'Stockholm-Arlanda Airport');
  assert.equal(titleFromUrl(''), '');
});
