/* engine.js — the S3OK dashboard, client side.
 *
 * Renders the site 03_build_dashboard.R assembles: the question, topic and
 * region data 02_create_dashboard_data.R computed, plus a config.json of
 * presentation content. Nothing here computes a statistic — every percentage,
 * mean, interval, rank and median was computed upstream, so this file only
 * ever picks a slice and draws it. That is what lets the site run with no
 * server.
 *
 * The front end is shared with the institute's other dashboards (WxDash, the
 * fusion dashboard), which is why its class names carry a wx- prefix: a
 * change to the shared chrome is worth carrying to the others.
 *
 * Components (registered on the `components` object): explore (the survey
 * question explorer), s3_topics, s3_region_map, s3_narratives, wx_landing,
 * static_page. Each receives (pageConfig, container) and renders itself from
 * the files it references.
 */

"use strict";

window.WX_ENGINE_LOADED = true; // watchdog diagnostics: proves this file executed

const BUNDLE = (() => {
  // A page served from a subdirectory sets window.WX_BUNDLE (e.g. "../../")
  // so fetches resolve to the bundle root; ?bundle= does the same.
  const p = window.WX_BUNDLE ||
    new URLSearchParams(location.search).get("bundle") || "./";
  return p.endsWith("/") ? p : p + "/";
})();

let CONFIG = null;
const jsonCache = new Map();

async function fetchJSON(rel) {
  if (jsonCache.has(rel)) return jsonCache.get(rel);
  // Build stamp (set by the bundle's index.html) busts long-lived host
  // caches on every deploy.
  const bust = window.WX_BUILD
    ? (rel.includes("?") ? "&" : "?") + "v=" + window.WX_BUILD : "";
  const res = await fetch(BUNDLE + rel + bust);
  if (!res.ok) throw new Error(`Failed to load ${rel}: ${res.status}`);
  const data = await res.json();
  jsonCache.set(rel, data);
  return data;
}

/* ---------------------------------------------------------------- utils -- */

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return node;
}

// Display token for missing groups/categories — mirrors R's rendering of NA.
const naLabel = (v) => (v == null ? "NA" : v);

/* Flagging ------------------------------------------------------------------
 * A triage tool, not a reader feature: ?flag=1 puts a flag beside the question
 * heading and a panel at the foot of the explorer. What it collects is the
 * input to hidden_questions.csv, which the build reads to drop a question, so
 * the judgement is made where the problem is visible rather than against a
 * list of variable names.
 *
 * Kept in localStorage because the site is plain files on a host with nothing
 * to POST to. That makes the list per-browser and per-origin: flags made
 * against a local preview do not follow you to the deployed site, so export
 * before switching. Every access is guarded — a browser set to block site data
 * throws on the accessor itself rather than returning empty. */
const FLAGS_KEY = "s3ok-flags";
const flaggingOn = () => new URLSearchParams(location.search).get("flag") === "1";

function readFlags() {
  try {
    return JSON.parse(localStorage.getItem(FLAGS_KEY) || "{}");
  } catch { return {}; }
}

function writeFlags(f) {
  try { localStorage.setItem(FLAGS_KEY, JSON.stringify(f)); } catch { /* no store */ }
}

// Same columns the build reads, so an export can be dropped straight in;
// every row is `hide`, and a different disposition or a note is set in the
// file itself.
function flagsToCSV(flags) {
  const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const rows = Object.entries(flags).map(([id, f]) =>
    [id, f.disposition || "hide", f.note || "", f.question || ""].map(q).join(","));
  return ["id,disposition,note,question", ...rows].join("\n") + "\n";
}

/* Saved questions ------------------------------------------------------------
 * A reader's own list, for keeping track of questions while browsing: "Save"
 * beside the question heading, and a panel at the foot of the explorer that
 * appears once something is saved. Kept apart from the flags above, so saving
 * a question to read later never feeds the hide list. In localStorage for
 * the same reason the flags are, which makes it per-browser; the panel says
 * so, and the download is how a list is kept. Guarded the same way. */
const SAVED_KEY = "s3ok-saved";

function readSaved() {
  try {
    const list = JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function writeSaved(list) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); } catch { /* no store */ }
}

// What a reader needs to find each question again in the released data.
function savedToCSV(list) {
  const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const rows = list.map(x =>
    [x.waves, x.years, x.question, x.variable].map(q).join(","));
  return ["waves,years,question,variable", ...rows].join("\n") + "\n";
}

/* A split-sample question nests its splits and summaries one level deeper,
 * under the version the respondent read; every other question does not.
 * `arms` being present is the signal, and this is the one place that knows it,
 * so a component that charts a question need not care which shape it got.
 * There is no pooled option: pooling the versions would average across the
 * difference the experiment was testing. */
function questionSlice(v, armId) {
  const arms = Array.isArray(v.arms) ? v.arms : [];
  if (arms.length === 0) {
    return { armed: false, armKey: null,
             splits: v.splits || {}, summaries: v.summaries || {} };
  }
  const armKey = arms.some(a => a.id === armId) ? armId : arms[0].id;
  return { armed: true, armKey,
           splits: (v.splits || {})[armKey] || {},
           summaries: (v.summaries || {})[armKey] || {} };
}

// Optional deep-link: ?grouping=Gender preselects the demographic grouping.
const urlGrouping = () => {
  const g = new URLSearchParams(location.search).get("grouping");
  return g && CONFIG.groupings.some(x => x.id === g) ? g : null;
};

// "Snow\nIce" → ["Snow", "Ice"] for multi-line Chart.js tick labels.
const tickLines = (label) => String(label).split("\n");

/* ---- viridis (matches ggplot2 scale_fill_viridis discrete sampling) ------ */
// 32 anchor stops of the viridis colormap; discrete palette of n colors =
// n evenly spaced samples over [0,1] with linear interpolation, like
// viridisLite::viridis(n).
const VIRIDIS_STOPS = [
  [68,1,84],[71,13,96],[72,24,106],[72,35,116],[71,45,123],[69,55,129],
  [66,64,134],[62,73,137],[58,82,139],[54,90,140],[50,98,142],[47,106,142],
  [43,113,142],[40,121,142],[37,128,142],[34,136,142],[31,143,141],[29,151,140],
  [27,158,138],[27,166,135],[30,173,131],[37,180,126],[47,187,119],[61,194,111],
  [77,200,101],[95,206,90],[114,212,77],[135,217,63],[157,221,48],[180,224,33],
  [203,226,25],[253,231,37]
];
function viridis(n) {
  if (n === 1) return ["rgb(68,1,84)"];
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1) * (VIRIDIS_STOPS.length - 1);
    const lo = Math.floor(t), hi = Math.min(lo + 1, VIRIDIS_STOPS.length - 1);
    const f = t - lo;
    const c = [0, 1, 2].map(k => Math.round(VIRIDIS_STOPS[lo][k] * (1 - f) + VIRIDIS_STOPS[hi][k] * f));
    out.push(`rgb(${c[0]},${c[1]},${c[2]})`);
  }
  return out;
}

// ColorBrewer Greys — greyscale theme's map ramp (see dataStops).
const GREYS_STOPS = [
  [247,247,247],[217,217,217],[189,189,189],[150,150,150],
  [115,115,115],[82,82,82],[37,37,37]
];

// In the greyscale accessibility theme the maps repaint in greys, so one
// theme switch covers them; every other theme keeps the chosen color scheme.
// Charts are untouched: this applies to choropleth ramps only.
function dataStops(stops) {
  return document.documentElement.dataset.theme === "greyscale" ? GREYS_STOPS : stops;
}

// Continuous colour ramp over stop array; t clamped to [0,1]. Used by the
// choropleth components (clamping is a deliberate deviation from R
// colorNumeric, which paints out-of-domain values grey).
function rampColor(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const x = t * (stops.length - 1);
  const lo = Math.floor(x), hi = Math.min(lo + 1, stops.length - 1), f = x - lo;
  const c = [0, 1, 2].map(k => Math.round(stops[lo][k] * (1 - f) + stops[hi][k] * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/* ---- user-facing data-color schemes -------------------------------------
 * The two explore pages open in blue and offer viridis and print-safe grey
 * as viewer choices. Blue is the default without being first in the menu,
 * which is why the default lives here rather than in the scheme list order.
 * The greyscale accessibility theme still overrides map ramps via
 * dataStops(). */
const BLUES_STOPS = [
  [239,243,255],[198,219,239],[158,202,225],[107,174,214],
  [66,146,198],[33,113,181],[8,69,148]
];
const COLOR_SCHEMES = [
  { id: "viridis", label: "Viridis (multiple hues)", stops: VIRIDIS_STOPS },
  { id: "blue", label: "Blue (one hue)", stops: BLUES_STOPS },
  { id: "grey", label: "Grey (print safe)", stops: GREYS_STOPS }
];
const DEFAULT_SCHEME = "blue";
const urlScheme = () => {
  const s = getParam("scheme");
  return COLOR_SCHEMES.some(x => x.id === s) ? s : DEFAULT_SCHEME;
};
const schemeStops = (id) =>
  (COLOR_SCHEMES.find(x => x.id === id)
   || COLOR_SCHEMES.find(x => x.id === DEFAULT_SCHEME)).stops;
// Discrete series colors. Viridis keeps its ggplot sampling; the sequential
// ramps sample dark→light so a single series is always the dark end.
function schemeSeriesColors(id, n) {
  if (id === "viridis") return viridis(n);
  const stops = schemeStops(id);
  const out = [];
  for (let i = 0; i < n; i++) out.push(rampColor(stops, n === 1 ? 1 : 1 - (i / (n - 1)) * 0.8));
  return out;
}
function schemeSelect(current, onChange) {
  const wrap = el("div");
  wrap.append(el("label", { class: "field-label", for: "scheme-sel" }, "Change color scheme"));
  const sel = el("select", { class: "grouping", id: "scheme-sel", onchange: () => onChange(sel.value) });
  for (const sc of COLOR_SCHEMES) sel.append(el("option", { value: sc.id }, sc.label));
  sel.value = current;
  wrap.append(sel);
  return wrap;
}

/* ---- PDF export (jsPDF vendored with the site) -------------------------- */
// Crop the flat backdrop off a snapshot, so what lands in a document is the
// map rather than the map plus the empty frame around it. The frame is a
// fixed-size container the CONUS floats in; left in, it shrinks the plot and
// leaves a legend anchored to the image sitting well left of the coastline.
function trimCanvas(src, bg) {
  const W = src.width, H = src.height;
  const data = src.getContext("2d").getImageData(0, 0, W, H).data;
  const rgb = (String(bg).match(/\d+(\.\d+)?/g) || [255, 255, 255])
    .slice(0, 3).map(Number);
  const tol = 10;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (data[i + 3] < 8) continue;
      if (Math.abs(data[i] - rgb[0]) <= tol &&
          Math.abs(data[i + 1] - rgb[1]) <= tol &&
          Math.abs(data[i + 2] - rgb[2]) <= tol) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return src;                       // nothing drawn — leave it be
  const pad = 8;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  const ctx = out.getContext("2d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/* A figure to take away - a chart or a map - drawn once for both downloads,
 * so the PNG and the PDF are the same picture in two formats, and drawn the
 * same way on every page. A fixed 1200px layout at four times the pixel
 * density, 4800px across, holds up full-width on a slide. Above the figure:
 * a small label, an optional stem, the title. Below it: the page's own
 * caption lines and a source line, so it still says what it shows once it
 * has left the page. On the page's own background, so a dark theme exports
 * legibly.
 *
 * `body` is { height, draw(ctx, x, y, width) }, drawn into a context already
 * scaled to the figure's density. */
const FIGURE = { S: 4, W: 1200, pad: 48 };
// Every download names its source in the same first sentence; each page adds
// one sentence on method.
const FIGURE_SOURCE = "Source: S3OK Public Survey, University of Oklahoma " +
  "Institute for Public Policy Research and Analysis.";
function figureImage({ label, stem, title, body, lines = [], source }) {
  const { S, W, pad } = FIGURE, inner = W - pad * 2;
  const css = getComputedStyle(document.body);
  const tok = (n, d) => css.getPropertyValue(n).trim() || d;
  const bg = tok("--panel", "#ffffff"), ink = tok("--text", "#1f1d2b");
  const muted = tok("--text-muted", "#5f5a73"), accent = tok("--accent", "#443a83");
  const family = css.fontFamily, mono = tok("--mono", "monospace");

  const measure = document.createElement("canvas").getContext("2d");
  const wrapText = (text, font) => {
    measure.font = font;
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const out = []; let line = "";
    for (const w of words) {
      const t = line ? line + " " + w : w;
      if (line && measure.measureText(t).width > inner) { out.push(line); line = w; }
      else line = t;
    }
    if (line) out.push(line);
    return out;
  };
  const block = (text, size, weight, color, lead, gap, face = family) => {
    if (!text) return null;
    const font = `${weight} ${size}px ${face}`;
    return { lines: wrapText(text, font), font, color, lead, gap };
  };
  const head = [
    block(label && String(label).toUpperCase(), 13, 600, accent, 18, 12, mono),
    block(stem, 17, 400, muted, 25, 8),
    block(title, 30, 700, ink, 38, 22)
  ].filter(Boolean);
  const foot = [
    ...lines.map((l, i) => block(l.text, 15, l.strong ? 600 : 400,
      l.strong ? ink : muted, 22, i === lines.length - 1 ? 6 : 4)),
    block(source, 13, 400, muted, 19, 0)
  ].filter(Boolean);
  const heightOf = (bs) => bs.reduce((t, b) => t + b.lines.length * b.lead + b.gap, 0);
  const H = pad + heightOf(head) + body.height + 22 + heightOf(foot) + pad;

  const out = document.createElement("canvas");
  out.width = W * S; out.height = Math.ceil(H * S);
  const ctx = out.getContext("2d");
  ctx.scale(S, S);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "alphabetic";
  let y = pad;
  const paint = (bs) => {
    for (const b of bs) {
      ctx.font = b.font; ctx.fillStyle = b.color;
      for (const ln of b.lines) { y += b.lead; ctx.fillText(ln, pad, y - b.lead * 0.25); }
      y += b.gap;
    }
  };
  paint(head);
  ctx.save(); body.draw(ctx, pad, y, inner, { ink, muted, accent, family, mono }); ctx.restore();
  y += body.height + 22;
  paint(foot);
  return { canvas: out, width: W, height: H };
}

// Saves a figure as a PNG, or as a PDF page 11 inches wide cut to the
// figure's height so nothing is letterboxed or cropped.
function saveFigure(img, name, kind) {
  if (!img) return;
  if (kind === "pdf") {
    if (!window.jspdf) { alert("The PDF library did not load - try reloading the page."); return; }
    const w = 792, h = w * img.height / img.width;
    const doc = new window.jspdf.jsPDF({
      orientation: w > h ? "l" : "p", unit: "pt", format: [w, h] });
    doc.addImage(img.canvas, "PNG", 0, 0, w, h, undefined, "FAST");
    doc.save(name);
    return;
  }
  img.canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, "image/png");
}

/* A Leaflet map redrawn as vectors at the figure's density. Leaflet paints
 * its canvas at screen resolution, which pixelates on a slide, so the paths
 * and dots are drawn again from the positions and styles Leaflet has already
 * worked out: the same frame, colors, borders and outline as on screen, sharp
 * at any size. */
function vectorMap(lmap, S, bg) {
  const size = lmap.getSize();
  const cv = document.createElement("canvas");
  cv.width = Math.round(size.x * S); cv.height = Math.round(size.y * S);
  const ctx = cv.getContext("2d");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.scale(S, S);
  ctx.lineJoin = "round";
  const layers = [];
  lmap.eachLayer(l => {
    if (l instanceof L.Polyline || l instanceof L.CircleMarker) layers.push(l);
  });
  // A pane above another is painted after it, whatever order they were
  // added in; within a pane, in the order added.
  const paneZ = (l) => Number((lmap.getPane(l.options.pane) || {}).style?.zIndex) || 400;
  layers.sort((a, b) => paneZ(a) - paneZ(b) || L.stamp(a) - L.stamp(b));
  for (const l of layers) {
    const o = l.options, isPoly = l instanceof L.Polygon;
    if (l instanceof L.CircleMarker) {
      const c = lmap.latLngToContainerPoint(l.getLatLng());
      ctx.beginPath(); ctx.arc(c.x, c.y, o.radius, 0, Math.PI * 2);
      ctx.globalAlpha = o.fillOpacity == null ? 0.2 : o.fillOpacity;
      ctx.fillStyle = o.fillColor || o.color; ctx.fill();
      if (o.stroke !== false && o.weight > 0) {
        ctx.globalAlpha = o.opacity == null ? 1 : o.opacity;
        ctx.strokeStyle = o.color; ctx.lineWidth = o.weight; ctx.stroke();
      }
      ctx.globalAlpha = 1;
      continue;
    }
    ctx.beginPath();
    const walk = (a) => {
      if (!a.length) return;
      if (a[0].lat !== undefined) {
        a.forEach((p, i) => {
          const q = lmap.latLngToContainerPoint(p);
          if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
        });
        if (isPoly) ctx.closePath();
      } else a.forEach(walk);
    };
    walk(l.getLatLngs());
    if (isPoly && o.fill !== false) {
      ctx.globalAlpha = o.fillOpacity == null ? 0.2 : o.fillOpacity;
      ctx.fillStyle = o.fillColor || o.color;
      ctx.fill("evenodd");
    }
    if (o.stroke !== false && o.weight > 0) {
      ctx.globalAlpha = o.opacity == null ? 1 : o.opacity;
      ctx.strokeStyle = o.color; ctx.lineWidth = o.weight;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  return trimCanvas(cv, bg);
}

function pdfButton(label, onClick) {
  return el("button", { class: "wx-pdf-btn", onclick: onClick }, label);
}

// Error bars for Chart.js (CIs) — reads dataset.errorLow / dataset.errorHigh
// arrays parallel to data. Draws along the value axis with a cap at each end:
// vertical normally, horizontal when the chart uses indexAxis "y" (flipped
// bars), where the caps come out as short vertical ticks.
const ErrorBarsPlugin = {
  id: "wxErrorBars",
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    const flipped = chart.options.indexAxis === "y";
    chart.data.datasets.forEach((ds, di) => {
      if (!ds.errorLow) return;
      const meta = chart.getDatasetMeta(di);
      if (meta.hidden) return;
      ctx.save();
      ctx.strokeStyle = ds.borderColor || "#000";
      ctx.lineWidth = 2;
      meta.data.forEach((pt, i) => {
        const lo = ds.errorLow[i], hi = ds.errorHigh[i];
        if (lo == null || hi == null) return;
        const scale = flipped ? chart.scales.x : chart.scales.y;
        const p1 = scale.getPixelForValue(lo);
        const p2 = scale.getPixelForValue(hi);
        // Capped at both ends, across the bar rather than along it: on the
        // horizontal explorer bars a bare line reads as part of the bar, and
        // the caps are what make the interval's ends findable. Sized off the
        // bar so they stay proportional as the canvas grows with the group
        // count, and clamped so thin bars still get a visible tick.
        const half = Math.max(3, Math.min(7,
          (flipped ? pt.height : pt.width) * 0.35)) / 2;
        ctx.beginPath();
        if (flipped) {
          ctx.moveTo(p1, pt.y); ctx.lineTo(p2, pt.y);
          ctx.moveTo(p1, pt.y - half); ctx.lineTo(p1, pt.y + half);
          ctx.moveTo(p2, pt.y - half); ctx.lineTo(p2, pt.y + half);
        } else {
          ctx.moveTo(pt.x, p1); ctx.lineTo(pt.x, p2);
          ctx.moveTo(pt.x - half, p1); ctx.lineTo(pt.x + half, p1);
          ctx.moveTo(pt.x - half, p2); ctx.lineTo(pt.x + half, p2);
        }
        ctx.stroke();
      });
      ctx.restore();
    });
  }
};

// URL state helpers — page id stays in the hash, per-page state lives in the
// query string (merged, so dev's ?bundle= survives).
function getParam(k) { return new URLSearchParams(location.search).get(k); }
// `push` makes the change a step in the browser's history, for a reader's own
// choices (a question, a comparison, a version, a measure, an area), so Back
// undoes it; housekeeping replaces the entry it is tidying.
function setParams(obj, push = false) {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === "") q.delete(k); else q.set(k, v);
  }
  const url = location.pathname + "?" + q.toString() + location.hash;
  if (url === location.pathname + location.search + location.hash) return;
  history[push ? "pushState" : "replaceState"](null, "", url);
}

// A link to another page carrying exactly the state it names. The reader's
// theme and color scheme come along; anything else in the address (a version,
// an area, a split left from an earlier page) is left behind. The full
// address is the href, so the link works opened in a new tab or copied as
// well as clicked; a plain click moves in place without reloading.
const CARRIED_PARAMS = ["theme", "scheme", "flag"];
function pageLink(hash, params, attrs, label) {
  const query = () => {
    const now = new URLSearchParams(location.search);
    const q = new URLSearchParams();
    for (const k of CARRIED_PARAMS) if (now.get(k)) q.set(k, now.get(k));
    for (const [k, v] of Object.entries(params || {}))
      if (v != null && v !== "") q.set(k, v);
    return q.toString();
  };
  const a = el("a", Object.assign({}, attrs, { href: "?" + query() + hash }), label);
  a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;
    e.preventDefault();
    history.replaceState(null, "", location.pathname + "?" + query() + location.hash);
    location.hash = hash;
  });
  // Kept current for a copy made after the theme or scheme changes.
  a.addEventListener("mouseenter", () => { a.href = "?" + query() + hash; });
  a.addEventListener("focus", () => { a.href = "?" + query() + hash; });
  return a;
}

/* ------------------------------------------------------ shared widgets -- */

function groupingSelect(onChange, initial, labelText = "Select a grouping") {
  const wrap = el("div");
  wrap.append(el("label", { class: "field-label", for: "grouping-sel" }, labelText));
  const sel = el("select", { class: "grouping", id: "grouping-sel", onchange: () => onChange(sel.value) });
  for (const g of CONFIG.groupings) {
    sel.append(el("option", { value: g.id }, g.label));
  }
  sel.value = initial || CONFIG.groupings[0].id;
  wrap.append(sel);
  return wrap;
}

/* Grouped bar chart from long rows [{group, category, value, label}].
   Category axis order + series (group) order = first-appearance order in the
   data (which preserves R's factor-level ordering from the compiler), unless
   an explicit categoryOrder is supplied by config. */
let activeChart = null;
function groupedBarChart(canvas, rows, { title = "", xLabel = "", yLabel = "", categoryOrder = null, showCI = false, horizontal = false, colors = null, legend = true, legendTitle = "Group", standalone = false, pixelRatio = null, labelSize = null, altTitle = "", ciDigits = 1 }) {
  const groupsSeen = [], catsSeen = [];
  for (const r of rows) {
    const g = naLabel(r.group), c = naLabel(r.category);
    if (!groupsSeen.includes(g)) groupsSeen.push(g);
    if (!catsSeen.includes(c)) catsSeen.push(c);
  }
  let cats = catsSeen;
  if (categoryOrder) {
    const order = categoryOrder.map(naLabel);
    cats = order.filter(c => catsSeen.includes(c))
      .concat(catsSeen.filter(c => !order.includes(c))); // unknowns (e.g. NA) go last
  }
  const lookup = new Map(rows.map(r => [naLabel(r.group) + "\x1F" + naLabel(r.category), r]));
  colors = colors || viridis(groupsSeen.length);
  const datasets = groupsSeen.map((g, i) => ({
    label: g,
    backgroundColor: colors[i],
    data: cats.map(c => {
      const r = lookup.get(g + "\x1F" + c);
      return r ? r.value : null;
    }),
    barLabels: cats.map(c => {
      const r = lookup.get(g + "\x1F" + c);
      return r ? String(r.label ?? "") : "";
    }),
    // CI whiskers (opt-in): stroked by ErrorBarsPlugin in the theme's ink —
    // a same-color whisker would vanish where it overlaps its own bar.
    ...(showCI ? {
      borderColor: getComputedStyle(document.body).getPropertyValue("--text").trim() || "#000",
      errorLow: cats.map(c => { const r = lookup.get(g + "\x1F" + c); return r && r.low != null ? r.low : null; }),
      errorHigh: cats.map(c => { const r = lookup.get(g + "\x1F" + c); return r && r.upp != null ? r.upp : null; })
    } : {})
  }));

  // A standalone chart is drawn for export: fixed size, no animation, at the
  // pixel ratio asked for, and it leaves the chart on screen alone.
  if (!standalone && activeChart) { activeChart.destroy(); activeChart = null; }
  const chart = new Chart(canvas, {
    type: "bar",
    data: { labels: cats.map(tickLines), datasets },
    options: {
      responsive: !standalone,
      maintainAspectRatio: false,
      ...(standalone ? { animation: false, devicePixelRatio: pixelRatio || 1 } : {}),
      // horizontal: categories run down the y-axis
      indexAxis: horizontal ? "y" : "x",
      interaction: { mode: "nearest", intersect: false, axis: horizontal ? "y" : "x" },
      layout: { padding: horizontal ? { right: 48 } : { top: 24 } },
      plugins: {
        title: title ? { display: true, text: title, align: "start",
          font: { size: 15, weight: "600" }, padding: { bottom: 16 } } : { display: false },
        // legend:false for single-group charts — a one-entry
        // "Group: All" legend is noise.
        legend: legend ? { position: "bottom",
                           title: { display: !!legendTitle, text: legendTitle } }
          : { display: false },
        datalabels: showCI ? { display: false } : {
          anchor: "end", align: "end", offset: 0, clip: false,
          color: getComputedStyle(document.body).getPropertyValue("--text").trim() || "#000",
          font: { size: labelSize
            ? (groupsSeen.length > 8 ? labelSize - 3 : labelSize)
            : (groupsSeen.length > 8 ? 9 : 11) },
          formatter: (v, ctx) => ctx.dataset.barLabels[ctx.dataIndex]
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const base = `${ctx.dataset.label}: ${ctx.dataset.barLabels[ctx.dataIndex]}`;
              const lo = ctx.dataset.errorLow && ctx.dataset.errorLow[ctx.dataIndex];
              const hi = ctx.dataset.errorHigh && ctx.dataset.errorHigh[ctx.dataIndex];
              return lo != null && hi != null
                ? `${base} (95% CI ${lo.toFixed(ciDigits)}–${hi.toFixed(ciDigits)})` : base;
            }
          }
        }
      },
      scales: horizontal ? {   // xLabel/yLabel keep their meaning: category / value
        // Every category keeps its label: Chart.js drops alternate ones when
        // they crowd, which leaves a bar with nothing to say what it is.
        y: { title: { display: !!xLabel, text: xLabel }, grid: { display: false },
             ticks: { autoSkip: false } },
        x: { title: { display: !!yLabel, text: yLabel }, beginAtZero: true, grace: "15%" }
      } : {
        x: { title: { display: !!xLabel, text: xLabel }, grid: { display: false },
             ticks: { autoSkip: false } },
        y: { title: { display: !!yLabel, text: yLabel }, beginAtZero: true, grace: "15%" }
      }
    },
    plugins: [ChartDataLabels, ErrorBarsPlugin]   // ErrorBarsPlugin no-ops without errorLow
  });
  if (!standalone) {
    activeChart = chart;
    // altTitle names what the chart answers (the question) for the spoken
    // label, where the drawn chart has no title of its own.
    chartAlt(canvas, { cats, groups: groupsSeen, lookup, valueLabel: yLabel,
      title: altTitle || title, ci: showCI, ciDigits });
  }
  return chart;
}

/* Question wording with its survey placeholders made readable. The
   instruments pipe text into questions ("[rand_evnt_snow]", "[lead_time: 15 |
   30 | 60]", "rand_timeline"); a reader should see what was shown, not a
   variable name. A split-sample question's own variable becomes the version
   selected, in bold; a placeholder carrying its values becomes that list
   ("[15, 30, or 60]", "[5 to 100]"); a known one takes its words from the
   config; anything else reads "[varied between respondents]". Returns DOM
   nodes, the plain text, and the variable names that varied (for the note). */
function readableWording(text, id, armLabel = null, armId = null) {
  const words = CONFIG.placeholders || {};
  const armVar = (CONFIG.arm_variables || {})[id];
  const nodes = [], varied = [];
  let plain = "", last = 0, m;
  const re = /\[([a-z][a-z0-9_]*)(?::\s*([^\]]*))?\]|\b(rand_[a-z0-9_]+)\b/g;
  const push = (t) => { if (t) { nodes.push(t); plain += t; } };
  const listOf = (spec) => {
    // A value that depends on another placeholder ("2 and 6 if
    // amount_format_rand1 = 4, or 10 and 14 if ...") keeps its alternatives
    // and drops the conditions, which only name variables.
    if (/\sif\s/.test(spec)) {
      return spec.replace(/\s+if\s+[a-z][a-z0-9_]*\s*=\s*[^,\]]+/g, "").trim();
    }
    const range = spec.match(/^\s*(\d+)\s*:\s*(\d+)\s*$/);
    if (range) return `${range[1]} to ${range[2]}`;
    const items = spec.split(spec.includes("|") ? "|" : ",").map(x => x.trim()).filter(Boolean);
    return items.length > 1
      ? items.slice(0, -1).join(", ") + (items.length > 2 ? "," : "") + " or " + items[items.length - 1]
      : items.join("");
  };
  // With no version chosen, the slot names the versions: a run of numbers or
  // times as its two ends ("1:00 AM to 9:00 AM"), a few short words as a list,
  // and anything longer as a count, since a list of sentences is not wording.
  const versionsOf = (v) => {
    const all = ((CONFIG.arm_versions || {})[v] || []).map(String);
    const xs = all.filter(Boolean);
    if (xs.length < 2) return null;
    if (xs.some(x => x.length > 40) || xs.length < all.length)
      return `one of ${all.length} versions`;
    if (xs.length > 4 && xs.every(x => /^\d/.test(x)))
      return `${xs[0]} to ${xs[xs.length - 1]}`;
    return xs.slice(0, -1).join(", ") + (xs.length > 2 ? "," : "") +
      " or " + xs[xs.length - 1];
  };
  const pickFor = (spec) => {
    if (!/\sif\s/.test(spec)) return null;
    const alts = [...spec.matchAll(
      /(?:^|,)\s*(?:or\s+)?(.+?)\s+if\s+([a-z][a-z0-9_]*)\s*=\s*([^,]+)/g)];
    const hit = alts.find(a => a[2] === armVar && a[3].trim() === String(armId));
    return hit ? hit[1].trim() : null;
  };
  text = String(text || "");
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    const name = m[1] || m[3];
    if (armVar && name === armVar && armLabel == null && versionsOf(armVar)) {
      push("[" + versionsOf(armVar) + "]");
    } else if (armVar && name === armVar && armLabel != null) {
      if (armLabel) { nodes.push(el("strong", {}, armLabel)); plain += armLabel; }
    } else if (m[2] && armVar && armId != null && pickFor(m[2]) != null) {
      // A value keyed to the version shown ("10 and 14 if
      // amount_format_rand1 = 12") is the one that version read.
      const pick = pickFor(m[2]);
      nodes.push(el("strong", {}, pick)); plain += pick;
    } else {
      if (name !== armVar && !varied.includes(name)) varied.push(name);
      push("[" + (m[2] ? listOf(m[2]) : (words[name] || words[".default"] || "varied")) + "]");
    }
    last = re.lastIndex;
  }
  push(text.slice(last));
  return { nodes, text: plain, varied };
}

/* A question file with its response labels put into words, since options
   carry placeholders as often as the wording does ("[amount_format_rand1: 4
   or 12] inches"). Every chart reads its labels from here. */
async function fetchQuestion(id) {
  const v = await fetchJSON(`data/q/${id}.json`);
  if (v && v.options) {
    const varied = new Set();
    v.options = v.options.map(o => {
      const w = readableWording(String(o.label ?? ""), v.id);
      w.varied.forEach(n => varied.add(n));
      return { ...o, raw: o.label, label: w.text };
    });
    // Named in the note like the wording's own placeholders.
    v.options_varied = [...varied];
  }
  return v;
}

/* A chart drawn on a canvas says nothing to a screen reader, so every bar
   chart on the page carries a text alternative: a short spoken label on the
   canvas and, beside it, a table of the same numbers that is hidden on
   screen. Nothing is computed here - the table repeats the bars' own labels.
   Redrawing the chart replaces its table. */
function chartAlt(canvas, { cats, groups, lookup, valueLabel, title, ci = false, ciDigits = 1 }) {
  const clean = (t) => String(t).replace(/\n/g, " ");
  const multi = groups.length > 1;
  canvas.setAttribute("role", "img");
  // In sentences, so a title ending in its own punctuation reads cleanly.
  const sentence = (t) => { t = clean(t).trim(); return /[.?!]$/.test(t) ? t : t + "."; };
  canvas.setAttribute("aria-label", ["Bar chart.",
    title ? sentence(title) : "",
    valueLabel ? sentence("Values: " + valueLabel) : "",
    `${cats.length} categories${multi ? `, ${groups.length} groups` : ""}.`,
    "The values are in the table that follows."].filter(Boolean).join(" "));
  if (canvas._altTable) canvas._altTable.remove();
  const cell = (g, c) => {
    const r = lookup.get(g + "\x1F" + c);
    let v = r ? (r.label != null ? String(r.label) : String(r.value)) : "\u2014";
    // The interval the chart draws, when it draws one.
    if (ci && r && r.low != null && r.upp != null)
      v += ` (95% CI ${Number(r.low).toFixed(ciDigits)}\u2013${Number(r.upp).toFixed(ciDigits)})`;
    return v;
  };
  const table = el("table", {},
    el("caption", {}, clean(title || valueLabel || "Chart values")),
    el("thead", {}, el("tr", {},
      el("th", { scope: "col" }, "Category"),
      ...(multi ? groups.map(g => el("th", { scope: "col" }, clean(g)))
                : [el("th", { scope: "col" }, clean(valueLabel || "Value"))]))),
    el("tbody", {}, ...cats.map(c => el("tr", {},
      el("th", { scope: "row" }, clean(c)),
      ...groups.map(g => el("td", {}, cell(g, c)))))));
  // Hidden by its wrapper rather than by its own class: a table will not
  // shrink to the one-pixel box that hides it, and on a phone its full width
  // would widen the page.
  const hidden = el("div", { class: "wx-sr-only" }, table);
  canvas.insertAdjacentElement("afterend", hidden);
  canvas._altTable = hidden;
}

/* Change over time: a line chart from long rows [{series, wave, value, label,
   low, upp}], one line per series (a group, or an answer option) across the
   waves. The same options as groupedBarChart where they apply, so the two
   views read alike: the value axis's title, a legend keyed by what the lines
   split on, intervals on request, and a standalone mode for the download.
   `yTicks` labels the value axis with the answer options where the value is
   an average position among them. */
function trendChart(canvas, rows, { yLabel = "", yTicks = null, yMax = null,
    showCI = false, colors = null, legend = true, legendTitle = "Group",
    standalone = false, pixelRatio = null, labelSize = null, altTitle = "",
    ciDigits = 1, waveNames = {} }) {
  const seriesSeen = [], wavesSeen = [];
  for (const r of rows) {
    if (!seriesSeen.includes(r.series)) seriesSeen.push(r.series);
    if (!wavesSeen.includes(r.wave)) wavesSeen.push(r.wave);
  }
  wavesSeen.sort((a, b) => a - b);
  const lookup = new Map(rows.map(r => [r.series + "\x1F" + r.wave, r]));
  colors = colors || viridis(seriesSeen.length);
  const ink = getComputedStyle(document.body).getPropertyValue("--text").trim() || "#000";
  const cell = (name, w) => lookup.get(name + "\x1F" + w);
  const datasets = seriesSeen.map((name, i) => ({
    label: name,
    borderColor: colors[i], backgroundColor: colors[i],
    pointRadius: 4, pointHoverRadius: 6, borderWidth: 2.5, tension: 0,
    spanGaps: false,
    data: wavesSeen.map(w => { const r = cell(name, w); return r ? r.value : null; }),
    barLabels: wavesSeen.map(w => { const r = cell(name, w); return r ? String(r.label ?? "") : ""; }),
    ...(showCI ? {
      errorLow: wavesSeen.map(w => { const r = cell(name, w); return r && r.low != null ? r.low : null; }),
      errorHigh: wavesSeen.map(w => { const r = cell(name, w); return r && r.upp != null ? r.upp : null; })
    } : {})
  }));
  if (!standalone && activeChart) { activeChart.destroy(); activeChart = null; }
  // The wave's dates under its number.
  const tick = (w) => waveNames[w] ? ["Wave " + w, waveNames[w]] : "Wave " + w;
  const chart = new Chart(canvas, {
    type: "line",
    data: { labels: wavesSeen.map(tick), datasets },
    options: {
      responsive: !standalone,
      maintainAspectRatio: false,
      ...(standalone ? { animation: false, devicePixelRatio: pixelRatio || 1 } : {}),
      interaction: { mode: "nearest", intersect: false, axis: "x" },
      layout: { padding: { top: 20, right: 24 } },
      plugins: {
        title: { display: false },
        legend: legend ? { position: "bottom",
                           title: { display: !!legendTitle, text: legendTitle } }
          : { display: false },
        // Values on the points only for a single line: several lines' labels
        // crowd one another. The intervals take their place when drawn.
        datalabels: showCI || seriesSeen.length > 1 ? { display: false } : {
          align: "top", offset: 6, clip: false, color: ink,
          font: { size: labelSize || 11 },
          formatter: (v, ctx) => ctx.dataset.barLabels[ctx.dataIndex]
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const base = `${ctx.dataset.label}: ${ctx.dataset.barLabels[ctx.dataIndex]}`;
              const lo = ctx.dataset.errorLow && ctx.dataset.errorLow[ctx.dataIndex];
              const hi = ctx.dataset.errorHigh && ctx.dataset.errorHigh[ctx.dataIndex];
              return lo != null && hi != null
                ? `${base} (95% CI ${lo.toFixed(ciDigits)}\u2013${hi.toFixed(ciDigits)})` : base;
            }
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { autoSkip: false } },
        y: yTicks
          // An average position among the answers: the axis runs over the
          // answers themselves, the first at the bottom.
          ? { min: 1, max: yTicks.length, title: { display: !!yLabel, text: yLabel },
              ticks: { stepSize: 1, callback: (v) => yTicks[Math.round(v) - 1] || "" } }
          : { beginAtZero: true, ...(yMax != null ? { max: yMax } : { grace: "10%" }),
              title: { display: !!yLabel, text: yLabel } }
      }
    },
    plugins: [ChartDataLabels, ErrorBarsPlugin]
  });
  if (!standalone) {
    activeChart = chart;
    chartAlt(canvas, { cats: wavesSeen.map(w => "Wave " + w), groups: seriesSeen,
      lookup: new Map(rows.map(r => [r.series + "\x1FWave " + r.wave, {
        label: r.label, value: r.value, low: r.low, upp: r.upp }])),
      valueLabel: yLabel, title: altTitle, ci: showCI, ciDigits });
  }
  return chart;
}

/* ------------------------------------------------------------ components -- */

const components = {};

/* Explore: a search over every question, the selected question as a
 * heading, the split control (color and intervals under "Chart options"),
 * the full-width chart card with its caption and downloads, and the question
 * browser below.
 *
 * Bars carry the instrument's own response labels, from the question file's
 * `options`, and its `summaries` (per-split respondent counts) fill the
 * `explore_caption` templates in config, so the caption rewrites itself
 * for the selected split ("… the percentage of each age group selecting each
 * response. The smallest group, X, includes N respondents."). */

/* A caption's facts, shared by every chart on the site. The survey is a
   panel, so a count over several waves is of responses, and says how many
   people they came from; a count from one wave is of people. */
const dashed = (t) => String(t || "").replace(/-/g, "\u2013");
function wavesText(s) {
  return (s.n_waves > 1 ? "Waves " : "Wave ") + dashed(s.waves);
}
function captionMeta(s) {
  const tpl = CONFIG.explore_caption;
  return fillTpl(s.n_waves > 1 ? tpl.meta_pooled : tpl.meta, {
    n: Number(s.n).toLocaleString(), people: Number(s.people).toLocaleString(),
    waves: wavesText(s), years: dashed(s.years) });
}
// The smallest group charted, and any group too small to chart.
function captionGroups(s, g) {
  const tpl = CONFIG.explore_caption;
  let out = "";
  if (g !== "All") out += fillTpl(tpl.smallest, {
    smallest: s.smallest, smallest_n: Number(s.smallest_n).toLocaleString() });
  if ((s.not_shown || []).length) out += fillTpl(tpl.not_shown, {
    min: CONFIG.min_group_n,
    groups: s.not_shown.map(x => `${x.group} (${x.n})`).join(", ") });
  return out;
}

// SVG/Chart.js tick labels don't wrap on their own; response labels are
// sentences ("I would trust forecasts generated by machine learning…"), so
// they are broken into tick lines at word boundaries instead of trimmed.
function wrapTickLabel(text, width = 26, maxLines = 3) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length > width) { lines.push(line); line = w; }
    else line = line ? line + " " + w : w;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  else if (line) lines[maxLines - 1] += "…";
  return lines.join("\n");
}

/* Tick labels for a question's options. The chart keys bars by label, so
   two options that read the same once cut (formats that differ only in a
   last sentence) would share one bar and the other response would vanish;
   those are wrapped in full instead of cut. */
function tickLabeller(labels) {
  const cut = labels.map(l => wrapTickLabel(l));
  const clash = new Set(cut.filter((c, i) => cut.indexOf(c) !== i));
  const map = new Map(labels.map((l, i) =>
    [l, clash.has(cut[i]) ? wrapTickLabel(l, 26, Infinity) : cut[i]]));
  return (l) => map.get(l) ?? wrapTickLabel(l);
}

components.explore = async function (page, container) {
  const questions = await fetchJSON(page.questions.replace(/^data\//, "data/"));
  let grouping = urlGrouping() || page.default_grouping || "All";
  let showCI = getParam("ci") === "1";   // ?ci=1 deep-links the CI view
  // ?view=trend deep-links the view of change over time, which only
  // questions asked in more than one wave offer.
  let view = getParam("view") === "trend" ? "trend" : "bars";
  const trendQuestions = new Set(CONFIG.trend_questions || []);
  let currentArm = getParam("arm");      // ?arm= deep-links a split-sample version
  let scheme = urlScheme();              // ?scheme= deep-links a color scheme
  let currentQuestionText = "";          // for the flag list
  // Question files are keyed by `id`, which is the survey variable.
  const keyOf = (r) => r.id;
  // ?q=<id> deep-links a question; else row 1.
  const urlQ = getParam("q");
  let currentKey = (urlQ && questions.some(x => keyOf(x) === urlQ))
    ? urlQ : (questions[0] && keyOf(questions[0]));

  // The selected question leads the section and is set on the page rather
  // than in a card: the survey as a small label, then the stem it shares
  // with the rest of its battery, quiet, and the item large beneath it.
  const resultHead = el("div", { class: "wx-result-head" });
  const qSurvey = el("p", { class: "wx-result-survey" }, "");
  const chartCard = el("div", { class: "card wx-result-chart" });
  const wrap = el("div", { class: "chart-wrap" });
  const canvas = el("canvas");
  wrap.append(canvas);

  // Chrome created up front so draw() can update it.
  // The stem a battery of items shares, above the item itself. Quieter,
  // because it is the same sentence on every item in the battery and the item
  // is what changes.
  const qIntro = el("p", { class: "wx-question-intro wx-result-stem" }, "");
  // Text a version showed ahead of the question, for experiments where the
  // question itself reads the same in every version.
  const qShown = el("div", { class: "wx-arm-shown" });
  const qHead = el("h2", { class: "wx-question-head wx-result-item" }, "");
  // The version menu, inside the chart card rather than the toolbar above it:
  // it belongs to this question, not to the page, and it disappears with the
  // question. Only split-sample items have one.
  const armBox = el("div", { class: "wx-arm-pick" });
  const flagBtn = flaggingOn()
    ? el("button", { class: "wx-flag-btn", type: "button" }, "\u2691 Flag")
    : null;
  const flagPanel = flaggingOn() ? el("div", { class: "card wx-flag-panel" }) : null;
  const saveBtn = el("button", { class: "wx-save-btn", type: "button" }, "\u2606 Save question");
  const savedPanel = el("section", { class: "card wx-saved" });
  let currentSave = null;   // the question on screen, as a saved entry
  let shownStem = "", shownItem = "", shownQuestion = "";

  function syncSaveBtn() {
    const on = readSaved().some(x => x.id === currentKey);
    saveBtn.textContent = on ? "\u2605 Saved" : "\u2606 Save question";
    saveBtn.classList.toggle("is-on", on);
    saveBtn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  saveBtn.onclick = () => {
    if (!currentSave) return;
    const list = readSaved();
    const at = list.findIndex(x => x.id === currentSave.id);
    if (at >= 0) list.splice(at, 1); else list.push(currentSave);
    writeSaved(list);
    syncSaveBtn();
    renderSaved();
  };

  // A quiet way down to the list from the search, shown once something is
  // saved, so a reader with a list does not have to scroll the browser to
  // find it.
  const savedJump = el("a", { class: "wx-saved-jump", href: "#",
    onclick: (e) => {
      e.preventDefault();
      savedPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    } });

  function renderSaved() {
    const list = readSaved();
    savedJump.textContent = `Saved questions (${list.length}) \u2193`;
    savedJump.style.display = list.length ? "" : "none";
    savedPanel.textContent = "";
    savedPanel.style.display = list.length ? "" : "none";
    if (!list.length) return;
    savedPanel.append(
      el("h2", { class: "wx-saved-title" }, `Saved questions (${list.length})`),
      el("p", { class: "wx-saved-lede" },
        "Saved in this browser only. Download the list to keep it."));
    const ul = el("ul", { class: "wx-saved-list" });
    for (const x of list) {
      // A question taken off the list since it was saved still shows, so the
      // reader knows what they had, but it no longer opens.
      const listed = questions.some(r => keyOf(r) === x.id);
      const text = [
        el("span", { class: "wx-saved-meta" },
          [x.waves, dashed(x.years)].filter(Boolean).join(" \u00b7 ")),
        el("span", { class: "wx-saved-q" }, x.question)];
      const open = listed
        ? el("button", { class: "wx-saved-open", type: "button", onclick: () => {
            currentKey = x.id;
            currentArm = null;
            setParams({ q: currentKey, arm: null }, true);
            qTable.selectRow(r => keyOf(r) === currentKey);
            resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
            draw();
          } }, ...text)
        : el("div", { class: "wx-saved-open is-gone" }, ...text);
      const drop = el("button", { class: "wx-saved-drop", type: "button",
        "aria-label": "Remove from saved questions", title: "Remove",
        onclick: () => {
          writeSaved(readSaved().filter(y => y.id !== x.id));
          syncSaveBtn();
          renderSaved();
        } }, "\u00d7");
      ul.append(el("li", { class: "wx-saved-row" }, open, drop));
    }
    savedPanel.append(ul, el("div", { class: "wx-saved-actions" },
      pdfButton("Download list (CSV)", () => {
        const url = URL.createObjectURL(
          new Blob([savedToCSV(readSaved())], { type: "text/csv" }));
        const a = el("a", { href: url, download: "s3ok_saved_questions.csv" });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      })));
  }

  function renderFlagPanel() {
    if (!flagPanel) return;
    const flags = readFlags();
    const ids = Object.keys(flags).sort();
    flagPanel.textContent = "";
    flagPanel.append(el("h3", {}, `Flagged questions (${ids.length})`));
    if (ids.length === 0) {
      flagPanel.append(el("p", { class: "wx-flag-empty" },
        "Nothing flagged yet. Open a question and use the flag beside its heading."));
      return;
    }
    for (const id of ids) {
      const f = flags[id];
      const row = el("div", { class: "wx-flag-row" });
      row.append(
        el("button", { class: "wx-flag-drop", type: "button", onclick: () => {
          const all = readFlags(); delete all[id]; writeFlags(all);
          renderFlagPanel();
          syncFlagBtn();
          if (qTable && qTable.rerender) qTable.rerender();
        } }, "\u00d7"),
        el("code", { class: "wx-flag-id" }, id),
        el("span", { class: "wx-flag-question" }, f.question || ""));
      flagPanel.append(row);
    }
    const csv = () => flagsToCSV(readFlags());
    flagPanel.append(el("div", { class: "wx-flag-actions" },
      pdfButton("Download hidden_questions.csv", () => {
        const url = URL.createObjectURL(new Blob([csv()], { type: "text/csv" }));
        const a = el("a", { href: url, download: "hidden_questions.csv" });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }),
      pdfButton("Copy to clipboard", () => {
        navigator.clipboard && navigator.clipboard.writeText(csv());
      })));
  }

  // One toggle behind both affordances, so the flag beside the heading and the
  // one in the table row cannot disagree about what is flagged.
  function toggleFlag(id, question) {
    const all = readFlags();
    if (all[id]) delete all[id];
    else all[id] = { disposition: "hide", note: "", question: question || "" };
    writeFlags(all);
    renderFlagPanel();
    syncFlagBtn();
  }

  function flagCell(r) {
    const on = Object.prototype.hasOwnProperty.call(readFlags(), r.id);
    const b = el("button", {
      class: "wx-flag-cell" + (on ? " is-on" : ""), type: "button",
      title: on ? "Flagged" : "Flag this question",
      // The row itself loads the question; flagging is not that, so the click
      // stops here rather than opening what you were only triaging.
      onclick: (e) => {
        e.stopPropagation();
        toggleFlag(r.id, r.question_text || r.question);
        b.classList.toggle("is-on");
        b.textContent = b.classList.contains("is-on") ? "\u2691" : "\u2690";
      }
    }, on ? "\u2691" : "\u2690");
    return b;
  }

  function syncFlagBtn() {
    if (!flagBtn) return;
    const on = Object.prototype.hasOwnProperty.call(readFlags(), currentKey);
    flagBtn.textContent = on ? "\u2691 Flagged" : "\u2691 Flag";
    flagBtn.classList.toggle("is-on", on);
  }

  if (flagBtn) {
    flagBtn.onclick = () => {
      toggleFlag(currentKey, currentQuestionText);
      if (qTable && qTable.rerender) qTable.rerender();
    };
  }
  const caption = el("div", { class: "wx-caption wx-explore-caption" });
  const ciBox = el("input", { type: "checkbox", id: "ci-toggle" });
  ciBox.checked = showCI;
  ciBox.onchange = () => { showCI = ciBox.checked; setParams({ ci: showCI ? "1" : null }); draw(); };
  const headRow = el("div", { class: "wx-question-headrow" }, qHead);
  if (flagBtn) headRow.append(flagBtn);
  resultHead.append(qSurvey, qShown, qIntro, headRow, armBox);
  chartCard.append(wrap, caption);

  function renderArmPicker(v, armKey) {
    armBox.textContent = "";
    const arms = v.arms;
    armBox.style.display = arms ? "" : "none";
    if (!arms) return;
    const sel = el("select", { class: "wx-arm-select", onchange: () => {
      currentArm = sel.value;
      setParams({ arm: currentArm }, true);   // keep the URL shareable
      draw();
    } });
    for (const a of arms) sel.append(el("option", { value: a.id }, a.label));
    sel.value = armKey;
    armBox.append(
      el("span", { class: "wx-arm-label" },
         (v.arm_prompt || "Version") + ":"),
      sel,
      infoTip("Respondents did not all read the same thing. Each version is " +
              "estimated on its own — pooling them would average across the " +
              "difference being tested."));
  }
  // The R that rebuilds this exact chart is generated by
  // 02_create_dashboard_data.R, the script that computed the numbers, and
  // downloaded from the foot of the chart. Assigned with the downloads below; declared here so draw() can
  // hide it for a bundle whose question files carry no scripts.
  let lastCodeArgs = null;
  let rcodeBtn = null;
  let lastChart = null;   // what draw() last drew, for the PNG to redraw

  /* The chart as a figure (figureImage): redrawn off screen at the figure's
   * density with slide-sized type, under the survey, stem and item, over the
   * caption's facts line and bars sentence. */
  function chartImage() {
    if (!lastChart) return null;
    const inner = FIGURE.W - FIGURE.pad * 2;
    // The chart keeps the proportions it has on screen.
    const ratio = wrap.clientHeight / Math.max(1, wrap.clientWidth);
    const chartH = Math.round(Math.max(460, Math.min(1400, inner * ratio * 1.1)));
    const host = el("div", { style:
      `position:fixed;left:-30000px;top:0;width:${inner}px;height:${chartH}px` });
    const cv = el("canvas");
    cv.style.width = inner + "px"; cv.style.height = chartH + "px";
    cv.width = inner; cv.height = chartH;
    host.append(cv); document.body.append(host);
    const saved = Chart.defaults.font.size;
    Chart.defaults.font.size = 15;   // slide-sized type, not screen-sized
    let chart;
    try {
      // The same drawing the page shows, bars or lines.
      chart = (lastChart.trend ? trendChart : groupedBarChart)(cv, lastChart.rows,
        { ...lastChart.opts, standalone: true, pixelRatio: FIGURE.S, labelSize: 14 });
    } finally { Chart.defaults.font.size = saved; }
    const capLine = (cls) => (caption.querySelector(cls) || {}).textContent || "";
    const img = figureImage({
      label: lastChart.survey, stem: lastChart.stem, title: lastChart.item,
      body: { height: chartH,
              draw: (ctx, x, y, w) => ctx.drawImage(cv, x, y, w, chartH) },
      lines: [{ text: capLine(".wx-caption-meta"), strong: true },
              { text: capLine(".wx-caption-bars") }],
      source: FIGURE_SOURCE + " Results are unweighted."
    });
    chart.destroy(); host.remove();
    return img;
  }

  const exportName = (ext) => {
    const g = lastChart && lastChart.g;
    return `s3ok-${currentKey}${lastChart && lastChart.trend ? "-trend" : ""}` +
      `${g && g !== "All" ? "-" + g : ""}.${ext}`;
  };

  /* Change over time, for a question asked in more than one wave: the
   * average answer, the percentage answering yes, or the percentage giving
   * each answer, in each wave, on the balanced sample 02 kept. One line per
   * group under a comparison; a question with unordered answers has a line
   * per answer and takes no comparison. */
  // The scheme's colors, as the bars take them, except on the dark theme: a
  // ramp starts at its darkest color, which fills a bar well enough on a dark
  // card and loses a line, so there the ramp is read from its light end.
  function lineColors(n) {
    if (document.documentElement.dataset.theme !== "dark")
      return schemeSeriesColors(scheme, n);
    return schemeSeriesColors(scheme, Math.max(2, n)).reverse().slice(0, n);
  }

  async function drawTrend(v) {
    const t = await fetchJSON(`data/trend/${v.id}.json`);
    const tpl = CONFIG.explore_caption;
    // The comparison falls back to Everyone where this question does not
    // offer it (unordered answers, or a split with no group large enough),
    // and the menu shows it doing so.
    const g = t.splits[grouping] ? grouping : "All";
    if (groupingSel) groupingSel.value = g;
    const gcfg = CONFIG.groupings.find(x => x.id === g) || {};
    const s = t.summaries[g];
    const byOption = t.kind === "options";
    const fmt = (x) => t.kind === "mean" ? Number(x).toFixed(2) : Math.round(x) + "%";
    const rows = t.splits[g].map(r => ({
      series: byOption ? r.option : r.group, wave: r.wave,
      value: r.value, label: fmt(r.value), low: r.low, upp: r.upp
    }));
    // Series in their own order: the split's groups, or the answers as the
    // instrument lists them.
    const order = byOption ? (v.options || []).map(o => o.label) : (gcfg.levels || ["All"]);
    rows.sort((a, b) => order.indexOf(a.series) - order.indexOf(b.series));
    const nSeries = new Set(rows.map(r => r.series)).size;
    wrap.style.height = "440px";
    const chartOpts = {
      yLabel: t.value_label,
      yTicks: t.kind === "mean" ? (v.options || []).map(o => wrapTickLabel(o.label, 18, 2)) : null,
      yMax: t.kind === "mean" ? null : 100,
      showCI, ciDigits: t.kind === "mean" ? 2 : 1,
      legend: nSeries > 1,
      legendTitle: byOption ? "Answer" : (gcfg.label || "Group"),
      colors: lineColors(nSeries),
      altTitle: shownQuestion, waveNames: CONFIG.wave_names || {}
    };
    trendChart(canvas, rows, chartOpts);
    lastChart = { trend: true, rows, opts: chartOpts, g,
                  survey: qSurvey.textContent, stem: shownStem, item: shownItem };
    lastCodeArgs = [currentKey, g, null];

    let note = tpl["trend_" + t.kind];
    if (g !== "All") {
      note += fillTpl(tpl.trend_split, { group_phrase: gcfg.phrase || "group" }) +
        fillTpl(tpl.trend_smallest, { smallest: s.smallest,
          smallest_n: Number(s.smallest_n).toLocaleString() });
      if ((s.not_shown || []).length) note += fillTpl(tpl.trend_not_shown, {
        min: CONFIG.min_group_n,
        groups: s.not_shown.map(x => `${x.group} (${x.n})`).join(", ") });
    }
    if (showCI) note += t.kind === "mean" ? CONFIG.topic_caption.ci_mean
                                           : CONFIG.topic_caption.ci_share;
    caption.textContent = "";
    caption.append(
      el("p", { class: "wx-caption-meta" }, fillTpl(tpl.trend_meta, {
        n: Number(s.n).toLocaleString(), k: t.waves.length,
        waves: t.asked, years: dashed(t.years) })),
      el("p", { class: "wx-caption-bars" }, note),
      el("p", { class: "wx-caption-provenance", html: tpl.provenance }),
      el("p", { class: "wx-caption-ref", html: fillTpl(tpl.reference, {
        variable: esc(v.variable), randomization: "" }) }));
  }

  /* The scripts live in their own file, fetched the first time a reader asks
   * for one and kept after: one question carries fourteen splits, and code
   * nobody wanted has no business loading with the chart. 02 writes one
   * concrete script per split, so this is a lookup: the engine composes
   * nothing. */
  const rcodeCache = new Map();

  async function rcodeFor(id, g, armKey, trend = false) {
    // The view of change over time has scripts of its own, one per
    // comparison, in a file beside the bars'.
    if (trend) return (await fetchJSON(`data/trend_rcode/${id}.json`))[g] || "";
    let all = rcodeCache.get(id);
    if (!all) {
      all = await fetchJSON(`data/rcode/${id}.json`);
      rcodeCache.set(id, all);
    }
    // Nested under the version for a split-sample question, flat for the rest
    // — the same shape the question file uses.
    return (armKey ? (all[armKey] || {})[g] : all[g]) || "";
  }

  function downloadRCode(text, id, g, armKey, trend = false) {
    // A version id is the survey's own value ("your local area"), which does
    // not belong in a filename as written.
    const safe = (v) => String(v).replace(/[^A-Za-z0-9]+/g, "-")
                                 .replace(/^-|-$/g, "");
    const name = trend ? `s3ok-${id}-trend-${g}.R`
      : armKey ? `s3ok-${id}-${safe(armKey)}-${g}.R`
      : `s3ok-${id}-${g}.R`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = el("a", { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  let groupingSel = null;   // set below; draw() updates it on split fallback

  // The note under the chart (templates in config.explore_caption): a line
  // of facts, what the bars are for the chosen split, where the data come
  // from, then the variable and the data link.
  function renderCaption2(v, g, summaries, varied = []) {
    const tpl = CONFIG.explore_caption;
    const s = summaries && summaries[g];
    caption.textContent = "";
    if (!s) return;
    caption.append(el("p", { class: "wx-caption-meta" }, captionMeta(s)));
    const gcfg = CONFIG.groupings.find(x => x.id === g);
    let bars = g === "All" ? tpl.bars
      : fillTpl(tpl.bars_split, { group_phrase: (gcfg && gcfg.phrase) || "group" });
    bars += captionGroups(s, g);
    // A split-sample question says its versions were randomized, and one
    // whose wording carries other piped-in text says that varied; the
    // survey variables behind either are named in the reference line.
    const armVar = (CONFIG.arm_variables || {})[v.id];
    if (v.arms) bars += tpl.randomized || "";
    else if (varied.length) bars += tpl.varied || "";
    if (g !== "WAVE" && s.n_waves > 1)
      bars += fillTpl(tpl.pooled || "", { waves: wavesText(s) });
    if (showCI) bars += tpl.ci || "";
    caption.append(el("p", { class: "wx-caption-bars" }, bars));
    caption.append(el("p", { class: "wx-caption-provenance", html: tpl.provenance }));
    const others = varied.filter(x => x !== armVar)
      .filter((x, i, a) => a.indexOf(x) === i);
    const refExtra =
      (v.arms && armVar ? fillTpl(tpl.randomization || "", { names: esc(armVar) }) : "") +
      (others.length ? fillTpl(tpl.piped || "", { names: others.map(esc).join(", ") }) : "");
    caption.append(el("p", { class: "wx-caption-ref",
      html: fillTpl(tpl.reference, { variable: esc(v.variable),
        randomization: refExtra }) }));
  }

  async function draw() {
    if (!currentKey) return;
    const v = await fetchQuestion(currentKey);
    // A split-sample question nests its splits one level deeper, under the
    // version. `arms` being present is what says so — there is no pooled
    // option, because pooling averages across the treatment.
    const { armKey, splits, summaries } = questionSlice(v, currentArm);
    renderArmPicker(v, armKey);
    // A question is not asked under every split — fall back to Everyone
    // rather than drawing an empty panel, and show the select doing it.
    let g = grouping;
    if (!(splits[g] && splits[g].length)) g = "All";
    if (groupingSel) groupingSel.value = g;
    const labelFor = (resp) => {
      const hit = (v.options || []).find(o => String(o.value) === String(resp));
      // An unlabelled value is shown as itself rather than dropped: it means
      // the data carries a code the instrument does not document.
      return hit ? hit.label : String(resp);
    };
    currentQuestionText = v.question || currentKey;
    qSurvey.textContent = [v.topic, v.asked].filter(Boolean).join(" \u00b7 ");
    // Placeholders in the wording read as the version shown (in bold) or in
    // plain words, never as survey variable names.
    // The roster's wording where it has one, which may be empty (a version
    // that added nothing); otherwise the survey's own value where it is the
    // text respondents read ("flooding event"), and the label where the value
    // is a code (a number, a time, or a name with underscores).
    const arm = v.arms ? (v.arms.find(a => a.id === armKey) || {}) : {};
    const worded = (CONFIG.arm_wording || {})[(CONFIG.arm_variables || {})[v.id]];
    const armId = String(arm.id ?? "");
    const armLabel = !armId ? null
      : worded ? (worded[armId] ?? "")
      : /[a-z]/i.test(armId) && !/_/.test(armId) ? armId : (arm.label || "");
    // Options carry placeholders too; on a version, they read its numbers.
    if (armId && v.options) {
      const varied = new Set();
      v.options = v.options.map(o => {
        const w = readableWording(String(o.raw ?? o.label), v.id, armLabel, armId);
        w.varied.forEach(n => varied.add(n));
        return { ...o, label: w.text };
      });
      v.options_varied = [...varied];
    }
    const wi = readableWording(v.question_intro || "", v.id, armLabel);
    const wt = readableWording(v.question_text || v.question || currentKey, v.id, armLabel);
    const shown = ((CONFIG.arm_shown || {})[(CONFIG.arm_variables || {})[v.id]] || {})[armId];
    qShown.textContent = "";
    if (shown) {
      qShown.append(el("p", { class: "wx-arm-shown-label" }, CONFIG.arm_shown_label || ""),
        el("blockquote", { class: "wx-quiz-quote" }, shown));
    }
    qShown.style.display = shown ? "" : "none";
    qIntro.textContent = ""; qIntro.append(...wi.nodes);
    qIntro.style.display = v.question_intro ? "" : "none";
    qHead.textContent = ""; qHead.append(...wt.nodes);
    // The wording as shown, for everything that repeats it off the page: the
    // chart's spoken label and the downloaded figure.
    shownStem = v.question_intro ? wi.text : "";
    shownItem = wt.text;
    shownQuestion = [shownStem, shownItem].filter(Boolean).join(" ");
    renderCaption2(v, g, summaries,
      [...new Set(wi.varied.concat(wt.varied, v.options_varied || []))]);
    syncFlagBtn();
    currentSave = {
      id: currentKey,
      waves: v.asked || "",
      years: (summaries && summaries.All && summaries.All.years) || "",
      question: readableWording(v.question || "", v.id).text,
      variable: v.variable || ""
    };
    syncSaveBtn();
    lastCodeArgs = [currentKey, g, armKey];
    // The view menu shows only where there is a second view to offer, and a
    // question without one falls back to its bars.
    const canTrend = trendQuestions.has(currentKey);
    const trend = canTrend && view === "trend";
    viewWrap.style.display = canTrend ? "" : "none";
    viewSel.value = trend ? "trend" : "bars";
    if (rcodeBtn) rcodeBtn.style.display = v.has_r_code ? "" : "none";
    if (trend) { await drawTrend(v); return; }
    const tick = tickLabeller((v.options || []).map(o => o.label));
    const rows = (splits[g] || []).map(r => ({
      group: r.group, category: tick(labelFor(r.resp)),
      value: r.p, label: Math.round(r.p) + "%", low: r.p_low, upp: r.p_upp
    }));
    // Horizontal bars need vertical room proportional to bar count —
    // grow the canvas instead of cramming (long scales × many groups).
    const nCats = new Set(rows.map(r => naLabel(r.category))).size;
    const nGroups = new Set(rows.map(r => naLabel(r.group))).size;
    const tickLines = Math.max(1, ...rows.map(r => String(r.category).split("\n").length));
    wrap.style.height = Math.max(380, Math.min(1000,
      110 + nCats * Math.max(44, nGroups * 20, tickLines * 18))) + "px";
    // One series needs no key; several are keyed by what they split on, so
    // the legend reads "Age" rather than "Group".
    const gLabel = (CONFIG.groupings.find(x => x.id === g) || {}).label;
    const chartOpts = {
      title: "",
      altTitle: shownQuestion,
      xLabel: page.chart.x_label, yLabel: page.chart.y_label,
      showCI,
      legend: nGroups > 1, legendTitle: gLabel || "Group",
      horizontal: true,
      colors: schemeSeriesColors(scheme, new Set(rows.map(r => naLabel(r.group))).size)
    };
    groupedBarChart(canvas, rows, chartOpts);
    lastChart = { rows, opts: chartOpts, g,
                  survey: qSurvey.textContent, stem: shownStem,
                  item: shownItem };
  }

  const tableCard = el("section", { class: "card wx-browse" });
  tableCard.append(el("h2", { class: "wx-browse-title" }, "Browse Survey Questions"),
    el("p", { class: "wx-browse-lede" },
      "Browse all survey questions or use the filters below to narrow the list."));
  const qTable = questionBrowser(questions, {
    flagCell: flaggingOn() ? flagCell : null,
    onPick: (r) => {
      currentKey = keyOf(r);
      currentArm = null;
      setParams({ q: currentKey, arm: null }, true);   // keep the URL shareable
      // The chart sits well above the list: bring it into view so the click
      // visibly loads the new question.
      resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
      draw();
    }
  });
  if (currentKey === urlQ) qTable.selectRow(r => keyOf(r) === urlQ);
  else qTable.selectFirst();
  tableCard.append(qTable);

  const intro = pageHead(page,
    "Click a survey question in the list below to see the distribution of responses, split by the group you choose.");
  // The way in for someone who arrives with a question in mind: pick a match
  // and it loads exactly as a click in the table does, with the table paged
  // to it so the two never disagree about which question is showing.
  const search = questionSearch(questions, (r) => {
    currentKey = keyOf(r);
    currentArm = null;
    setParams({ q: currentKey, arm: null }, true);
    qTable.selectRow(x => keyOf(x) === currentKey);
    draw();
  });
  // The comparison is the control that matters, so it stands alone; color
  // and intervals sit behind "Chart options", open from the start only when
  // a link has already set one of them, so a shared view shows its settings.
  const bar = el("div", { class: "wx-result-controls" });
  const resultSection = el("section", { class: "wx-result" });
  // The URL carries the comparison, so a reload or a copied link shows the
  // same split, and a link that arrived with one does not keep it stale.
  const gWrap = groupingSelect(g => {
    grouping = g;
    setParams({ grouping: g === "All" ? null : g }, true);
    draw();
  }, grouping, "Compare responses by");
  gWrap.classList.add("wx-compare");
  groupingSel = gWrap.querySelector("select");
  // Which picture of the question to draw. Offered only for a question asked
  // in more than one wave; draw() shows and hides it.
  const viewSel = el("select", { class: "grouping", id: "view-sel", onchange: () => {
    view = viewSel.value;
    setParams({ view: view === "trend" ? "trend" : null }, true);
    draw();
  } });
  viewSel.append(el("option", { value: "bars" }, "Distribution of responses"),
                 el("option", { value: "trend" }, "Change over time"));
  const viewWrap = el("div", { class: "wx-compare" },
    el("label", { class: "field-label", for: "view-sel" }, "Show"), viewSel);
  viewWrap.style.display = "none";
  bar.append(viewWrap, gWrap);
  const options = el("details", { class: "wx-chart-options" });
  if (showCI || scheme !== DEFAULT_SCHEME) options.open = true;
  options.append(el("summary", {}, "Chart options"));
  options.append(el("div", { class: "wx-chart-options-body" },
    schemeSelect(scheme, (sc) => {
      scheme = sc;
      setParams({ scheme: sc === DEFAULT_SCHEME ? null : sc });
      draw();
    }),
    el("label", { class: "wx-ci-label", for: "ci-toggle" },
      ciBox, " Show 95% confidence intervals")));
  bar.append(options);
  // The caption below the chart is the document's notes: how many answered,
  // that the percentages are weighted, which waves, the smallest group, and
  // the provenance with the variable code. A chart without them cannot be
  // handed to anyone.
  // Both downloads in one group. .wx-pdf-btn carries margin-left:auto, so two
  // of them loose in the toolbar each push themselves to the right edge and
  // end up at opposite ends of the row; the group takes the auto margin once
  // and the buttons sit together.
  // At the foot of the chart, under the caption that says who answered and
  // where the data come from: the R code is part of that account, and both
  // downloads are things to take away rather than ways to change the view.
  const actions = el("div", { class: "wx-toolbar-actions wx-result-downloads" });
  chartCard.append(actions);
  actions.append(pdfButton("Download chart (PNG)",
    () => saveFigure(chartImage(), exportName("png"), "png")));
  // The same picture as the PNG, on a page cut to its shape: 11 inches wide
  // and as tall as the picture needs, so nothing is letterboxed or cropped.
  actions.append(pdfButton("Download chart (PDF)",
    () => saveFigure(chartImage(), exportName("pdf"), "pdf")));
  // Beside the chart download, and a download rather than a viewer: someone
  // who wants the script wants it in their editor, not in a scrolling box.
  rcodeBtn = pdfButton("Download R code", async () => {
    if (!lastCodeArgs) return;
    const [id, g, armKey] = lastCodeArgs;
    const trend = !!(lastChart && lastChart.trend);
    try {
      const text = await rcodeFor(id, g, armKey, trend);
      if (text) downloadRCode(text, id, g, armKey, trend);
    } catch { /* a missing file leaves the chart alone rather than erroring */ }
  });
  // Hidden until draw() has a question in hand: it downloads that question's
  // script, so it has nothing to offer before one is chosen.
  rcodeBtn.style.display = "none";
  actions.append(rcodeBtn);
  // Beside the downloads: saving is another way of taking the question away.
  // Explained on hover and on keyboard focus, and read out as the button's
  // description, so it needs no second control.
  saveBtn.setAttribute("aria-describedby", "wx-save-tip");
  actions.append(el("span", { class: "wx-save-wrap" }, saveBtn,
    el("span", { class: "wx-hover-tip", id: "wx-save-tip", role: "tooltip" },
      "Save questions you want to revisit. You can reopen them or download " +
      "your saved list as a CSV at the bottom of this page. Saved questions " +
      "are stored only in this browser and may be removed if you clear your " +
      "browsing data.")));
  container.append(el("div", { class: "page wx-explore-page" },
    el("div", { class: "content" }, intro, search, savedJump,
       resultSection,
       tableCard,
       savedPanel,
       ...(flagPanel ? [flagPanel] : []))));
  resultSection.append(resultHead, bar, chartCard);
  renderFlagPanel();
  renderSaved();
  pageRestyle = () => draw();
  await draw();
};

/* The question browser under the explore page's results: three menus
 * (wave, topic, question type), a search within whatever they leave, a
 * count, and the questions as rows rather than spreadsheet cells. The item
 * leads each row and the stem it shares with its battery sits quietly above
 * it; the waves that asked it and its topic are small labels over both. Rows
 * are whole-row links. Pagination stays, at a fixed ten, because there are
 * over 300.
 *
 * Topics come from the question data and nothing else: `topic` is the one a
 * row is labelled with, and `topics` lists every topic the question was given
 * ("A | B"), which the menu matches against. Until the data carries them the
 * menu says so and stays disabled rather than guessing from the wording. */
function questionBrowser(rows, { onPick, flagCell = null, pageSize = 10 }) {
  const distinct = (key) => [...new Set(rows.map(r => r[key]).filter(Boolean))];
  // A question belongs to every wave that asked it, so the wave menu matches
  // on the list each question carries rather than on one label.
  const waveNames = new Map((CONFIG.waves || []).map(w => [String(w.wave), w.name]));
  const wavesOf = (r) => (r.waves || []).map(String);
  const surveys = [...waveNames.keys()].filter(w => rows.some(r => wavesOf(r).includes(w)));
  const topicsOf = (r) => String(r.topics || r.topic || "").split(" | ")
    .filter(Boolean);
  const topics = [...new Set(rows.flatMap(topicsOf))]
    .sort((a, b) => a.localeCompare(b));
  const kinds = distinct("kind");
  const norm = (t) => String(t || "").toLowerCase();
  const haystack = new Map(rows.map(r => [r, norm([r.question, r.variable,
    r.asked, r.topics || r.topic, r.kind].filter(Boolean).join(" "))]));

  let fSurvey = "", fTopic = "", fKind = "", q = "", page = 0, selected = null;
  let filtered = rows.slice();

  const root = el("div", { class: "wx-browse-body" });
  const menu = (label, allText, values, show, onChange) => {
    const sel = el("select", { class: "grouping", "aria-label": label,
                               onchange: () => onChange(sel.value) });
    sel.append(el("option", { value: "" }, allText));
    for (const v of values) sel.append(el("option", { value: v }, show(v)));
    return sel;
  };
  const surveySel = menu("Wave", "All waves", surveys, v => waveNames.get(v),
    v => { fSurvey = v; apply(); });
  const topicSel = menu("Topic", "All topics", topics, v => v,
    v => { fTopic = v; apply(); });
  if (!topics.length) {
    topicSel.disabled = true;
    topicSel.title = "Topics are not in the question data yet.";
  }
  const kindSel = menu("Question type", "All question types", kinds, v => v,
    v => { fKind = v; apply(); });
  const find = el("input", { type: "search", class: "wx-browse-search",
    placeholder: "Search within results...", "aria-label": "Search within results",
    oninput: () => { q = find.value; apply(); } });
  const count = el("span", { class: "wx-browse-count", "aria-live": "polite" });
  root.append(el("div", { class: "wx-browse-filters" }, surveySel, topicSel, kindSel),
              el("div", { class: "wx-browse-searchrow" }, find, count));

  const list = el("ol", { class: "wx-browse-list" });
  const prev = el("button", { class: "wx-browse-page", type: "button",
    onclick: () => { page--; render(); } }, "‹ Previous");
  const next = el("button", { class: "wx-browse-page", type: "button",
    onclick: () => { page++; render(); } }, "Next ›");
  const where = el("span", { class: "wx-browse-where" });
  root.append(list, el("nav", { class: "wx-browse-pager", "aria-label": "Pages" },
                        prev, where, next));

  function apply() {
    const words = norm(q).split(/\s+/).filter(Boolean);
    filtered = rows.filter(r =>
      (!fSurvey || wavesOf(r).includes(fSurvey)) &&
      (!fTopic || topicsOf(r).includes(fTopic)) &&
      (!fKind || r.kind === fKind) &&
      words.every(w => haystack.get(r).includes(w)));
    page = 0;
    render();
  }

  function render() {
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.min(Math.max(0, page), pages - 1);
    const n = filtered.length;
    count.textContent = `${n.toLocaleString()} question${n === 1 ? "" : "s"}`;
    list.textContent = "";
    if (!n) list.append(el("li", { class: "wx-browse-none" },
      "No questions match. Try another filter or fewer words."));
    for (const r of filtered.slice(page * pageSize, (page + 1) * pageSize)) {
      // The list item stays a list item; the control inside it is the
      // button, so the list reads as a list to a screen reader.
      const li = el("li", { class: "wx-browse-row" + (r === selected ? " selected" : "") });
      const hit = el("div", { class: "wx-browse-hit", tabindex: "0", role: "button",
        "aria-current": r === selected ? "true" : "false",
        onclick: () => pick(r),
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(r); }
        } });
      const meta = el("div", { class: "wx-browse-meta" },
        el("span", { class: "wx-browse-survey" }, r.asked || ""));
      if (r.topic) meta.append(el("span", { class: "wx-browse-topic" }, r.topic));
      const body = el("div", { class: "wx-browse-q" });
      if (r.question_intro)
        body.append(el("p", { class: "wx-browse-stem" },
          readableWording(r.question_intro, r.id).text));
      const itemRow = el("div", { class: "wx-browse-itemrow" },
        el("p", { class: "wx-browse-item" },
          readableWording(r.question_text || r.question, r.id).text));
      // Neither the variable name nor the question type is shown on the row;
      // both are found by typing them in the search, and the type has a menu.
      if (flagCell) itemRow.append(flagCell(r));
      body.append(itemRow);
      hit.append(meta, body);
      li.append(hit);
      list.append(li);
    }
    where.textContent = `Page ${page + 1} of ${pages}`;
    prev.disabled = page === 0;
    next.disabled = page >= pages - 1;
  }

  function pick(r) { selected = r; render(); onPick && onPick(r); }

  // Select and page to the first row matching pred, for deep links and for
  // the search above; a question the filters hide is still selected, and the
  // list stays where it is.
  root.selectRow = (pred) => {
    const r = rows.find(pred);
    if (!r) return;
    selected = r;
    const i = filtered.indexOf(r);
    if (i >= 0) page = Math.floor(i / pageSize);
    render();
  };
  root.selectFirst = () => root.selectRow(() => true);
  root.rerender = render;
  render();
  return root;
}

/* The explore page's search: one large field over the full wording of every
 * question, stem and item together, with matches listed as the reader types.
 * Every word typed has to appear, in any order, so "water cost" finds
 * questions using both words. Matches whose item itself contains the words
 * come first, because the stem is shared by a whole battery and would
 * otherwise bury the one item the reader meant. Each suggestion shows the
 * item, the stem quietly above it where there is one, and the survey. */
function questionSearch(questions, onPick) {
  const LIMIT = 8;
  const norm = (t) => String(t || "").toLowerCase();
  const index = questions.map(r => ({
    row: r, all: norm(r.question), item: norm(r.question_text || r.question)
  }));

  const wrap = el("section", { class: "wx-qsearch" });
  const label = el("label", { class: "wx-qsearch-label", for: "wx-qsearch-input" },
    "What do you want to know?");
  const input = el("input", {
    id: "wx-qsearch-input", class: "wx-qsearch-input", type: "search",
    placeholder: "Search survey questions...", autocomplete: "off",
    "aria-describedby": "wx-qsearch-hint",
    role: "combobox", "aria-expanded": "false",
    "aria-controls": "wx-qsearch-list", "aria-autocomplete": "list"
  });
  const list = el("ul", { id: "wx-qsearch-list", class: "wx-qsearch-list",
                          role: "listbox", hidden: "" });
  const field = el("div", { class: "wx-qsearch-field" }, input, list);
  // Stays visible while typing, unlike a placeholder, and is not cut off on
  // a narrow screen.
  const hint = el("p", { id: "wx-qsearch-hint", class: "wx-qsearch-hint" },
    "Search question text for words or phrases, e.g., drought, water " +
    "quality, wind energy");
  wrap.append(label, field, hint);

  let matches = [], active = -1;
  const close = () => {
    list.hidden = true; input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant"); active = -1;
  };
  const setActive = (i) => {
    active = i;
    [...list.querySelectorAll(".wx-qsearch-opt")].forEach((li, j) => {
      li.classList.toggle("active", j === i);
      li.setAttribute("aria-selected", j === i ? "true" : "false");
      if (j === i) {
        input.setAttribute("aria-activedescendant", li.id);
        li.scrollIntoView({ block: "nearest" });
      }
    });
  };
  const pick = (r) => { input.value = ""; close(); input.blur(); onPick(r); };

  const render = () => {
    const words = norm(input.value).split(/\s+/).filter(Boolean);
    list.textContent = "";
    if (!words.length) { close(); return; }
    const hits = index.filter(x => words.every(w => x.all.includes(w)));
    hits.sort((a, b) =>
      (words.every(w => b.item.includes(w)) - words.every(w => a.item.includes(w))));
    matches = hits.slice(0, LIMIT).map(x => x.row);
    if (!matches.length) {
      list.append(el("li", { class: "wx-qsearch-none" },
        "No questions use those words. Try fewer or different ones."));
    }
    matches.forEach((r, i) => {
      const li = el("li", { class: "wx-qsearch-opt", role: "option",
                            id: `wx-qsearch-opt-${i}`, "aria-selected": "false" });
      if (r.question_intro)
        li.append(el("span", { class: "wx-qsearch-stem" },
          readableWording(r.question_intro, r.id).text));
      li.append(el("span", { class: "wx-qsearch-item" },
          readableWording(r.question_text || r.question, r.id).text),
                el("span", { class: "wx-qsearch-survey" },
                  [r.topic, r.asked].filter(Boolean).join(" \u00b7 ")));
      // mousedown rather than click, so the pick lands before the input's
      // blur closes the list underneath it.
      li.addEventListener("mousedown", (e) => { e.preventDefault(); pick(r); });
      li.addEventListener("mousemove", () => { if (active !== i) setActive(i); });
      list.append(li);
    });
    if (hits.length > LIMIT)
      list.append(el("li", { class: "wx-qsearch-more" },
        `Showing ${LIMIT} of ${hits.length.toLocaleString()} matches. Add a word to narrow them.`));
    list.hidden = false; input.setAttribute("aria-expanded", "true");
    active = -1;
  };

  input.addEventListener("input", render);
  input.addEventListener("focus", () => { if (input.value.trim()) render(); });
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && matches.length) {
      e.preventDefault(); if (list.hidden) render();
      setActive(Math.min(active + 1, matches.length - 1));
    } else if (e.key === "ArrowUp" && matches.length) {
      e.preventDefault(); setActive(Math.max(active - 1, 0));
    } else if (e.key === "Enter" && !list.hidden && matches.length) {
      e.preventDefault(); pick(matches[Math.max(active, 0)]);
    } else if (e.key === "Escape") {
      close();
    }
  });
  return wrap;
}

/* ------------------------------------------------- shared helpers ------- */
/* Popovers, legends, the map helpers and the caption templates the page
 * components share. All text is authored by the builder in config.json
 * (templated with {tokens}), so the engine stays generic. */

function fillTpl(s, vals) {
  return String(s || "").replace(/\{(\w+)\}/g, (_, k) => (vals && vals[k] != null) ? vals[k] : "");
}
let openTipClose = null;
document.addEventListener("click", (e) => {
  if (openTipClose && !e.target.closest(".tip-wrap")) openTipClose();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openTipClose) openTipClose();
});

function infoTip(html, opts = {}) {
  const wrap = el("span", { class: "tip-wrap" });
  const btn = el("button", {
    class: "tip-btn" + (opts.text ? " text" : ""), type: "button",
    "aria-label": opts.label || opts.text || "What does this mean?",
    "aria-expanded": "false",
    onclick: (e) => { e.stopPropagation(); toggle(); }
  }, opts.text || "?");
  const panel = el("div", { class: "tip-panel", role: "note", html });
  function close() {
    wrap.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
    if (openTipClose === close) openTipClose = null;
  }
  function toggle() {
    if (wrap.classList.contains("open")) return close();
    if (openTipClose) openTipClose();
    wrap.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
    // keep the panel on-screen: right-align when the trigger sits right of center
    panel.classList.toggle("align-right", btn.getBoundingClientRect().left > window.innerWidth * 0.55);
    openTipClose = close;
  }
  wrap.append(btn, panel);
  // ?tips=open auto-opens a tip — headless-screenshot aid. Opens the first
  // tip created on the page, or the Nth with &tipn=N.
  if (getParam("tips") === "open") {
    infoTip._count = (infoTip._count || 0) + 1;
    if (infoTip._count === (parseInt(getParam("tipn"), 10) || 1)) setTimeout(toggle, 60);
  }
  return wrap;
}


// Tile-free basemap: no tiles and no background, framed on the bounds given
// (self-contained bundle, no third-party requests).
function baseMap(mapEl, bounds, opts = {}) {
  const map = L.map(mapEl, {
    renderer: L.canvas(),                       // one canvas, not an SVG node per polygon
    attributionControl: false,
    ...opts
  });
  map.fitBounds(bounds);
  return map;
}

// A theme token, read at build time. Safe to cache per call: switching themes
// re-renders the page, so nothing drawn from these outlives its theme.
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return (v && v.trim()) || fallback;
}

// Ink that reads on a given fill (sRGB luma). A constant outline color cannot
// serve both ends of a ramp: grey disappears into the dark end of the greys,
// which is exactly where a comparison map draws the eye.
function inkOn(fill) {
  const t = String(fill);
  let rgb;
  if (t.startsWith("#")) {
    const h = t.length === 4
      ? t.slice(1).split("").map(c => c + c).join("") : t.slice(1);
    rgb = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  } else {
    const n = t.match(/\d+(\.\d+)?/g);
    if (!n || n.length < 3) return "#111827";
    rgb = n.slice(0, 3).map(Number);
  }
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) > 150
    ? "#111827" : "#ffffff";
}

// One choropleth layer with popups + click selection.
function choroLayer(geo, { idProp, valueOf, color, popupHTML, onSelect,
                           tooltipHTML, popupOptions = {}, fillOpacity = 0.9 }) {
  let selected = null;
  const outline = (id) => ({ weight: 4, color: inkOn(color(valueOf(id))) });
  // A neutral hairline rather than white: white borders vanish at the pale
  // end of a ramp because the map has no background of its own, taking the
  // shape of the lightest areas with them.
  const hairline = cssVar("--map-hairline", "rgba(35, 33, 48, 0.28)");
  const layer = L.geoJSON(geo, {
    style: (f) => ({
      fillColor: color(valueOf(f.properties[idProp])),
      fillOpacity, color: hairline, weight: idProp === "FIPS" ? 0.5 : 1,
      opacity: 1
    }),
    onEachFeature: (f, lyr) => {
      const id = f.properties[idProp];
      lyr.bindPopup(() => popupHTML(id, f.properties), popupOptions);
      // Hover-to-read: sticky tooltip with the value.
      if (tooltipHTML) lyr.bindTooltip(() => tooltipHTML(id, f.properties),
        { sticky: true, direction: "top", opacity: 0.96 });
      lyr.on("mouseover", () => {
        lyr.setStyle(outline(id));
        lyr.bringToFront();
      });
      lyr.on("mouseout", () => {
        if (selected !== lyr) layer.resetStyle(lyr);
      });
      lyr.on("click", () => {
        if (selected) layer.resetStyle(selected);
        selected = lyr;
        onSelect && onSelect(id, f.properties, lyr);
      });
    }
  });
  // fit=false: highlight + popup without moving the view (static maps).
  layer.selectById = (id, map, fit = true, popup = true) => {
    layer.eachLayer(lyr => {
      if (String(lyr.feature.properties[idProp]) === String(id)) {
        if (selected) layer.resetStyle(selected);
        selected = lyr;
        lyr.setStyle(outline(id));
        lyr.bringToFront();
        if (map && fit) map.fitBounds(lyr.getBounds().pad(1.2));
        if (map && popup) lyr.openPopup();
        onSelect && onSelect(id, lyr.feature.properties, lyr);
      }
    });
  };
  // Drops the outline without touching the data: the scan panel's Clear has
  // to leave the map looking like nothing was ever picked.
  layer.clearSelection = () => {
    if (selected) { layer.resetStyle(selected); selected = null; }
  };
  return layer;
}

/* ---- map-story helpers ------------------------------------------------- */

function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return n + "th";
  if (n % 10 === 1) return n + "st";
  if (n % 10 === 2) return n + "nd";
  if (n % 10 === 3) return n + "rd";
  return n + "th";
}

// One row of the scan sheet: the other regions as small diamonds, this one
// as a filled dot, on a strip stretched to the measure's range. Each mark
// carries its region and value for the tip the sheet shows on hover, and a
// clear disc around it wide enough to hover. The range ends print in their
// own columns rather than inside the SVG, so they line up down the sheet
// instead of drifting with each measure's width.
function scanStripSVG(points, hereId, lo, hi, W = 210) {
  const H = 16, pad = 7;
  const at = (v) => hi === lo ? W / 2
    : +(pad + (v - lo) / (hi - lo) * (W - 2 * pad)).toFixed(1);
  const mark = (p, shape) => {
    const cx = at(p.v);
    return `<g class="s3-mark" data-tip="${esc(p.id)} \u00b7 ${esc(p.label)}">` +
      shape(cx) + `<circle cx="${cx}" cy="8" r="8" fill="transparent"/></g>`;
  };
  const diamond = (cx) =>
    `<path d="M${cx} 4.5L${cx + 3.5} 8L${cx} 11.5L${cx - 3.5} 8Z" ` +
    `fill="var(--text-muted, #6e737a)"/>`;
  const dot = (cx) =>
    `<circle cx="${cx}" cy="8" r="5.5" fill="var(--accent, #443a83)" ` +
    `stroke="var(--panel, #ffffff)" stroke-width="1.2"/>`;
  const here = points.find(p => p.id === hereId);
  return `<svg class="wx-scan-strip" width="${W}" height="${H}" ` +
    `viewBox="0 0 ${W} ${H}" aria-hidden="true">` +
    points.filter(p => p.id !== hereId).map(p => mark(p, diamond)).join("") +
    (here ? mark(here, dot) : "") + `</svg>`;
}

// Config prose arrives as HTML; the PDF takes text. Going through a detached
// element decodes the entities too, so "measure&rsquo;s" does not reach the
// sheet as markup.
function plainText(html) {
  const d = document.createElement("div");
  // Block ends become spaces first: textContent runs two paragraphs together
  // into one word where the markup was the only thing separating them.
  d.innerHTML = String(html || "").replace(/<\/(p|div|li|h[1-6])>/gi, " ");
  return (d.textContent || "").replace(/\s+/g, " ").trim();
}

/* Explore Key Topics: a whole battery on one chart, where Explore Survey
 * Questions shows one question at a time. Every item of the battery is a row
 * (a mean rating, or the share answering yes, or the share ranking it first),
 * split by the group chosen. The same skeleton as the survey explorer: the
 * battery named above the controls, the comparison and one options toggle on
 * the page, the chart as the one card with its caption and downloads.
 *
 * Nothing is computed here. 02 writes each battery under every split, with
 * its intervals and respondent counts, and this draws the slice asked for. */
components.s3_topics = async function (page, container) {
  const catalog = CONFIG.topics || [];
  let topicId = getParam("topic");
  if (!catalog.some(t => t.id === topicId))
    topicId = page.default_topic || (catalog[0] && catalog[0].id);
  let grouping = urlGrouping() || "All";
  let showCI = getParam("ci") === "1";
  let scheme = urlScheme();

  const head = el("div", { class: "wx-result-head" });
  const kind = el("p", { class: "wx-result-survey" });
  const stem = el("p", { class: "wx-question-intro wx-result-stem" });
  const title = el("h2", { class: "wx-question-head wx-result-item" });
  head.append(kind, stem, el("div", { class: "wx-question-headrow" }, title));

  const chartCard = el("div", { class: "card wx-result-chart" });
  const wrap = el("div", { class: "chart-wrap" });
  const canvas = el("canvas");
  wrap.append(canvas);
  const caption = el("div", { class: "wx-caption wx-explore-caption" });
  const actions = el("div", { class: "wx-toolbar-actions wx-result-downloads" });
  chartCard.append(wrap, caption, actions);

  let lastChart = null;
  let groupingSel = null;

  // The battery menu, grouped the way the menu on Explore Regions is.
  const bar = el("div", { class: "wx-result-controls wx-map-toolbar" });
  const topicSel = el("select", { class: "grouping", id: "topic-sel", onchange: () => {
    topicId = topicSel.value;
    setParams({ topic: topicId }, true);
    draw();
  } });
  for (const g of [...new Set(catalog.map(t => t.group))]) {
    const og = el("optgroup", { label: g });
    for (const t of catalog.filter(x => x.group === g))
      og.append(el("option", { value: t.id }, t.label));
    topicSel.append(og);
  }
  topicSel.value = topicId;
  const topicWrap = el("div");
  topicWrap.append(el("label", { class: "field-label", for: "topic-sel" },
    "What do you want to explore?"), topicSel);

  const gWrap = groupingSelect(g => {
    grouping = g;
    setParams({ grouping: g === "All" ? null : g }, true);
    draw();
  }, grouping, "Compare responses by");
  groupingSel = gWrap.querySelector("select");

  const ciBox = el("input", { type: "checkbox", id: "ci-toggle" });
  ciBox.checked = showCI;
  ciBox.onchange = () => {
    showCI = ciBox.checked; setParams({ ci: showCI ? "1" : null }); draw();
  };
  const options = el("details", { class: "wx-chart-options wx-map-options" });
  if (showCI || scheme !== DEFAULT_SCHEME) options.open = true;
  options.append(el("summary", {}, "Chart options"),
    el("div", { class: "wx-chart-options-body" },
      schemeSelect(scheme, (sc) => {
        scheme = sc;
        setParams({ scheme: sc === DEFAULT_SCHEME ? null : sc });
        draw();
      }),
      el("label", { class: "wx-ci-label", for: "ci-toggle" },
        ciBox, " Show 95% confidence intervals")));
  bar.append(topicWrap, gWrap, el("div", { class: "wx-map-options-wrap" }, options));

  // Means print to two decimals: groups a tenth apart would otherwise carry
  // the same label on bars of visibly different length.
  const fmtValue = (t) => (v) => t.kind === "mean"
    ? Number(v).toFixed(2) : Math.round(v) + "%";

  // The way into the single questions behind the chart, offered only where
  // the battery's items are listed on Explore Survey Questions.
  const exploreLink = el("span");

  function renderCaption(t, g) {
    const tpl = CONFIG.topic_caption;
    const s = t.summaries && t.summaries[g];
    caption.textContent = "";
    if (!s) return;
    caption.append(el("p", { class: "wx-caption-meta" }, captionMeta(s)));
    const gcfg = CONFIG.groupings.find(x => x.id === g);
    const phrase = (gcfg && gcfg.phrase) || "group";
    let bars = fillTpl(g === "All" ? tpl[t.kind] : tpl[t.kind + "_split"],
      { group_phrase: phrase });
    bars += captionGroups(s, g);
    const note = (CONFIG.topic_notes || {})[t.id];
    if (note) bars += " " + note;
    if (g !== "WAVE" && s.n_waves > 1)
      bars += fillTpl(CONFIG.explore_caption.pooled, { waves: wavesText(s) });
    if (showCI) bars += t.kind === "mean" ? tpl.ci_mean : tpl.ci_share;
    caption.append(el("p", { class: "wx-caption-bars" }, bars));
    caption.append(el("p", { class: "wx-caption-provenance",
      html: CONFIG.explore_caption.provenance }));
    caption.append(el("p", { class: "wx-caption-ref", html: fillTpl(tpl.reference, {
      variables: t.items.map(x => `<code>${esc(x.variable)}</code>`).join(", ") }) }));
  }

  async function draw() {
    const t = await fetchJSON(`data/topics/${topicId}.json`);
    let g = grouping;
    if (!(t.splits[g] && t.splits[g].length)) g = "All";
    if (groupingSel) groupingSel.value = g;

    kind.textContent = t.group;
    stem.textContent = t.prompt + (t.scale ? ` (${t.scale})` : "");
    title.textContent = t.label;
    renderCaption(t, g);

    const fmt = fmtValue(t);
    const tick = tickLabeller(t.items.map(x => x.label));
    const rows = t.splits[g].map(r => ({
      group: r.group, category: tick(r.item),
      value: r.value, label: fmt(r.value), low: r.low, upp: r.upp
    }));
    // Groups in the split's own order. The chart keys its series by first
    // appearance, and an item asked in only some waves would otherwise put
    // those waves first.
    const levels = (CONFIG.groupings.find(x => x.id === g) || {}).levels || [];
    rows.sort((x, y) => levels.indexOf(x.group) - levels.indexOf(y.group));
    const nCats = new Set(rows.map(r => r.category)).size;
    const nGroups = new Set(rows.map(r => r.group)).size;
    const tickLines = Math.max(1, ...rows.map(r => String(r.category).split("\n").length));
    wrap.style.height = Math.max(380, Math.min(1400,
      110 + nCats * Math.max(44, nGroups * 20, tickLines * 18))) + "px";
    const gLabel = (CONFIG.groupings.find(x => x.id === g) || {}).label;
    const chartOpts = {
      title: "", altTitle: t.label + ". " + t.prompt,
      xLabel: "", yLabel: t.value_label,
      categoryOrder: t.items.map(x => tick(x.label)),
      showCI, ciDigits: t.kind === "mean" ? 2 : 1,
      legend: nGroups > 1, legendTitle: gLabel || "Group",
      horizontal: true,
      colors: schemeSeriesColors(scheme, nGroups)
    };
    groupedBarChart(canvas, rows, chartOpts);
    lastChart = { rows, opts: chartOpts, g, label: t.group,
                  stem: stem.textContent, title: t.label };

    exploreLink.textContent = "";
    const listed = t.items.find(x => x.listed);
    if (listed) exploreLink.append(pageLink("#survey",
      { q: listed.variable, grouping: g === "All" ? null : g },
      { class: "wx-quiz-explore wx-foot-link" },
      "Open these questions in the survey explorer →"));
  }

  // The chart as a figure, redrawn off screen the way the survey explorer
  // redraws its own.
  function chartImage() {
    if (!lastChart) return null;
    const inner = FIGURE.W - FIGURE.pad * 2;
    const ratio = wrap.clientHeight / Math.max(1, wrap.clientWidth);
    const chartH = Math.round(Math.max(460, Math.min(1400, inner * ratio * 1.1)));
    const host = el("div", { style:
      `position:fixed;left:-30000px;top:0;width:${inner}px;height:${chartH}px` });
    const cv = el("canvas");
    cv.style.width = inner + "px"; cv.style.height = chartH + "px";
    cv.width = inner; cv.height = chartH;
    host.append(cv); document.body.append(host);
    const saved = Chart.defaults.font.size;
    Chart.defaults.font.size = 15;
    let chart;
    try {
      chart = groupedBarChart(cv, lastChart.rows,
        { ...lastChart.opts, standalone: true, pixelRatio: FIGURE.S, labelSize: 14 });
    } finally { Chart.defaults.font.size = saved; }
    const capLine = (cls) => (caption.querySelector(cls) || {}).textContent || "";
    const img = figureImage({
      label: lastChart.label, stem: lastChart.stem, title: lastChart.title,
      body: { height: chartH,
              draw: (ctx, x, y, w) => ctx.drawImage(cv, x, y, w, chartH) },
      lines: [{ text: capLine(".wx-caption-meta"), strong: true },
              { text: capLine(".wx-caption-bars") }],
      source: FIGURE_SOURCE + " Results are unweighted."
    });
    chart.destroy(); host.remove();
    return img;
  }
  const exportName = (ext) => {
    const g = lastChart && lastChart.g;
    return `s3ok-${topicId}${g && g !== "All" ? "-" + g : ""}.${ext}`;
  };
  actions.append(
    pdfButton("Download chart (PNG)",
      () => saveFigure(chartImage(), exportName("png"), "png")),
    pdfButton("Download chart (PDF)",
      () => saveFigure(chartImage(), exportName("pdf"), "pdf")),
    exploreLink);

  container.append(el("div", { class: "page wx-explore-page" },
    el("div", { class: "content" }, pageHead(page),
       el("section", { class: "wx-result" }, head, bar, chartCard))));
  pageRestyle = () => draw();
  await draw();
};

/* Explore Regions: where the panel lives, and every key-topic measure for the
 * region a reader picks. The map draws the five survey regions, each in a
 * color of its own, with the panel's approximate locations over them;
 * clicking a region opens a popup with its response count and fills the
 * overview sheet below the notes: every measure as a row stretched to its
 * own range across the five regions.
 *
 * Values and ranks arrive computed. The map has no tiles and no color of its
 * own: the regions sit directly on the card, county lines over them. */
components.s3_region_map = async function (page, container) {
  const cats = CONFIG.catalog;
  const byCode = new Map(cats.map(c => [c.code, c]));
  // The one measure the map draws; the sheet carries the rest.
  const measure = page.default_measure || cats[0].code;
  if (!byCode.get(measure)) throw new Error(`No measure ${measure} to map.`);
  setParams({ measure: null, scheme: null });   // from links to an earlier version
  let showDots = getParam("dots") !== "0";

  const values = await fetchJSON("data/map/region_values.json");
  const geo = await fetchJSON("data/geo/regions.geojson");
  const counties = await fetchJSON("data/geo/counties.geojson");
  const locations = await fetchJSON("data/map/locations.json");
  const N = values.areas;
  const M = (code) => values.measures[code];
  const kindOf = (code) => byCode.get(code).kind;
  const fmtVal = (code) => (v) =>
    kindOf(code) === "count" ? Number(v).toLocaleString()
    : kindOf(code) === "mean" ? Number(v).toFixed(2)
    : Number(v).toFixed(1) + "%";
  const fmtRange = (code) => (v) =>
    kindOf(code) === "count" ? Number(v).toLocaleString()
    : kindOf(code) === "mean" ? Number(v).toFixed(2)
    : Number(v).toFixed(1);

  // One color per region, from the viridis ramp the masthead's rule is drawn
  // in, stopping short of its yellow, which a dot vanishes against. The
  // greyscale theme takes greys instead. Regions are colored in the order
  // the map file lists them, so a region keeps its color between visits.
  const regionIds = Object.keys(values.places);
  const regionColor = (id) => {
    const i = regionIds.indexOf(id);
    const stops = dataStops(VIRIDIS_STOPS);
    return rampColor(stops, 0.08 + 0.72 * i / Math.max(1, regionIds.length - 1));
  };

  const lead = pageHead(page);
  const mapHead = el("div", { class: "wx-result-head" });
  const mapKind = el("p", { class: "wx-result-survey" });
  const mapTitle = el("h2", { class: "wx-question-head wx-result-item" });
  mapHead.append(mapKind, mapTitle);

  const bar = el("div", { class: "wx-result-controls wx-map-toolbar" });

  const dotsBox = el("input", { type: "checkbox", id: "dots-toggle" });
  dotsBox.checked = showDots;
  dotsBox.onchange = () => {
    showDots = dotsBox.checked;
    setParams({ dots: showDots ? null : "0" });
    syncDots();
  };
  const colors = el("details", { class: "wx-chart-options wx-map-options" });
  if (!showDots) colors.open = true;
  colors.append(el("summary", {}, "Map options"),
    el("div", { class: "wx-chart-options-body" },
      el("label", { class: "wx-ci-label", for: "dots-toggle" },
        dotsBox, " Show approximate respondent locations")));
  bar.append(el("div", { class: "wx-map-options-wrap" }, colors));

  const clearBtn = el("button", { class: "wx-clear-btn wx-map-clear",
    type: "button", onclick: () => clearPlace() }, "Clear selection");
  clearBtn.style.display = "none";

  const card = el("div", { class: "card wx-map-card wx-map-fullwidth" });
  const mapEl = el("div", { class: "wx-map s3-map" });
  const legendHolder = el("div", { class: "wx-legend-row" });
  const pairEl = el("div", { class: "wx-map-pair" },
    el("div", { class: "wx-map-pane wx-pane-a" }, mapEl, legendHolder));
  const mapAlt = el("div", { class: "wx-sr-only" });
  card.append(clearBtn, pairEl,
    el("p", { class: "wx-field-hint wx-map-hint" }, page.hint || ""));

  // Notes first, then the overview sheet: what the map is showing has to be
  // read before one region's standing on it means anything.
  const notesCard = el("div", { class: "card wx-map-notes" });
  const scanCard = el("div", { class: "card wx-scan-card" });

  /* The map as a figure (figureImage): the paths redrawn as vectors with the
   * legend under them, over a facts line and what the colors show. */
  function mapImage() {
    const bg = getComputedStyle(document.body).getPropertyValue("--panel").trim() || "#ffffff";
    const inner = FIGURE.W - FIGURE.pad * 2;
    const img = vectorMap(map, FIGURE.S, bg);
    const mapH = inner * img.height / img.width;
    const keyH = 30;
    return figureImage({
      label: page.map_kind || "", stem: "", title: page.map_title || "",
      body: {
        height: mapH + 14 + keyH,
        draw: (ctx, x, y, w, t) => {
          ctx.drawImage(img, x, y, w, mapH);
          // The key: a swatch and a name per region, with its count.
          let kx = x; const ky = y + mapH + 24;
          ctx.font = `400 13px ${t.family}`; ctx.textBaseline = "middle";
          for (const id of regionIds) {
            const words = `${values.places[id].label} \u00b7 ` +
              `${Number(values.places[id].responses).toLocaleString()}`;
            ctx.fillStyle = regionColor(id); ctx.fillRect(kx, ky - 6, 14, 12);
            ctx.fillStyle = t.ink; ctx.fillText(words, kx + 20, ky);
            kx += 20 + ctx.measureText(words).width + 22;
          }
          ctx.textBaseline = "alphabetic";
        }
      },
      lines: [{ text: fillTpl(CONFIG.map.figure.meta, { areas: N }), strong: true },
              { text: CONFIG.map.figure.regions +
                      (showDots ? " " + CONFIG.map.figure.dots : "") }],
      source: FIGURE_SOURCE + " Results are unweighted."
    });
  }
  const mapName = (ext) => `s3ok-map-regions.${ext}`;
  card.append(el("div", { class: "wx-toolbar-actions wx-result-downloads" },
    pdfButton("Download map (PNG)", () => saveFigure(mapImage(), mapName("png"), "png")),
    pdfButton("Download map (PDF)", () => saveFigure(mapImage(), mapName("pdf"), "pdf"))));

  container.append(el("div", { class: "page wx-explore-page wx-map-page" },
    el("div", { class: "content" }, lead,
       el("section", { class: "wx-result" }, mapHead, bar, card),
       notesCard, scanCard)));

  // Fixed-frame map: the page scrolls normally over it, with no scroll-wheel
  // zoom trap, no drag, no zoom buttons. The state fills the frame.
  const FIXED_FRAME = {
    zoomControl: false, dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false,
    zoomSnap: 0.05
  };
  const stateBounds = L.geoJSON(geo).getBounds().pad(0.02);
  const map = baseMap(mapEl, stateBounds, FIXED_FRAME);
  const refit = () => { map.invalidateSize(); map.fitBounds(stateBounds); };

  // County lines and respondent dots each ride in a pane of their own above
  // the choropleth, deaf to the pointer: hovering a region brings it to the
  // front of its own pane, which would otherwise bury them.
  const pane = (name, z) => {
    const p = map.createPane(name);
    p.style.zIndex = z; p.style.pointerEvents = "none";
    return L.canvas({ pane: name });
  };
  const lineRenderer = pane("s3-lines", 420);
  const dotRenderer = pane("s3-dots", 430);
  L.geoJSON(counties, { renderer: lineRenderer, interactive: false, style: {
    color: cssVar("--map-hairline", "rgba(35, 33, 48, 0.28)"),
    weight: 0.5, fill: false } }).addTo(map);
  let dotLayer = null;
  function syncDots() {
    if (dotLayer) { map.removeLayer(dotLayer); dotLayer = null; }
    if (!showDots) return;
    const ink = cssVar("--text", "#232130"), halo = cssVar("--panel", "#ffffff");
    dotLayer = L.layerGroup(locations.points.map(p => L.circleMarker([p[1], p[0]], {
      renderer: dotRenderer, interactive: false, radius: 1.6,
      stroke: true, color: halo, weight: 0.4, opacity: 0.7,
      fillColor: ink, fillOpacity: 0.55 }))).addTo(map);
  }

  let refitTimer = null;
  new ResizeObserver(() => {
    clearTimeout(refitTimer);
    refitTimer = setTimeout(refit, 120);
  }).observe(pairEl);

  let activeLayer = null;

  const scanCfg = (CONFIG.map && CONFIG.map.scan) || {};
  let place = getParam("place") || "";
  if (place && !values.places[place]) place = "";

  function clearPlace() {
    place = "";
    setParams({ place: null }, true);
    if (activeLayer) activeLayer.clearSelection();
    map.closePopup();
    renderScan();
  }

  function scanRow(cat) {
    const m = M(cat.code);
    return {
      cat,
      values: Object.values(m.values).filter(v => v != null).map(Number),
      // Every region's value with its name, for the marks and their tips.
      points: Object.entries(m.values).filter(([, v]) => v != null)
        .map(([id, v]) => ({ id, v: Number(v), label: fmtVal(cat.code)(v) })),
      here: Number(m.values[place]),
      lo: Number(m.domain[0]), hi: Number(m.domain[1]),
      rank: m.rank[place]
    };
  }
  // The sheet in the order the catalog groups its measures.
  const groupsSeen = [...new Set(cats.map(c => c.group))];
  const scanSections = () => groupsSeen.map(g =>
    ({ group: g, rows: cats.filter(c => c.group === g) }));
  const rankText = (r) => ordinal(r);

  /* The overview sheet as a figure: its key, column heads and every row
   * redrawn with the marks the page uses. */
  function scanImage() {
    const label = (values.places[place] || {}).label || place;
    const sections = scanSections();
    const rowH = 26, groupH = 30, keyH = 30, headH = 22;
    const nRows = sections.reduce((t, s) => t + s.rows.length, 0);
    const css = getComputedStyle(document.body);
    const bg = css.getPropertyValue("--panel").trim() || "#ffffff";
    const draw = (ctx, x, y, w, t) => {
      const SW = 380;
      const X = { label: x, lo: x + 420, strip: x + 432, hi: x + 432 + SW + 12,
                  value: x + w - 110, rank: x + w };
      const text = (str, px, py, font, color, align = "left") => {
        ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align;
        ctx.fillText(str, px, py); ctx.textAlign = "left";
      };
      const diamond = (px, cy) => {
        ctx.fillStyle = t.muted; ctx.beginPath();
        ctx.moveTo(px, cy - 4); ctx.lineTo(px + 4, cy); ctx.lineTo(px, cy + 4);
        ctx.lineTo(px - 4, cy); ctx.closePath(); ctx.fill();
      };
      const dot = (px, cy) => {
        ctx.fillStyle = t.accent; ctx.strokeStyle = bg; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(px, cy, 6.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      };
      let kx = x; const ky = y + 14;
      const keyItem = (mark, words) => {
        mark(kx + 5); text(words, kx + 16, ky + 4, `400 13px ${t.family}`, t.muted);
        ctx.font = `400 13px ${t.family}`; kx += 16 + ctx.measureText(words).width + 26;
      };
      keyItem(px => diamond(px, ky), "the other regions");
      keyItem(px => dot(px, ky), label);
      let cy = y + keyH;
      const headFont = `600 11px ${t.mono}`;
      text("LOWEST REGION TO HIGHEST REGION", X.strip + SW / 2, cy + 12, headFont, t.muted, "center");
      text("VALUE", X.value, cy + 12, headFont, t.muted, "right");
      text(`RANK OF ${N}`, X.rank, cy + 12, headFont, t.muted, "right");
      cy += headH;
      for (const sec of sections) {
        ctx.fillStyle = t.ink; ctx.fillRect(x, cy, w, groupH - 6);
        text(String(sec.group).toUpperCase(), x + 10, cy + 16, `700 12px ${t.family}`, bg);
        cy += groupH;
        sec.rows.forEach((cat, i) => {
          const r = scanRow(cat), mid = cy + rowH / 2;
          if (i % 2) {
            ctx.globalAlpha = 0.05; ctx.fillStyle = t.ink; ctx.fillRect(x, cy, w, rowH);
            ctx.globalAlpha = 1;
          }
          let name = cat.short || cat.label;
          ctx.font = `400 14px ${t.family}`;
          while (ctx.measureText(name).width > 395 && name.length > 8)
            name = name.slice(0, -2).trimEnd() + "…";
          text(name, X.label + 6, mid + 5, `400 14px ${t.family}`, t.ink);
          text(fmtRange(cat.code)(r.lo), X.lo, mid + 4, `400 12px ${t.family}`, t.muted, "right");
          text(fmtRange(cat.code)(r.hi), X.hi, mid + 4, `400 12px ${t.family}`, t.muted);
          const span = r.hi - r.lo;
          const at = (v) => span === 0 ? X.strip + SW / 2
            : X.strip + 6 + (v - r.lo) / span * (SW - 12);
          for (const v of r.values) if (v !== r.here) diamond(at(v), mid);
          dot(at(r.here), mid);
          text(fmtVal(cat.code)(r.here), X.value, mid + 5, `700 14px ${t.family}`, t.ink, "right");
          text(rankText(r.rank), X.rank, mid + 5, `400 13px ${t.family}`, t.muted, "right");
          cy += rowH;
        });
      }
    };
    return figureImage({
      label: "Region overview",
      stem: `${cats.length} measures`,
      title: label,
      body: { height: keyH + headH + sections.length * groupH + nRows * rowH, draw },
      lines: [{ text: fillTpl(CONFIG.map.figure.meta, { areas: N }), strong: true },
              ...[scanCfg.lede, scanCfg.note].filter(Boolean)
                .map(h => ({ text: plainText(h) }))],
      source: FIGURE_SOURCE + " Results are unweighted."
    });
  }
  const scanName = (ext) =>
    `s3ok-overview-${place.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.${ext}`;

  // The key's marks, drawn as the rows draw them; the dot is named for the
  // region on the sheet.
  const keyMarks = (label) => [
    ['<svg width="12" height="12"><path d="M6 2L10 6L6 10L2 6Z" fill="var(--text-muted,#6e737a)"/></svg>',
     "the other regions"],
    ['<svg width="12" height="12"><circle cx="6" cy="6" r="5.5" fill="var(--accent,#443a83)"/></svg>',
     label]
  ];

  // The sheet's own way of choosing a region, at its head, so everything a
  // click on the map does is reachable from the keyboard and from the table
  // itself. It follows the map: a click there shows here.
  const placeSel = el("select", { class: "grouping", id: "place-sel", onchange: () => {
    if (!placeSel.value) { clearPlace(); return; }
    if (activeLayer) activeLayer.selectById(placeSel.value, map, false, true);
  } });
  placeSel.append(el("option", { value: "" }, "Choose a region"),
    ...regionIds.map(id => el("option", { value: id }, values.places[id].label)));

  function renderScan() {
    scanCard.textContent = "";
    clearBtn.style.display = place ? "" : "none";
    placeSel.value = place;
    const label = (values.places[place] || {}).label || "";

    scanCard.append(el("div", { class: "wx-scan-head" },
      el("h3", { class: "wx-scan-sub wx-scan-heading" },
        place ? `Region overview · ${label} · ${cats.length} measures`
              : `Region overview · ${cats.length} measures`),
      el("div", { class: "wx-scan-actions" },
        el("label", { class: "field-label s3-scan-pick-label", for: "place-sel" },
          "Region"),
        placeSel)));

    // Until a region is chosen the sheet says how to choose one and stops.
    if (!place) {
      scanCard.append(el("p", { class: "wx-scan-lede" },
        "Choose a region above, or click one on the map, to see every " +
        "measure for it set against the other four regions."));
      return;
    }

    if (scanCfg.lede) scanCard.append(el("div", { class: "wx-scan-lede", html: scanCfg.lede }));
    scanCard.append(el("p", { class: "wx-scan-key", html: keyMarks(label)
      .map(([mark, text]) => `<span>${mark} ${esc(text)}</span>`).join("") }));

    const table = el("div", { class: "wx-scan-table" });
    table.append(el("div", { class: "wx-scan-cols" },
      el("span", {}), el("span", {}),
      el("span", { class: "wx-scan-colhead wx-scan-center" },
        "Lowest region to highest region"),
      el("span", {}),
      el("span", { class: "wx-scan-colhead wx-scan-right" }, "Value"),
      el("span", { class: "wx-scan-colhead wx-scan-right" }, "Rank")));

    for (const s of scanSections()) {
      table.append(el("div", { class: "wx-scan-group" }, el("span", {}, s.group)));
      s.rows.forEach((cat, i) => {
        const r = scanRow(cat);
        table.append(el("div", {
          class: "wx-scan-row is-static" + (i % 2 ? " is-band" : "")
        },
          el("span", { class: "wx-scan-label" }, cat.short || cat.label),
          el("span", { class: "wx-scan-lo" }, fmtRange(cat.code)(r.lo)),
          el("span", { class: "wx-scan-plot",
            html: scanStripSVG(r.points, place, r.lo, r.hi, stripWidth) }),
          el("span", { class: "wx-scan-hi" }, fmtRange(cat.code)(r.hi)),
          el("span", { class: "wx-scan-value" }, fmtVal(cat.code)(r.here)),
          el("span", { class: "wx-scan-pct" }, rankText(r.rank))));
      });
    }
    scanCard.append(table);
    if (scanCfg.note) scanCard.append(el("div", { class: "wx-scan-note", html: scanCfg.note }));
    scanCard.append(el("div", { class: "wx-toolbar-actions wx-result-downloads" },
      pdfButton("Download overview (PNG)", () => saveFigure(scanImage(), scanName("png"), "png")),
      pdfButton("Download overview (PDF)", () => saveFigure(scanImage(), scanName("pdf"), "pdf"))));
    // The sheet is rebuilt from nothing each time, so its tip rejoins it.
    scanCard.append(markTip);
    fitStrips();
  }

  // The strip column is elastic, so the marks are drawn at the width the
  // column actually got. Measured after layout, because a grid track has no
  // width until then.
  let stripWidth = 210;
  function fitStrips() {
    const cells = scanCard.querySelectorAll(".wx-scan-plot");
    if (!cells.length) return;
    const w = Math.round(cells[0].getBoundingClientRect().width);
    if (!w || Math.abs(w - stripWidth) < 2) return;
    stripWidth = w;
    let i = 0;
    for (const s of scanSections()) {
      for (const cat of s.rows) {
        const r = scanRow(cat);
        cells[i++].innerHTML =
          scanStripSVG(r.points, place, r.lo, r.hi, stripWidth);
      }
    }
  }
  let stripTimer = null;
  new ResizeObserver(() => {
    clearTimeout(stripTimer);
    stripTimer = setTimeout(fitStrips, 120);
  }).observe(scanCard);

  // The tip over a mark in the sheet: one element, moved to whichever mark
  // the pointer is on, in the map tooltip's own style. Delegated on the
  // card, because the marks are redrawn whenever the strips are refitted.
  const markTip = el("div", { class: "s3-mark-tip", role: "tooltip" });
  markTip.hidden = true;
  const moveTip = (e) => {
    const box = scanCard.getBoundingClientRect();
    markTip.style.left = (e.clientX - box.left) + "px";
    markTip.style.top = (e.clientY - box.top - 14) + "px";
  };
  scanCard.addEventListener("mouseover", (e) => {
    const g = e.target.closest(".s3-mark");
    if (!g || !scanCard.contains(g)) return;
    markTip.textContent = g.dataset.tip;
    markTip.hidden = false;
    moveTip(e);
  });
  scanCard.addEventListener("mousemove", (e) => {
    if (!markTip.hidden) moveTip(e);
  });
  scanCard.addEventListener("mouseout", (e) => {
    const g = e.target.closest(".s3-mark");
    if (g && !g.contains(e.relatedTarget)) markTip.hidden = true;
  });

  // The popup's one sentence: how many responses the region gave, from how
  // many panelists, both shipped in the map file.
  function popupStory(id) {
    const m = M(measure);
    const here = m.values[id];
    if (here == null) return "No data for this region.";
    const p = values.places[id] || {};
    return fillTpl(CONFIG.map.popup.count, {
      value: fmtVal(measure)(here),
      people: Number(p.people || 0).toLocaleString()
    });
  }

  let syncing = false;
  function selectPlace(id) {
    place = String(id);
    setParams({ place }, true);
    renderScan();
    if (syncing) return;
    syncing = true;
    if (activeLayer) activeLayer.selectById(place, null, false, false);
    syncing = false;
  }

  // Colors stretch over the measure's own observed range: on a shared 1-5
  // scale five regions a tenth apart would all come out one tone.
  function buildRegions() {
    const m = M(measure);
    return choroLayer(geo, {
      idProp: "REGION",
      // The color is the region's own, so the layer colors by id.
      valueOf: (id) => id,
      color: regionColor,
      // Lighter than a value map, so the county lines and the dots read
      // through the fills.
      fillOpacity: 0.62,
      onSelect: (id) => selectPlace(id),
      // The frame is fixed and the state fills it, so a popup over a northern
      // region has nowhere to pan to; it is let out over the top of the card
      // instead (the map's overflow is visible in engine.css).
      popupOptions: { autoPan: false },
      tooltipHTML: (id) => {
        const v = m.values[id];
        return `<strong>${esc(id)}</strong><br>` +
          `<span class="wx-tt-val">${v == null ? "no data" : fmtVal(measure)(v)} ` +
          `responses</span>` +
          `<br><span class="wx-tip-hint">Click to see every measure</span>`;
      },
      popupHTML: (id) =>
        `<strong>${esc(id)}</strong><br>` + esc(popupStory(id))
    }).addTo(map);
  }

  // The key under the map: each region's swatch, name and response count.
  function drawKey() {
    legendHolder.textContent = "";
    const key = el("p", { class: "wx-scan-key s3-region-key" });
    for (const id of regionIds) {
      key.append(el("span", {},
        el("span", { class: "s3-region-swatch", "aria-hidden": "true",
          style: `background:${regionColor(id)}` }),
        `${values.places[id].label} \u00b7 ` +
        `${Number(values.places[id].responses).toLocaleString()} responses`));
    }
    legendHolder.append(key);
  }

  async function redraw() {
    const cat = byCode.get(measure);
    refit();
    mapKind.textContent = page.map_kind || cat.group;
    mapTitle.textContent = page.map_title || cat.label;

    if (activeLayer) map.removeLayer(activeLayer);
    activeLayer = buildRegions();
    syncDots();

    // The map's text alternative: a spoken label, and every region's value
    // in a table hidden on screen, rebuilt with each measure.
    pairEl.setAttribute("role", "region");
    pairEl.setAttribute("aria-label", cat.label + ": map of Oklahoma's five " +
      "survey regions. The values are in the table that follows.");
    mapAlt.textContent = "";
    mapAlt.append(el("table", {},
      el("caption", {}, cat.label),
      el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "Region"),
        el("th", { scope: "col" }, cat.label))),
      el("tbody", {}, ...Object.entries(values.places)
        .map(([id, p]) => {
          const v = M(measure).values[id];
          return el("tr", {}, el("th", { scope: "row" }, p.label),
            el("td", {}, v == null ? "no data" : fmtVal(measure)(v)));
        }))));
    if (!mapAlt.isConnected) pairEl.after(mapAlt);

    drawKey();

    const notes = CONFIG.map.notes || {};
    notesCard.innerHTML = notes[measure] || "";
    notesCard.style.display = notesCard.innerHTML ? "" : "none";

    // ?place= deep-links a region. The popup opens on the first draw only:
    // reopening it on a repaint would fight the reader who just closed it.
    if (place) {
      activeLayer.selectById(place, map, false, firstDraw);
      firstDraw = false;
    } else {
      renderScan();
    }
  }
  let firstDraw = true;
  pageRestyle = () => redraw();
  await redraw();
};

/* Policy Narratives: what respondents wrote, in their own words, when Wave 1
 * asked them to describe a problem, who or what is causing it and what might
 * fix it. A reading page, so it borrows the question browser's list rather
 * than a spreadsheet: one answer a row, its three parts side by side under
 * the three questions, a region menu and a search over all three parts, ten
 * a page. Nothing is coded or summarized: grouping the answers into themes
 * would show a coding frame that does not exist. */
components.s3_narratives = async function (page, container) {
  const sets = page.sets || [];
  let setId = getParam("set");
  if (!sets.some(s => s.id === setId)) setId = sets[0].id;
  const PAGE_SIZE = 10;
  const norm = (t) => String(t || "").toLowerCase();

  const head = el("div", { class: "wx-result-head" });
  const kind = el("p", { class: "wx-result-survey" });
  const title = el("h2", { class: "wx-question-head wx-result-item" });
  head.append(kind, el("div", { class: "wx-question-headrow" }, title));

  const bar = el("div", { class: "wx-result-controls wx-map-toolbar" });
  const setSel = el("select", { class: "grouping", id: "narr-set", onchange: () => {
    setId = setSel.value;
    setParams({ set: setId }, true);
    load();
  } });
  for (const s of sets)
    setSel.append(el("option", { value: s.id },
      `${s.label} (${Number(s.n).toLocaleString()})`));
  setSel.value = setId;
  const setWrap = el("div");
  setWrap.append(el("label", { class: "field-label", for: "narr-set" },
    "What do you want to read about?"), setSel);
  bar.append(setWrap);

  const card = el("section", { class: "card wx-browse s3-narr" });
  const regionSel = el("select", { class: "grouping", "aria-label": "Region",
    onchange: () => { fRegion = regionSel.value; apply(); } });
  const find = el("input", { type: "search", class: "wx-browse-search",
    placeholder: "Search these responses...", "aria-label": "Search these responses",
    oninput: () => { q = find.value; apply(); } });
  const count = el("span", { class: "wx-browse-count", "aria-live": "polite" });
  const colHead = el("div", { class: "s3-narr-cols", "aria-hidden": "true" },
    ...page.prompts.map(p => el("span", {}, p.question)));
  const list = el("ol", { class: "wx-browse-list" });
  const prev = el("button", { class: "wx-browse-page", type: "button",
    onclick: () => { pageNo--; render(); toTop(); } }, "‹ Previous");
  const next = el("button", { class: "wx-browse-page", type: "button",
    onclick: () => { pageNo++; render(); toTop(); } }, "Next ›");
  const where = el("span", { class: "wx-browse-where" });
  const caption = el("div", { class: "wx-caption wx-explore-caption" });
  const toTop = () => card.scrollIntoView({ behavior: "smooth", block: "start" });

  let data = null, rows = [], filtered = [], fRegion = "", q = "", pageNo = 0;

  // The list as it stands, filters applied, so the download is what the
  // reader is looking at.
  function toCSV(list) {
    const cell = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const lines = list.map(r =>
      [r.region, r.month, r.problem, r.cause, r.solve].map(cell).join(","));
    return ["region,month,problem,cause,possible_fix", ...lines].join("\n") + "\n";
  }

  card.append(
    el("div", { class: "wx-browse-filters" }, regionSel),
    el("div", { class: "wx-browse-searchrow" }, find, count),
    colHead, list,
    el("nav", { class: "wx-browse-pager", "aria-label": "Pages" }, prev, where, next),
    caption,
    el("div", { class: "wx-toolbar-actions wx-result-downloads" },
      pdfButton("Download these responses (CSV)", () => {
        const url = URL.createObjectURL(
          new Blob([toCSV(filtered)], { type: "text/csv" }));
        const a = el("a", { href: url, download: `s3ok-narratives-${setId}.csv` });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      })));

  function apply() {
    const words = norm(q).split(/\s+/).filter(Boolean);
    filtered = rows.filter(r => (!fRegion || r.region === fRegion) &&
      words.every(w => r.hay.includes(w)));
    pageNo = 0;
    render();
  }

  function render() {
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    pageNo = Math.min(Math.max(0, pageNo), pages - 1);
    const n = filtered.length;
    count.textContent = `${n.toLocaleString()} response${n === 1 ? "" : "s"}`;
    list.textContent = "";
    if (!n) list.append(el("li", { class: "wx-browse-none" },
      "No responses match. Try another region or fewer words."));
    for (const r of filtered.slice(pageNo * PAGE_SIZE, (pageNo + 1) * PAGE_SIZE)) {
      const li = el("li", { class: "wx-browse-row s3-narr-row" });
      const meta = el("div", { class: "wx-browse-meta" });
      if (r.region) meta.append(el("span", { class: "wx-browse-survey" }, r.region));
      meta.append(el("span", { class: "wx-browse-topic" }, r.month));
      const parts = el("div", { class: "s3-narr-parts" });
      page.prompts.forEach(p => {
        const text = r[p.key];
        parts.append(el("div", { class: "s3-narr-part" },
          el("p", { class: "s3-narr-label" }, p.label),
          text ? el("p", { class: "s3-narr-text" }, text)
               : el("p", { class: "s3-narr-text is-empty" }, "No answer")));
      });
      li.append(meta, parts);
      list.append(li);
    }
    where.textContent = `Page ${pageNo + 1} of ${pages}`;
    prev.disabled = pageNo === 0;
    next.disabled = pageNo >= pages - 1;
  }

  async function load() {
    const cfg = sets.find(s => s.id === setId);
    data = await fetchJSON(cfg.file);
    rows = data.rows.map(r => ({ ...r,
      hay: norm([r.problem, r.cause, r.solve].filter(Boolean).join(" ")) }));
    kind.textContent = page.fielded || "";
    title.textContent = cfg.heading || cfg.label;
    const regions = [...new Set(rows.map(r => r.region).filter(Boolean))].sort();
    regionSel.textContent = "";
    regionSel.append(el("option", { value: "" }, "All regions"),
      ...regions.map(r => el("option", { value: r }, r)));
    fRegion = ""; q = ""; find.value = "";
    caption.textContent = "";
    caption.append(
      el("p", { class: "wx-caption-meta" }, fillTpl(page.caption.meta,
        { n: Number(data.n).toLocaleString(), label: norm(cfg.label) })),
      el("p", { class: "wx-caption-bars" }, page.caption.note),
      el("p", { class: "wx-caption-provenance", html: CONFIG.explore_caption.provenance }),
      el("p", { class: "wx-caption-ref", html: fillTpl(page.caption.reference, {
        variables: (cfg.variables || []).map(v => `<code>${esc(v)}</code>`).join(", ") }) }));
    apply();
  }

  container.append(el("div", { class: "page wx-explore-page" },
    el("div", { class: "content" }, pageHead(page),
       el("section", { class: "wx-result" }, head, bar, card))));
  await load();
};

/* Landing page — the program before its results, in seven steps down the
 * page: identity and title, a one-sentence introduction, the statement as the
 * loudest thing on it, what the project is, its scale, why it matters, and
 * the ways into the data. No chart: a teaser plot invites a reader to
 * judge the whole project on whichever question happens to be on it.
 * Hierarchy comes from type, whitespace, rules and one tinted band rather
 * than from boxes; the explore cards are the only cards, because they are
 * the only things on the page to click. Every word is authored in the
 * builder. */
components.wx_landing = async function (page, container) {
  const h = page.hero || {};

  const hero = el("section", { class: "wx-landing-hero" });
  if (h.eyebrow) hero.append(el("p", { class: "wx-eyebrow" }, h.eyebrow));
  // A headline given as lines keeps those breaks; each line still wraps on
  // its own when the screen is narrower than it.
  const title = el("h1", { class: "wx-landing-title" });
  for (const line of [].concat(h.headline || CONFIG.project.title))
    title.append(el("span", { class: "wx-title-line" }, line));
  hero.append(title);

  // Below the title: the words on the left and the map of the panel on the
  // right.
  const top = el("div", { class: "wx-landing-top" });
  const words = el("div", { class: "wx-landing-words" });
  if (h.intro) words.append(el("p", { class: "wx-landing-intro" }, h.intro));
  // The data gap, set as a statement in the page's display type between two
  // rules - large enough to be read in a five-second scan, and deliberately
  // not boxed, so it cannot be mistaken for something to click.
  if (h.statement) {
    const stmt = el("p", { class: "wx-landing-statement" });
    [].concat(h.statement).forEach(line =>
      stmt.append(el("span", { class: "wx-statement-line" }, line)));
    words.append(stmt);
  }
  if (h.description)
    words.append(el("p", { class: "wx-landing-desc" }, h.description,
      ...(h.description_close ? [" ", el("strong", {}, h.description_close)] : [])));
  top.append(words);
  if (page.map) {
    const [pts, regions, counties] = await Promise.all([
      fetchJSON(page.map.points), fetchJSON(page.map.regions),
      fetchJSON(page.map.counties)]);
    top.classList.add("s3-landing-map");
    top.append(heroMap(page.map, pts.points, regions, counties));
  }
  hero.append(top);

  // One band, not four cards: hairlines between the figures and a tint
  // behind them, so the scale reads as one fact about the program.
  let stats = null;
  if ((page.stats || []).length) {
    stats = el("section", { class: "wx-stats", "aria-label": "Project at a glance" });
    for (const st of page.stats) {
      const cell = el("div", { class: "wx-stat" });
      cell.append(el("p", { class: "wx-stat-value" }, st.value),
                  el("p", { class: "wx-stat-label" }, st.label));
      stats.append(cell);
    }
  }

  // A pair rather than stacked: two halves of one argument.
  const sections = (page.sections || []).map(sec => {
    const wrap = el("section", { class: "wx-sec" });
    const cols = el("div", { class: "wx-sec-cols" });
    for (const col of (sec.columns || [sec])) {
      const half = el("div", { class: "wx-sec-col" });
      if (col.lead) half.append(el("h2", { class: "wx-sec-lead" }, col.lead));
      const box = el("div", { class: "wx-sec-prose" });
      for (const para of [].concat(col.body || [])) box.append(el("p", {}, para));
      half.append(box);
      cols.append(half);
    }
    if (!sec.columns) cols.classList.add("wx-sec-wide");
    wrap.append(cols);
    return wrap;
  });

  let explore = null;
  const ex = page.explore;
  if (ex) {
    explore = el("section", { class: "wx-explore" });
    if (ex.heading) explore.append(el("h2", { class: "wx-explore-heading" }, ex.heading));
    if (ex.intro) explore.append(el("p", { class: "wx-explore-lede" }, ex.intro));
    const grid = el("nav", { class: "wx-explore-cards" +
      ((ex.cards || []).length === 4 ? " s3-four" : ""),
      "aria-label": ex.heading || "Explore" });
    for (const c of (ex.cards || [])) {
      const target = CONFIG.pages.find(p => p.id === c.page);
      if (!target) continue;
      const a = el("a", { class: "wx-explore-card", href: "#" + target.id });
      a.append(el("h3", {}, c.label || target.label),
               el("p", {}, c.body || target.blurb || ""));
      if (c.cta) a.append(el("span", { class: "wx-explore-cta" }, c.cta));
      grid.append(a);
    }
    explore.append(grid);
  }

  container.append(el("div", { class: "page wx-landing-page" },
    el("div", { class: "content" },
      ...[hero, stats, ...sections, explore].filter(Boolean))));
};

/* The landing page's map: the panel, where it lives. Every panelist is a dot
 * on a bare outline of Oklahoma, colored along the viridis ramp from west to
 * east so the map picks up the rule under the masthead. On arrival the county
 * lines fade up and the dots drop in as a sweep across the state, each
 * settling with a small overshoot; afterwards a dot here and there sends out
 * a ring, so the page keeps a pulse without anything moving position. A
 * reader who has asked for less motion gets the finished picture at once and
 * no rings.
 *
 * Drawn on a canvas, because three and a half thousand dots animating at once
 * are more than SVG should be asked to move. The locations are the displaced
 * ones Explore Regions draws, and carry nothing but a position. */
function heroMap(cfg, points, regions, counties) {
  const fig = el("figure", { class: "wx-dotfield s3-heromap" });
  if (cfg.title) fig.append(el("p", { class: "wx-dotfield-title" }, cfg.title));
  const canvas = el("canvas", { class: "s3-heromap-canvas", role: "img",
    "aria-label": [cfg.title, cfg.caption].filter(Boolean).join(". ") });
  fig.append(canvas);
  if (cfg.caption)
    fig.append(el("figcaption", { class: "wx-dotfield-caption" }, cfg.caption));

  // The state's extent, from the region shapes.
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const rings = (geo) => geo.features.flatMap(f =>
    f.geometry.type === "Polygon" ? f.geometry.coordinates
      : f.geometry.coordinates.flat());
  const regionRings = rings(regions), countyRings = rings(counties);
  for (const ring of regionRings) for (const [x, y] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  // Longitude shrinks with latitude; one factor for the whole state is
  // close enough at this size.
  const kx = Math.cos((y0 + y1) / 2 * Math.PI / 180);
  const aspect = ((x1 - x0) * kx) / (y1 - y0);
  canvas.style.aspectRatio = String(aspect);

  const reduced = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dark = () => document.documentElement.dataset.theme === "dark";
  const grey = () => document.documentElement.dataset.theme === "greyscale";
  // Each dot: where it is, how far east (its color and its turn in the
  // sweep), and a little randomness so the sweep has a ragged front.
  const dots = points.map(([lon, lat]) => {
    const t = (lon - x0) / (x1 - x0);
    return { lon, lat, t, delay: 350 + t * 1500 + Math.random() * 320,
             drop: 10 + Math.random() * 16 };
  });
  // Yellow vanishes on a light page, so the ramp stops short of it there.
  const colorOf = (t) => grey() ? "#1a1a1a"
    : rampColor(VIRIDIS_STOPS, dark() ? 0.18 + t * 0.82 : t * 0.86);
  const easeOutBack = (p) => {
    const c = 1.9;
    return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2);
  };

  let W = 0, H = 0, ratio = 1, start = null, raf = null;
  const ripples = [];
  let nextRipple = 0;
  const px = (lon) => (lon - x0) / (x1 - x0) * W;
  const py = (lat) => (y1 - lat) / (y1 - y0) * H;

  function size() {
    const box = canvas.getBoundingClientRect();
    if (!box.width) return false;
    ratio = window.devicePixelRatio || 1;
    W = box.width; H = box.width / aspect;
    canvas.width = Math.round(W * ratio); canvas.height = Math.round(H * ratio);
    return true;
  }

  function trace(ctx, ring) {
    ring.forEach(([x, y], i) => i ? ctx.lineTo(px(x), py(y)) : ctx.moveTo(px(x), py(y)));
    ctx.closePath();
  }

  function frame(now) {
    if (!canvas.isConnected) { raf = null; return; }
    if (start == null) start = now;
    const t = reduced ? 1e9 : now - start;
    const ctx = canvas.getContext("2d");
    const css = getComputedStyle(document.body);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // The state, fading up under the dots: a faint fill, county hairlines,
    // region borders a little stronger.
    const up = Math.min(1, t / 700);
    ctx.lineJoin = "round";
    ctx.globalAlpha = up;
    ctx.fillStyle = css.getPropertyValue("--panel").trim() || "#fff";
    ctx.beginPath(); regionRings.forEach(r => trace(ctx, r)); ctx.fill();
    ctx.strokeStyle = css.getPropertyValue("--panel-border").trim() || "#ddd";
    ctx.lineWidth = 0.6;
    ctx.beginPath(); countyRings.forEach(r => trace(ctx, r)); ctx.stroke();
    ctx.strokeStyle = css.getPropertyValue("--control-border").trim() || "#bbb";
    ctx.lineWidth = 1.2;
    ctx.beginPath(); regionRings.forEach(r => trace(ctx, r)); ctx.stroke();

    // The dots, each dropping into place when the sweep reaches it.
    const r = Math.max(1.3, W / 330);
    let settled = true;
    for (const d of dots) {
      const p = (t - d.delay) / 520;
      if (p <= 0) { settled = false; continue; }
      const q = Math.min(1, p), e = easeOutBack(q);
      if (q < 1) settled = false;
      ctx.globalAlpha = Math.min(1, q * 1.6) * 0.78;
      ctx.fillStyle = colorOf(d.t);
      ctx.beginPath();
      ctx.arc(px(d.lon), py(d.lat) - (1 - e) * d.drop, r * Math.max(0, e), 0, Math.PI * 2);
      ctx.fill();
    }

    // Once everyone has arrived, the pulse: a ring from one dot at a time.
    if (settled && !reduced) {
      if (now > nextRipple) {
        ripples.push({ d: dots[Math.floor(Math.random() * dots.length)], t0: now });
        nextRipple = now + 140 + Math.random() * 260;
      }
      for (let i = ripples.length - 1; i >= 0; i--) {
        const age = (now - ripples[i].t0) / 1100;
        if (age >= 1) { ripples.splice(i, 1); continue; }
        const d = ripples[i].d;
        ctx.globalAlpha = (1 - age) * 0.7;
        ctx.strokeStyle = colorOf(d.t);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(px(d.lon), py(d.lat), r + age * 13, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1 - age;
        ctx.fillStyle = colorOf(d.t);
        ctx.beginPath();
        ctx.arc(px(d.lon), py(d.lat), r * (1 + (1 - age) * 0.9), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    raf = reduced ? null : requestAnimationFrame(frame);
  }

  const kick = () => {
    if (!size()) return;
    if (raf == null) raf = requestAnimationFrame(frame);
  };
  // Sized once it is on the page, and again whenever its column changes
  // width; the animation does not restart on a resize.
  new ResizeObserver(kick).observe(canvas);
  return fig;
}

/* Static page (About): builder-authored HTML from config, under the same
 * head every other page carries, so it opens with its title rather than with
 * a heading buried in the card. */
components.static_page = async function (page, container) {
  container.append(el("div", { class: "page" },
    el("div", { class: "content" }, pageHead(page),
      el("div", { class: "card wx-static", html: page.html || "" }))));
};

/* A page opens with what it is, then how to use it: a title that is a phrase
 * rather than an instruction, and the paragraph under it that instructs. Both
 * are authored in the builder like every other sentence on the site; a page
 * without a title renders the paragraph alone, and a page with neither
 * renders an empty head that takes no space. */
function pageHead(page, fallback) {
  const wrap = el("div", { class: "wx-page-head" });
  if (page.title) wrap.append(el("h1", { class: "wx-page-title" }, page.title));
  // An intro given as a list is set as that many paragraphs.
  for (const text of [].concat(page.intro || fallback || []))
    wrap.append(el("p", { class: "wx-explore-intro" }, text));
  return wrap;
}

/* ------------------------------------------------------------- routing -- */

function currentPageId() {
  return location.hash.replace(/^#/, "") || CONFIG.pages[0].id;
}

// Set by a page that can repaint itself in a new theme without being rebuilt,
// so changing colors keeps what the reader has done there (filters, search,
// a chosen region). Cleared on every page change.
let pageRestyle = null;

// The hash the page on screen was drawn for.
let shownHash = location.hash;

async function renderPage() {
  pageRestyle = null;
  shownHash = location.hash;
  const app = document.getElementById("app");
  const id = currentPageId();
  const page = CONFIG.pages.find(p => p.id === id) || CONFIG.pages[0];

  document.querySelectorAll("#nav-pages a").forEach(a =>
    a.classList.toggle("active", a.getAttribute("href") === "#" + page.id));
  document.querySelectorAll("#nav-pages .nav-group").forEach(g => {
    g.classList.remove("open");
    g.querySelector(".nav-group-btn").classList.toggle("active",
      !!g.querySelector(`a[href="#${page.id}"]`));
  });

  if (activeChart) { activeChart.destroy(); activeChart = null; }
  app.textContent = "";
  const renderer = components[page.component];
  if (!renderer) {
    app.append(el("div", { class: "error" }, `Unknown component: ${page.component}`));
    return;
  }
  try {
    await renderer(page, app);
  } catch (err) {
    console.error(err);
    app.append(el("div", { class: "error" }, `Failed to render "${page.label}": ${err.message}`));
  }
}

/* ---- viewer theme switcher ---------------------------------------------- */
// Themes restyle chrome; data colors come from the color scheme, except that
// the greyscale theme repaints map ramps in greys (dataStops).
const THEMES = [
  { id: "s3ok", label: "S3OK", swatch: "#443A83" },
  { id: "dark", label: "Dark", swatch: "#0f172a" },
  { id: "greyscale", label: "Greyscale (high contrast)", swatch: "#000000" }
];

function applyTheme(id, { rerender = false } = {}) {
  document.documentElement.dataset.theme = id;
  // Chart text (titles, ticks, legends) follows the theme's ink so dark
  // themes don't render Chart.js's default grey-on-dark.
  if (window.Chart)
    Chart.defaults.color = getComputedStyle(document.body).getPropertyValue("--text").trim() || "#666";
  try { sessionStorage.setItem("engine-theme", id); } catch { /* private mode */ }
  document.querySelectorAll("#theme-menu button").forEach(b =>
    b.classList.toggle("active", b.dataset.theme === id));
  // Charts capture label colors at creation — redraw the page so they follow.
  if (rerender) { if (pageRestyle) pageRestyle(); else renderPage(); }
}

function themeSwitcher() {
  const wrap = el("div", { id: "theme-switch" });
  const btn = el("button", { id: "theme-btn", title: "Adjust colors",
    onclick: () => menu.classList.toggle("open") }, "◐ Adjust colors");
  const menu = el("div", { id: "theme-menu" });
  for (const t of THEMES) {
    menu.append(el("button", { "data-theme": t.id, onclick: () => {
      applyTheme(t.id, { rerender: true });
      menu.classList.remove("open");
    } }, el("span", { class: "swatch", style: `background:${t.swatch}` }), t.label));
  }
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) menu.classList.remove("open");
  });
  wrap.append(btn, menu);
  return wrap;
}

async function boot() {
  try {
    CONFIG = await fetchJSON("config.json");
  } catch (err) {
    document.getElementById("app").innerHTML =
      `<div class="error">Could not load bundle config from <code>${esc(BUNDLE)}config.json</code>. ` +
      `Serve the built site over HTTP: the page fetches its data, which a file:// address blocks.</div>`;
    return;
  }
  document.title = CONFIG.project.title;
  // Brand lockup: wordmark + optional small institutional subtitle line.
  const navTitle = document.getElementById("nav-title");
  navTitle.textContent = "";
  const brandName = el("span", { class: "brand-name" }, CONFIG.project.nav_title || CONFIG.project.title);
  // The GitHub Pages build says so, so a link to it is not taken for the
  // production site.
  if (CONFIG.project.beta) brandName.append(el("span", { class: "brand-beta" }, "Beta"));
  navTitle.append(brandName);
  if (CONFIG.project.nav_subtitle)
    navTitle.append(el("span", { class: "brand-sub" }, CONFIG.project.nav_subtitle));
  const nav = document.getElementById("nav-pages");
  // Featured pages render as links; pages carrying nav_group fold into a
  // labeled dropdown at the position of the group's first member.
  const navGroups = new Map();
  const closeMenus = () => nav.querySelectorAll(".nav-group.open")
    .forEach(g => { g.classList.remove("open");
      g.querySelector(".nav-group-btn").setAttribute("aria-expanded", "false"); });
  for (const p of CONFIG.pages) {
    if (p.hidden) continue; // a page reached by link rather than from the menu
    if (!p.nav_group) { nav.append(el("a", { href: "#" + p.id }, p.label)); continue; }
    if (!navGroups.has(p.nav_group)) {
      const wrap = el("div", { class: "nav-group" });
      const btn = el("button", { class: "nav-group-btn", type: "button",
        "aria-expanded": "false", "aria-haspopup": "true",
        onclick: (e) => {
          e.stopPropagation();
          const open = wrap.classList.contains("open");
          closeMenus();
          if (!open) {
            // Fixed positioning from the button's viewport rect: the
            // navbar scrolls horizontally (overflow-x), which clips
            // absolutely-positioned children — fixed escapes any ancestor
            // overflow in every theme.
            const r = btn.getBoundingClientRect();
            menu.style.left = Math.round(r.left) + "px";
            menu.style.top = Math.round(r.bottom) + "px";
            wrap.classList.add("open");
            btn.setAttribute("aria-expanded", "true");
          }
        } }, p.nav_group, el("span", { class: "nav-caret" }, " ▾"));
      const menu = el("div", { class: "nav-menu", role: "menu" });
      wrap.append(btn, menu);
      nav.append(wrap);
      navGroups.set(p.nav_group, menu);
    }
    navGroups.get(p.nav_group).append(el("a", { href: "#" + p.id, onclick: closeMenus }, p.label));
  }
  document.addEventListener("click", closeMenus);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });
  // Theme precedence: ?theme= deep link > viewer's per-tab pick > bundle default.
  let saved = null;
  try { saved = sessionStorage.getItem("engine-theme"); } catch { /* private mode */ }
  const themeParam = new URLSearchParams(location.search).get("theme");
  const initialTheme = [themeParam, saved, CONFIG.theme && CONFIG.theme.default, "s3ok"]
    .find(t => t && THEMES.some(x => x.id === t));
  if (CONFIG.theme && CONFIG.theme.allow_viewer_switch !== false) {
    document.getElementById("navbar").append(themeSwitcher());
  }
  applyTheme(initialTheme);
  // Guarded: a blocked/failed vendor script must not freeze boot on the
  // loading screen — chartless pages still render, chart pages fail visibly
  // through renderPage's per-component catch.
  if (window.Chart) Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  // Config-driven footer: a clear end-of-page bookend (navbar colors).
  if (CONFIG.footer && !document.getElementById("site-footer")) {
    const f = CONFIG.footer;
    const brand = el("div", { class: "foot-brand" },
      el("span", { class: "brand-name" },
         f.name || CONFIG.project.nav_title || CONFIG.project.title));
    if (f.tagline) brand.append(el("p", { class: "foot-tag" }, f.tagline));
    const cols = el("div", { class: "foot-inner" }, brand);
    if (f.links_html) cols.append(el("nav", { class: "foot-links", html: f.links_html }));
    const meta = el("div", { class: "foot-meta" });
    if (f.funding) meta.append(el("p", {}, f.funding));
    meta.append(el("p", { class: "foot-build" }, "BUILD " + (window.WX_BUILD || "dev")));
    cols.append(meta);
    document.body.append(el("footer", { id: "site-footer" }, cols));
  }
  window.addEventListener("hashchange", renderPage);
  // Back and Forward within a page change only the query, which fires no
  // hashchange; the page is drawn again from the address it now shows, so
  // the selection, the chart and the URL agree. A step across pages changes
  // the hash, and hashchange draws that.
  window.addEventListener("popstate", () => {
    if (location.hash === shownHash) renderPage();
  });
  await renderPage();
}

boot();
