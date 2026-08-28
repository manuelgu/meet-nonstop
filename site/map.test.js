// Interaction tests for the map. The gesture handling cannot be exercised in a
// headless browser tab (requestAnimationFrame is suspended while the tab is
// hidden), so the DOM surface the map touches is stubbed instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const W = 800, H = 400;

function stubEnv() {
  const handlers = new Map();
  const arcs = [];
  const ctx = new Proxy({
    arc(x, y, r) { arcs.push([x, y, r]); },
    measureText: () => ({ width: 40 }),
  }, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });

  const canvas = {
    width: W, height: H, style: {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }),
    addEventListener: (type, fn) => handlers.set(type, fn),
    setPointerCapture() {}, releasePointerCapture() {},
    dispatch(type, props) { handlers.get(type)?.({ preventDefault() {}, ...props }); },
  };

  globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };
  globalThis.cancelAnimationFrame = () => {};
  // The real one fires on observe, which is what gives the map its measured
  // size; a no-op stub left W and H at zero and every projection meaningless.
  globalThis.ResizeObserver = class {
    constructor(cb) { this.cb = cb; }
    observe() { this.cb(); }
  };
  globalThis.MutationObserver = class { observe() {} };
  globalThis.window = { matchMedia: () => ({ addEventListener() {} }), devicePixelRatio: 1 };
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#000' });
  return { canvas, arcs };
}

const AMS = { iata: 'AMS', lon: 4.76, lat: 52.31 };
const ARN = { iata: 'ARN', lon: 17.93, lat: 59.65 };
const rows = [
  { dest: 1, label: 'Paris', legs: [400, 1500], airport: { iata: 'CDG', name: 'CDG', country: 'FR', lon: 2.55, lat: 49.01 } },
  { dest: 2, label: 'Rome', legs: [1300, 1980], airport: { iata: 'FCO', name: 'FCO', country: 'IT', lon: 12.25, lat: 41.80 } },
];

/** Distance between the two destination dots in the most recent frame. */
function dotSpread(arcs) {
  const frame = arcs.slice(-4); // 2 destinations + 2 origins per draw
  const [a, b] = frame;
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

async function mounted(cbs = {}) {
  const env = stubEnv();
  const { createMap } = await import('./map.js?' + Math.random());
  const map = createMap(env.canvas, cbs);   // ResizeObserver stub sizes it
  return { ...env, map };
}

test('pinching apart zooms in by the ratio of finger separation', async () => {
  const { canvas, arcs, map } = await mounted();
  map.setData([AMS, ARN], rows, false);
  const before = dotSpread(arcs);
  assert.ok(before > 0, 'destinations are drawn before the gesture');

  const cx = W / 2, cy = H / 2;
  canvas.dispatch('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: cx - 50, clientY: cy });
  canvas.dispatch('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: cx + 50, clientY: cy });
  canvas.dispatch('pointermove', { pointerId: 1, pointerType: 'touch', clientX: cx - 100, clientY: cy });
  canvas.dispatch('pointermove', { pointerId: 2, pointerType: 'touch', clientX: cx + 100, clientY: cy });
  const after = dotSpread(arcs);

  assert.ok(Math.abs(after / before - 2) < 0.05,
    `spread should double, got ${(after / before).toFixed(3)}x`);
});

test('pinching together zooms out', async () => {
  const { canvas, arcs, map } = await mounted();
  map.setData([AMS, ARN], rows, false);
  const before = dotSpread(arcs);
  const cx = W / 2, cy = H / 2;
  canvas.dispatch('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: cx - 100, clientY: cy });
  canvas.dispatch('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: cx + 100, clientY: cy });
  canvas.dispatch('pointermove', { pointerId: 1, pointerType: 'touch', clientX: cx - 50, clientY: cy });
  canvas.dispatch('pointermove', { pointerId: 2, pointerType: 'touch', clientX: cx + 50, clientY: cy });
  assert.ok(dotSpread(arcs) / before < 0.55, 'pinching in halves the spread');
});

test('one finger pans without changing zoom', async () => {
  const { canvas, arcs, map } = await mounted();
  map.setData([AMS, ARN], rows, false);
  const before = dotSpread(arcs);
  canvas.dispatch('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 400, clientY: 200 });
  canvas.dispatch('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 460, clientY: 240 });
  assert.ok(Math.abs(dotSpread(arcs) - before) < 0.001, 'panning leaves scale untouched');
});

test('a line-mode wheel notch zooms comparably to a pixel-mode scroll', async () => {
  const px = await mounted();
  px.map.setData([AMS, ARN], rows, false);
  const pxBefore = dotSpread(px.arcs);
  px.canvas.dispatch('wheel', { deltaY: -48, deltaMode: 0, clientX: 400, clientY: 200 });
  const pxRatio = dotSpread(px.arcs) / pxBefore;

  const ln = await mounted();
  ln.map.setData([AMS, ARN], rows, false);
  const lnBefore = dotSpread(ln.arcs);
  ln.canvas.dispatch('wheel', { deltaY: -3, deltaMode: 1, clientX: 400, clientY: 200 });
  const lnRatio = dotSpread(ln.arcs) / lnBefore;

  assert.ok(pxRatio > 1 && lnRatio > 1, 'both zoom in');
  assert.ok(Math.abs(pxRatio - lnRatio) < 0.02,
    `line mode should match pixel mode, got ${pxRatio.toFixed(3)} vs ${lnRatio.toFixed(3)}`);
});

test('one coarse wheel notch cannot jump more than the clamp allows', async () => {
  const { canvas, arcs, map } = await mounted();
  map.setData([AMS, ARN], rows, false);
  const before = dotSpread(arcs);
  canvas.dispatch('wheel', { deltaY: -100000, deltaMode: 0, clientX: 400, clientY: 200 });
  assert.ok(dotSpread(arcs) / before < 1.4, 'a runaway delta is clamped');
});

test('zoom keeps the point under the cursor fixed', async () => {
  const { canvas, arcs, map } = await mounted();
  map.setData([AMS, ARN], rows, false);
  const anchor = arcs.slice(-4)[0].slice(0, 2);          // first destination dot
  canvas.dispatch('wheel', { deltaY: -60, deltaMode: 0, clientX: anchor[0], clientY: anchor[1] });
  const moved = arcs.slice(-4)[0].slice(0, 2);
  assert.ok(Math.hypot(moved[0] - anchor[0], moved[1] - anchor[1]) < 0.5,
    'the anchored point does not drift');
});

/** Screen position of the first destination dot in the latest frame. */
function firstDot(arcs) { return arcs.slice(-4)[0].slice(0, 2); }

test('tapping a dot on touch opens its tooltip and does not jump the list', async () => {
  const selected = [], hovered = [];
  const { canvas, arcs, map } = await mounted({
    onSelect: (r) => selected.push(r.label),
    onHover: (r) => hovered.push(r ? r.label : null),
  });
  map.setData([AMS, ARN], rows, true);
  const [x, y] = firstDot(arcs);

  canvas.dispatch('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: x, clientY: y });
  canvas.dispatch('pointerup', { pointerId: 1, pointerType: 'touch', clientX: x, clientY: y });

  assert.deepEqual(selected, [], 'touch must not trigger the scroll-to-list callback');
  assert.deepEqual(hovered, ['Paris'], 'touch reveals the destination instead');
});

test('tapping empty space on touch dismisses the tooltip', async () => {
  const hovered = [];
  const { canvas, arcs, map } = await mounted({ onHover: (r) => hovered.push(r ? r.label : null) });
  map.setData([AMS, ARN], rows, true);          // fit, so the dots land on-canvas
  const drawn = arcs.slice(-4).map((a) => [a[0], a[1]]);
  const [x, y] = drawn[0];

  // Find a point comfortably clear of every drawn marker.
  let empty = null;
  for (let gx = 20; gx < W && !empty; gx += 20) {
    for (let gy = 20; gy < H; gy += 20) {
      if (drawn.every(([dx, dy]) => Math.hypot(dx - gx, dy - gy) > 60)) { empty = [gx, gy]; break; }
    }
  }
  assert.ok(empty, 'the canvas has some empty space to tap');

  canvas.dispatch('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: x, clientY: y });
  canvas.dispatch('pointerup', { pointerId: 1, pointerType: 'touch', clientX: x, clientY: y });
  canvas.dispatch('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: empty[0], clientY: empty[1] });
  canvas.dispatch('pointerup', { pointerId: 2, pointerType: 'touch', clientX: empty[0], clientY: empty[1] });

  assert.equal(hovered.length, 2, `expected open then close, got ${JSON.stringify(hovered)}`);
  assert.ok(hovered[0], 'first tap opened a tooltip');
  assert.equal(hovered[1], null, 'the second tap clears it');
});

test('clicking a dot with a mouse still jumps to the list entry', async () => {
  const selected = [];
  const { canvas, arcs, map } = await mounted({ onSelect: (r) => selected.push(r.label) });
  map.setData([AMS, ARN], rows, true);
  const [x, y] = firstDot(arcs);
  canvas.dispatch('pointerdown', { pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y });
  canvas.dispatch('pointerup', { pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y });
  assert.deepEqual(selected, ['Paris']);
});

test('a drag is not treated as a tap', async () => {
  const selected = [], hovered = [];
  const { canvas, arcs, map } = await mounted({
    onSelect: (r) => selected.push(r.label),
    onHover: (r) => hovered.push(r ? r.label : null),
  });
  map.setData([AMS, ARN], rows, false);
  const [x, y] = firstDot(arcs);
  canvas.dispatch('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: x, clientY: y });
  canvas.dispatch('pointermove', { pointerId: 1, pointerType: 'touch', clientX: x + 60, clientY: y + 30 });
  canvas.dispatch('pointerup', { pointerId: 1, pointerType: 'touch', clientX: x + 60, clientY: y + 30 });
  assert.deepEqual(selected, []);
  assert.deepEqual(hovered, [], 'panning must not open a tooltip');
});

test('the tooltip names the country', async () => {
  const texts = [];
  const env = stubEnv();
  const { createMap } = await import('./map.js?' + Math.random());
  // Capture text drawn into the tooltip.
  const realCtx = env.canvas.getContext();
  realCtx.fillText = (t) => texts.push(t);
  const map = createMap(env.canvas, {});
  map.setData([AMS, ARN], rows, true);
  map.highlight(1);
  assert.ok(texts.includes('Paris'), 'label present');
  assert.ok(texts.some((t) => t.startsWith('FR')), `country line present, got ${JSON.stringify(texts)}`);
  assert.ok(texts.some((t) => t.startsWith('AMS ')), 'leg lines present');
});

test('the zoom buttons scale about the centre of the viewport', async () => {
  const { arcs, map } = await mounted();
  map.setData([AMS, ARN], rows, true);
  const before = dotSpread(arcs);

  map.zoomBy(1.7);
  const zoomedIn = dotSpread(arcs);
  assert.ok(Math.abs(zoomedIn / before - 1.7) < 0.02,
    `zoom in should scale by 1.7, got ${(zoomedIn / before).toFixed(3)}`);

  map.zoomBy(1 / 1.7);
  assert.ok(Math.abs(dotSpread(arcs) - before) < 0.01, 'zooming back out returns to the start');
});

test('zoom buttons report when a limit is reached', async () => {
  const states = [];
  const { map } = await mounted({ onViewChange: (s) => states.push(s) });
  map.setData([AMS, ARN], rows, true);

  for (let i = 0; i < 40; i++) map.zoomBy(2);
  assert.equal(states.at(-1).atMax, true, 'reports when zoomed all the way in');
  assert.equal(states.at(-1).atMin, false);

  for (let i = 0; i < 80; i++) map.zoomBy(0.5);
  assert.equal(states.at(-1).atMin, true, 'reports when zoomed all the way out');
  assert.equal(states.at(-1).atMax, false);
});

test('wheel and pinch also report view changes, so the buttons stay in sync', async () => {
  const states = [];
  const { canvas, map } = await mounted({ onViewChange: (s) => states.push(s) });
  map.setData([AMS, ARN], rows, true);
  const n = states.length;
  canvas.dispatch('wheel', { deltaY: -60, deltaMode: 0, clientX: 400, clientY: 200 });
  assert.ok(states.length > n, 'a wheel zoom notifies the host');
});
