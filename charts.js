/* ============================================================================
   charts.js -- a small, dependency-free SVG line chart.

   Deliberately no charting library: this dashboard should keep working for
   years with nothing to install or update. Everything here is plain SVG + DOM.

   Public API:
     const chart = TrendChart(hostEl, tooltipEl);
     chart.render({ data, series, yearRange, scale, milestones });

   - data:       [{year, <metricKey>: number|null, ...}]
   - series:     [{key, label, color, unit}]  (unit: 'money' | 'usd' | 'count')
   - yearRange:  [minYear, maxYear]
   - scale:      'linear' | 'log'
   - milestones: [{year, event}]
   ========================================================================== */

(function () {
const SVGNS = "http://www.w3.org/2000/svg";
function el(name, attrs) {
  const n = document.createElementNS(SVGNS, name);
  for (const k in (attrs || {})) n.setAttribute(k, attrs[k]);
  return n;
}

/* ---- value formatting ----------------------------------------------------- */
function fmtMoney(v) {            // v is in US$ millions
  if (v == null) return "n/a";
  const a = Math.abs(v), s = v < 0 ? "-" : "";
  if (a >= 1000) return `${s}$${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}B`;
  if (a >= 1) return `${s}$${a.toFixed(0)}M`;
  return `${s}$${(a * 1000).toFixed(0)}K`;
}
function fmtUsd(v) { return v == null ? "n/a" : `$${v.toFixed(2)}`; }
function fmtCount(v) { return v == null ? "n/a" : Math.round(v).toLocaleString(); }
function fmtIndex(v) { return v == null ? "n/a" : Math.round(v).toLocaleString(); }
function fmtPct(v) { return v == null ? "n/a" : `${v.toFixed(2)}%`; }
function formatterFor(unit) {
  return unit === "usd" ? fmtUsd : unit === "count" ? fmtCount : unit === "index" ? fmtIndex : unit === "pct" ? fmtPct : fmtMoney;
}

/* ---- tick helpers --------------------------------------------------------- */
function niceTicks(min, max, count) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step0 = Math.pow(10, Math.floor(Math.log10(span / count)));
  const err = (span / count) / step0;
  const step = err >= 7.5 ? 10 * step0 : err >= 3 ? 5 * step0 : err >= 1.5 ? 2 * step0 : step0;
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let t = start; t <= max + step * 0.5; t += step) ticks.push(+t.toFixed(10));
  return ticks;
}
function logTicks(min, max) {
  const lo = Math.floor(Math.log10(min)), hi = Math.ceil(Math.log10(max));
  const ticks = [];
  for (let e = lo; e <= hi; e++) ticks.push(Math.pow(10, e));
  return ticks.filter(t => t >= min * 0.95 && t <= max * 1.05);
}

function TrendChart(host, tip) {
  const W = 920, H = 400, M = { l: 66, r: 18, t: 14, b: 46 };
  const plotW = W - M.l - M.r, plotH = H - M.t - M.b;

  function render(opts) {
    const { data, series, yearRange, scale, milestones, bands } = opts;
    // Replace only the SVG -- the tooltip element lives inside `host` and must
    // survive re-renders (clearing innerHTML would detach it).
    const prev = host.querySelector("svg");
    if (prev) prev.remove();
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });

    const [y0, y1] = yearRange;
    const rows = data.filter(d => d.year >= y0 && d.year <= y1);

    // y-domain across all visible series (ignore null; for log, ignore <=0)
    let vmin = Infinity, vmax = -Infinity;
    for (const s of series)
      for (const d of rows) {
        const v = d[s.key];
        if (v == null) continue;
        if (scale === "log" && v <= 0) continue;
        if (v < vmin) vmin = v;
        if (v > vmax) vmax = v;
      }
    if (!isFinite(vmin)) { vmin = 0; vmax = 1; }

    const useLog = scale === "log" && vmin > 0;
    if (useLog) { vmin = Math.pow(10, Math.floor(Math.log10(vmin))); vmax = Math.pow(10, Math.ceil(Math.log10(vmax))); }
    else {
      const pad = (vmax - vmin) * 0.08 || Math.abs(vmax) * 0.08 || 1;
      if (vmin >= 0) vmin = 0;          // anchor zero when all data is non-negative
      else vmin = vmin - pad;           // give breathing room below negative values
      vmax = vmax + pad;
    }

    const xOf = yr => M.l + (yearRange[1] === yearRange[0] ? 0 : (yr - y0) / (y1 - y0) * plotW);
    const yOf = v => {
      if (useLog) return M.t + plotH - (Math.log10(v) - Math.log10(vmin)) / (Math.log10(vmax) - Math.log10(vmin)) * plotH;
      return M.t + plotH - (v - vmin) / (vmax - vmin) * plotH;
    };

    // recession / event bands (drawn first, sit behind gridlines and series)
    if (bands && bands.length) {
      const gBands = el("g", { class: "bands" });
      for (const b of bands) {
        if (b.end < y0 || b.start > y1) continue;
        const x0 = xOf(Math.max(b.start, y0));
        const x1 = xOf(Math.min(b.end, y1)) + (b.start === b.end ? (plotW / Math.max(y1 - y0, 1)) : 0);
        gBands.appendChild(el("rect", {
          class: "recession-band", x: x0, y: M.t, width: Math.max(x1 - x0, 1), height: plotH,
        }));
      }
      svg.appendChild(gBands);
    }

    // gridlines + y axis
    const yticks = useLog ? logTicks(vmin, vmax) : niceTicks(vmin, vmax, 6);
    const fmt = formatterFor(series[0] ? series[0].unit : "money");
    const gAxis = el("g", { class: "axis" });
    for (const t of yticks) {
      const y = yOf(t);
      gAxis.appendChild(el("line", { class: "gridline", x1: M.l, x2: W - M.r, y1: y, y2: y }));
      const tx = el("text", { x: M.l - 8, y: y + 4, "text-anchor": "end" });
      tx.textContent = fmt(t);
      gAxis.appendChild(tx);
    }
    // x axis (years)
    const span = y1 - y0;
    const xstep = span > 80 ? 20 : span > 40 ? 10 : span > 16 ? 5 : span > 6 ? 2 : 1;
    for (let yr = Math.ceil(y0 / xstep) * xstep; yr <= y1; yr += xstep) {
      const x = xOf(yr);
      const tx = el("text", { x, y: H - M.b + 20, "text-anchor": "middle" });
      tx.textContent = yr;
      gAxis.appendChild(tx);
    }
    gAxis.appendChild(el("line", { x1: M.l, x2: W - M.r, y1: M.t + plotH, y2: M.t + plotH }));
    svg.appendChild(gAxis);

    // series lines (break the path at nulls / non-positive-in-log)
    for (const s of series) {
      let dpath = "", pen = false;
      for (const d of rows) {
        const v = d[s.key];
        const ok = v != null && !(useLog && v <= 0);
        if (!ok) { pen = false; continue; }
        dpath += `${pen ? "L" : "M"}${xOf(d.year).toFixed(1)},${yOf(v).toFixed(1)} `;
        pen = true;
      }
      svg.appendChild(el("path", { class: "series-line", d: dpath, stroke: s.color }));
    }

    // milestone markers along the baseline
    const baseY = M.t + plotH;
    const gMile = el("g");
    for (const m of (milestones || [])) {
      if (m.year < y0 || m.year > y1) continue;
      const x = xOf(m.year);
      const tri = el("path", { class: "mileMark", d: `M${x - 5},${baseY + 7} L${x + 5},${baseY + 7} L${x},${baseY - 1} Z` });
      tri.addEventListener("mouseenter", e => showTip(e, `<div class="ttyear">${m.year}</div><div>${m.event}</div>`));
      tri.addEventListener("mouseleave", hideTip);
      gMile.appendChild(tri);
    }
    svg.appendChild(gMile);

    // hover layer: crosshair + nearest-year dots + tooltip
    const cross = el("line", { class: "crosshair", y1: M.t, y2: M.t + plotH, x1: 0, x2: 0, opacity: 0 });
    svg.appendChild(cross);
    const dots = el("g");
    svg.appendChild(dots);
    const overlay = el("rect", { x: M.l, y: M.t, width: plotW, height: plotH, fill: "transparent" });
    overlay.style.cursor = "crosshair";
    overlay.addEventListener("mousemove", ev => {
      const pt = localPoint(svg, ev);
      const yr = Math.round(y0 + (pt.x - M.l) / plotW * (y1 - y0));
      const row = rows.find(d => d.year === yr);
      if (!row) return;
      const x = xOf(yr);
      cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("opacity", 1);
      dots.innerHTML = "";
      const band = (bands || []).find(b => yr >= b.start && yr <= b.end);
      let html = `<div class="ttyear">${yr}</div>`;
      if (band && band.name) html += `<div class="ttband">${band.name} (${band.start}${band.end !== band.start ? "–" + band.end : ""})</div>`;
      for (const s of series) {
        const v = row[s.key];
        html += `<div class="ttrow"><span><span class="dot" style="background:${s.color}"></span>${s.label}</span><b>${formatterFor(s.unit)(v)}</b></div>`;
        if (v != null && !(useLog && v <= 0)) {
          const c = el("circle", { cx: x, cy: yOf(v), r: 3.5, fill: s.color, stroke: "#fff", "stroke-width": 1.5 });
          dots.appendChild(c);
        }
      }
      const hostRect = host.getBoundingClientRect();
      tip.innerHTML = html;
      tip.style.left = (x / W * hostRect.width) + "px";
      tip.style.top = (M.t / H * hostRect.height) + "px";
      tip.style.opacity = 1;
    });
    overlay.addEventListener("mouseleave", () => { cross.setAttribute("opacity", 0); dots.innerHTML = ""; hideTip(); });
    svg.appendChild(overlay);

    host.appendChild(svg);
  }

  function showTip(ev, html) {
    const hostRect = host.getBoundingClientRect();
    tip.innerHTML = html;
    tip.style.left = (ev.clientX - hostRect.left) + "px";
    tip.style.top = (ev.clientY - hostRect.top) + "px";
    tip.style.opacity = 1;
  }
  function hideTip() { tip.style.opacity = 0; }

  return { render };
}

// map a mouse event to SVG viewBox coordinates
function localPoint(svg, ev) {
  const r = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  return { x: (ev.clientX - r.left) / r.width * vb.width, y: (ev.clientY - r.top) / r.height * vb.height };
}

window.TrendChart = TrendChart;
})();
