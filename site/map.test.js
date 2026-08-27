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
  }, { get: (t, k) => (k in t ? t[k] : () => {}), set: () => true });

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
  globalThis.ResizeObserver = class { observe() {} };
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

async function mounted() {
  const env = stubEnv();
  const { createMap } = await import('./map.js?' + Math.random());
  const map = createMap(env.canvas, {});
  // Give it a measured size the way ResizeObserver would.
  map.fit();
  env.canvas.width = W; env.canvas.height = H;
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
