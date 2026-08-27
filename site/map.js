// Vector world map: Natural Earth outlines on canvas, great-circle legs on
// hover. No tiles, no external requests, no API key.

const LON_SCALE = 180, LAT_SCALE = 360;
const TAU = Math.PI * 2, RAD = Math.PI / 180;

// ---------------------------------------------------------------- projection
// Web Mercator into a unit square. Latitude is clamped to the usual +/-85.05
// so the poles do not run to infinity.
const projX = (lon) => (lon + 180) / 360;
function projY(lat) {
  const p = Math.max(-85.0511, Math.min(85.0511, lat)) * RAD;
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + p / 2)) / TAU;
}

/** Points along the great circle from a to b, as [lon, lat]. */
function greatCircle(a, b) {
  const φ1 = a.lat * RAD, λ1 = a.lon * RAD, φ2 = b.lat * RAD, λ2 = b.lon * RAD;
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((φ2 - φ1) / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2));
  if (!d || !Number.isFinite(d)) return [[a.lon, a.lat], [b.lon, b.lat]];
  const n = Math.max(8, Math.min(128, Math.ceil((d / RAD) / 1.5)));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    out.push([Math.atan2(y, x) / RAD, Math.atan2(z, Math.hypot(x, y)) / RAD]);
  }
  return out;
}

export function createMap(canvas, { onHover, onSelect } = {}) {
  const ctx = canvas.getContext('2d');
  let rings = null, offsets = null, coords = null;
  let origins = [], rows = [], showAll = false;
  let view = { x: 0.5, y: 0.35, s: 600 };
  let hover = null, dpr = 1, W = 0, H = 0, needsFit = false;
  let theme = {};

  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    theme = {
      water: v('--bg'), land: v('--surface-2'), border: v('--rule'),
      ink: v('--ink'), muted: v('--muted'), faint: v('--faint'), surface: v('--surface'),
      origin: [1, 2, 3, 4, 5, 6].map((i) => v(`--o${i}`)),
    };
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // A fit requested before the canvas had a measured size would have
    // collapsed to the minimum scale, so honour it now instead.
    if (needsFit) fit(); else draw();
  }

  const toScreen = (wx, wy) => [(wx - view.x) * view.s + W / 2, (wy - view.y) * view.s + H / 2];
  const project = (lon, lat) => toScreen(projX(lon), projY(lat));

  function fit() {
    const pts = [...origins, ...rows.map((r) => r.airport)];
    if (!pts.length) return;
    if (W < 2 || H < 2) { needsFit = true; return; }   // retried from resize()
    needsFit = false;
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const p of pts) {
      const x = projX(p.lon), y = projY(p.lat);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const pad = 0.08;
    const w = Math.max(x1 - x0, 1e-4) * (1 + pad * 2);
    const h = Math.max(y1 - y0, 1e-4) * (1 + pad * 2);
    view.s = Math.max(120, Math.min(W / w, H / h, 40000));
    view.x = (x0 + x1) / 2; view.y = (y0 + y1) / 2;
    draw();
  }

  // ------------------------------------------------------------------ drawing
  function drawLand() {
    ctx.beginPath();
    for (let r = 0; r < rings; r++) {
      const start = offsets[r], end = offsets[r + 1];
      let prevX = null;
      for (let i = start; i < end; i++) {
        const lon = coords[i * 2] / LON_SCALE, lat = coords[i * 2 + 1] / LAT_SCALE;
        const [sx, sy] = project(lon, lat);
        if (i === start) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
        prevX = sx;
      }
      ctx.closePath();
    }
    ctx.fillStyle = theme.land; ctx.fill('evenodd');
    ctx.strokeStyle = theme.border; ctx.lineWidth = 0.7; ctx.stroke();
  }

  function drawArc(from, to, color, alpha, width) {
    const pts = greatCircle(from, to);
    ctx.beginPath();
    let prevWx = null, started = false;
    for (const [lon, lat] of pts) {
      const wx = projX(lon), wy = projY(lat);
      // Break the line where it crosses the antimeridian.
      if (prevWx !== null && Math.abs(wx - prevWx) > 0.5) { started = false; }
      const [sx, sy] = toScreen(wx, wy);
      if (!started) { ctx.moveTo(sx, sy); started = true; } else ctx.lineTo(sx, sy);
      prevWx = wx;
    }
    ctx.globalAlpha = alpha; ctx.strokeStyle = color;
    ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function dot(p, radius, fill, stroke) {
    const [x, y] = project(p.lon, p.lat);
    ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU);
    ctx.fillStyle = fill; ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
    return [x, y];
  }

  function draw() {
    if (!ctx) return;
    ctx.fillStyle = theme.water || '#EDF0F2';
    ctx.fillRect(0, 0, W, H);
    if (rings) drawLand();

    if (showAll && !hover) {
      for (const r of rows) {
        origins.forEach((o, i) => drawArc(o, r.airport, theme.origin[i], 0.1, 1));
      }
    }
    if (hover) {
      origins.forEach((o, i) => drawArc(o, hover.airport, theme.origin[i], 0.85, 2));
    }

    for (const r of rows) {
      const on = hover && hover.dest === r.dest;
      dot(r.airport, on ? 5 : 3, on ? theme.ink : theme.muted, on ? theme.surface : null);
    }
    origins.forEach((o, i) => dot(o, 6, theme.origin[i], theme.surface));

    if (hover) {
      const [x, y] = project(hover.airport.lon, hover.airport.lat);
      const lines = [hover.label,
        ...origins.map((o, i) => `${o.iata} ${hover.legs[i].toLocaleString()} km`)];
      ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
      const w = Math.max(...lines.map((t) => ctx.measureText(t).width)) + 16;
      const h = lines.length * 15 + 10;
      const bx = Math.min(Math.max(8, x + 12), W - w - 8);
      const by = Math.min(Math.max(8, y - h - 10), H - h - 8);
      ctx.fillStyle = theme.surface; ctx.strokeStyle = theme.border; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(bx, by, w, h, 3); ctx.fill(); ctx.stroke();
      lines.forEach((t, i) => {
        ctx.fillStyle = i === 0 ? theme.ink : theme.muted;
        ctx.font = `${i === 0 ? '600 ' : ''}12px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillText(t, bx + 8, by + 18 + i * 15);
      });
    }
  }

  // -------------------------------------------------------------- interaction
  function pick(px, py) {
    let best = null, bestD = 12 * 12;
    for (const r of rows) {
      const [x, y] = project(r.airport.lon, r.airport.lat);
      const d = (x - px) ** 2 + (y - py) ** 2;
      if (d < bestD) { bestD = d; best = r; }
    }
    return best;
  }

  let dragging = false, moved = false, lastX = 0, lastY = 0;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    if (dragging) {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      view.x -= dx / view.s; view.y -= dy / view.s;
      lastX = e.clientX; lastY = e.clientY;
      draw();
      return;
    }
    const h = pick(e.clientX - r.left, e.clientY - r.top);
    if (h !== hover) {
      hover = h;
      canvas.style.cursor = h ? 'pointer' : 'grab';
      onHover?.(h);
      draw();
    }
  });
  const endDrag = (e) => {
    if (dragging && !moved) {
      const r = canvas.getBoundingClientRect();
      const h = pick(e.clientX - r.left, e.clientY - r.top);
      if (h) onSelect?.(h);
    }
    dragging = false;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', () => { dragging = false; });
  canvas.addEventListener('pointerleave', () => {
    if (hover) { hover = null; onHover?.(null); draw(); }
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const wx = (px - W / 2) / view.s + view.x, wy = (py - H / 2) / view.s + view.y;
    const k = Math.exp(-e.deltaY * 0.0015);
    view.s = Math.max(90, Math.min(view.s * k, 60000));
    view.x = wx - (px - W / 2) / view.s;
    view.y = wy - (py - H / 2) / view.s;
    draw();
  }, { passive: false });

  new ResizeObserver(resize).observe(canvas);

  // Canvas colours are copied out of CSS custom properties, so they have to be
  // re-read whenever the theme changes. Two routes lead there: the OS setting
  // (media query) and an explicit data-theme stamp on the root element.
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener?.('change', () => { readTheme(); draw(); });
  new MutationObserver(() => { readTheme(); draw(); })
    .observe(document.documentElement, { attributeFilter: ['data-theme'] });

  readTheme();

  return {
    async loadBasemap(url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`basemap ${res.status}`);
      const buf = await res.arrayBuffer();
      if (String.fromCharCode(...new Uint8Array(buf, 0, 4)) !== 'MNB1') throw new Error('bad basemap');
      const head = new Uint32Array(buf, 4, 3);
      rings = head[1];
      offsets = new Uint32Array(buf, 16, rings + 1);
      coords = new Int16Array(buf, 16 + (rings + 1) * 4, head[2] * 2);
      draw();
    },
    setData(nextOrigins, nextRows, refit = true) {
      origins = nextOrigins; rows = nextRows; hover = null;
      if (refit) { needsFit = true; fit(); } else draw();
    },
    setShowAll(v) { showAll = v; draw(); },
    highlight(destOrNull) {
      hover = destOrNull ? rows.find((r) => r.dest === destOrNull) ?? null : null;
      draw();
    },
    refreshTheme() { readTheme(); draw(); },
    fit,
  };
}
