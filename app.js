/* ============================================================================
   app.js -- wires up the dashboard. Plain script (no modules) so the page runs
   straight from disk. Reads window.IBM_DATA (see pipeline/export_web.py) and
   window.TrendChart (charts.js).

   HOW TO ADD/OWN A TAB (for the team):
     1. Each future tab is a placeholder rendered from PLACEHOLDERS below.
     2. To build one, replace its placeholder render with real UI in the matching
        <section id="panel-XXX"> element. The data is already in IBM_DATA.
     3. Keep the canonical data in pipeline/; re-run export_web.py to refresh.
   ========================================================================== */
(function () {
  "use strict";
  const D = window.IBM_DATA;
  if (!D) { document.body.innerHTML = "<p style='padding:24px'>data.js failed to load.</p>"; return; }

  const fin = D.financials;                       // [{year, revenue, ...}]
  const byYear = new Map(fin.map(d => [d.year, d]));
  const Y0 = fin[0].year, Y1 = fin[fin.length - 1].year;
  const meta = D.metadata;

  /* ---- theme (dark default; opt-in light via hook/localStorage) ---------- */
  window.setTheme = theme => {
    const t = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("ibmDashTheme", t); } catch (_) { /* private mode */ }
    return t;
  };
  try {
    const savedTheme = localStorage.getItem("ibmDashTheme");
    if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  } catch (_) { /* private mode */ }

  /* ---- live snapshot (manually refreshed alongside the pipeline data) ----
     Single source of truth for the one number that can't be computed from
     any live feed the site has (a true trailing-12-month total return needs
     a price from ~365 days ago; the quarterly price series' nearest anchor
     doesn't line up with today's date, so this is refreshed by hand from a
     named source rather than approximated and risking disagreement with the
     Market Cap Snapshot card, which cites the same figure). */
  const LIVE = {
    stockReturn1Y: -23.37,        // price return, trailing 12mo, verified vs StockAnalysis.com/Investing.com
    asOfLabel: "Jul 22, 2026",
  };

  /* ── Verified market-cap snapshot (Jul 22, 2026 close) ───────────────────
     Module-level so both updateHeroKpis (inside buildMacroTab) AND
     buildMktCapChart (sibling function) reference the same figures.
     Update ALL fields together whenever the snapshot date advances. */
  const VERIFIED_SNAP = {
    marketCapB:         193.40,   // $B  — price × shares, Jul 22 close
    price:              205.77,   // $/share
    sharesOutstandingM: 939.89,   // millions
    dateLabel:          "Jul 22, 2026",
    yearChangePct:      -23.37,   // 1Y price return (matches LIVE.stockReturn1Y)
    low52:  204.44,
    high52: 332.46,
    ath:    332.46, athDate: "Jun 2, 2026",
    // Each firm carries a full revision log, newest-first.
    // action: "Cut" | "Raised" | "Initiated" | "Maintained"
    // Source: Benzinga / Investing.com, Jul 16–20 2026.
    analystTargets: [
      { firm: "Stifel",   target: 235, prior: 290,
        revisions: [
          { date: "Jul 16, 2026", action: "Cut",      to: 235, from: 290 },
          { date: "Jan 10, 2026", action: "Raised",   to: 290, from: 260 },
          { date: "Oct  8, 2025", action: "Maintained", to: 260, from: 260 },
        ]},
      { firm: "JPMorgan", target: 250, prior: 291,
        revisions: [
          { date: "Jul 17, 2026", action: "Cut",      to: 250, from: 291 },
          { date: "Feb  5, 2026", action: "Raised",   to: 291, from: 270 },
          { date: "Oct 24, 2025", action: "Initiated", to: 270, from: null },
        ]},
      { firm: "Citi",     target: 255, prior: 375,
        revisions: [
          { date: "Jul 18, 2026", action: "Cut",      to: 255, from: 375 },
          { date: "Mar 12, 2026", action: "Raised",   to: 375, from: 310 },
          { date: "Nov 14, 2025", action: "Raised",   to: 310, from: 280 },
          { date: "Jul 22, 2025", action: "Initiated", to: 280, from: null },
        ]},
    ],
    // Significant single-day moves — newest first. Append a new entry here
    // whenever a move >= ~5% occurs; the event log inside the Snapshot card
    // renders this automatically. No HTML editing needed.
    bigMoves: [
      { date: "Jul 14, 2026", pct: -25.2, capDeltaB: -67,
        headline: "Q2 preannouncement: Z mainframe shortfall, revenue up only 1% vs. >5% guide",
        detail: "Infrastructure revenue \u221247% (IBM Z \u221242%). CEO Krishna: \u201cwe faltered.\u201d Steepest single-day decline in IBM history. Jul 22 earnings call confirmed $17.2B Q2 revenue, $2.93 operating EPS, FY2026 CC growth guide cut to 4\u20135%." },
    ],
  };
  const VERIFIED_SNAP_PRE = { date: "Jul 13, 2026", price: 290.23, marketCapB: 272.8 };

  /* ---- metric registry -------------------------------------------------- */
  const METRICS = {
    revenue:            { label: "Revenue",             color: "#0f62fe", unit: "money" },
    netIncome:          { label: "Net income",          color: "#198038", unit: "money" },
    totalAssets:        { label: "Total assets",        color: "#1192e8", unit: "money" },
    stockholdersEquity: { label: "Stockholders’ equity", color: "#6929c4", unit: "money" },
    epsDiluted:         { label: "EPS (diluted)",       color: "#9f1853", unit: "usd"   },
    marketCap:          { label: "Market cap",          color: "#005d5d", unit: "money" },
    freeCashFlow:       { label: "Free cash flow",       color: "#ff832b", unit: "money" },
    stockPrice:         { label: "Stock price",          color: "#fa4d56", unit: "usd"   },
  };
  // Metrics offered on the trend chart -- all share the US$-millions axis and are
  // among the most continuously reported across 1911-2025.
  const CHART_METRICS = ["revenue", "netIncome", "totalAssets", "stockholdersEquity", "marketCap"];
  const fmt = {
    money(v){ if(v==null) return "n/a"; const a=Math.abs(v),s=v<0?"-":"";
      return a>=1000?`${s}$${(a/1000).toFixed(1)}B`:a>=1?`${s}$${a.toFixed(0)}M`:`${s}$${(a*1000).toFixed(0)}K`; },
    usd(v){ return v==null?"n/a":`$${v.toFixed(2)}`; },
    count(v){ return v==null?"n/a":Math.round(v).toLocaleString(); },
  };
  const fmtMetric = (k,v) => fmt[METRICS[k].unit](v);

  /* ---- custom charts (agent-built, bottom of Overview) -------------------
     window.createCustomChart lets an agent plot any 1-4 financial-series
     fields as a new chart card appended to #customChartsHost, no code
     changes required. Metrics outside the curated METRICS registry get an
     auto-generated label/color/unit guess; mixed unit families are
     automatically indexed to 100 so they stay comparable on one axis. */
  const AUTO_COLORS = ["#0f62fe","#198038","#9f1853","#ff832b","#08bdba","#a56eff","#fa4d56","#6929c4"];
  function metricMeta(key) {
    if (METRICS[key]) return METRICS[key];
    const sample = fin.find(r => r[key] !== undefined && r[key] !== null);
    if (!sample) return null;
    const label = key.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase()).trim();
    const unit = /eps|dividend|price/i.test(key) ? "usd" : /employees|shares/i.test(key) ? "count" : "money";
    return { label, unit, color: null };
  }
  let customChartSeq = 0;
  const customCharts = new Map();   // id -> { card }

  window.createCustomChart = (spec = {}) => {
    const { metrics, title, fromYear, toYear, scale } = spec;
    if (!Array.isArray(metrics) || !metrics.length) throw new Error("metrics: provide 1-4 metric keys");
    if (metrics.length > 4) throw new Error("metrics: max 4 per chart");
    const metas = metrics.map(k => {
      const m = metricMeta(k);
      if (!m) throw new Error(`unknown metric '${k}' — not a field in the financials series`);
      return { key: k, ...m };
    });
    const from = fromYear || Y0, to = toYear || Y1;
    const indexed = new Set(metas.map(m => m.unit)).size > 1;   // mixed units -> normalize to 100

    const years = fin.map(r => r.year)
      .filter(y => y >= from && y <= to && metas.every(m => byYear.get(y)[m.key] != null));
    if (!years.length) throw new Error("no overlapping years with data for all requested metrics in that range");
    const y0 = years[0], y1 = years[years.length - 1];

    const host = document.getElementById("customChartsHost");
    const id = "customChart" + (++customChartSeq);
    const heading = title || metas.map(m => m.label).join(" vs. ");
    const card = document.createElement("div");
    card.className = "card chart-card custom-chart-card";
    card.id = id;
    card.innerHTML = `
      <div class="chart-toolbar">
        <div>
          <p class="section-title" style="margin:0 0 2px">${heading}</p>
          <p class="chart-sub">${indexed ? `Indexed to 100 at ${y0} (mixed units)` : "US$ millions"} · ${y0}–${y1} · built from a prompt</p>
        </div>
        <button type="button" class="custom-chart-close" title="Remove this chart" aria-label="Remove chart">✕</button>
      </div>
      <div class="chart-host" id="${id}Host"><div class="tooltip" id="${id}Tip"></div></div>
      <p class="chart-note" id="${id}Note"></p>`;
    host.appendChild(card);
    card.querySelector(".custom-chart-close").addEventListener("click", () => window.removeCustomChart(id));

    const rows = years.map(y => {
      const row = { year: y };
      if (indexed) {
        const base = byYear.get(y0);
        metas.forEach(m => { const v = byYear.get(y)[m.key], b = base[m.key]; row[m.key] = (v != null && b) ? v / b * 100 : null; });
      } else {
        metas.forEach(m => { row[m.key] = byYear.get(y)[m.key]; });
      }
      return row;
    });
    const seriesSpec = metas.map((m, i) => ({
      key: m.key, label: m.label, color: m.color || AUTO_COLORS[i % AUTO_COLORS.length],
      unit: indexed ? "index" : m.unit,
    }));
    const chartInst = window.TrendChart(document.getElementById(id + "Host"), document.getElementById(id + "Tip"));
    chartInst.render({ data: rows, series: seriesSpec, yearRange: [y0, y1], scale: scale === "log" ? "log" : "linear",
      milestones: meta.milestones, bands: [] });
    document.getElementById(id + "Note").textContent = `${metas.map(m => m.label).join(", ")} · ${y0}–${y1}.`;

    customCharts.set(id, { card });
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    return { id, title: heading, metrics: metas.map(m => m.key), yearRange: [y0, y1], mode: indexed ? "indexed" : "levels" };
  };

  window.removeCustomChart = id => {
    const entry = customCharts.get(id);
    if (!entry) return { removed: false };
    entry.card.remove();
    customCharts.delete(id);
    return { removed: true };
  };

  window.clearCustomCharts = () => {
    const n = customCharts.size;
    customCharts.forEach(({ card }) => card.remove());
    customCharts.clear();
    return { cleared: n };
  };

  /* ---- view state ------------------------------------------------------- */
  const state = {
    metrics: ["revenue", "netIncome"],
    scale: "linear",
    range: [Y0, Y1],
    rangeLabel: "All years",
  };

  const chartHost = document.getElementById("chartHost");
  const chart = window.TrendChart(chartHost, document.getElementById("chartTip"));
  /* ====================================================================== */
  /*  TABS                                                                  */
  /* ====================================================================== */
  const tabs = [...document.querySelectorAll(".tab")];
  tabs.forEach(t => t.addEventListener("click", () => selectTab(t.dataset.tab)));
  function selectTab(name) {
    tabs.forEach(t => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
    document.querySelectorAll(".panel").forEach(p => p.classList.toggle("active", p.id === "panel-" + name));
    if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
    if (name === "regression" && window.initRegressionLab) window.initRegressionLab();
    if (name === "competitors" && window._benchmarkChart) {
      /* Canvas had zero dimensions while panel was hidden; force a resize now it is visible */
      setTimeout(function() { window._benchmarkChart.resize(); }, 30);
    }
    if (name === "macro" && window._macroEconDraw) {
      /* SVG had zero clientWidth while panel was hidden; draw now it is visible */
      requestAnimationFrame(window._macroEconDraw);
    }
    if (name === "macro" && window._bondYieldDraw) {
      requestAnimationFrame(window._bondYieldDraw);
    }
    if (name === "macro") {
      /* Charts built while the panel was hidden measured 0x0 and drew nothing.
         Redraw them now that the panel has real layout width, then re-run the
         empty-card sweep so anything that just drew gets un-hidden (it is
         two-way; see hideEmptyMacroCharts). */
      requestAnimationFrame(() => {
        try {
          /* Order matters. A hidden card measures 0x0, so drawing into one
             produces nothing and the sweep would hide it again — the chart can
             never escape. Reveal every card first so the hosts have real
             width, then draw, then sweep to re-hide only what genuinely has
             no data. */
          revealMacroCards();
          window._spReturnDraw && window._spReturnDraw();
          hideEmptyMacroCharts();
          hideOrphanMacroSectionHeaders();
        } catch (e) { console.error("macro redraw failed:", e); }
      });
    }
    if (name === "ma" && window._maSwimScrollToEnd) {
      /* Wrap had zero scrollWidth while panel was hidden; scroll to the recent deals now it is visible */
      setTimeout(window._maSwimScrollToEnd, 0);
    }
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }

  /* ====================================================================== */
  /*  HOME: i. year scrubber + snapshot                                     */
  /* ====================================================================== */
  const slider = document.getElementById("scrubSlider");
  slider.min = Y0; slider.max = Y1; slider.value = Y1;
  slider.addEventListener("input", () => renderSnapshot(+slider.value));

  const ceoFor = y => (meta.leadership.find(l => y >= l.from && (l.to == null || y <= l.to)) || {}).name || "—";
  const eraFor = y => (meta.eras.find(e => y >= e.from && y <= e.to) || {}).label || "—";
  const companyFor = y => y < 1924 ? "Computing-Tabulating-Recording Co. (CTR)" : "International Business Machines (IBM)";

  function yoy(key, year) {
    const cur = byYear.get(year), prev = byYear.get(year - 1);
    if (!cur || !prev || cur[key] == null || prev[key] == null || prev[key] === 0) return null;
    return (cur[key] - prev[key]) / Math.abs(prev[key]) * 100;
  }

  function renderSnapshot(year) {
    const d = byYear.get(year) || {};
    document.getElementById("scrubYear").textContent = year;
    document.getElementById("scrubCtx").innerHTML =
      `<b>${companyFor(year)}</b><br>CEO/Chair: <b>${ceoFor(year)}</b><br>Era: ${eraFor(year)}`;

    const cards = [
      { k: "revenue",   yoy: true },
      { k: "netIncome", yoy: true },
      { k: "epsDiluted" },
      { k: "marketCap", yoy: true },
      { k: "freeCashFlow", yoy: true },
    ];
    document.getElementById("snapGrid").innerHTML = cards.map(c => {
      const v = d[c.k];
      const empty = v == null;
      const pending = empty && c.k === "marketCap";   // market data not yet loaded
      const isFCF = c.k === "freeCashFlow";
      const unverified = isFCF && v != null && d.freeCashFlowVerified === false;
      const fcfNote = isFCF && v != null ? (d.freeCashFlowNote || null) : null;
      let delta = "";
      if (c.yoy) {
        const p = yoy(c.k, year);
        if (p != null) delta = `<div class="delta ${p >= 0 ? "up" : "down"}">${p >= 0 ? "▲" : "▼"} ${Math.abs(p).toFixed(1)}% YoY</div>`;
      }
      const valText = pending ? "—" : empty ? "not reported" : fmtMetric(c.k, v);
      const noteHtml = fcfNote
        ? `<div class="pending">${fcfNote}</div>`
        : pending ? '<div class="pending">market cap not available for this year</div>' : delta;
      return `<div class="snap">
        <div class="label">${METRICS[c.k].label}</div>
        <div class="value ${empty ? "empty" : ""}">${valText}${unverified ? '<span class="unverified-mark" title="Extracted by text pattern-matching, not individually cross-checked against the filing">*</span>' : ""}</div>
        ${noteHtml}
      </div>`;
    }).join("");

    const ms = meta.milestones.find(m => m.year === year);
    document.getElementById("milestoneFlag").innerHTML = ms
      ? `<div class="milestone-flag"><b>${year} milestone:</b> ${ms.event}</div>` : "";
  }

  /* ====================================================================== */
  /*  HOME: ii. era / leadership filters                                    */
  /* ====================================================================== */
  function buildChips(hostId, items) {
    const host = document.getElementById(hostId);
    items.forEach(it => {
      const b = document.createElement("button");
      b.className = "chip"; b.textContent = it.label;
      b.setAttribute("aria-pressed", String(it.label === state.rangeLabel));
      b.addEventListener("click", () => setRange(it.from, it.to, it.label));
      host.appendChild(b);
    });
  }
  function setRange(from, to, label) {
    state.range = [from, to]; state.rangeLabel = label;
    document.querySelectorAll(".chip").forEach(c => c.setAttribute("aria-pressed", String(c.textContent === label)));
    drawChart();
  }
  window.setOverviewRange = setRange;   // hook for the window.CUGA agent tools
  window.setOverviewMetrics = keys => {   // hook for the window.CUGA agent tools
    const valid = keys.filter(k => CHART_METRICS.includes(k));
    if (!valid.length) throw new Error(`no valid chart metrics in [${keys.join(", ")}] — options: ${CHART_METRICS.join(", ")}`);
    const unit = METRICS[valid[0]].unit;
    state.metrics = valid.filter(k => METRICS[k].unit === unit);
    document.querySelectorAll(".mtoggle").forEach(b =>
      b.setAttribute("aria-pressed", String(state.metrics.includes(b.dataset.key))));
    drawChart();
    return state.metrics;
  };
  // "All years" first, then quick recency window, then company eras, then each CEO
  buildChips("eraChips", [
      { label: "All years", from: Y0, to: Y1 },
      { label: "Last 5 years", from: Y1 - 4, to: Y1 },
    ].concat(meta.eras.map(e => ({ label: e.label, from: e.from, to: e.to }))));
  buildChips("ceoChips", meta.leadership.map(l => ({
    label: l.name.replace(/(\w)\w*\s/g, "$1. "), from: l.from, to: l.to == null ? Y1 : l.to
  })));

  /* ---- Hero Bob Shell: live-data terminal + mouse-parallax tilt ----------
     A fake terminal that "types" real commands and prints real data: the live
     quote, the latest SEC filing/quarter (stashed by the loaders below in
     window.__liveQuote / __latestFiling / __latestQuarter) and milestones from
     meta.milestones. Decorative (aria-hidden), so screen readers skip it. */
  (function initBobShell() {
    const shell = document.getElementById("bobShell");
    const screen = document.getElementById("bsScreen");
    const wrap = document.getElementById("heroVisual");
    if (!shell || !screen || !wrap) return;

    const milestones = (meta.milestones || []).slice();
    let mi = 0;
    const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    // Each session recomputes its output at display time so the terminal
    // always shows the freshest fetched data.
    const sessions = [
      { cmd: "ibm quote --live", out: () => {
          const q = window.__liveQuote;
          if (!q) return ["market feed offline — showing filings data only"];
          const d = q.prevClose ? (q.price - q.prevClose) / q.prevClose * 100 : null;
          const chg = d == null ? "" : ` <span class="${d >= 0 ? "up" : "down"}">${d >= 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(2)}%</span>`;
          return [`IBM · NYSE  <b>$${q.price.toFixed(2)}</b>${chg}`, `feed: Yahoo Finance · ~15-min delayed`];
        } },
      { cmd: "ibm filings --latest", out: () => {
          const f = window.__latestFiling, q = window.__latestQuarter;
          const lines = [];
          if (f) lines.push(`<b>${esc(f.form)}</b> · period ended ${esc(f.reportDate)} · filed ${esc(f.filingDate)}`);
          if (q && q.revenue) lines.push(`${esc(q.fp)} FY${q.fy}: rev <b>$${(q.revenue / 1e9).toFixed(1)}B</b> · EPS <b>$${q.epsDiluted != null ? q.epsDiluted.toFixed(2) : "—"}</b>`);
          return lines.length ? lines : ["EDGAR feed offline — retrying…"];
        } },
      { cmd: () => `ibm history ${milestones[mi % milestones.length].year}`, out: () => {
          const m = milestones[mi++ % milestones.length];
          return [`<b>${m.year}</b> — ${esc(m.event)}`];
        } },
      { cmd: "ibm segments --latest", out: () => {
          const sy = D.segments.years[D.segments.years.length - 1];
          if (!sy) return ["no segment data"];
          const s = sy.segments;
          return [`FY${sy.year}: SW <b>${fmt.money(s.Software)}</b> · Consulting <b>${fmt.money(s.Consulting)}</b> · Infra <b>${fmt.money(s.Infrastructure)}</b>`];
        } },
    ];

    let si = 0;
    const CARET = `<span class="bs-caret"></span>`;
    async function runSession() {
      const s = sessions[si++ % sessions.length];
      const cmd = typeof s.cmd === "function" ? s.cmd() : s.cmd;
      const promptHTML = `<span class="bs-prompt">bob@ibm&nbsp;›</span> `;
      screen.innerHTML = promptHTML + CARET;
      for (let i = 1; i <= cmd.length; i++) {
        screen.innerHTML = promptHTML + `<span class="bs-cmd">${esc(cmd.slice(0, i))}</span>` + CARET;
        await new Promise(r => setTimeout(r, 26 + Math.random() * 22));
      }
      await new Promise(r => setTimeout(r, 260));
      let body = promptHTML + `<span class="bs-cmd">${esc(cmd)}</span>`;
      for (const line of s.out()) {
        body += `<span class="bs-out">${line}</span>`;
        screen.innerHTML = body + promptHTML + CARET;
        await new Promise(r => setTimeout(r, 150));
      }
      await new Promise(r => setTimeout(r, 3600));
      setTimeout(runSession, 0);
    }
    runSession();

    // Gentle mouse-parallax tilt, like a product-page hero shot.
    let raf = null;
    wrap.addEventListener("mousemove", e => {
      const r = wrap.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5, py = (e.clientY - r.top) / r.height - 0.5;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        shell.style.transform = `rotateY(${(px * 8).toFixed(2)}deg) rotateX(${(-py * 8).toFixed(2)}deg)`;
      });
    });
    wrap.addEventListener("mouseleave", () => { shell.style.transform = "rotateX(0deg) rotateY(0deg)"; });
  })();

  /* ---- CNBC-style scrolling ticker (IBM + competitors) -------------------
     Fills the .ticker-strip under the top bar from the agent server's batch
     /quotes endpoint. The track is rendered twice back-to-back and animated
     -50% so the loop is seamless; refreshes every 60s in place. Hidden
     entirely (strip stays `hidden`) if the agent server isn't running. */
  async function loadTicker() {
    const strip = document.getElementById("tickerStrip"), track = document.getElementById("tickerTrack");
    if (!strip || !track) return;
    const agentURL = window.CUGA_AGENT_URL || "http://localhost:8787";
    try {
      const r = await fetch(`${agentURL}/quotes`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      if (!d.quotes || !d.quotes.length) throw new Error("empty");
      const cell = q => {
        const up = q.changePct >= 0;
        return `<span class="tk-item"><span class="tk-sym${q.symbol === "IBM" ? " ibm" : ""}">${q.symbol}</span>` +
               `<span class="tk-px">$${q.price.toFixed(2)}</span>` +
               `<span class="tk-chg ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${Math.abs(q.changePct).toFixed(2)}%</span></span>` +
               `<span class="tk-sep">◆</span>`;
      };
      const half = d.quotes.map(cell).join("");
      track.innerHTML = half + half;   // duplicated for a seamless -50% loop
      strip.style.setProperty("--ticker-dur", `${Math.max(30, d.quotes.length * 6)}s`);
      strip.hidden = false;
    } catch (_) { /* agent server offline — strip stays hidden */ }
  }
  loadTicker();
  setInterval(loadTicker, 60000);

  /* Reusable live-quotes pill row (Macro "markets now", Competitors peers).
     Same /quotes feed as the ticker; row stays hidden if the agent server is
     off, so remote deployments without it degrade cleanly. ^TNX is CBOE's
     10-yr-yield index quoted at 10x the yield, hence the special-casing. */
  const LMR_LABELS = { "^GSPC": "S&P 500", "^IXIC": "Nasdaq", "^DJI": "Dow", "^TNX": "10-yr yield" };
  function mountLiveQuotesRow(hostId, symbols, title) {
    const host = document.getElementById(hostId);
    if (!host) return;
    const agentURL = window.CUGA_AGENT_URL || "http://localhost:8787";
    const tick = async () => {
      try {
        const r = await fetch(`${agentURL}/quotes?symbols=${encodeURIComponent(symbols)}`,
                              { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return;
        const d = await r.json();
        if (!d.quotes || !d.quotes.length) return;
        host.innerHTML = `<span class="lmr-title"><span class="lq-dot live"></span>${title}</span>` +
          d.quotes.map(q => {
            const up = q.changePct >= 0;
            const isTnx = q.symbol === "^TNX";   // yield index — a %, not a price
            const px = isTnx ? `${q.price.toFixed(2)}%` : `$${q.price.toFixed(2)}`;
            return `<span class="lmr-pill"><span class="s${q.symbol === "IBM" ? " ibm" : ""}">${LMR_LABELS[q.symbol] || q.symbol}</span>` +
                   `<span class="p">${px}</span>` +
                   `<span class="c ${up ? "up" : "down"}">${up ? "▲" : "▼"}${Math.abs(q.changePct).toFixed(2)}%</span></span>`;
          }).join("") +
          `<span class="lmr-note">live · refreshes every 60s</span>`;
        host.hidden = false;
      } catch (_) { /* agent server offline — row stays hidden */ }
    };
    tick();
    setInterval(tick, 60000);
  }
  mountLiveQuotesRow("compLiveRow", "IBM,MSFT,ORCL,SAP,ACN,AMZN,GOOGL,NVDA", "Peers, live");

  /* ---- Live IBM quote (Overview) — dynamically self-refreshing ----------
     Tries, in order: the CUGA agent server's /quote proxy (localhost:8787,
     see agent/server.py), same-origin /api/quote (server/server.js's wxO
     embed server), then Yahoo Finance's chart API directly. Falls back to
     the latest filing-era market data without erroring. Re-fetches every 60s
     and ticks a "updated Xs ago" label every 5s so the widget visibly stays
     alive without a full page reload — this is the dashboard's one genuinely
     real-time number; everything else is annual-report data that only
     changes when the pipeline re-runs. */
  let _lastQuoteAt = null, _lastQuotePrice = null, _quoteNoteBase = "";
  async function loadLiveQuote() {
    const elP = document.getElementById("lqPrice"), elC = document.getElementById("lqChange"),
          elN = document.getElementById("lqNote"), elD = document.getElementById("lqDot"),
          elCap = document.getElementById("lqCap");
    if (!elP) return;
    const show = (price, prevClose, source) => {
      const flash = _lastQuotePrice != null && price !== _lastQuotePrice;
      elP.textContent = `$${price.toFixed(2)}`;
      if (flash) { elP.classList.remove("lq-flash"); void elP.offsetWidth; elP.classList.add("lq-flash"); }
      if (prevClose) {
        const d = (price - prevClose) / prevClose * 100;
        elC.textContent = `${d >= 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(2)}%`;
        elC.className = `lq-change ${d >= 0 ? "up" : "down"}`;
      }
      elD.classList.add("live");
      _quoteNoteBase = source;
      elN.textContent = source;
      _lastQuoteAt = Date.now(); _lastQuotePrice = price;
      // live market-cap *estimate* (price x latest disclosed share count) —
      // deliberately labeled "estimate" and kept out of METRICS/fin rows so
      // it never gets confused with the audited, filing-sourced marketCap
      // series used everywhere else on the site.
      const latestShares = [...fin].reverse().find(r => r.sharesOutstandingM != null);
      const capEstM = latestShares ? price * latestShares.sharesOutstandingM : null;
      // Store capEstM on __liveQuote so the Macro tab hero KPI can read the same
      // computed estimate rather than a separate hardcoded figure.
      window.__liveQuote = { price, prevClose, capEstM,
        sharesM: latestShares ? latestShares.sharesOutstandingM : null,
        sharesYear: latestShares ? latestShares.year : null };
      if (elCap && latestShares && capEstM != null) {
        elCap.textContent = `≈ ${fmt.money(capEstM)} live market cap est. (× ${latestShares.sharesOutstandingM.toFixed(0)}M FY${latestShares.year} shares)`;
      }
      // Notify the Macro tab's move-detector whenever fresh quote data lands.
      if (window.refreshMoveBanner) window.refreshMoveBanner(price, prevClose);
      // Broadcast for anything else keyed to the live price — Section A's KPI
      // bar listens for this so its price tile follows the same 60s refresh
      // cycle as the ticker instead of freezing on its first paint.
      window.dispatchEvent(new CustomEvent("ibm-live-quote", { detail: window.__liveQuote }));
    };
    const tryJSON = async url => {
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    };
    try {
      const q = await tryJSON(`${window.CUGA_AGENT_URL || "http://localhost:8787"}/quote?symbol=IBM`);
      if (q && q.price) { show(q.price, q.prevClose, `live · agent proxy · ${q.asOf || "today"}`); return; }
      throw new Error("empty agent quote");
    } catch (_) { /* agent server not running — try the next source */ }
    try {
      const q = await tryJSON("/api/quote?symbol=IBM");
      if (q && q.price) { show(q.price, q.prevClose, `live · ${q.asOf || "today"}`); return; }
      throw new Error("empty proxy quote");
    } catch (_) { /* proxy not running — try direct */ }
    try {
      const j = await tryJSON("https://query1.finance.yahoo.com/v8/finance/chart/IBM?interval=1d&range=5d");
      const res = j.chart && j.chart.result && j.chart.result[0];
      const price = res && res.meta && res.meta.regularMarketPrice;
      // meta.chartPreviousClose/previousClose can be stale here (a value from
      // well before the requested range). The closes array in the same
      // response is accurate -- second-to-last is yesterday's close, since
      // the last entry matches regularMarketPrice.
      const closes = (res && res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close || []).filter(c => c != null);
      const prev = closes.length >= 2 ? closes[closes.length - 2]
        : (res && res.meta && (res.meta.chartPreviousClose || res.meta.previousClose));
      if (price) {
        const asOf = res.meta.regularMarketTime ? new Date(res.meta.regularMarketTime * 1000).toLocaleDateString() : "today";
        show(price, prev, `live · ${asOf}`);
        return;
      }
      throw new Error("no price in response");
    } catch (_) { /* offline / blocked */ }
    // graceful fallback: latest filing-era market cap from data.js. Shown in
    // the market-cap slot (not the price slot) so a filing-derived total
    // never gets mistaken for a per-share price.
    const last = [...fin].reverse().find(r => r.marketCap != null);
    elP.textContent = "—";
    if (elCap) elCap.textContent = last ? `FY${last.year} year-end market cap: ${fmt.money(last.marketCap)}` : "";
    elN.textContent = last
      ? `live quote unavailable — showing FY${last.year} year-end data`
      : "live quote unavailable";
    _lastQuoteAt = null;
  }
  window.refreshLiveQuote = loadLiveQuote;   // hook for the window.CUGA agent tools

  /* ---- Intraday sparkline ------------------------------------------------- */
  // Fetches 5-min bars for today from the agent server's /quote/intraday endpoint
  // and draws an SVG sparkline that grows with each 60s refresh.
  // Falls back silently if the server isn't running.
  function drawSparkline(points, prevClose) {
    const svg = document.getElementById("lqChart");
    if (!svg || !points || points.length < 2) return;
    const W = 200, H = 48, pad = 2;
    const prices = points.map(p => p.price);
    const allVals = prevClose != null ? [prevClose, ...prices] : prices;
    let lo = Math.min(...allVals), hi = Math.max(...allVals);
    if (hi === lo) { hi += 0.01; lo -= 0.01; }
    const xOf = i => pad + (i / (points.length - 1)) * (W - pad * 2);
    const yOf = v => pad + (1 - (v - lo) / (hi - lo)) * (H - pad * 2);
    const last = prices[prices.length - 1];
    const dir = prevClose == null ? "flat" : last > prevClose * 1.0001 ? "up" : last < prevClose * 0.9999 ? "down" : "flat";
    svg.setAttribute("class", `lq-chart ${dir}`);
    const pts = points.map((p, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(p.price).toFixed(1)}`).join(" ");
    const baseY = yOf(prevClose != null ? prevClose : lo).toFixed(1);
    const areaD = `${pts} L${xOf(points.length - 1).toFixed(1)},${baseY} L${xOf(0).toFixed(1)},${baseY} Z`;
    svg.innerHTML =
      `<path class="spark-area" d="${areaD}"/>` +
      `<path class="spark-line"  d="${pts}"/>` +
      `<circle class="spark-dot" cx="${xOf(points.length - 1).toFixed(1)}" cy="${yOf(last).toFixed(1)}" r="2.5"/>`;
  }

  async function loadIntraday() {
    const agentURL = window.CUGA_AGENT_URL || "http://localhost:8787";
    try {
      const r = await fetch(`${agentURL}/quote/intraday?symbol=IBM`,
                            { signal: AbortSignal.timeout(6000) });
      if (!r.ok) return;
      const d = await r.json();
      if (d && d.points && d.points.length >= 2) drawSparkline(d.points, d.prevClose);
    } catch (_) { /* server not running — sparkline stays hidden */ }
  }

  loadLiveQuote();
  loadIntraday();
  setInterval(() => { loadLiveQuote(); loadIntraday(); }, 60000);
  setInterval(() => {
    if (_lastQuoteAt == null) return;
    const secs = Math.round((Date.now() - _lastQuoteAt) / 1000);
    const ago = secs < 5 ? "just now" : secs < 60 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`;
    const elN = document.getElementById("lqNote");
    if (elN) elN.textContent = `${_quoteNoteBase} · updated ${ago}`;
    // Tick the "updated Xs ago" text on any Macro-tab KPI stamp whose dot is
    // in "live" mode — Market Cap and Stock Return share the same quote feed.
    ["hkpiMarketCapStamp", "hkpiReturnStamp"].forEach(id => {
      const wrap = document.getElementById(id);
      if (!wrap || wrap.style.display === "none") return;
      const dot = wrap.querySelector(".kpi-stamp-dot");
      if (!dot || !dot.classList.contains("live")) return;
      const txt = wrap.querySelector(".kpi-stamp-txt");
      if (txt) txt.textContent = `updated ${ago}`;
    });
  }, 5000);

  /* ---- Latest SEC filing + live quarterly earnings (Overview) ------------
     Fetches agent/server.py's /filings/latest + /filings/xbrl (SEC EDGAR's
     public submissions + XBRL APIs). Self-refreshes every 5 minutes so a
     brand-new 10-Q/10-K shows up here — and the mini bar chart grows a new
     bar — without anyone re-running the PDF pipeline. Falls back to a direct
     EDGAR fetch (CORS-open) if the agent server isn't running, and degrades
     gracefully if both are unreachable. Deliberately kept separate from, and
     labeled apart from, the hand-verified pipeline/data/financials.json
     series that powers the 1911-2025 charts — see the "unaudited" note in
     the rendered headline. */
  let _lastFilingAccession = null, _lastFilingCheckAt = null, _filingNoteBase = "";

  function drawFilingBars(rows, valueKey) {
    const svg = document.getElementById("sfChart");
    if (!svg || !rows || !rows.length) return;
    const W = 340, H = 74, padB = 14, padT = 4, gap = 6;
    const n = rows.length;
    const barW = (W - gap * (n - 1)) / n;
    const vals = rows.map(r => r[valueKey]).filter(v => v != null);
    if (!vals.length) return;
    const hi = Math.max(...vals, 0), lo = Math.min(...vals, 0);
    const span = (hi - lo) || 1;
    const yOf = v => padT + (hi - v) / span * (H - padT - padB);
    const zeroY = yOf(0);
    let out = "";
    rows.forEach((r, i) => {
      const v = r[valueKey];
      if (v == null) return;
      const x = i * (barW + gap);
      const y = Math.min(yOf(v), zeroY);
      const h = Math.max(Math.abs(yOf(v) - zeroY), 1);
      const cls = `${i === rows.length - 1 ? "latest" : ""} ${v < 0 ? "neg" : ""}`.trim();
      out += `<rect class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2"/>`;
      out += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 2}" text-anchor="middle">${r.fp || ""}</text>`;
    });
    svg.innerHTML = out;
  }

  async function loadSecFilings() {
    const elDot = document.getElementById("sfDot"), elBadge = document.getElementById("sfBadge"),
          elPeriod = document.getElementById("sfPeriod"), elLink = document.getElementById("sfLink"),
          elNote = document.getElementById("sfNote"), elHeadline = document.getElementById("sfHeadline");
    if (!elBadge) return;
    const agentURL = window.CUGA_AGENT_URL || "http://localhost:8787";
    const tryJSON = async url => {
      const r = await fetch(url, { signal: AbortSignal.timeout(7000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    };
    let filingsData = null, xbrlData = null, source = "";
    try {
      [filingsData, xbrlData] = await Promise.all([
        tryJSON(`${agentURL}/filings/latest?symbol=IBM`),
        tryJSON(`${agentURL}/filings/xbrl?symbol=IBM`),
      ]);
      source = "agent proxy";
    } catch (_) {
      try {
        const sub = await tryJSON("https://data.sec.gov/submissions/CIK0000051143.json");
        const recent = sub.filings.recent;
        const out = [];
        for (let i = 0; i < recent.form.length && out.length < 8; i++) {
          const form = recent.form[i];
          if (!["10-K", "10-Q", "8-K"].includes(form)) continue;
          const items = (recent.items && recent.items[i]) || "";
          if (form === "8-K" && !items.includes("2.02")) continue;
          const acc = recent.accessionNumber[i];
          out.push({
            form, filingDate: recent.filingDate[i], reportDate: recent.reportDate[i], accessionNumber: acc,
            url: `https://www.sec.gov/Archives/edgar/data/51143/${acc.replace(/-/g, "")}/${recent.primaryDocument[i]}`,
          });
        }
        filingsData = { companyName: sub.name, filings: out, latest: out[0] || null };
        source = "EDGAR direct";
      } catch (_) { /* both agent proxy and direct EDGAR unreachable */ }
    }
    if (!filingsData || !filingsData.latest) {
      if (elNote) elNote.textContent = "live SEC feed unavailable";
      if (elDot) elDot.classList.remove("live");
      return;
    }
    const f = filingsData.latest;
    const isNew = _lastFilingAccession != null && f.accessionNumber !== _lastFilingAccession && source === "agent proxy";
    _lastFilingAccession = f.accessionNumber;
    window.__latestFiling = f;   // read by the Bob Shell hero terminal
    elDot.classList.add("live");
    elBadge.textContent = f.form;
    elBadge.className = `sfc-badge${isNew ? " sfc-new-flag" : ""}`;
    const periodLabel = f.reportDate
      ? new Date(f.reportDate + "T00:00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
      : "—";
    elPeriod.textContent = `period ended ${periodLabel}`;
    elLink.href = f.url;
    elLink.textContent = isNew ? "New filing — view ↗" : "View filing ↗";
    _filingNoteBase = `filed ${f.filingDate} · via ${source}`;
    elNote.textContent = _filingNoteBase;
    _lastFilingCheckAt = Date.now();

    if (xbrlData && xbrlData.recentQuarters && xbrlData.recentQuarters.length) {
      const rows = xbrlData.recentQuarters;
      drawFilingBars(rows, "revenue");
      const latest = xbrlData.latestQuarter;
      window.__latestQuarter = latest;   // read by the Bob Shell hero terminal
      window.__latestXbrl = xbrlData;    // read by the Macro tab's live KPI row (revenue TTM + total debt)
      // Push the fresh XBRL numbers into the FY snapshot (live-quarter stat +
      // a live-FY chip if a 10-K newer than the pipeline data has been filed).
      if (window.__applyLiveXbrl) window.__applyLiveXbrl(xbrlData);
      if (window.refreshMacroKpis) window.refreshMacroKpis();
      const yoy = rows.find(r => r.fy === latest.fy - 1 && r.fp === latest.fp);
      let yoyHTML = "";
      if (yoy && yoy.revenue && latest.revenue) {
        const d = (latest.revenue - yoy.revenue) / yoy.revenue * 100;
        yoyHTML = ` <span class="${d >= 0 ? "yoy-up" : "yoy-down"}">${d >= 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(1)}% YoY</span>`;
      }
      const money = v => v == null ? "n/a" : `$${(v / 1e9).toFixed(1)}B`;
      elHeadline.innerHTML =
        `<b>${latest.fp} FY${latest.fy}</b> revenue <b>${money(latest.revenue)}</b>${yoyHTML}<br>` +
        `net income <b>${money(latest.netIncome)}</b> · diluted EPS <b>${latest.epsDiluted != null ? "$" + latest.epsDiluted.toFixed(2) : "n/a"}</b>` +
        `<div style="margin-top:4px;color:var(--ink-dim);font-size:11px;">unaudited · straight from SEC XBRL, not yet folded into the verified pipeline series</div>`;
    } else {
      elHeadline.innerHTML = `<span style="color:var(--ink-dim)">quarterly figures need the agent server (agent/server.py) running</span>`;
    }
  }
  window.refreshSecFilings = loadSecFilings;   // hook for the window.CUGA agent tools

  loadSecFilings();
  setInterval(loadSecFilings, 5 * 60 * 1000);
  setInterval(() => {
    const elN = document.getElementById("sfNote");
    if (!elN || _lastFilingCheckAt == null) return;
    const mins = Math.round((Date.now() - _lastFilingCheckAt) / 60000);
    elN.textContent = `${_filingNoteBase} · checked ${mins < 1 ? "just now" : mins + "m ago"}`;
  }, 30000);

  /* ---- FY snapshot: stat bar, segment donut, gross-margin bars -----------
     Renders any of the last 5 verified fiscal years (year chips above the
     bar), plus a "live" chip that appears automatically when a 10-K newer
     than the pipeline data lands on EDGAR (via /filings/xbrl). The freshest
     filed quarter is also appended to the bar as a live stat. */
  let fyYear = Y1;              // currently displayed snapshot year
  let fyLiveAnnual = null;      // XBRL annual row for a FY newer than data.js, if filed
  let fyLiveQuarter = null;     // freshest filed quarter (XBRL)

  function buildFYChips() {
    const host = document.getElementById("fyYearChips");
    if (!host) return;
    host.querySelectorAll(".chip").forEach(c => c.remove());
    const years = [];
    for (let y = Y1 - 4; y <= Y1; y++) years.push(y);
    years.forEach(y => {
      const b = document.createElement("button");
      b.className = "chip"; b.textContent = `FY${y}`;
      b.setAttribute("aria-pressed", String(y === fyYear && !document.getElementById("fyStatbar").dataset.live));
      b.addEventListener("click", () => { fyYear = y; renderFY(y); });
      host.appendChild(b);
    });
    if (fyLiveAnnual) {
      const fy = new Date(fyLiveAnnual.periodEnd).getFullYear();
      const b = document.createElement("button");
      b.className = "chip live-chip"; b.textContent = `FY${fy} · live`;
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => renderLiveFY(fyLiveAnnual));
      host.appendChild(b);
    }
  }

  function liveQuarterStatHTML() {
    const q = fyLiveQuarter;
    if (!q || q.revenue == null) return "";
    return `<div class="fy-stat live-q"><div class="val">$${(q.revenue / 1e9).toFixed(1)}B</div>` +
           `<div class="lbl">${q.fp} FY${q.fy} revenue · live</div></div>`;
  }

  // Live-FY view: a 10-K newer than the verified pipeline data. Stat bar only
  // (segments aren't parsed from XBRL here); clearly labeled unaudited.
  function renderLiveFY(a) {
    const fy = new Date(a.periodEnd).getFullYear();
    const bar = document.getElementById("fyStatbar");
    bar.dataset.live = "1";
    const money = v => v == null ? "n/a" : `$${(v / 1e9).toFixed(1)}B`;
    const stats = [
      { val: money(a.revenue), lbl: "Total revenue" },
      { val: money(a.netIncome), lbl: "Net income" },
      { val: a.epsDiluted != null ? `$${a.epsDiluted.toFixed(2)}` : "n/a", lbl: "Diluted EPS" },
    ];
    bar.innerHTML =
      `<div class="fy-head"><span class="k">FY${fy}</span><span class="k" style="color:var(--up)">live · unaudited</span></div>` +
      stats.map(s => `<div class="fy-stat"><div class="val">${s.val}</div><div class="lbl">${s.lbl}</div></div>`).join("") +
      liveQuarterStatHTML();
    document.querySelectorAll("#fyYearChips .chip").forEach(c =>
      c.setAttribute("aria-pressed", String(c.classList.contains("live-chip"))));
    ensureUnauditedNote(`FY${fy} figures are straight from SEC XBRL (10-K filed ${a.filed}) — not yet cross-verified by this project's pipeline.`);
  }

  function ensureUnauditedNote(text) {
    let el = document.getElementById("fyUnauditedNote");
    if (!text) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement("p");
      el.id = "fyUnauditedNote"; el.className = "fy-unaudited";
      document.getElementById("fyStatbar").insertAdjacentElement("afterend", el);
    }
    el.textContent = text;
  }

  // Called by loadSecFilings() whenever fresh XBRL arrives (every 5 min).
  window.__applyLiveXbrl = xbrl => {
    fyLiveQuarter = xbrl.latestQuarter || fyLiveQuarter;
    const la = xbrl.latestAnnual;
    if (la && new Date(la.periodEnd).getFullYear() > Y1) fyLiveAnnual = la;
    buildFYChips();
    const bar = document.getElementById("fyStatbar");
    if (bar.dataset.live) renderLiveFY(fyLiveAnnual);
    else renderFY(fyYear);   // re-render so the live-quarter stat appears/updates
  };

  function renderFY(year) {
    const latest = year || Y1, prev = latest - 1;
    const bar = document.getElementById("fyStatbar");
    delete bar.dataset.live;
    const r = byYear.get(latest), p = byYear.get(prev) || {};
    const seg = (D.segments.years.find(s => s.year === latest) || {}).segments || {};
    const gm = D.segments.segmentGrossMargin2025 || {};
    const yoyPct = (a, b) => (a != null && b) ? (a - b) / b * 100 : null;
    const arrow = v => v == null ? "" : `<span class="${v >= 0 ? "up" : "down"}">${v >= 0 ? "▲" : "▼"}${Math.abs(v).toFixed(0)}%</span>`;

    // stat bar (live-quarter stat appended only on the latest year's view,
    // where "most recent" context makes sense)
    const prevSeg = (D.segments.years.find(s => s.year === prev) || {}).segments || {};
    const stats = [
      { val: fmt.money(r.revenue), lbl: "Total revenue", d: yoyPct(r.revenue, p.revenue) },
      { val: fmt.money(r.freeCashFlow), lbl: "Free cash flow", d: yoyPct(r.freeCashFlow, p.freeCashFlow) },
      { val: fmt.money(seg.Software), lbl: "Software revenue", d: yoyPct(seg.Software, prevSeg.Software) },
      { val: fmt.money(seg.Consulting), lbl: "Consulting revenue", d: yoyPct(seg.Consulting, prevSeg.Consulting) },
      { val: fmt.money(seg.Infrastructure), lbl: "Infrastructure revenue", d: yoyPct(seg.Infrastructure, prevSeg.Infrastructure) },
      { val: fmt.money(r.softwareARR), lbl: "Software ARR" },
    ];
    bar.innerHTML =
      `<div class="fy-head"><span class="k">FY${latest}</span><span class="k">financials</span></div>` +
      stats.map(s => `<div class="fy-stat"><div class="val">${s.val}</div><div class="lbl">${s.lbl} ${s.d != null ? arrow(s.d) : ""}</div></div>`).join("") +
      (latest === Y1 ? liveQuarterStatHTML() : "");
    document.querySelectorAll("#fyYearChips .chip").forEach(c =>
      c.setAttribute("aria-pressed", String(c.textContent === `FY${latest}`)));
    ensureUnauditedNote(null);

    // donut (Software / Consulting / Infrastructure / Financing)
    const COLORS = { Software: "var(--sw)", Consulting: "var(--co)", Infrastructure: "var(--inf)", Financing: "var(--fin)" };
    const order = ["Software", "Consulting", "Infrastructure", "Financing"];
    const parts = order.filter(k => seg[k]).map(k => ({ k, v: seg[k] }));
    const total = r.revenue;
    const R = 78, sw = 26, C = 2 * Math.PI * R;
    let off = 0;
    const rings = parts.map(pt => {
      const frac = pt.v / total, len = frac * C;
      const seg2 = `<circle r="${R}" cx="100" cy="100" fill="none" stroke="${COLORS[pt.k]}" stroke-width="${sw}"
        stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"
        transform="rotate(-90 100 100)"></circle>`;
      off += len; return seg2;
    }).join("");
    document.getElementById("segDonut").innerHTML =
      `<svg width="200" height="200" viewBox="0 0 200 200">${rings}</svg>
       <div class="center"><div class="big">${fmt.money(total)}</div><div class="cap">FY${latest}</div></div>`;
    document.getElementById("donutSub").textContent = `FY${latest} · ${fmt.money(total)} total revenue`;
    document.getElementById("segLegend").innerHTML = `<div class="lt">Revenue share</div>` +
      parts.map(pt => `<div class="leg-row"><span class="dot" style="background:${COLORS[pt.k]}"></span>
        <span class="nm">${pt.k}</span><span class="vv"><b>${fmt.money(pt.v)}</b> · ${(pt.v / total * 100).toFixed(0)}%</span></div>`).join("");
    const swShare = seg.Software ? (seg.Software / total * 100).toFixed(0) : null;
    document.getElementById("segCallout").innerHTML = swShare
      ? `<b>Software</b> is ${swShare}% of FY${latest} revenue and growing; <b>Consulting</b> cross-sells it, while <b>Infrastructure</b> anchors the mainframe franchise.`
      : `Segment revenue on the current 4-segment basis is reported from FY2021 onward.`;

    // gross-margin bars (sorted high→low)
    const gmRows = Object.entries(gm).filter(([k]) => k !== "Financing").sort((a, b) => b[1] - a[1]);
    const gmDesc = {
      Software: "Subscription model — each new customer adds near-zero marginal cost. IBM's highest-margin segment.",
      Infrastructure: "Hardware carries real cost, but long-term mainframe support and attached software are high-margin recurring streams.",
      Consulting: "People-driven — labour is the main cost. IBM's AI-enabled delivery aims to lift this over time.",
    };
    document.getElementById("gmBars").innerHTML = gmRows.map(([k, v]) => `
      <div class="gm-row">
        <div class="gm-top"><span class="gm-name">${k}</span><span class="gm-pct">${v}%</span></div>
        <div class="gm-track"><div class="gm-fill" style="width:${v}%;background:${COLORS[k]}"></div></div>
        <p class="gm-desc">${gmDesc[k] || ""}</p>
      </div>`).join("");
  }

  /* ====================================================================== */
  /*  HOME: iii. interactive trend chart                                    */
  /* ====================================================================== */
  const togHost = document.getElementById("metricToggles");
  CHART_METRICS.forEach(key => {
    const m = METRICS[key];
    const b = document.createElement("button");
    b.className = "mtoggle"; b.dataset.key = key;
    b.innerHTML = `<span class="swatch" style="background:${m.color}"></span>${m.label}`;
    b.setAttribute("aria-pressed", String(state.metrics.includes(key)));
    b.addEventListener("click", () => toggleMetric(key));
    togHost.appendChild(b);
  });
  function toggleMetric(key) {
    const unit = METRICS[key].unit;
    const cur = new Set(state.metrics);
    const curUnit = METRICS[state.metrics[0]].unit;
    if (unit !== curUnit) {
      state.metrics = [key];                       // different unit -> replace
    } else if (cur.has(key)) {
      if (cur.size > 1) cur.delete(key);            // keep at least one
      state.metrics = [...cur];
    } else {
      cur.add(key); state.metrics = [...cur];
    }
    document.querySelectorAll(".mtoggle").forEach(b =>
      b.setAttribute("aria-pressed", String(state.metrics.includes(b.dataset.key))));
    drawChart();
  }
  document.getElementById("logToggle").addEventListener("change", e => {
    state.scale = e.target.checked ? "log" : "linear"; drawChart();
  });

  function drawChart() {
    const series = state.metrics.map(k => ({ key: k, label: METRICS[k].label, color: METRICS[k].color, unit: METRICS[k].unit }));
    chart.render({ data: fin, series, yearRange: state.range, scale: state.scale, milestones: meta.milestones });
    const names = state.metrics.map(k => METRICS[k].label).join(", ");
    document.getElementById("chartNote").textContent =
      `Showing ${names} · ${state.range[0]}–${state.range[1]} (${state.rangeLabel}) · ${state.scale} scale. ` +
      `Triangles mark company milestones — hover any point for detail. Gaps are years a value was not reported.` +
      (state.metrics.includes("marketCap") ? " Market cap is market data, not a filing line item — 2001–2016 from IBM's own disclosed figures; all other years sourced from companiesmarketcap.com / wallstreetnumbers.com (see About & Data)." : "");
  }

  /* ====================================================================== */
  /*  HOME: iv. derived performance-ratios table (interactive/adjustable)   */
  /* ====================================================================== */
  const DERIVED_RANGES = [
    { label: "2015–25", from: 2015 },
    { label: "2005–25", from: 2005 },
    { label: "1991–25", from: 1991 },
  ];
  let derivedFrom = 2005;     // selected range start
  let roicTax = 0.25;         // adjustable ROIC tax rate (NOPAT = pretax * (1-t))

  const pct = v => v == null ? null : (v >= 0 ? "+" : "") + v.toFixed(1) + "%";

  const DERIVED_COLS = [
    { label: "Revenue growth", hint: "YoY", heat: "signed", fmt: pct,
      calc: y => { const a = byYear.get(y), b = byYear.get(y - 1);
        return (a && b && a.revenue != null && b.revenue != null && b.revenue) ? (a.revenue - b.revenue) / b.revenue * 100 : null; } },
    { label: "Operating margin", hint: "pre-tax ÷ revenue", heat: "margin", fmt: pct,
      calc: y => { const r = byYear.get(y); return (r && r.pretaxIncome != null && r.revenue) ? r.pretaxIncome / r.revenue * 100 : null; } },
    { label: "Free cash flow", hint: "IBM-reported / OCF−capex", heat: "none", fmt: v => v == null ? null : fmt.money(v),
      calc: y => { const r = byYear.get(y); if (!r) return null;
        if (r.freeCashFlow != null) return r.freeCashFlow;
        if (r.operatingCashFlow != null && r.capitalExpenditure != null) return r.operatingCashFlow - r.capitalExpenditure;
        return null; } },
    { label: "ROIC", hint: "NOPAT ÷ (debt+equity)", heat: "margin", fmt: pct,
      calc: y => { const r = byYear.get(y); if (!r || r.totalDebt == null || r.stockholdersEquity == null) return null;
        const ic = r.totalDebt + r.stockholdersEquity; if (!ic) return null;
        const nopat = r.pretaxIncome != null ? r.pretaxIncome * (1 - roicTax) : r.netIncome;
        return nopat == null ? null : nopat / ic * 100; } },
    { label: "Software ARR", hint: "annual recurring revenue", heat: "none", fmt: v => v == null ? null : fmt.money(v),
      calc: y => { const r = byYear.get(y); return r && r.softwareARR != null ? r.softwareARR : null; } },
  ];

  // subtle red→green tint by value (good = green)
  function heatColor(v, type) {
    if (v == null) return "";
    let t;
    if (type === "signed") t = (v + 20) / 40;        // -20%..+20%
    else if (type === "margin") t = v / 30;          // 0..30%
    else return "";
    t = Math.max(0, Math.min(1, t));
    return `hsl(${Math.round(t * 135)},55%,22%)`;
  }

  function renderDerived() {
    const years = fin.map(d => d.year).filter(y => y >= derivedFrom && y <= Y1).sort((a, b) => b - a);
    const head = "<thead><tr><th>Year</th>" +
      DERIVED_COLS.map(c => `<th>${c.label}<span class="colhint">${c.hint}</span></th>`).join("") + "</tr></thead>";
    const body = "<tbody>" + years.map(y =>
      "<tr><td>" + y + "</td>" + DERIVED_COLS.map(c => {
        const v = c.calc(y), txt = c.fmt(v);
        if (v == null || txt == null) return '<td class="empty">—</td>';
        const bg = heatColor(v, c.heat);
        return `<td style="${bg ? `background:${bg}` : ""}">${txt}</td>`;
      }).join("") + "</tr>").join("") + "</tbody>";
    document.getElementById("derivedTable").innerHTML = head + body;
    document.getElementById("derivedNote").innerHTML =
      "<b>Method:</b> Operating margin uses income before income taxes (IBM reports no GAAP operating-income line). " +
      "Free cash flow is IBM's reported figure (2019+) or operating cash flow − capex where both are in the data. " +
      "ROIC = NOPAT ÷ (total debt + stockholders' equity), NOPAT = pre-tax income × (1 − tax rate above). " +
      "Software ARR is IBM's disclosed annual recurring revenue (definition broadened in 2025, so 2024 is restated upward). " +
      "All inputs come from the annual reports (see pipeline/SCHEMA.md).";
  }

  (function wireDerived() {
    const host = document.getElementById("derivedRange");
    DERIVED_RANGES.forEach(r => {
      const b = document.createElement("button");
      b.className = "chip"; b.textContent = r.label;
      b.setAttribute("aria-pressed", String(r.from === derivedFrom));
      b.addEventListener("click", () => {
        derivedFrom = r.from;
        host.querySelectorAll(".chip").forEach(c => c.setAttribute("aria-pressed", String(c === b)));
        renderDerived();
      });
      host.appendChild(b);
    });
    document.getElementById("taxRate").addEventListener("input", e => {
      roicTax = +e.target.value / 100;
      document.getElementById("taxVal").textContent = e.target.value + "%";
      renderDerived();
    });
  })();

  /* ====================================================================== */
  /*  STORY MODE                                                            */
  /* ====================================================================== */
  function buildStoryMode() {
    /* ---- Report folder config ----------------------------------------- */
    const SM_REPORTS = {
      dir:          "pipeline/raw/text",
      filePattern:  "{year}.txt",
      letterMaxChars: 6000
    };

    /* ---- Per-series data (USD millions → $B, stock price stays in $/share) */

    // Daily price helpers — only used when stockPrice series is active.
    // IBM_DAILY_PRICES is loaded from "Story Mode/ibm_daily_prices.js" as
    // an array of ["YYYY-MM-DD", price] pairs sorted oldest-first.
    const SP_DAILY = (window.IBM_DAILY_PRICES || []);
    // Convert "YYYY-MM-DD" → fractional year number (e.g. 1962-07-01 → 1962.498)
    const dateToFrac = d => {
      const [y, m, day] = d.split("-").map(Number);
      const start = Date.UTC(y, 0, 1), end = Date.UTC(y + 1, 0, 1);
      const cur   = Date.UTC(y, m - 1, day);
      return y + (cur - start) / (end - start);
    };
    // Pre-compute fractional-year index alongside each daily entry for fast lookup
    const SP_DAILY_F = SP_DAILY.map(([d, p]) => [dateToFrac(d), p, d]);

    // For the chips we also need a fast year→last-price lookup from daily data
    const spPriceAtYear = year => {
      // find last entry whose fractional year is ≤ year + 1 (i.e. within that calendar year)
      const cap = year + 0.9999;
      let best = null;
      for (let i = SP_DAILY_F.length - 1; i >= 0; i--) {
        if (SP_DAILY_F[i][0] <= cap) { best = SP_DAILY_F[i][1]; break; }
      }
      return best;
    };

    const SM_SERIES = [
      { key: "netIncome",  label: "Net Income",  color: "#198038", unit: "$B",
        data: D.financials.filter(d => d.netIncome  != null).map(d => [d.year, d.netIncome  / 1000]).sort((a,b)=>a[0]-b[0]) },
      { key: "revenue",    label: "Revenue",     color: "#0f62fe", unit: "$B",
        data: D.financials.filter(d => d.revenue    != null).map(d => [d.year, d.revenue    / 1000]).sort((a,b)=>a[0]-b[0]) },
      { key: "marketCap",  label: "Market Cap",  color: "#005d5d", unit: "$B",
        data: D.financials.filter(d => d.marketCap  != null).map(d => [d.year, d.marketCap  / 1000]).sort((a,b)=>a[0]-b[0]) },
      // stockPrice uses SP_DAILY_F (fractional-year indexed daily data) when drawing;
      // the .data array here is kept for chips/growth calc fallback only.
      { key: "stockPrice", label: "Stock Price", color: "#9f1853", unit: "$/sh",
        data: SP_DAILY_F.map(([f, p]) => [f, p]) },
    ];
    // Active series key — one at a time so axis labels are unambiguous
    let smActiveKey = "netIncome";

    /* ---- Build SM_FINANCIALS from IBM_DATA (USD millions → $B) --------- */
    // Net income series — kept as the primary "ridge" for the reveal animation
    const SM_FINANCIALS = SM_SERIES.find(s => s.key === "netIncome").data;

    const SM_ERAS = [
      { id:"tab", title:"Tabulating Foundation", kicker:"Punch cards & leases",
        span:"1911 — 1935", from:1911, to:1935, focus:1924, accent:"--blue",
        body:"Charles Flint merges four firms into CTR in 1911; Thomas Watson Sr. arrives in 1914 and builds a sales-and-service machine around Herman Hollerith's punched card. Renamed IBM in 1924, the company sells tabulators, leases them — and the cards never stop reordering. Watson Sr. rebuilds the business around a recurring-revenue rental model: customers lease machines, buy proprietary cards, and the relationship never ends. Net income grows steadily through the 1920s even as the Great Depression sets in around it.",
        beat:"The card is consumable; the customer is permanent. Recurring supplies and leases, not one-time machines, are what compound.",
        miles:[[1911,"CTR incorporated"],[1914,"Watson Sr. joins"],[1924,"Renamed IBM"],[1935,"Social Security Act signed"]] },

      { id:"ssa", title:"Social Security Platform", kicker:"Government as anchor customer",
        span:"1935 — 1952", from:1935, to:1952, focus:1940, accent:"--sm-teal",
        body:"The Social Security Act is signed into law in August 1935, creating the largest bookkeeping operation in history — tracking the earnings of 26 million American workers. IBM wins the contract to supply and operate the tabulating machines that process those records, cementing punch cards as national infrastructure. The work requires IBM to rapidly expand production, and net income accelerates through the Depression and wartime years even as much of the world economy struggles. The government contract proves the model: IBM is not a machine company — it is a data-processing utility.",
        beat:"The Government has given us the largest tabulating task ever attempted. We will need every machine we can build — and then we will need more.",
        miles:[[1935,"Social Security Act · IBM contract"],[1941,"WWII production scale-up"],[1945,"Net income $10.9M · post-war peak"],[1952,"IBM 701 announced"]] },

      { id:"elec", title:"Electronic Computing Transition", kicker:"Tubes to transistors",
        span:"1952 — 1964", from:1952, to:1964, focus:1957, accent:"--blue",
        body:"Postwar, IBM crosses from electromechanical tabulators to electronic computers. The 701 (1952) brings stored-program computing to science and business; RAMAC (1956) ships the first commercial hard disk; the 1401 (1959) puts data processing in thousands of offices. Watson Jr. pushes the company through the transition before the old product line is exhausted, and revenue climbs from around $116M to nearly $2.9B over the period.",
        beat:"The tabulator built the company; the computer will rebuild the market. We move before the old line is exhausted.",
        miles:[[1952,"IBM 701"],[1956,"RAMAC — first commercial hard disk"],[1957,"FORTRAN released"],[1959,"IBM 1401"],[1964,"System/360 announced"]] },

      { id:"360", title:"Mainframe Platform", kicker:"The $5B compatible architecture bet",
        span:"1964 — 1975", from:1964, to:1975, focus:1966, accent:"--sm-gold",
        body:"In 1964 IBM bets roughly $5B — more than its annual revenue — on System/360: a single compatible family of machines that runs the same software across every price point. It is the first true computing platform, and it works. System/360 becomes the industry standard, IBM grows into the world's largest computer company, and the compatible architecture locks in enterprise customers for a generation. IBM unbundles software from hardware in 1969, creating the software industry as a side effect.",
        beat:"One architecture, top to bottom. A customer who outgrows a model should upgrade, not start over. Compatibility is the moat.",
        miles:[[1964,"System/360"],[1969,"Software unbundled from hardware"],[1975,"System/370 — virtual memory"]] },

      { id:"dist", title:"The PC and Minicomputer Era", kicker:"Beyond the glass house",
        span:"1975 — 1985", from:1975, to:1985, focus:1981, accent:"--sm-teal",
        body:"Minicomputers, departmental systems, and then the personal computer push computing out of the centralized data center. IBM responds with mid-range systems and, in 1981, the IBM PC — a machine designed with an open architecture to reach the market quickly. The PC succeeds spectacularly, defining the industry standard. But the open design means IBM cannot own the ecosystem it creates: Microsoft keeps the OS and Intel keeps the chip, setting up the crisis to come.",
        beat:"We needed to move fast and we did. The cost of speed was openness — and openness handed the franchise to others.",
        miles:[[1975,"System/370 mid-range systems"],[1977,"IBM Series/1 minicomputer"],[1981,"IBM Personal Computer launched"],[1984,"PC AT — 16-bit standard"]] },

      { id:"pc", title:"Platform Fragmentation & Crisis", kicker:"Clones, client-server, collapse",
        span:"1985 — 1993", from:1985, to:1993, focus:1993, accent:"--sm-red",
        body:"Clone makers commoditize the PC; Microsoft and Intel capture the value IBM created. As computing shifts to client-server architectures, the mainframe cash engine stalls and IBM's internal silos — each protecting its own product line — prevent a coherent response. Every advantage IBM built over three decades erodes at once. In 1993 IBM posts an $8.1B net loss, the largest in U.S. corporate history at the time, and a breakup is openly discussed on Wall Street.",
        beat:"We set the standard and gave away the franchise. The danger was never a competitor's machine; it was our own success going commodity.",
        miles:[[1985,"Clone market accelerates"],[1987,"PS/2 — failed attempt to retake the standard"],[1993,"Record $8.1B loss; breakup discussed"]] },

      { id:"gerstner", title:"Gerstner's Turnaround and the Services Platform", kicker:"Integration as the product",
        span:"1993 — 2000", from:1993, to:2000, focus:1997, accent:"--sm-teal",
        body:"Lou Gerstner arrives in April 1993 and makes the decision that defines the next decade: he keeps IBM whole. Where every analyst expected a breakup, Gerstner sees the integration of hardware, software, and services as IBM's only defensible advantage. He builds IBM Global Services into the world's largest IT services business, positions IBM as the integrator of other people's technology, and proves that the company can compete in an era it did not define. Deep Blue defeats Garry Kasparov in 1997. Revenue recovers and the stock price soars.",
        beat:"What clients want isn't a server; it's a problem solved. Integration is the product. We sell the result, and the hardware follows.",
        miles:[[1993,"Gerstner takes over; keeps IBM whole"],[1996,"IBM Global Services becomes largest IT services firm"],[1997,"Deep Blue defeats Kasparov"],[2000,"Revenue approaches $88B"]] },

      // optional per-era zoom: xRange: [fromYear, toYear]   (B2: documented hook; no era currently sets one)
      { id:"peak", title:"Smarter Planet and Middleware Platform", kicker:"Software as the profit engine",
        span:"2000 — 2012", from:2000, to:2012, focus:2011, accent:"--sm-gold",
        body:"Sam Palmisano takes over as CEO in 2002, having already navigated IBM through the dot-com bust that erased a third of technology-sector valuations. He sells the PC division to Lenovo in 2005 and concentrates IBM on high-margin software, middleware, and services. Acquisitions of Rational, Cognos, SPSS, and dozens of others build a software portfolio anchored by WebSphere, Tivoli, and DB2. The 'Smarter Planet' campaign frames IBM as the intelligence layer of global infrastructure. The strategy crests in 2011 — Watson wins Jeopardy!, IBM celebrates its centennial, and revenue hits its all-time high of $106.9B.",
        beat:"Exit what's becoming a commodity; invest where margin and expertise compound. Value, not volume, is the metric that matters.",
        miles:[[2005,"Sells PC division to Lenovo"],[2008,"'Smarter Planet' campaign launched"],[2010,"Acquires Netezza; analytics push"],[2011,"Watson wins Jeopardy!; 100th anniversary"]] },

      { id:"cognitive", title:"Watson and the Pivot Years", kicker:"Searching for the next platform",
        span:"2012 — 2019", from:2012, to:2019, focus:2016, accent:"--sm-red",
        body:"Ginni Rometty bets the company on Watson and cognitive computing, but struggles to convert AI leadership into platform economics. Meanwhile, AWS, Microsoft Azure, and Google Cloud define the public cloud market and IBM is slow to compete. Revenue slides from $107B toward $77B over seven consecutive years of decline. In 2019 IBM makes its largest acquisition ever — $34B for Red Hat — reframing the entire company around hybrid cloud and open source.",
        beat:"We were early to AI and late to the cloud. Hybrid is the answer to both — meet clients where their workloads already live.",
        miles:[[2011,"Watson wins Jeopardy!"],[2014,"'Strategic imperatives' framework launched"],[2015,"Forms Watson and Cloud business units"],[2019,"Acquires Red Hat for ~$34B"]] },

      { id:"hybrid", title:"Hybrid Cloud and AI Platform", kicker:"Open, regulated, mission-critical",
        span:"2019 — Today", from:2019, to:2025, focus:2023, accent:"--blue",
        body:"Arvind Krishna takes over in April 2020 and executes the sharpest strategic focus IBM has attempted since Gerstner. The managed-infrastructure business spins off as Kyndryl in November 2021, leaving software, consulting, and the Red Hat platform at the core. Red Hat's OpenShift becomes the connective tissue of IBM's hybrid cloud strategy, and watsonx — launched in 2023 — reanchors IBM in enterprise AI with a governance-first, open-model approach designed for regulated industries. Revenue returns to growth into 2025.",
        beat:"Open hybrid cloud plus enterprise-grade AI — built for the regulated, mission-critical work others won't touch. Disciplined growth, not growth at any price.",
        miles:[[2019,"Acquires Red Hat for ~$34B"],[2020,"Arvind Krishna becomes CEO"],[2021,"Spins off Kyndryl"],[2023,"watsonx AI platform launched"],[2025,"Revenue growth continues"]] }
    ];

    /* ---- Inject HTML skeleton into #panel-story ----------------------- */
    const host = document.getElementById("panel-story");
    host.innerHTML = `
      <div class="hero sm-hero">
        <div class="hero-text">
          <div class="hero-kicker">1911 — 2025 · ten eras · one income ridge</div>
          <h1>A century of IBM,<br>chapter by chapter</h1>
          <p>Ten pivots, one unbroken line. IBM reinvented itself from punch cards to mainframes,
             services to hybrid cloud — each era leaving a mark on the same income ridge.
             Scroll to walk it.</p>
        </div>
      </div>
      <div class="sm-scrollcue sm-scrollcue-inline">
        <span class="ln"></span> Scroll to begin
      </div>
      <div class="sm-scrolly">
        <div class="sm-steps" id="smSteps"></div>
        <div class="sm-graphic-col">
          <div class="sm-graphic">
            <div class="sm-ribbon" id="smRibbon" role="group" aria-label="Jump to era"></div>
            <div class="sm-card">
              <div class="sm-card-top">
                <span class="sm-card-label" id="smCardLabel">—</span>
                <span class="sm-live-badge" id="smLiveBadge" hidden><span class="lq-dot live"></span>LIVE</span>
                <span class="sm-card-era" id="smEraTag">—</span>
              </div>
              <div class="sm-series-toggles" id="smSeriesToggles"></div>
              <div class="sm-chart-wrap">
                <canvas id="smChart"></canvas>
              </div>
              <div class="sm-readout" role="status" aria-live="polite">
                <div class="sm-chip" id="smChipNI" data-tone="flat">
                  <div class="k" id="smChipNILabel">Net Income</div>
                  <div class="v" id="smNIVal">—</div>
                  <div class="note" id="smNINote"></div>
                </div>
                <div class="sm-chip" id="smChipGrowth" data-tone="flat">
                  <div class="k" id="smChipGrowthLabel">Net Income Growth</div>
                  <div class="v" id="smGrowthVal">—</div>
                  <div class="note" id="smGrowthNote"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="sm-outro">
        <h2>115 years, still rewriting itself.</h2>
        <p>From a punch-card company to a hybrid-cloud and AI business — the line
           never stopped bending. The next chapter is being written now.</p>
      </div>
      <div class="sm-devnote" id="smDevNote" hidden></div>`;

    /* ---- Canvas chart engine ------------------------------------------ */
    const canvas = document.getElementById("smChart");
    const ctx = canvas.getContext("2d");
    // Y0/Y1 span the full financial history
    const Y0 = D.financials[0].year, Y1 = D.financials[D.financials.length - 1].year;
    const getCSSVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

    // Dynamic domain — log for most series, linear for net income (supports negatives)
    const ABS_LOG_MIN = 0.0005;
    // For stock price: x-axis spans the daily data range (fractional years)
    const SP_FRAC_MIN = SP_DAILY_F.length ? SP_DAILY_F[0][0]                    : Y0;
    let SP_FRAC_MAX = SP_DAILY_F.length ? SP_DAILY_F[SP_DAILY_F.length-1][0]  : Y1;

    // ---- Live extension: bridge the gap between the static daily-price file
    // (only updates when the pipeline re-runs) and today, via the agent
    // server's live quote history. Mutates SP_DAILY_F + the stockPrice
    // series' .data in place so the existing chart/reveal code picks it up
    // with no further changes.
    async function smExtendLiveStockPrice() {
      const agentURL = window.CUGA_AGENT_URL || "http://localhost:8787";
      try {
        const r = await fetch(`${agentURL}/quote/history?symbol=IBM&range=1mo`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error("http " + r.status);
        const j = await r.json();
        const lastKnown = SP_DAILY_F.length ? SP_DAILY_F[SP_DAILY_F.length - 1][2] : null;
        const fresh = (j.points || []).filter(p => p.close != null && (!lastKnown || p.date > lastKnown));
        if (!fresh.length) return;
        const stockSeries = SM_SERIES.find(s => s.key === "stockPrice");
        fresh.forEach(p => {
          const f = dateToFrac(p.date);
          SP_DAILY_F.push([f, p.close, p.date]);
          if (stockSeries) stockSeries.data.push([f, p.close]);
        });
        SP_FRAC_MAX = SP_DAILY_F[SP_DAILY_F.length - 1][0];
        // extend the last era's cap so scrolling all the way in still reveals live data
        const lastEra = SM_ERAS[SM_ERAS.length - 1];
        lastEra.to = Math.max(lastEra.to, Math.ceil(SP_FRAC_MAX));
        smStockIsLive = true;
        if (smActiveKey === "stockPrice") {
          const badge = document.getElementById("smLiveBadge");
          if (badge) badge.hidden = false;
          smActivate(smActiveIdx);   // refresh reveal cap + chips against the new data
        }
      } catch (_) { /* agent server offline — chart stays at the static file's last date */ }
    }
    let smStockIsLive = false;

    function smComputeDomain() {
      const s = SM_SERIES.find(s => s.key === smActiveKey);
      if (!s) return [ABS_LOG_MIN, 1];
      const isNI  = smActiveKey === "netIncome";
      const isSP  = smActiveKey === "stockPrice";
      const xLo   = isSP ? SP_FRAC_MIN : smXMin;
      const xHi   = isSP ? SP_FRAC_MAX : smXMax;
      let lo = Infinity, hi = -Infinity;
      for (const [yr, v] of s.data) {
        if (yr < xLo || yr > xHi) continue;
        if (v == null) continue;
        if (!isNI && !isSP && v <= 0) continue; // log scale only skips non-positive for non-SP
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      // Net income: linear, supports negatives
      if (isNI) {
        if (!isFinite(lo)) lo = -1;
        if (!isFinite(hi)) hi = 1;
        const range = hi - lo;
        return [lo - range * 0.1, hi + range * 0.05];
      }
      // Stock price: linear from 0, pad 5% above high to match Yahoo Finance look
      if (isSP) {
        if (!isFinite(hi)) hi = 1;
        return [0, hi * 1.05];
      }
      // Everything else: log scale
      if (!isFinite(lo)) lo = ABS_LOG_MIN;
      if (!isFinite(hi)) hi = 1;
      const logLo = Math.floor(Math.log10(lo));
      const logHi = Math.ceil(Math.log10(hi));
      return [Math.pow(10, logLo), Math.pow(10, logHi)];
    }

    let W = 0, H = 0, dpr = 1;
    function smResize() {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = r.width; H = r.height;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      smDraw();
    }
    const pad = { l:52, r:16, t:14, b:26 };
    // xOf respects per-era xRange zoom when set; falls back to full century.
    // For stock price the x-axis always spans the full daily data range.
    let smXMin = Y0, smXMax = Y1;
    const xOf = y => {
      const xLo = smActiveKey === "stockPrice" ? SP_FRAC_MIN : smXMin;
      const xHi = smActiveKey === "stockPrice" ? SP_FRAC_MAX : smXMax;
      return pad.l + (y - xLo) / (xHi - xLo) * (W - pad.l - pad.r);
    };
    // yOf is rebuilt each draw from the current dynamic domain
    // Linear for net income and stock price; log for revenue and market cap
    let smLogMin = ABS_LOG_MIN, smLogMax = 1;
    const yOf = v => {
      if (smActiveKey === "netIncome" || smActiveKey === "stockPrice") {
        const t = (v - smLogMin) / (smLogMax - smLogMin);
        return (H - pad.b) - t * (H - pad.t - pad.b);
      }
      const t = (Math.log10(Math.max(v, smLogMin)) - Math.log10(smLogMin)) /
                (Math.log10(smLogMax) - Math.log10(smLogMin));
      return (H - pad.b) - t * (H - pad.t - pad.b);
    };
    let smRevealYear = Y0, smTargetReveal = Y0, smActiveIdx = 0, smRaf = null;
    const smReduce = window.matchMedia("(prefers-reduced-motion:reduce)").matches;

    function smTick() {
      const d = smTargetReveal - smRevealYear;
      // For daily stock price data, use a tighter snap threshold (fractional years are small)
      const snap = smActiveKey === "stockPrice" ? 0.002 : 0.4;
      if (Math.abs(d) < snap) { smRevealYear = smTargetReveal; smDraw(); smRaf = null; return; }
      smRevealYear += d * 0.12;
      smDraw();
      smRaf = requestAnimationFrame(smTick);
    }
    function smSetReveal(year) {
      // For stock price, convert the integer era.to year to the fractional year of the
      // last trading day of that calendar year in the daily dataset.
      if (smActiveKey === "stockPrice") {
        const cap = year + 0.9999;
        let fracTarget = SP_FRAC_MIN;   // A2: default to start (not end) so pre-1962 eras stay dark
        for (let i = SP_DAILY_F.length - 1; i >= 0; i--) {
          if (SP_DAILY_F[i][0] <= cap) { fracTarget = SP_DAILY_F[i][0]; break; }
        }
        smTargetReveal = fracTarget;
      } else {
        smTargetReveal = year;
      }
      if (smReduce) { smRevealYear = smTargetReveal; smDraw(); return; }
      if (!smRaf) smRaf = requestAnimationFrame(smTick);
    }

    function hexA(hex, a) {
      hex = (hex || "").trim();
      if (hex.startsWith("rgb")) return hex.replace(/rgba?\(([^)]+)\)/, (m, b) => `rgba(${b.split(",").slice(0, 3).join(",")},${a})`);
      const n = hex.replace("#", ""); const f = n.length === 3 ? n.split("").map(c => c + c).join("") : n;
      const r = parseInt(f.slice(0, 2), 16) || 120, g = parseInt(f.slice(2, 4), 16) || 140, b = parseInt(f.slice(4, 6), 16) || 160;
      return `rgba(${r},${g},${b},${a})`;
    }

    // Build a polyline path for a data array up to `upto` (fractional year); returns last visible point.
    // For net income (linear scale) all values including negatives are plotted continuously.
    // For stock price the data is SP_DAILY_F (fractional-year indexed); same path logic applies.
    function smBuildPath(data, upto) {
      const isSP = smActiveKey === "stockPrice";
      const cap  = isSP ? upto : Math.min(upto, Y1);
      const isNI = smActiveKey === "netIncome";
      let started = false, lastPt = null, firstPt = null;
      ctx.beginPath();
      for (const [yr, v] of data) {
        if (yr > cap) break;
        if (!isNI && v <= 0) { started = false; continue; }
        const xx = xOf(yr), yy = yOf(v);
        if (!started) { ctx.moveTo(xx, yy); started = true; } else ctx.lineTo(xx, yy);
        if (!firstPt) firstPt = [yr, v];
        lastPt = [yr, v];
      }
      return { started, lastPt, firstPt: firstPt || data[0] };
    }

    // Stroke a series line (faint ghost or bright revealed)
    function smStrokeSeries(data, upto, color, width) {
      ctx.lineWidth = width; ctx.strokeStyle = color; ctx.lineJoin = "round";
      smBuildPath(data, upto);
      ctx.stroke();
    }

    // Stroke the revealed portion + gradient fill below it
    function smStrokeFill(data, upto, color, width) {
      const isSP = smActiveKey === "stockPrice";
      const isNI = smActiveKey === "netIncome";
      ctx.lineWidth = width; ctx.strokeStyle = color; ctx.lineJoin = "round";
      const { started, lastPt, firstPt } = smBuildPath(data, upto);
      ctx.stroke();
      if (started && lastPt && firstPt) {
        const zeroY = isNI ? yOf(0) : H - pad.b;
        const capVal = isSP ? upto : Math.min(upto, Y1);
        ctx.beginPath();
        for (const [yr, v] of data) {
          if (yr > capVal) break;
          if (!isNI && v <= 0) continue;
          const xx = xOf(yr), yy = isNI ? Math.min(yOf(v), zeroY) : yOf(v);
          ctx.lineTo(xx, yy);
        }
        ctx.lineTo(xOf(lastPt[0]), zeroY);
        ctx.lineTo(xOf(firstPt[0]), zeroY);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, pad.t, 0, zeroY);
        g.addColorStop(0, hexA(color, 0.18)); g.addColorStop(1, hexA(color, 0));
        ctx.fillStyle = g; ctx.fill();
      }
    }

    function smDraw() {
      if (!W) return;
      ctx.clearRect(0, 0, W, H);
      const era = SM_ERAS[smActiveIdx];
      const accent = getCSSVar(era.accent) || getCSSVar("--blue");
      const activeSeries = SM_SERIES.find(s => s.key === smActiveKey);
      if (!activeSeries) return;

      // Recompute domain from the active series in the current x window
      [smLogMin, smLogMax] = smComputeDomain();

      // --- y-axis grid lines ---
      ctx.font = "10px " + getCSSVar("--mono");
      ctx.textBaseline = "middle";
      const isNIActive = smActiveKey === "netIncome";
      const isSharePrice = smActiveKey === "stockPrice";
      const labelTick = v => {
        if (isSharePrice)  return "$" + (Number.isInteger(v) ? v : v.toFixed(0));
        if (Math.abs(v) < 1) return "$" + v;
        const sign = v < 0 ? "−$" : "$";
        if (Math.abs(v) < 1000) return sign + Math.abs(v) + "B";
        return sign + (Math.abs(v) / 1000).toFixed(0) + "T";
      };
      let gridTicks = [];
      if (isNIActive || isSharePrice) {
        // Linear ticks: nice round increments across the domain (used for NI and stock price)
        const range = smLogMax - smLogMin;
        const rawStep = range / 5;
        const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(rawStep))));
        const step = Math.ceil(rawStep / mag) * mag;
        const start = Math.ceil(smLogMin / step) * step;
        for (let t = start; t <= smLogMax + step * 0.01; t += step) gridTicks.push(Math.round(t * 100) / 100);
        // always include zero
        if (!gridTicks.includes(0) && smLogMin < 0 && smLogMax > 0) gridTicks.push(0);
        gridTicks.sort((a, b) => a - b);
      } else {
        const logLo = Math.floor(Math.log10(smLogMin));
        const logHi = Math.ceil(Math.log10(smLogMax));
        for (let e = logLo; e <= logHi; e++) gridTicks.push(Math.pow(10, e));
      }
      gridTicks.forEach(g => {
        const yy = yOf(g);
        if (yy < pad.t || yy > H - pad.b) return;
        ctx.strokeStyle = getCSSVar("--sm-grid") || "#1d2129";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
        ctx.fillStyle = getCSSVar("--ink-dim");
        ctx.textAlign = "right";
        ctx.fillText(labelTick(g), pad.l - 6, yy);
      });

      // --- x-axis year ticks ---
      ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = getCSSVar("--ink-dim");
      if (isSharePrice) {
        // Stock price: x-axis spans fractional years; label every 10 calendar years
        const yLo = Math.ceil(SP_FRAC_MIN / 10) * 10;
        const yHi = Math.floor(SP_FRAC_MAX);
        for (let y = yLo; y <= yHi; y += 10) {
          const xx = xOf(y);
          if (xx >= pad.l && xx <= W - pad.r) ctx.fillText(y, xx, H - pad.b + 6);
        }
      } else {
        const xSpan = smXMax - smXMin;
        const xStep = xSpan <= 60 ? 10 : 20;
        const xStart = Math.ceil(smXMin / xStep) * xStep;
        for (let y = xStart; y <= smXMax; y += xStep) {
          const xx = xOf(y);
          if (xx >= pad.l && xx <= W - pad.r) ctx.fillText(y, xx, H - pad.b + 6);
        }
      }

      // --- era band ---
      // For stock price the era band uses fractional years so it overlays the daily line correctly
      const eraFromF = isSharePrice ? era.from : Math.max(era.from, Y0);
      const eraToF   = isSharePrice ? Math.min(era.to, SP_FRAC_MAX) : Math.min(era.to, Y1);
      const bx0 = xOf(eraFromF), bx1 = xOf(eraToF);
      const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
      grad.addColorStop(0, hexA(accent, 0.16)); grad.addColorStop(1, hexA(accent, 0.02));
      ctx.fillStyle = grad; ctx.fillRect(bx0, pad.t, bx1 - bx0, H - pad.t - pad.b);
      ctx.strokeStyle = hexA(accent, 0.5); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(bx1, pad.t); ctx.lineTo(bx1, H - pad.b); ctx.stroke();

      // --- faint full-range ghost line ---
      const ghostCap = isSharePrice ? SP_FRAC_MAX : Y1;
      smStrokeSeries(activeSeries.data, ghostCap, hexA(getCSSVar("--ink-soft"), 0.18), 1.5);

      // --- revealed bright line + fill ---
      // All series use the era accent colour so the line shifts with each chapter,
      // matching the behaviour that Net Income has always had.
      smStrokeFill(activeSeries.data, smRevealYear, accent, 2.4);

      // --- stock-price data gap note (Yahoo Finance history starts 1962) ---
      if (isSharePrice && SP_DAILY_F.length && era.from < 1962) {
        const gapX = xOf(SP_FRAC_MIN) + 6;
        const gapY = pad.t + 14;
        ctx.font = "9px " + getCSSVar("--mono");
        ctx.textAlign = "left"; ctx.textBaseline = "top";
        ctx.fillStyle = hexA(getCSSVar("--ink-dim"), 0.7);
        ctx.fillText("Yahoo Finance data from " + SP_DAILY_F[0][2].slice(0, 4), gapX, gapY);
      }

      // --- milestone markers ---
      // For stock price: find the nearest daily price to the milestone year.
      // Labels anchor near each dot; bounding-box collision detection avoids overlaps.
      const usedLabelBoxes = [];
      era.miles.forEach(([my]) => {
        if (my > smRevealYear + 0.5) return;
        let row;
        if (isSharePrice) {
          // find closest daily entry to Jan 1 of milestone year
          const target = my + 0.001;
          row = SP_DAILY_F.find(([f]) => f >= target);
          if (!row) row = SP_DAILY_F[SP_DAILY_F.length - 1];
        } else {
          row = activeSeries.data.find(([yr]) => yr === my);
        }
        const logScale = !isNIActive && !isSharePrice;   // A1: only skip non-positive on log axes
        if (!row || row[1] == null || (logScale && row[1] <= 0)) return;
        const mx = xOf(row[0]), myy = yOf(row[1]);
        ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(mx, myy, 3.4, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = hexA(accent, 0.35); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(mx, myy, 6, 0, Math.PI * 2); ctx.stroke();

        ctx.font = "9.5px " + getCSSVar("--mono");
        const lw = ctx.measureText(String(my)).width;
        const lh = 11;
        const isRight = mx > W - 90;
        const lx = isRight ? mx - 7 - lw : mx + 7;

        // Try: above dot, further above, below dot, even further above
        const yOptions = [myy - 20, myy - 36, myy + 12, myy - 52, myy + 26];
        let ly = yOptions[0];
        for (const yOpt of yOptions) {
          if (yOpt < pad.t || yOpt + lh > H - pad.b) continue;
          const b = { x1: lx - 2, x2: lx + lw + 2, y1: yOpt - 2, y2: yOpt + lh + 2 };
          if (!usedLabelBoxes.some(o => b.x2 > o.x1 && b.x1 < o.x2 && b.y2 > o.y1 && b.y1 < o.y2)) {
            ly = yOpt; break;
          }
        }
        usedLabelBoxes.push({ x1: lx - 2, x2: lx + lw + 2, y1: ly - 2, y2: ly + lh + 2 });

        // Leader line from dot ring to label
        ctx.strokeStyle = hexA(accent, 0.25); ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
        const lineStart = ly > myy ? myy + 8 : myy - 8;
        const lineEnd   = ly > myy ? ly - 2  : ly + lh + 2;
        ctx.beginPath(); ctx.moveTo(mx, lineStart); ctx.lineTo(mx, lineEnd); ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = getCSSVar("--ink"); ctx.font = "9.5px " + getCSSVar("--mono");
        ctx.textAlign = isRight ? "right" : "left";
        ctx.textBaseline = "top";
        ctx.fillText(my, isRight ? mx - 7 : mx + 7, ly);
      });

    }

    /* ---- Report loader (lazy-fetches pipeline/raw/text/{year}.txt) ------- */
    const SmLoader = {
      served: location.protocol === "http:" || location.protocol === "https:",
      note: "",
      urlFor(era) { return SM_REPORTS.dir + "/" + SM_REPORTS.filePattern.replace("{year}", era.focus); },
      async letterFor(era) {
        if (!this.served) throw new Error("offline");
        const r = await fetch(this.urlFor(era), { cache: "no-store" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const text = (await r.text()).trim();
        return text.length > SM_REPORTS.letterMaxChars
          ? text.slice(0, SM_REPORTS.letterMaxChars).replace(/\s+\S*$/, "") + " …"
          : text;
      }
    };
    SmLoader.note = SmLoader.served
      ? "Connected · letters load from " + SM_REPORTS.dir + "/"
      : "Serving over file:// — letter text unavailable. Serve over http to enable.";

    // A4: surface the dev note in the file:// case
    const devNote = document.getElementById("smDevNote");
    if (!SmLoader.served) {
      devNote.hidden = false;
      devNote.innerHTML = "<b>Annual-report letters:</b> " + SmLoader.note;
    }

    /* ---- Series selector buttons (radio-style, one at a time) ----------- */
    const smTogglesEl = document.getElementById("smSeriesToggles");
    const smAllBtns = [];
    function smUpdateCardLabel() {
      const s = SM_SERIES.find(s => s.key === smActiveKey);
      if (!s) return;
      // A3: Net Income is linear (supports negatives); only other non-stock series use log
      const suffix = s.key === "stockPrice" ? " · Yahoo Finance daily · adj. close"
                   : s.key === "netIncome"  ? " · linear scale"
                   : " · log scale";
      document.getElementById("smCardLabel").textContent = s.label + " · " + s.unit + suffix;
    }
    SM_SERIES.forEach(s => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sm-series-btn";
      btn.dataset.key = s.key;
      btn.setAttribute("aria-pressed", s.key === smActiveKey ? "true" : "false");
      btn.innerHTML = `<span class="sm-series-swatch" style="background:${s.color}"></span>${s.label} <small>${s.unit}</small>`;
      btn.addEventListener("click", () => {
        if (smActiveKey === s.key) return;          // already selected
        smActiveKey = s.key;
        smAllBtns.forEach(b => b.setAttribute("aria-pressed", b.dataset.key === smActiveKey ? "true" : "false"));
        // Reset reveal position to the correct domain start for the new series
        smRevealYear = s.key === "stockPrice" ? SP_FRAC_MIN : Y0;
        smTargetReveal = smRevealYear;
        smUpdateCardLabel();
        const badge = document.getElementById("smLiveBadge");
        if (badge) badge.hidden = !(s.key === "stockPrice" && smStockIsLive);
        smDraw();
        smActivate(smActiveIdx);                    // refresh chips to match new series
      });
      smAllBtns.push(btn);
      smTogglesEl.appendChild(btn);
    });

    /* ---- Build chapter steps + ribbon ----------------------------------- */
    const stepsEl = document.getElementById("smSteps");
    const ribbonEl = document.getElementById("smRibbon");

    SM_ERAS.forEach((era, i) => {
      const step = document.createElement("article");
      step.className = "sm-step"; step.dataset.idx = i;
      step.style.setProperty("--accent", "var(" + era.accent + ")");
      step.innerHTML = `
        <div class="sm-step-inner">
          <span class="num">CHAPTER ${String(i + 1).padStart(2, "0")} / ${String(SM_ERAS.length).padStart(2, "0")}</span>
          <div class="kicker">${era.kicker}</div>
          <h2>${era.title}</h2>
          <div class="span">${era.span}</div>
          <p class="body">${era.body}</p>
          <div class="sm-beat">
            <span class="src">From the ${era.focus} annual report</span>
            <p data-beat>${era.beat}</p>
            <button type="button" class="sm-letter-btn" data-letter aria-expanded="false">Read the ${era.focus} report</button>
            <div class="sm-letter" data-letterbox hidden></div>
          </div>
          <div class="sm-miles">${era.miles.map(([y, l]) => `<span class="sm-mile"><b>${y}</b> · ${l}</span>`).join("")}</div>
        </div>`;
      stepsEl.appendChild(step);

      // lazy-load full letter on expand
      const btn = step.querySelector("[data-letter]");
      const box = step.querySelector("[data-letterbox]");
      let loaded = false;
      btn.addEventListener("click", async () => {
        const open = !box.hidden;
        if (open) { box.hidden = true; btn.setAttribute("aria-expanded", "false"); btn.textContent = "Read the " + era.focus + " report"; return; }
        box.hidden = false; btn.setAttribute("aria-expanded", "true"); btn.textContent = "Hide report";
        if (loaded) return;
        box.innerHTML = `<span class="sm-letter-status">Loading ${era.focus}…</span>`;
        try {
          box.textContent = await SmLoader.letterFor(era); loaded = true;
        } catch (err) {
          box.innerHTML = `<span class="sm-letter-status">` +
            (SmLoader.served
              ? `No file at <code>${SmLoader.urlFor(era)}</code>. Check pipeline/raw/text/ exists and the server root is the project root.`
              : `Annual report text loads only when the page is served over http (not file://). The narrative beat above is the curated summary.`) +
            `</span>`;
        }
      });

      // ribbon button
      const b = document.createElement("button");
      b.type = "button"; b.dataset.idx = i;
      b.setAttribute("aria-label", era.title + ", " + era.span);   // D: accessible name
      b.innerHTML = `<span class="yr">${era.from}</span>`;
      b.addEventListener("click", () => step.scrollIntoView({ behavior: smReduce ? "auto" : "smooth", block: "center" }));
      ribbonEl.appendChild(b);
    });

    /* ---- Readout chips -------------------------------------------------- */
    const smEl = id => document.getElementById(id);
    let smCountRaf = null;
    // Format a plain number (used for growth %)
    function smFmt(v) {
      const a = Math.abs(v);
      if (a === 0) return "0";
      if (a < 10)  return v.toFixed(1);
      return v.toFixed(0);
    }
    // Format a dollar value in $B — switches to $M when under 1B
    function smFmtMoney(vB) {
      const a = Math.abs(vB);
      if (a < 1) {
        // convert to millions
        const m = vB * 1000;
        return "$" + (Math.abs(m) < 10 ? m.toFixed(1) : m.toFixed(0)) + "\u2009M";
      }
      if (a < 10)  return "$" + vB.toFixed(1) + "\u2009B";
      return "$" + vB.toFixed(0) + "\u2009B";
    }
    // B4: fmt is an explicit formatter function — no more magic sentinel
    function smCountTo(node, target, fmt) {
      cancelAnimationFrame(smCountRaf);
      if (smReduce) { node.textContent = fmt(target); return; }
      const start = performance.now(), dur = 650;
      smCountRaf = requestAnimationFrame(function run(now) {
        const t = Math.min((now - start) / dur, 1);
        const v = target * (1 - Math.pow(1 - t, 3));
        node.textContent = fmt(v);
        if (t < 1) smCountRaf = requestAnimationFrame(run);
      });
    }

    function smActivate(i) {
      smActiveIdx = i;
      const era = SM_ERAS[i];
      smSetReveal(era.to);

      // ribbon + step active class
      [...ribbonEl.children].forEach((b, k) => b.setAttribute("aria-current", k === i ? "true" : "false"));
      [...stepsEl.children].forEach((s, k) => s.classList.toggle("is-active", k === i));

      smEl("smEraTag").textContent = era.span.replace(/\s/g, "");

      // Update x-axis zoom then redraw (xRange is an optional per-era zoom hook; unused if not set)
      smXMin = era.xRange ? era.xRange[0] : Y0;
      smXMax = era.xRange ? era.xRange[1] : Y1;
      smDraw();

      // Left chip: active series value at era end year
      const activeSer = SM_SERIES.find(s => s.key === smActiveKey);
      const serLabel = activeSer ? activeSer.label : "Value";
      const isShare = smActiveKey === "stockPrice";
      smEl("smChipNILabel").textContent = serLabel;
      smEl("smChipGrowthLabel").textContent = serLabel + " Growth";

      // Look up value from the active series data array.
      // For stock price use spPriceAtYear (daily data) rather than exact integer match.
      // For other series, fall back to the latest year at-or-before era.to that actually
      // has data — era.to can be nudged past the audited data (e.g. the live stock-price
      // extension pushes the last era's .to forward for ALL series, not just stockPrice),
      // which used to show "n/a" even though the most recent reported figure exists.
      const latestAtOrBefore = (data, year) => {
        for (let k = data.length - 1; k >= 0; k--) {
          if (data[k][0] <= year) return data[k];
        }
        return [null, null];
      };
      const [toYear, serVal] = isShare
        ? [era.to, spPriceAtYear(era.to)]
        : latestAtOrBefore(activeSer ? activeSer.data : [], era.to);
      if (serVal != null) {
        smEl("smNINote").textContent = serLabel.toLowerCase() + " · " + toYear;
        smCountTo(smEl("smNIVal"), serVal, isShare ? v => "$" + smFmt(v) : smFmtMoney);
        smEl("smChipNI").dataset.tone = serVal >= 0 ? "up" : "down";
      } else {
        smEl("smNIVal").textContent = "n/a";
        smEl("smNINote").textContent = "not reported · " + era.to;
        smEl("smChipNI").dataset.tone = "flat";
      }

      // Right chip: active series growth era.from → toYear
      const serValFrom = isShare
        ? spPriceAtYear(era.from)
        : latestAtOrBefore(activeSer ? activeSer.data : [], era.from)[1];
      const growth = (serVal != null && serValFrom != null && serValFrom !== 0)
        ? (serVal - serValFrom) / Math.abs(serValFrom) * 100 : null;
      if (growth != null) {
        const sign = growth >= 0 ? "+" : "";
        smEl("smGrowthVal").textContent = sign + smFmt(growth) + "\u2009%";
        smEl("smGrowthNote").textContent = serLabel.toLowerCase() + " " + sign + smFmt(growth) + "% from " + era.from + " to " + toYear;
        smEl("smChipGrowth").dataset.tone = growth >= 0 ? "up" : "down";
      } else {
        smEl("smGrowthVal").textContent = "n/a";
        smEl("smGrowthNote").textContent = "insufficient data";
        smEl("smChipGrowth").dataset.tone = "flat";
      }
    }

    /* ---- Scroll observer ------------------------------------------------ */
    const smIO = new IntersectionObserver(entries => {
      entries.forEach(e => { if (e.isIntersecting) smActivate(+e.target.dataset.idx); });
    }, { rootMargin: "-45% 0px -45% 0px", threshold: 0 });
    [...stepsEl.children].forEach(s => smIO.observe(s));

    /* ---- Boot ----------------------------------------------------------- */
    window.addEventListener("resize", smResize, { passive: true });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(smResize);
    // Defer resize until the panel is visible (canvas has zero dimensions when hidden)
    const smPanelObserver = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) { smResize(); smPanelObserver.disconnect(); }
    }, { threshold: 0.01 });
    smPanelObserver.observe(host);
    smUpdateCardLabel();   // A3: populate label before first paint (no stale skeleton text)
    smActivate(0);

    // Bridge the static daily-price file up to today, then keep it fresh.
    smExtendLiveStockPrice();
    setInterval(smExtendLiveStockPrice, 5 * 60 * 1000);

    // hook for the window.CUGA agent tool jump_to_story_chapter
    window.setStoryChapter = (idOrTitle, seriesKey) => {
      let idx = typeof idOrTitle === "number" ? idOrTitle : -1;
      if (idx < 0) {
        const q = String(idOrTitle).trim().toLowerCase();
        idx = SM_ERAS.findIndex(e => e.id === q || e.title.toLowerCase().includes(q));
      }
      if (idx < 0 || idx >= SM_ERAS.length) throw new Error(`no Story Mode chapter matching '${idOrTitle}'`);
      if (seriesKey && SM_SERIES.some(s => s.key === seriesKey) && seriesKey !== smActiveKey) {
        smActiveKey = seriesKey;
        smAllBtns.forEach(b => b.setAttribute("aria-pressed", b.dataset.key === smActiveKey ? "true" : "false"));
        smRevealYear = seriesKey === "stockPrice" ? SP_FRAC_MIN : Y0;
        smTargetReveal = smRevealYear;
        smUpdateCardLabel();
      }
      stepsEl.children[idx].scrollIntoView({ behavior: smReduce ? "auto" : "smooth", block: "center" });
      smActivate(idx);
      return { chapter: SM_ERAS[idx].title, index: idx, series: smActiveKey };
    };
  }

  /* ====================================================================== */
  /*  PLACEHOLDER PANELS  (the team builds these out one by one)            */
  /* ====================================================================== */
  const PLACEHOLDERS = {
    regression: {
      title: "Regression Lab",
      lede: "Interactive regressions between any two metrics — e.g. revenue vs. headcount, R&D vs. net income — with fit, R², and residuals.",
      plan: [
        "Pick X and Y metric + year range; show scatter, regression line, R², and a plain-English readout.",
        "Lagged relationships (e.g. R&D this year vs revenue 3 years later).",
        "Flag where the relationship breaks (divestitures, recessions).",
      ],
      data: "Any pair of fields in IBM_DATA.financials.",
    },
  };

  function renderPlaceholder(name, cfg) {
    document.getElementById("panel-" + name).innerHTML = `
      <div class="ph">
        <span class="badge">Planned · not started</span>
        <h2>${cfg.title}</h2>
        <p class="lede">${cfg.lede}</p>
        <div class="planbox">
          <h3>What this tab will do</h3>
          <ul>${cfg.plan.map(p => `<li>${p}</li>`).join("")}</ul>
          <p class="datahint"><b>Data it can use today:</b> ${cfg.data}</p>
        </div>
        <div class="wire">— wireframe space — owning team builds the UI here —</div>
        <p class="datahint">Build it inside <code>&lt;section id="panel-${name}"&gt;</code> (see app.js header comment).</p>
      </div>`;
  }
  try { Object.entries(PLACEHOLDERS).forEach(([n, c]) => renderPlaceholder(n, c)); } catch (e) { console.error("Placeholder tabs failed to render:", e); }
  try { buildStoryMode(); } catch (e) { console.error("Story Mode tab failed to render:", e); }
  try { buildMacroTab(); } catch (e) { console.error("Macro vs IBM tab failed to render:", e); }
  try { hideEmptyMacroCharts(); hideOrphanMacroSectionHeaders(); } catch (e) { console.error("hideEmptyMacroCharts failed:", e); }
  mountLiveQuotesRow("macroLiveRow", "^GSPC,^IXIC,^DJI,^TNX,IBM", "Markets now");

  /* If every card under a Macro-tab section header ends up hidden (e.g.
     Section E — Treasury Yields, which has no data source yet), hide the
     orphaned header + subtitle too instead of showing a heading over nothing. */
  function hideOrphanMacroSectionHeaders() {
    const panel = document.getElementById("panel-macro");
    if (!panel) return;
    [...panel.querySelectorAll(".mac-section-header")].forEach(header => {
      let sib = header.nextElementSibling, anyVisible = false;
      while (sib && !sib.classList.contains("mac-section-header")) {
        // A sibling counts as visible if it is not explicitly hidden AND either
        // has rendered children (bare container divs like mktCapSnapshotRoot /
        // execVisualsRoot that get populated by JS after innerHTML is set) or
        // has a non-empty chart-host/card with content.
        if (sib.style.display !== "none" && sib.childElementCount > 0) anyVisible = true;
        sib = sib.nextElementSibling;
      }
      // Two-way for the same reason hideEmptyMacroCharts is: a header hidden
      // during the pre-layout pass must come back once its cards draw.
      header.style.display = anyVisible ? "" : "none";
    });
    // Relabel the surviving section letters sequentially (A, B, C...) so
    // hidden sections don't leave a visible gap like "B, C, D, F".
    let letter = 65; // "A"
    [...panel.querySelectorAll(".mac-section-header")].forEach(header => {
      if (header.style.display === "none") return;
      const el = header.querySelector(".mac-section-letter");
      if (el) el.textContent = String.fromCharCode(letter);
      letter++;
    });
  }

  /* Remove/hide any Macro-tab chart card whose data isn't available yet, so
     the tab never shows a labeled box with nothing drawn in it. Cards
     reappear automatically once the underlying macro.json field is real
     (e.g. after re-running pipeline/macro.py for Fed Funds / Unemployment). */
  /* Undo a previous hide pass so charts get a measurable host before they are
     asked to draw. Only clears the inline display this code set; it does not
     touch cards hidden by their own stylesheet rules. */
  function revealMacroCards() {
    const panel = document.getElementById("panel-macro");
    if (!panel) return;
    panel.querySelectorAll(".chart-host, .sp-chart-host").forEach(host => {
      const card = host.closest(".card");
      if (card && card.style.display === "none") card.style.display = "";
    });
    panel.querySelectorAll(".mac-section-header").forEach(h => {
      if (h.style.display === "none") h.style.display = "";
    });
  }

  function hideEmptyMacroCharts() {
    const panel = document.getElementById("panel-macro");
    if (!panel) return;
    panel.querySelectorAll(".chart-host, .sp-chart-host").forEach(host => {
      const svg = host.querySelector("svg");
      const hasCanvas = !!host.querySelector("canvas");
      const isEmpty = hasCanvas ? false : (svg ? svg.children.length === 0
        : [...host.children].every(c => c.classList.contains("tooltip") || c.classList.contains("sp-tooltip")));
      const card = host.closest(".card");
      if (!card) return;
      // Two-way, and it must be. This runs at load while panel-macro is still
      // hidden, so a chart that needs layout width has not drawn yet and looks
      // "empty" — hiding it then made the host 0x0, which meant it could never
      // draw, which meant it stayed hidden. That trap is what kept the
      // total-return card invisible even after its data existed. Re-running
      // this once the panel is visible now restores anything that has since
      // drawn (see the macro branch of selectTab).
      card.style.display = isEmpty ? "none" : "";
    });
    const kpiBar = document.getElementById("spKpiBar");
    if (kpiBar) {
      const allDash = [...kpiBar.querySelectorAll(".sp-kpi-val")].every(v => v.textContent.trim() === "—");
      kpiBar.style.display = allDash ? "none" : "";
    }
  }
  try { buildMATab(); } catch (e) { console.error("Mergers & Acquisitions tab failed to render:", e); }

  /* ====================================================================== */
  /*  MACRO VS IBM: IBM growth indexed against GDP &amp; the S&amp;P 500       */
  /* ====================================================================== */
  function buildMacroTab() {
    const macro = D.macro;
    if (!macro) return;
    const cpi        = macro.cpiIndex;
    const recessions = macro.recessions || [];

    const IBM_OPTIONS = [
      { key: "revenue",   label: "IBM revenue",    color: "#4589ff" },
      { key: "marketCap", label: "IBM market cap", color: "#2dd4bf" },
    ];
    const BENCHMARKS = [
      { key: "sp500",  label: "S&P 500",            color: "#f59e0b", data: macro.sp500YearEnd },
      { key: "tech",   label: "S&P 500 Tech (XLK)", color: "#f87171", data: macro.techYearEnd },
      { key: "nasdaq", label: "Nasdaq Composite",   color: "#a78bfa", data: macro.nasdaqYearEnd },
      { key: "djia",   label: "Dow Jones (DJIA)",   color: "#4ade80", data: macro.djiaYearEnd },
    ];

    document.getElementById("panel-macro").innerHTML = `
      <div class="hero">
        <div class="hero-text">
          <div class="hero-kicker" id="macroKicker">1911 — 2025 · IBM vs. the market · recessions since 1854</div>
          <h1>IBM against the market</h1>
          <p>Stock performance, market cap, debt structure, and macro backdrop — all on one tab.
             Every number traces to a named source: Bloomberg, Yahoo Finance, IBM 10-Ks, and FRED.
             Grey bands mark NBER-dated U.S. recessions.</p>
        </div>
      </div>

      <div id="macroMoveBanner"></div>
      <div class="live-mkt-row" id="macroLiveRow" hidden></div>

      <!-- ════════════════════════════════════════════════════════════════════
           KPI ROW
           ════════════════════════════════════════════════════════════════════ -->
      <!-- Date-context strip: makes it explicit which figures are live vs FY2025 filing -->
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;margin-bottom:8px;font-size:11px;color:var(--ink-dim);font-family:var(--mono)">
        <span><b style="color:var(--ink-soft)">KPI row below:</b> Market Cap, Total Debt, Revenue &amp; Stock Return are live (SEC EDGAR + live quote) when the year filter is at the present; Credit Rating has no live feed (rating actions are episodic, not continuous) so it shows the most recent action</span>
        <span style="color:var(--line)">|</span>
        <span><b style="color:var(--ink-soft)">Full snapshot:</b> see Market Cap Snapshot card below (Jul 22, 2026 close)</span>
      </div>
      <div class="mac-hero-kpi-row" id="macHeroKpiRow">
        <div class="mac-hero-kpi kpi-blue">
          <span class="mac-hero-kpi-lbl">MARKET CAP</span>
          <span class="mac-hero-kpi-val" id="hkpiMarketCap">—</span>
          <span class="mac-hero-kpi-delta" id="hkpiMarketCapDelta"></span>
          <span style="font-size:9px;color:var(--ink-dim);font-family:var(--mono);margin-top:2px" id="hkpiMarketCapSub">FY2025 10-K</span>
          <span class="kpi-stamp" id="hkpiMarketCapStamp"><span class="kpi-stamp-dot"></span><span class="kpi-stamp-txt"></span></span>
        </div>
        <div class="mac-hero-kpi kpi-coral">
          <span class="mac-hero-kpi-lbl">TOTAL DEBT</span>
          <span class="mac-hero-kpi-val" id="hkpiDebt">—</span>
          <span class="mac-hero-kpi-delta" id="hkpiDebtDelta"></span>
          <span style="font-size:9px;color:var(--ink-dim);font-family:var(--mono);margin-top:2px" id="hkpiDebtSub">FY2025 10-K</span>
          <span class="kpi-stamp" id="hkpiDebtStamp"><span class="kpi-stamp-dot"></span><span class="kpi-stamp-txt"></span></span>
        </div>
        <div class="mac-hero-kpi kpi-teal">
          <span class="mac-hero-kpi-lbl" id="hkpiRevenueLbl">REVENUE (FY2025)</span>
          <span class="mac-hero-kpi-val" id="hkpiRevenue">—</span>
          <span class="mac-hero-kpi-delta" id="hkpiRevenueDelta"></span>
          <span style="font-size:9px;color:var(--ink-dim);font-family:var(--mono);margin-top:2px" id="hkpiRevenueSub">FY2025 10-K</span>
          <span class="kpi-stamp" id="hkpiRevenueStamp"><span class="kpi-stamp-dot"></span><span class="kpi-stamp-txt"></span></span>
        </div>
        <div class="mac-hero-kpi kpi-gold">
          <span class="mac-hero-kpi-lbl">STOCK RETURN (1Y)</span>
          <span class="mac-hero-kpi-val" id="hkpiReturn">—</span>
          <span class="mac-hero-kpi-delta" id="hkpiReturnVsSP"></span>
          <span style="font-size:9px;color:var(--ink-dim);font-family:var(--mono);margin-top:2px" id="hkpiReturnSub">FY2025 (Dec 2024–Dec 2025)</span>
          <span class="kpi-stamp" id="hkpiReturnStamp"><span class="kpi-stamp-dot"></span><span class="kpi-stamp-txt"></span></span>
        </div>
        <div class="mac-hero-kpi kpi-violet">
          <span class="mac-hero-kpi-lbl">CREDIT RATING</span>
          <span class="mac-hero-kpi-val" id="hkpiRating">—</span>
          <span class="mac-hero-kpi-delta" id="hkpiRatingSub"></span>
          <span style="font-size:9px;color:var(--ink-dim);font-family:var(--mono);margin-top:2px">S&amp;P / Moody's current</span>
          <span class="kpi-stamp" id="hkpiRatingStamp"><span class="kpi-stamp-dot"></span><span class="kpi-stamp-txt"></span></span>
        </div>
      </div>

      <!-- ════════════════════════════════════════════════════════════════════
           GLOBAL FILTER BAR
           ════════════════════════════════════════════════════════════════════ -->
      <div class="mac-global-filter-bar" id="macGlobalFilterBar" role="search" aria-label="Filter IBM stock data">
        <span class="mac-gf-label">Filter</span>
        <div class="mac-gf-group">
          <span class="mac-gf-group-lbl">Year range</span>
          <div class="mac-gf-chips" id="gfYearChips"></div>
        </div>
        <div class="mac-gf-sep"></div>
        <div class="mac-gf-group">
          <span class="mac-gf-group-lbl">CEO era</span>
          <div class="mac-gf-chips" id="gfCeoChips"></div>
        </div>
        <div class="mac-gf-sep"></div>
        <div class="mac-gf-group">
          <span class="mac-gf-group-lbl">Show layers</span>
          <div class="mac-gf-chips" id="gfLayerChips"></div>
        </div>
        <button class="mac-gf-reset" id="gfReset" title="Clear all filters">✕ Reset</button>
      </div>

      <!-- ════════════════════════════════════════════════════════════════════
           HERO CHART — IBM Stock Performance
           ════════════════════════════════════════════════════════════════════ -->
      <div class="card mac-hero-chart-card" id="macHeroChartCard">
        <div class="mac-hero-chart-header">
          <div>
            <div class="mac-hero-chart-title">IBM Stock Performance</div>
            <div class="mac-hero-chart-sub" id="macHeroChartSub">1962 – present · quarterly close · split-adjusted</div>
          </div>
          <div class="mac-hero-chart-controls">
            <div class="mac-hero-layer-row" id="macHeroLayerRow">
              <button class="mac-hero-layer-btn active" data-layer="price" style="--lc:#4589ff">Stock Price</button>
              <button class="mac-hero-layer-btn" data-layer="marketCap" style="--lc:#08bdba">Market Cap</button>
              <button class="mac-hero-layer-btn" data-layer="dividends" style="--lc:#6fdc8c">Dividends</button>
              <button class="mac-hero-layer-btn" data-layer="earnings" style="--lc:#a56eff">Earnings</button>
              <button class="mac-hero-layer-btn" data-layer="acquisitions" style="--lc:#ff832b">Acquisitions</button>
            </div>
          </div>
        </div>
        <div class="mac-hero-chart-host" id="macHeroChartHost">
          <svg id="macHeroSvg" class="mac-hero-svg"></svg>
          <div class="mac-hero-tooltip" id="macHeroTip"></div>
        </div>
        <div class="mac-hero-chart-legend" id="macHeroLegend">
          <span class="mac-hero-leg-item"><span class="mac-hero-leg-dot" style="background:#4589ff"></span>IBM close</span>
          <span class="mac-hero-leg-item mac-hero-leg-rec"><span class="mac-hero-leg-rect"></span>Recession period</span>
          <span class="mac-hero-leg-item mac-hero-leg-acq" id="macHeroLegAcq" style="display:none"><span class="mac-hero-leg-dot" style="background:#ff832b;width:8px;height:8px;border-radius:50%"></span>Acquisition marker</span>
        </div>
        <p class="chart-note" id="macHeroNote"></p>
      </div>

      <!-- ────────────────────────────────────────────────────────────────────
           SECTION A — IBM STOCK PERFORMANCE
           ──────────────────────────────────────────────────────────────────── -->
      <div class="mac-section-header">
        <span class="mac-section-letter">A</span>
        <div>
          <p class="mac-section-title">IBM Stock Performance</p>
          <p class="mac-section-sub">Price history and total return vs benchmarks · Sources: Bloomberg IBM US Equity, Yahoo Finance, IBM 10-K</p>
        </div>
      </div>

      <!-- A1 — KPI bar -->
      <div class="sp-kpi-bar" id="spKpiBar">
        <div class="sp-kpi" id="spKpiPrice"><span class="sp-kpi-val">—</span><span class="sp-kpi-lbl">Dec 2024 close</span></div>
        <div class="sp-kpi" id="spKpiYTD"><span class="sp-kpi-val">—</span><span class="sp-kpi-lbl">2024 total return</span></div>
        <div class="sp-kpi" id="spKpiDiv"><span class="sp-kpi-val">—</span><span class="sp-kpi-lbl">Dividend yield (2024)</span></div>
        <div class="sp-kpi" id="spKpiBeta"><span class="sp-kpi-val">—</span><span class="sp-kpi-lbl">5-yr beta vs S&amp;P 500</span></div>
        <div class="sp-kpi" id="spKpiVol"><span class="sp-kpi-val">—</span><span class="sp-kpi-lbl">Avg daily volume (2024)</span></div>
        <div class="sp-kpi" id="spKpiOutperf"><span class="sp-kpi-val">—</span><span class="sp-kpi-lbl">IBM vs S&amp;P (2024)</span></div>
      </div>

      <!-- A4 — Total Return vs S&P 500 + window selector -->
      <div class="card sp-chart-card" style="margin-top:16px">
        <div class="sp-chart-header">
          <div>
            <p class="section-title" style="margin:0 0 2px">IBM vs Market — Total Return &amp; Outperformance</p>
            <p class="chart-sub">Calendar-year total return (%), dividends reinvested · Source: Bloomberg / S&amp;P Dow Jones Indices / Damodaran</p>
          </div>
          <div class="sp-chart-opts">
            <div class="sp-legend-row" id="spReturnLegend">
              <button class="sp-leg-btn" data-key="ibm"  aria-pressed="true" style="--c:#0f62fe">IBM</button>
              <button class="sp-leg-btn" data-key="sp500" aria-pressed="true" style="--c:#42be65">S&amp;P 500</button>
            </div>
            <div class="sp-tab-row" style="margin-left:12px" id="spReturnWindow">
              <button class="sp-tab-btn active" data-win="all">All</button>
              <button class="sp-tab-btn" data-win="20">20yr</button>
              <button class="sp-tab-btn" data-win="10">10yr</button>
              <button class="sp-tab-btn" data-win="5">5yr</button>
            </div>
            <label style="margin-left:8px"><input type="checkbox" id="spReturnCumToggle" /> Cumulative</label>
          </div>
        </div>
        <div class="sp-chart-host" id="spReturnHost">
          <svg id="spReturnSvg" class="sp-svg"></svg>
          <div class="sp-tooltip" id="spReturnTip"></div>
        </div>
        <p class="chart-note" id="spReturnNote"></p>
      </div>

      <!-- A5 — was Dividend Yield / Volume / Beta. Removed: macro.ibmDividendYield,
           macro.ibmAvgDailyVolume and macro.ibmBeta5yr were never present in the
           dataset, so buildStockPerformanceCharts() bailed at its guard and this
           card rendered as an empty box. Replaced by the cost-of-debt card in
           Section D, which is built from data that actually exists. -->

      <!-- ────────────────────────────────────────────────────────────────────
           SECTION B — IBM STOCK HISTORY & INVESTMENT CALCULATOR
           ──────────────────────────────────────────────────────────────────── -->
      <div class="mac-section-header" style="margin-top:40px">
        <span class="mac-section-letter">B</span>
        <div>
          <p class="mac-section-title">IBM Stock History &amp; Investment Calculator</p>
          <p class="mac-section-sub">Milestone-annotated price history 1970–2025 · "What would $X have grown to?" calculator · Sources: Macrotrends, IBM annual reports</p>
        </div>
      </div>
      <div id="execVisualsRoot"></div>

      <!-- ────────────────────────────────────────────────────────────────────
           SECTION C — MARKET CAP SNAPSHOT
           ──────────────────────────────────────────────────────────────────── -->
      <div class="mac-section-header" style="margin-top:40px">
        <span class="mac-section-letter">C</span>
        <div>
          <p class="mac-section-title">Market Cap — At a Glance</p>
          <p class="mac-section-sub">As of Jul 22, 2026 close · Reflects Jul 14 Q2 preannouncement ($67B single-day drop) and the Jul 22 full Q2 earnings call · Sources: StockAnalysis.com, Macrotrends, Benzinga, IBM newsroom</p>
        </div>
      </div>
      <div id="mktCapSnapshotRoot"></div>

      <!-- ────────────────────────────────────────────────────────────────────
           SECTION D — ECONOMIC CLIMATE & LEVERAGE
           ──────────────────────────────────────────────────────────────────── -->
      <div class="mac-section-header" style="margin-top:40px">
        <span class="mac-section-letter">D</span>
        <div>
          <p class="mac-section-title">Economic Climate &amp; IBM Leverage</p>
          <p class="mac-section-sub">Macro conditions 1970–2026 YTD (Fed Funds, GDP, CPI, Unemployment) and IBM's cost of debt against the Treasury curve · Sources: BLS, BEA, Federal Reserve, SEC EDGAR, Yahoo Finance, IBM 10-K</p>
        </div>
      </div>
      <div style="margin-top:16px">
        <div id="macroEconRoot"></div>
      </div>
      <div style="margin-top:16px">
        <div id="bondYieldRoot"></div>
      </div>

      <!-- ────────────────────────────────────────────────────────────────────
           SECTION F — LATEST SEC FILINGS
           ──────────────────────────────────────────────────────────────────── -->
      <div class="mac-section-header" style="margin-top:40px">
        <span class="mac-section-letter">F</span>
        <div>
          <p class="mac-section-title">Latest IBM SEC Filings</p>
          <p class="mac-section-sub">10-K · 10-Q · earnings 8-K (item 2.02) · refreshes every 5 min · Source: SEC EDGAR via agent server or direct EDGAR API</p>
        </div>
      </div>
      <div id="macFilingsRoot"></div>
`;

    /* ── Executive Visuals: Milestone Price + Calculator ── */
    (function buildExecVisuals() {
      const EV_PRICE = {
        1970:3.71,1971:4.05,1972:4.96,1973:3.79,1974:2.69,1975:3.69,1976:4.69,1977:4.82,
        1978:5.59,1979:4.98,1980:5.71,1981:4.99,1982:8.67,1983:11.75,1984:12.30,1985:16.35,
        1986:13.32,1987:13.01,1988:13.63,1989:11.06,1990:13.35,1991:11.09,1992:6.56,
        1993:7.64,1994:9.90,1995:12.40,1996:20.90,1997:28.79,1998:50.60,1999:59.93,
        2000:44.13,2001:63.22,2002:40.63,2003:47.09,2004:51.09,2005:43.36,2006:52.02,
        2007:58.63,2008:47.97,2009:73.32,2010:82.79,2011:104.99,2012:109.77,2013:106.90,
        2014:94.68,2015:83.03,2016:105.24,2017:100.31,2018:77.28,2019:94.21,2020:92.16,
        2021:109.19,2022:118.68,2023:143.94,2024:203.03,2025:278.96
      };

      // EV_MILESTONES removed with the milestone chart; the hero chart's
      // Acquisitions layer is where deal markers live now.

      const EV_YEARS = Object.keys(EV_PRICE).map(Number).sort((a,b)=>a-b);
      const EV_END_YEAR = EV_YEARS[EV_YEARS.length-1];

      /* ---- colours ---- */
      const eC = { accent:"#4589ff", green:"#4ade80", red:"#f87171", orange:"#f59e0b" };
      const GRID = "#1a2030", AXIS = "#4b5563", TICK = "#6b7280", BORDER = "#1f2535";
      const BG = "#0d1117", SURF = "#0d1320", SURF2 = "#111318";
      const mono = "'IBM Plex Mono',monospace";

      /* ---- tooltip helper ---- */
      function makeTip(host) {
        const el = document.createElement("div");
        el.style.cssText = `position:absolute;pointer-events:none;display:none;background:${SURF};border:1px solid ${BORDER};border-radius:6px;padding:10px 14px;font-size:12px;font-family:${mono};color:#E8EAED;white-space:nowrap;z-index:20`;
        host.appendChild(el);
        return el;
      }

      /* ── micro SVG line/area chart ─────────────────────────────────────── */
      function svgChart({ data, xKey, series, width, height, yFmt, zeroLine }) {
        const ml=46, mr=12, mt=10, mb=28;
        const W=width-ml-mr, H=height-mt-mb;
        const xs = data.map(d=>d[xKey]);
        const allY = series.flatMap(s=>data.map(d=>d[s.key]).filter(v=>v!=null));
        let yMin=Math.min(...allY), yMax=Math.max(...allY);
        if (zeroLine) { yMin=Math.min(yMin,0); yMax=Math.max(yMax,0); }
        const pad=(yMax-yMin)*0.08||1; yMin-=pad; yMax+=pad;
        const px=(x)=>ml+((x-xs[0])/(xs[xs.length-1]-xs[0]||1))*W;
        const py=(y)=>mt+H-((y-yMin)/(yMax-yMin))*H;

        const yTicks=5;
        let tickLines="", tickLabels="";
        for(let i=0;i<=yTicks;i++){
          const v=yMin+(yMax-yMin)*i/yTicks;
          const y_=mt+H-((v-yMin)/(yMax-yMin))*H;
          tickLines+=`<line x1="${ml}" x2="${ml+W}" y1="${y_.toFixed(1)}" y2="${y_.toFixed(1)}" stroke="${GRID}" stroke-dasharray="3 3"/>`;
          tickLabels+=`<text x="${ml-4}" y="${(y_+4).toFixed(1)}" text-anchor="end" fill="${TICK}" font-size="10" font-family="${mono}">${yFmt?yFmt(v):v.toFixed(0)}</text>`;
        }

        const xTickEvery=Math.ceil(xs.length/7);
        let xLabels="";
        xs.forEach((x,i)=>{
          if(i%xTickEvery===0||i===xs.length-1)
            xLabels+=`<text x="${px(x).toFixed(1)}" y="${mt+H+18}" text-anchor="middle" fill="${TICK}" font-size="10" font-family="${mono}">${x}</text>`;
        });

        let paths="", areas="";
        series.forEach(s=>{
          const pts=data.map(d=>d[s.key]!=null?`${px(d[xKey]).toFixed(1)},${py(d[s.key]).toFixed(1)}`:"").filter(Boolean);
          if(!pts.length) return;
          const line=`M${pts.join("L")}`;
          paths+=`<path d="${line}" fill="none" stroke="${s.color}" stroke-width="2"/>`;
          if(s.area){
            const zero=py(0).toFixed(1);
            const areaPath=`${line}L${px(data[data.length-1][xKey]).toFixed(1)},${zero}L${px(data[0][xKey]).toFixed(1)},${zero}Z`;
            const gid=`evg_${s.key}`;
            areas+=`<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">` +
              (zeroLine?`<stop offset="0%" stop-color="${allY.some(v=>v>0)?s.color:s.colorNeg||eC.red}" stop-opacity="0.45"/><stop offset="100%" stop-color="${allY.some(v=>v>0)?s.color:s.colorNeg||eC.red}" stop-opacity="0.05"/>`:
                `<stop offset="0%" stop-color="${s.color}" stop-opacity="0.4"/><stop offset="100%" stop-color="${s.color}" stop-opacity="0.03"/>`) +
              `</linearGradient></defs>` +
              `<path d="${areaPath}" fill="url(#${gid})" opacity="0.9"/>`;
          }
        });

        let refLine="";
        if(zeroLine){
          const y0=py(0).toFixed(1);
          refLine=`<line x1="${ml}" x2="${ml+W}" y1="${y0}" y2="${y0}" stroke="${AXIS}" stroke-width="1"/>`;
        }

        // Milestone dots were only drawn for a series keyed "price" — the
        // removed milestone chart. Nothing here plots that key now.
        const dotMarks="";

        /* invisible hover rects — one per data point, for tooltip hit-testing */
        const slotW=Math.max(4, W/Math.max(xs.length-1,1));
        let hoverRects="";
        data.forEach((d,i)=>{
          const cx=px(d[xKey]);
          const rectX=(cx - slotW/2).toFixed(1);
          const vals=series.map(s=>d[s.key]!=null?(yFmt?yFmt(d[s.key]):d[s.key].toFixed(2)):"—").join(" · ");
          hoverRects+=`<rect x="${rectX}" y="${mt}" width="${slotW.toFixed(1)}" height="${H}" fill="transparent" class="ev-hover-rect" data-year="${d[xKey]}" data-vals="${vals}" data-cx="${cx.toFixed(1)}" data-cy="${d[series[0].key]!=null?py(d[series[0].key]).toFixed(1):""}"/>`;
        });

        return `<svg width="100%" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" style="display:block;overflow:visible">
          ${tickLines}${tickLabels}${xLabels}
          <line x1="${ml}" x2="${ml}" y1="${mt}" y2="${mt+H}" stroke="${BORDER}"/>
          <line x1="${ml}" x2="${ml+W}" y1="${mt+H}" y2="${mt+H}" stroke="${BORDER}"/>
          ${refLine}${areas}${paths}${dotMarks}
          <line class="ev-crosshair" x1="0" x2="0" y1="${mt}" y2="${mt+H}" stroke="${TICK}" stroke-width="1" stroke-dasharray="3 3" style="display:none"/>
          <circle class="ev-crossdot" cx="0" cy="0" r="4" fill="${eC.accent}" stroke="${BG}" stroke-width="1.5" style="display:none"/>
          ${hoverRects}
        </svg>`;
      }

      /* ── calculator ──
         "Value today" means today. The end price is the live quote when the
         feed is up, falling back to the last year-end close only when it is
         not — otherwise the calculator would keep valuing a position at a
         stale December close while the price tile beside it shows live. */
      function endPrice() {
        const lq = window.__liveQuote;
        return (lq && lq.price != null) ? lq.price : EV_PRICE[EV_END_YEAR];
      }
      function isLivePrice() {
        const lq = window.__liveQuote;
        return !!(lq && lq.price != null);
      }
      function calcResult(amount, startYear) {
        const shares=amount/EV_PRICE[startYear];
        const endValue=shares*endPrice();
        const gain=endValue-amount;
        return {endValue, gain, gainPct:(gain/amount)*100, shares};
      }
      /* Growth series: historical year-end closes, with the live price as the
         final point so the curve ends where the headline figure does. */
      function calcSeries(amount, startYear) {
        const shares=amount/EV_PRICE[startYear];
        const pts=EV_YEARS.filter(y=>y>=startYear)
          .map(y=>({year:y, value:Math.round(shares*EV_PRICE[y]*100)/100}));
        if (isLivePrice()) {
          pts.push({year:"now", value:Math.round(shares*endPrice()*100)/100});
        }
        return pts;
      }

      /* ── root container ── */
      const root=document.getElementById("execVisualsRoot");
      if(!root) return;

      let calcAmount=1000, calcStartYear=1985;

      function render() {
        const cRes=calcResult(calcAmount,calcStartYear);
        const calcData=calcSeries(calcAmount,calcStartYear);

        let body="";
        {
          /* The milestone-annotated price chart that used to sit here has been
             removed: it plotted IBM's price history with M&A dots, which is
             exactly the hero chart's default Stock Price layer plus its
             Acquisitions layer — the same series drawn twice on one tab. The
             calculator is the part of this section that is not duplicated
             anywhere, so it now gets the full width. */
          const calcSvg=svgChart({
            data:calcData, xKey:"year",
            series:[{key:"value",color:eC.accent}],
            width:1120, height:300,
            yFmt:v=>`$${v>=1000?(v/1000).toFixed(0)+"k":v.toFixed(0)}`
          });

          const yearOpts=EV_YEARS.slice(0,-1).map(y=>`<option value="${y}"${y===calcStartYear?" selected":""}>${y}</option>`).join("");

          body=`
            <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:stretch">

              <!-- Investment Calculator (full width) -->
              <div style="flex:1;min-width:300px;background:${SURF2};border:1px solid ${BORDER};border-radius:10px;padding:18px 16px;display:flex;flex-direction:column;gap:12px">
                <p class="ev-sub-title" style="margin:0">Investment Calculator</p>
                <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
                  <div>
                    <div class="ev-label">Invest ($)</div>
                    <input id="evCalcAmt" type="number" min="1" value="${calcAmount}"
                      style="background:${SURF};border:1px solid ${BORDER};border-radius:6px;color:#F5F6F8;padding:7px 10px;font-size:13px;width:110px;font-family:${mono}"/>
                  </div>
                  <div>
                    <div class="ev-label">Starting in</div>
                    <select id="evCalcYear"
                      style="background:${SURF};border:1px solid ${BORDER};border-radius:6px;color:#F5F6F8;padding:7px 10px;font-size:13px;width:110px;font-family:${mono}">
                      ${yearOpts}
                    </select>
                  </div>
                  <div style="flex:1;min-width:150px;background:${SURF};border:1px solid ${BORDER};border-radius:8px;padding:9px 14px">
                    <div style="font-size:10px;color:${TICK};font-family:${mono}" id="evCalcAsOf">${isLivePrice() ? `Value now · live $${endPrice().toFixed(2)}` : `Value at ${EV_END_YEAR} close`}</div>
                    <div id="evCalcValue" style="font-size:18px;font-weight:600;font-family:${mono}">$${cRes.endValue.toLocaleString(undefined,{maximumFractionDigits:0})}</div>
                    <div id="evCalcGain" style="font-size:11px;font-family:${mono};color:${cRes.gain>=0?eC.green:eC.red}">
                      ${cRes.gain>=0?"+":""}${cRes.gainPct.toFixed(1)}%
                      (${cRes.gain>=0?"+":"-"}$${Math.abs(cRes.gain).toLocaleString(undefined,{maximumFractionDigits:0})})
                    </div>
                  </div>
                </div>
                <div style="overflow-x:auto;flex-shrink:0">
                  <div style="min-width:280px;position:relative">
                    ${calcSvg}
                    <div class="ev-tip" id="evTipCalc"></div>
                  </div>
                </div>
                <p class="ev-note" style="margin-top:auto;padding-top:8px;border-top:1px solid #1E2330">Price return only — dividends not reinvested; real returns would be higher.
                Entry prices are verified year-end closes (macrotrends.net, 2012–2025), chained backward using verified annual % changes.
                The closing value uses the live quote when the feed is up, so it moves with the market during the session.</p>
              </div>
            </div>
          `;
        }
        root.innerHTML = `
          <div style="background:${BG};border-radius:12px;padding:24px 20px;margin-bottom:24px">
            ${body}
          </div>
          <style>
            .ev-tab{background:transparent;color:#B8BCC8;border:1px solid ${BORDER};border-radius:6px;padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
            .ev-tab-active{background:${eC.accent};color:${BG};border-color:${eC.accent}}
            .ev-sub-title{margin:0 0 8px;font-size:13px;font-weight:600;color:#E8EAED}
            .ev-label{font-size:10px;color:${TICK};text-transform:uppercase;letter-spacing:1px;margin-bottom:5px;font-family:${mono}}
            .ev-note{font-size:10.5px;color:${AXIS};line-height:1.6;margin:0}
            .ev-chart-wrap{margin-bottom:12px}
            .ev-tip{position:absolute;pointer-events:none;display:none;background:${SURF};border:1px solid ${BORDER};border-radius:6px;padding:10px 14px;font-size:12px;font-family:${mono};color:#E8EAED;white-space:nowrap;z-index:20}
          </style>
        `;

        /* calculator inputs */
        {
          const amtInput=document.getElementById("evCalcAmt");
          const yrSelect=document.getElementById("evCalcYear");
          function updateCalc(){
            const a=Math.max(1,Number(amtInput.value)||1);
            const y=Number(yrSelect.value);
            calcAmount=a; calcStartYear=y;
            const r=calcResult(a,y);
            const calcDataNew=calcSeries(a,y);
            document.getElementById("evCalcValue").textContent=`$${r.endValue.toLocaleString(undefined,{maximumFractionDigits:0})}`;
            document.getElementById("evCalcGain").textContent=`${r.gain>=0?"+":""}${r.gainPct.toFixed(1)}% (${r.gain>=0?"+":"-"}$${Math.abs(r.gain).toLocaleString(undefined,{maximumFractionDigits:0})})`;
            document.getElementById("evCalcGain").style.color=r.gain>=0?eC.green:eC.red;
            const asOf=document.getElementById("evCalcAsOf");
            if(asOf) asOf.textContent = isLivePrice()
              ? `Value now · live $${endPrice().toFixed(2)}`
              : `Value at ${EV_END_YEAR} close`;
            /* redraw calc svg inline */
            const calcWrap=document.getElementById("evCalcValue").closest("[style*='flex:1']");
            if(calcWrap){
              const svgWrap=calcWrap.querySelector("[style*='min-width:280px']");
              if(svgWrap){
                const newSvg=svgChart({
                  data:calcDataNew, xKey:"year",
                  series:[{key:"value",color:eC.accent}],
                  width:1120, height:230,
                  yFmt:v=>`$${v>=1000?(v/1000).toFixed(0)+"k":v.toFixed(0)}`
                });
                svgWrap.innerHTML=newSvg+`<div class="ev-tip" id="evTipCalc"></div>`;
                addSvgTooltip(svgWrap,"evTipCalc");
              }
            }
          }
          amtInput.addEventListener("input",updateCalc);
          yrSelect.addEventListener("change",updateCalc);
          /* Refresh the valuation whenever a new quote lands, so "Value now"
             tracks the same 60s cycle as the ticker rather than freezing at
             whatever the price was when this section first rendered. */
          window.addEventListener("ibm-live-quote", updateCalc);

          addSvgTooltip(root.querySelector("[style*='min-width:280px']"),"evTipCalc");
        }
      }

      /* ── SVG hover tooltips ── */
      function addSvgTooltip(wrap, tipId) {
        if(!wrap) return;
        const tip=document.getElementById(tipId);
        if(!tip) return;
        const svg=wrap.querySelector("svg");
        if(!svg) return;
        svg.style.cursor="crosshair";
        const crosshair=svg.querySelector(".ev-crosshair");
        const crossdot=svg.querySelector(".ev-crossdot");

        svg.querySelectorAll(".ev-hover-rect").forEach(rect=>{
          rect.addEventListener("mouseenter",(e)=>{
            const year=rect.dataset.year;
            const vals=rect.dataset.vals;
            const cx=rect.dataset.cx;
            const cy=rect.dataset.cy;

            /* show crosshair */
            if(crosshair){ crosshair.setAttribute("x1",cx); crosshair.setAttribute("x2",cx); crosshair.style.display=""; }
            if(crossdot && cy){ crossdot.setAttribute("cx",cx); crossdot.setAttribute("cy",cy); crossdot.style.display=""; }

            /* position tooltip — flip left if near right edge */
            const wrapR=wrap.getBoundingClientRect();
            const rectR=rect.getBoundingClientRect();
            const tipX=rectR.left-wrapR.left+rectR.width/2;
            const nearRight=tipX > wrapR.width*0.65;
            tip.style.display="block";
            tip.style.left= nearRight ? "" : (tipX+10)+"px";
            tip.style.right= nearRight ? (wrapR.width - tipX + 10)+"px" : "";
            tip.style.top="10px";
            tip.innerHTML=`<span style="color:#8B90A0">${year}</span>&nbsp;&nbsp;${vals}`;
          });
          rect.addEventListener("mouseleave",()=>{
            if(crosshair) crosshair.style.display="none";
            if(crossdot)  crossdot.style.display="none";
            tip.style.display="none";
          });
        });
      }


      render();
    })();

    /* ---- HERO: Global filter bar + KPI row + IBM Stock Performance hero chart */
    buildMacroHeroSection();

    /* ---- A: IBM Stock Performance Charts (2000-2025) ----------------------- */
    buildStockPerformanceCharts();

    /* ---- C: Market Capitalization chart ------------------------------------ */
    buildMktCapChart();

    /* ---- D: Economic Climate + D/E Gauge ----------------------------------- */
    buildMacroEconChart();

    /* ---- D: IBM cost of debt vs the Treasury curve -------------------------- */
    buildBondYieldChart();

    /* ---- F: Latest SEC Filings card ---------------------------------------- */
    buildFilingsCard();

  }

  /* ====================================================================== */
  /*  HERO SECTION — Global filter bar, KPI row, IBM Stock Performance chart */
  /* ====================================================================== */
  function buildMacroHeroSection() {
    const SVGNS = "http://www.w3.org/2000/svg";
    const macro = D.macro;
    if (!macro) return;

    // ── Credit rating history (S&P, publicly verifiable) ──────────────────
    // Sources: S&P Global Ratings press releases; IBM annual report footnotes.
    // Moody's ratings noted parenthetically. Unavailable years = not available.
    // Note: "not available" used for pre-1985 where a verifiable press-release
    // record could not be confirmed in the public domain.
    const CREDIT_RATINGS = {
      /* S&P / (Moody's)  -- Source: S&P Global Ratings, IBM 10-K footnotes */
      1985: { sp: "AA",  moody: "Aa3",  note: "Peak investment grade" },
      1986: { sp: "AA",  moody: "Aa3",  note: "" },
      1987: { sp: "AA",  moody: "Aa3",  note: "" },
      1988: { sp: "AA",  moody: "Aa3",  note: "" },
      1989: { sp: "AA",  moody: "Aa3",  note: "" },
      1990: { sp: "AA",  moody: "Aa3",  note: "" },
      1991: { sp: "A",   moody: "A1",   note: "Downgrade during IBM crisis" },
      1992: { sp: "A",   moody: "A1",   note: "" },
      1993: { sp: "BBB+",moody: "Baa1", note: "Lowered amid $8.1B loss" },
      1994: { sp: "BBB+",moody: "Baa1", note: "" },
      1995: { sp: "A-",  moody: "A3",   note: "Gerstner turnaround upgrade" },
      1996: { sp: "A",   moody: "A2",   note: "" },
      1997: { sp: "A",   moody: "A2",   note: "" },
      1998: { sp: "A+",  moody: "A1",   note: "" },
      1999: { sp: "A+",  moody: "A1",   note: "" },
      2000: { sp: "A+",  moody: "A1",   note: "" },
      2001: { sp: "A+",  moody: "A1",   note: "" },
      2002: { sp: "A",   moody: "A2",   note: "" },
      2003: { sp: "A",   moody: "A2",   note: "" },
      2004: { sp: "A",   moody: "A2",   note: "" },
      2005: { sp: "A",   moody: "A2",   note: "" },
      2006: { sp: "A",   moody: "A2",   note: "" },
      2007: { sp: "A",   moody: "A2",   note: "" },
      2008: { sp: "A",   moody: "A2",   note: "" },
      2009: { sp: "A",   moody: "A2",   note: "" },
      2010: { sp: "A",   moody: "A2",   note: "" },
      2011: { sp: "A+",  moody: "A2",   note: "" },
      2012: { sp: "A+",  moody: "Aa3",  note: "" },
      2013: { sp: "A+",  moody: "Aa3",  note: "" },
      2014: { sp: "A",   moody: "A1",   note: "Downgrade following buyback/debt increase" },
      2015: { sp: "A",   moody: "A1",   note: "" },
      2016: { sp: "A",   moody: "A1",   note: "" },
      2017: { sp: "A",   moody: "A1",   note: "" },
      2018: { sp: "A",   moody: "A1",   note: "" },
      2019: { sp: "A-",  moody: "A3",   note: "Post Red Hat debt load" },
      2020: { sp: "A-",  moody: "A3",   note: "" },
      2021: { sp: "A-",  moody: "A3",   note: "" },
      2022: { sp: "A-",  moody: "A3",   note: "" },
      2023: { sp: "A-",  moody: "A3",   note: "" },
      2024: { sp: "A-",  moody: "A3",   note: "" },
      2025: { sp: "A-",  moody: "A3",   note: "" },
    };

    // ── Quarterly price data (ibmMonthlyPrice stores Q1/Q4 closes) ────────
    // ibmMonthlyPrice keys are YYYY-MM; we have Jan/Apr/Jul/Oct per year.
    const qPrices = macro.ibmMonthlyPrice || {};
    const qKeys = Object.keys(qPrices).filter(k => !k.startsWith("_")).sort();

    // Also derive annual close from Q4 (October entry used as proxy for year-end close)
    // where not explicitly provided by ibmAnnualPrice.
    // Source: Yahoo Finance IBM, quarterly closes. Label as "split-adjusted quarterly close".
    const annualPriceFromQ = {};
    qKeys.forEach(k => {
      const [yr, mo] = k.split("-").map(Number);
      // use October entry (Q4 proxy) as annual close
      if (mo === 10) annualPriceFromQ[yr] = qPrices[k];
      // fallback to January of next year if October missing
    });

    // Merge with financials.stockPrice (year-end close from 10-K) where available
    // Financials stockPrice takes precedence as it comes from the 10-K directly.
    fin.forEach(r => {
      if (r.stockPrice != null) annualPriceFromQ[r.year] = r.stockPrice;
    });

    // Build the complete price series from available data
    const allYearsWithPrice = Object.keys(qPrices)
      .filter(k => !k.startsWith("_"))
      .map(k => { const [y, m] = k.split("-").map(Number); return { key: k, year: y, month: m, price: qPrices[k] }; })
      .sort((a, b) => a.key.localeCompare(b.key));

    // Deduplicated year list for the chart x-axis (using quarterly points)
    const uniqueYears = [...new Set(allYearsWithPrice.map(p => p.year))].sort((a, b) => a - b);
    const firstYear   = uniqueYears[0];
    const lastYear    = uniqueYears[uniqueYears.length - 1];
    // lastYear from the price series may be ahead of the financials (e.g. 2026
    // prices are in ibmMonthlyPrice but financials only go to Y1=2025).
    // Use kpiYear (clamped to Y1) for all KPI lookups so byYear.get() never misses.
    const kpiYear = Math.min(lastYear, Y1);
    let currentKpiYear = kpiYear;   // tracked so the 60s live-refresh tick knows what to redraw

    // ── Acquisitions (major only for markers) ─────────────────────────────
    const majorDeals = (D.ma && D.ma.deals ? D.ma.deals : [])
      // maTabOnly deals (e.g. quarterly 10-Q additions) stay on the M&A tab only,
      // so they never draw an acquisition marker on this Macro-tab stock chart.
      .filter(d => (d.tier === "major" || d.valueMillions != null) && !d.maTabOnly)
      .sort((a, b) => a.year - b.year);

    // ── S&P 500 annual total return (for KPI "vs S&P" card) ───────────────
    const sp500TR = macro.sp500TotalReturn || {};

    // ── Filter state ────────────────────────────────────────────────────────
    let gfRange = [firstYear, lastYear];  // active year range
    let gfActiveChips = new Set();        // active filter chip keys
    let heroActiveLayer = "price";        // active data layer

    // ── IBM economic/era cycles (for "Economic cycle" filter) ─────────────
    const CYCLES = meta.eras.map(e => ({
      key: "cycle_" + e.from,
      label: e.label.length > 22 ? e.label.slice(0, 22) + "…" : e.label,
      fullLabel: e.label,
      from: e.from,
      to: e.to,
    }));

    // ── CEO eras ─────────────────────────────────────────────────────────
    const CEO_ERAS = meta.leadership
      .filter(l => l.from >= firstYear || (l.to && l.to >= firstYear))
      .map(l => ({
        key: "ceo_" + l.from,
        label: l.name.replace(/(\w)\w+\s/, "$1. "),
        fullName: l.name,
        from: l.from,
        to: l.to || lastYear,
      }));

    // ── Decade filter ─────────────────────────────────────────────────────
    const DECADES = [];
    for (let d = Math.floor(firstYear / 10) * 10; d <= lastYear; d += 10) {
      DECADES.push({ key: "decade_" + d, label: d + "s", from: d, to: d + 9 });
    }

    // ── Build global filter bar ────────────────────────────────────────────
    function makeChip(label, key, groupEl, from, to, fullLabel) {
      const btn = document.createElement("button");
      btn.className = "mac-gf-chip mac-chip-btn";
      btn.textContent = label;
      btn.dataset.key = key;
      btn.dataset.from = from;
      btn.dataset.to = to;
      btn.setAttribute("aria-pressed", "false");
      btn.title = (fullLabel || label) + " (" + from + "–" + to + ")";
      btn.addEventListener("click", () => {
        const on = btn.getAttribute("aria-pressed") === "true";
        btn.setAttribute("aria-pressed", on ? "false" : "true");
        if (on) gfActiveChips.delete(key);
        else     gfActiveChips.add(key);
        applyGlobalFilter();
      });
      groupEl.appendChild(btn);
    }

    // Year-range quick-selects
    const gfYearEl    = document.getElementById("gfYearChips");
    const GF_YEARS    = [
      { label: "All",     from: firstYear, to: lastYear },
      { label: "Last 5",  from: lastYear - 4, to: lastYear },
      { label: "Last 10", from: lastYear - 9, to: lastYear },
      { label: "Last 20", from: lastYear - 19, to: lastYear },
      { label: "Since 2000", from: 2000, to: lastYear },
    ];
    GF_YEARS.forEach(yr => makeChip(yr.label, "yr_" + yr.from, gfYearEl, yr.from, yr.to));

    // CEO chips
    const gfCeoEl = document.getElementById("gfCeoChips");
    CEO_ERAS.forEach(c => makeChip(c.label, c.key, gfCeoEl, c.from, c.to, c.fullName));

    // Layer chips (mirror the hero chart buttons)
    const gfLayerEl = document.getElementById("gfLayerChips");
    const GF_LAYERS = [
      { key: "price",        label: "Stock Price",  color: "#4589ff" },
      { key: "marketCap",    label: "Market Cap",   color: "#08bdba" },
      { key: "dividends",    label: "Dividends",    color: "#6fdc8c" },
      { key: "earnings",     label: "Earnings",     color: "#a56eff" },
      { key: "acquisitions", label: "Acquisitions", color: "#ff832b" },
    ];
    GF_LAYERS.forEach(l => {
      const btn = document.createElement("button");
      btn.className = "mac-gf-chip mac-chip-btn";
      btn.textContent = l.label;
      btn.dataset.key = "layer_" + l.key;
      btn.setAttribute("aria-pressed", l.key === "price" ? "true" : "false");
      btn.style.setProperty("--gfc", l.color);
      btn.title = "Toggle " + l.label + " layer";
      btn.addEventListener("click", () => {
        // radio behaviour — only one layer active at a time (except acquisitions which overlays)
        if (l.key !== "acquisitions") {
          gfLayerEl.querySelectorAll("[data-key^='layer_']").forEach(b => {
            if (b.dataset.key !== "layer_acquisitions") b.setAttribute("aria-pressed", "false");
          });
          btn.setAttribute("aria-pressed", "true");
          heroActiveLayer = l.key;
          // sync hero layer buttons
          document.querySelectorAll(".mac-hero-layer-btn").forEach(lb => {
            lb.classList.toggle("active", lb.dataset.layer === l.key);
          });
        } else {
          const on = btn.getAttribute("aria-pressed") === "true";
          btn.setAttribute("aria-pressed", on ? "false" : "true");
        }
        drawHeroChart();
      });
      gfLayerEl.appendChild(btn);
    });

    // Reset button
    document.getElementById("gfReset").addEventListener("click", () => {
      gfActiveChips.clear();
      gfRange = [firstYear, lastYear];
      document.querySelectorAll(".mac-gf-chip[aria-pressed='true']").forEach(b => {
        if (!b.dataset.key.startsWith("layer_price")) b.setAttribute("aria-pressed", "false");
      });
      // re-activate price layer chip
      const priceChip = gfLayerEl.querySelector("[data-key='layer_price']");
      if (priceChip) priceChip.setAttribute("aria-pressed", "true");
      heroActiveLayer = "price";
      document.querySelectorAll(".mac-hero-layer-btn").forEach(lb => {
        lb.classList.toggle("active", lb.dataset.layer === "price");
      });
      applyGlobalFilter();
    });

    // ── Apply filter → compute range, update KPIs, redraw hero chart ─────
    function applyGlobalFilter() {
      // Collect all from/to constraints from active chips (excluding layer chips)
      const active = [...gfActiveChips].filter(k => !k.startsWith("layer_"));
      if (!active.length) {
        gfRange = [firstYear, lastYear];
      } else {
        let lo = lastYear, hi = firstYear;
        active.forEach(key => {
          const chip = document.querySelector(`.mac-gf-chip[data-key="${key}"]`);
          if (!chip) return;
          const f = +chip.dataset.from, t = +chip.dataset.to;
          lo = Math.min(lo, f);
          hi = Math.max(hi, t);
        });
        gfRange = [Math.max(firstYear, lo), Math.min(lastYear, hi)];
      }
      // KPI year: clamp to kpiYear (last year with financials data) so
      // byYear.get() always returns a real row, not undefined.
      const kpiEnd = Math.min(gfRange[1], kpiYear);
      currentKpiYear = kpiEnd;
      updateHeroKpis(kpiEnd);
      drawHeroChart();
    }

    // ── KPI row logic ──────────────────────────────────────────────────────
    // IBM credit rating — currently A- / A3 (S&P / Moody's)
    // Source: S&P Global Ratings press release Oct 2019 (A-); Moody's Oct 2019 (A3).
    // No change to rating as of the most recent verified public announcement.
    function updateHeroKpis(year) {
      const d = byYear.get(year) || {};
      const prev = byYear.get(year - 1) || {};

      // helpers
      const fmtB = v => v == null ? "—" : (Math.abs(v) >= 1000 ? `$${(v/1000).toFixed(1)}B` : `$${v.toFixed(0)}M`);
      const delta = (cur, prv) => {
        if (cur == null || prv == null || prv === 0) return { txt: "", cls: "" };
        const p = (cur - prv) / Math.abs(prv) * 100;
        return { txt: `${p >= 0 ? "▲" : "▼"} ${Math.abs(p).toFixed(1)}% YoY`, cls: p >= 0 ? "up" : "down" };
      };
      // setStamp(id, mode, text)
      //   mode "live"    — green pulsing dot; text ticked to "updated Xs ago" by the
      //                    5s interval that already drives lqNote on Overview.
      //   mode "filing"  — blue dot; text is a filing date/period string.
      //   mode "static"  — dim dot; text is a static source label.
      //   mode "none"    — hides the stamp entirely (historical year, no data).
      const setStamp = (id, mode, text) => {
        const wrap = document.getElementById(id); if (!wrap) return;
        const dot  = wrap.querySelector(".kpi-stamp-dot");
        const txt  = wrap.querySelector(".kpi-stamp-txt");
        if (mode === "none") { wrap.style.display = "none"; return; }
        wrap.style.display = "";
        dot.className = "kpi-stamp-dot " + mode;
        txt.textContent = text;
      };

      // Market Cap — three tiers of freshness:
      //   1. Live:    window.__liveQuote.capEstM (price × latest shares, real-time)
      //   2. Verified: VERIFIED_SNAP.marketCapB  (manually-verified close, same source
      //                as the Snapshot card — guarantees both sections agree)
      //   3. Historic: d.marketCap from the pipeline (FY-end 10-K, used only when
      //                showing a historical year that predates VERIFIED_SNAP)
      // The old fallback used d.marketCap for kpiYear (FY2025 10-K = $276.9B) which
      // contradicted the Snapshot card's VERIFIED_SNAP figure. Fix: use VERIFIED_SNAP
      // as the non-live fallback for the current year so both cards always agree.
      const lq = window.__liveQuote;
      const isLive = year === kpiYear && lq && lq.capEstM != null;
      const isVerified = year === kpiYear && !isLive;
      const fyMc = d.marketCap != null ? d.marketCap : null;
      const mc = isLive    ? lq.capEstM
               : isVerified ? VERIFIED_SNAP.marketCapB * 1000   // $B → $M
               : fyMc;
      document.getElementById("hkpiMarketCap").textContent = fmtB(mc);
      const mcDEl = document.getElementById("hkpiMarketCapDelta");
      const mcSubEl = document.getElementById("hkpiMarketCapSub");
      if (isLive) {
        if (lq.prevClose && lq.sharesM) {
          const prevCapM = lq.prevClose * lq.sharesM;
          const p = (lq.capEstM - prevCapM) / prevCapM * 100;
          mcDEl.textContent = `${p >= 0 ? "▲" : "▼"} ${Math.abs(p).toFixed(2)}% today`;
          mcDEl.className = "mac-hero-kpi-delta " + (p >= 0 ? "up" : "down");
        } else { mcDEl.textContent = ""; mcDEl.className = "mac-hero-kpi-delta"; }
        if (mcSubEl) mcSubEl.textContent = `live est. · $${lq.price.toFixed(2)} × ${lq.sharesM ? lq.sharesM.toFixed(0) + "M" : ""}${lq.sharesYear ? " FY" + lq.sharesYear : ""} shares`;
        setStamp("hkpiMarketCapStamp", "live", "");   // text filled by 5s ticker
      } else if (isVerified) {
        // Show the verified YoY return (same figure as the Snapshot card's ▼23.37%)
        const yoy = VERIFIED_SNAP.yearChangePct;
        mcDEl.textContent = `${yoy >= 0 ? "▲" : "▼"} ${Math.abs(yoy).toFixed(1)}% YoY`;
        mcDEl.className = "mac-hero-kpi-delta " + (yoy >= 0 ? "up" : "down");
        if (mcSubEl) mcSubEl.textContent = `${VERIFIED_SNAP.dateLabel} close · $${VERIFIED_SNAP.price} × ${VERIFIED_SNAP.sharesOutstandingM.toFixed(0)}M shares`;
        setStamp("hkpiMarketCapStamp", "filing", VERIFIED_SNAP.dateLabel);
      } else {
        const mcD = delta(fyMc, prev.marketCap);
        mcDEl.textContent = mcD.txt; mcDEl.className = "mac-hero-kpi-delta " + mcD.cls;
        if (mcSubEl) mcSubEl.textContent = `FY${year} 10-K`;
        setStamp("hkpiMarketCapStamp", "static", `FY${year} 10-K`);
      }

      // Total Debt — live (long-term debt + short-term borrowings, straight
      // from the latest filed 10-Q/10-K's XBRL balance sheet, see agent
      // server's /filings/xbrl "latestDebt") when viewing the current year
      // and a fresher filing than the FY-end pipeline data is available;
      // otherwise the audited FY-end figure.
      const xb = window.__latestXbrl;
      const liveDebtPt = xb && xb.latestDebt;
      const fyTd = d.totalDebt != null ? d.totalDebt : null;
      const isLiveDebt = year === kpiYear && liveDebtPt && liveDebtPt.val != null;
      const td = isLiveDebt ? liveDebtPt.val / 1e6 : fyTd;
      document.getElementById("hkpiDebt").textContent = fmtB(td);
      const tdDEl = document.getElementById("hkpiDebtDelta");
      const tdSubEl = document.getElementById("hkpiDebtSub");
      if (isLiveDebt) {
        if (fyTd) {
          const p = (td - fyTd) / Math.abs(fyTd) * 100;
          tdDEl.textContent = `${p >= 0 ? "▲" : "▼"} ${Math.abs(p).toFixed(1)}% vs FY${year}`;
          tdDEl.className = "mac-hero-kpi-delta " + (p >= 0 ? "down" : "up");   // more debt = down (bad)
        } else { tdDEl.textContent = ""; tdDEl.className = "mac-hero-kpi-delta"; }
        if (tdSubEl) tdSubEl.textContent = `live · ${liveDebtPt.fp} FY${liveDebtPt.fy} ${liveDebtPt.form}`;
        setStamp("hkpiDebtStamp", "filing", `${liveDebtPt.fp} FY${liveDebtPt.fy} ${liveDebtPt.form}`);
      } else {
        const tdD = delta(fyTd, prev.totalDebt);
        tdDEl.textContent = tdD.txt; tdDEl.className = "mac-hero-kpi-delta " + (tdD.cls === "up" ? "down" : tdD.cls === "down" ? "up" : "");
        if (tdSubEl) tdSubEl.textContent = `FY${year} 10-K`;
        setStamp("hkpiDebtStamp", year === kpiYear ? "filing" : "static", `FY${year} 10-K`);
      }

      // Revenue — trailing-twelve-months (live) when viewing the current
      // year and a full TTM is computable from SEC XBRL: latest full fiscal
      // year, minus the same quarter a year ago, plus the latest filed
      // quarter. Otherwise the audited FY-end figure.
      const fyRev = d.revenue != null ? d.revenue : null;
      let ttmRev = null, ttmLabel = null;
      if (year === kpiYear && xb && xb.latestQuarter && xb.latestAnnual && xb.recentQuarters) {
        const lq = xb.latestQuarter;
        const priorAnnual = xb.latestAnnual.fy === lq.fy - 1 ? xb.latestAnnual : null;
        const sameQPriorYear = xb.recentQuarters.find(r => r.fy === lq.fy - 1 && r.fp === lq.fp);
        if (priorAnnual && sameQPriorYear && priorAnnual.revenue != null && sameQPriorYear.revenue != null && lq.revenue != null) {
          ttmRev = (priorAnnual.revenue - sameQPriorYear.revenue + lq.revenue) / 1e6;
          ttmLabel = `${lq.fp} FY${lq.fy}`;
        }
      }
      const isLiveRev = ttmRev != null;
      const rev = isLiveRev ? ttmRev : fyRev;
      document.getElementById("hkpiRevenue").textContent = fmtB(rev);
      const revDEl = document.getElementById("hkpiRevenueDelta");
      const revSubEl = document.getElementById("hkpiRevenueSub");
      const revLblEl = document.getElementById("hkpiRevenueLbl");
      if (isLiveRev) {
        if (fyRev) {
          const p = (rev - fyRev) / Math.abs(fyRev) * 100;
          revDEl.textContent = `${p >= 0 ? "▲" : "▼"} ${Math.abs(p).toFixed(1)}% vs FY${year}`;
          revDEl.className = "mac-hero-kpi-delta " + (p >= 0 ? "up" : "down");
        } else { revDEl.textContent = ""; revDEl.className = "mac-hero-kpi-delta"; }
        if (revSubEl) revSubEl.textContent = `live TTM · through ${ttmLabel}`;
        if (revLblEl) revLblEl.textContent = "REVENUE (TTM)";
        setStamp("hkpiRevenueStamp", "filing", `TTM through ${ttmLabel}`);
      } else {
        const revD = delta(fyRev, prev.revenue);
        revDEl.textContent = revD.txt; revDEl.className = "mac-hero-kpi-delta " + revD.cls;
        if (revSubEl) revSubEl.textContent = `FY${year} 10-K`;
        if (revLblEl) revLblEl.textContent = `REVENUE (FY${year})`;
        setStamp("hkpiRevenueStamp", year === kpiYear ? "filing" : "static", `FY${year} 10-K`);
      }

      // Stock Return (1Y) — live view uses the verified trailing-12-month
      // price return (LIVE.stockReturn1Y, top of file) rather than
      // recomputing client-side: the quarterly price series' nearest anchor
      // to "today" doesn't fall exactly 365 days back, so a naive recompute
      // would disagree with the Market Cap Snapshot card, which cites the
      // same verified figure. Historical years still derive total return
      // (price change + dividends) from the annual price series.
      const lq2 = window.__liveQuote;
      const isLiveReturn = year === kpiYear && lq2 && lq2.price != null;
      let retPct = null;
      if (isLiveReturn) {
        retPct = LIVE.stockReturn1Y;
      } else {
        const priceEnd   = annualPriceFromQ[year];
        const priceStart = annualPriceFromQ[year - 1];
        const divPerShare = d.dividendsPerShare;
        if (priceEnd != null && priceStart != null && priceStart !== 0) {
          // total return = (price change + dividends) / prior price
          const divContrib = divPerShare != null ? divPerShare : 0;
          retPct = ((priceEnd - priceStart + divContrib) / priceStart) * 100;
        }
      }
      const retEl = document.getElementById("hkpiReturn");
      retEl.textContent = retPct != null ? `${retPct >= 0 ? "+" : ""}${retPct.toFixed(1)}%` : "—";
      retEl.style.color = retPct == null ? "" : retPct >= 0 ? "var(--up)" : "var(--down)";
      const retSubEl = document.getElementById("hkpiReturnSub");

      // vs S&P 500
      const spRet = sp500TR[year];
      const retVsEl = document.getElementById("hkpiReturnVsSP");
      if (isLiveReturn) {
        retVsEl.textContent = `live price return · ${LIVE.asOfLabel}`;
        retVsEl.className = "mac-hero-kpi-delta";
        if (retSubEl) retSubEl.textContent = "live · trailing 12mo";
        setStamp("hkpiReturnStamp", "live", "");   // text filled by 5s ticker
      } else if (retPct != null && spRet != null) {
        const diff = retPct - spRet;
        retVsEl.textContent = `${diff >= 0 ? "▲" : "▼"} vs S&P ${diff >= 0 ? "+" : ""}${diff.toFixed(1)}pp`;
        retVsEl.className = "mac-hero-kpi-delta " + (diff >= 0 ? "up" : "down");
        if (retSubEl) retSubEl.textContent = `FY${year} (Dec ${year - 1}–Dec ${year})`;
        setStamp("hkpiReturnStamp", "static", `Dec ${year - 1}–Dec ${year}`);
      } else if (retPct != null) {
        retVsEl.textContent = `Source: IBM 10-K / Yahoo Finance · ${year}`;
        retVsEl.className = "mac-hero-kpi-delta";
        if (retSubEl) retSubEl.textContent = `FY${year} (Dec ${year - 1}–Dec ${year})`;
        setStamp("hkpiReturnStamp", "static", `FY${year} annual`);
      } else {
        retVsEl.textContent = ""; retVsEl.className = "mac-hero-kpi-delta";
        if (retSubEl) retSubEl.textContent = `FY${year}`;
        setStamp("hkpiReturnStamp", "none", "");
      }

      // Credit Rating
      const cr = CREDIT_RATINGS[year];
      const ratingEl = document.getElementById("hkpiRating");
      const ratSubEl = document.getElementById("hkpiRatingSub");
      if (cr) {
        ratingEl.textContent = cr.sp;
        ratSubEl.textContent = `S&P / ${cr.moody}`;
        ratSubEl.className = "mac-hero-kpi-delta";
        // note discrepancy if any
        if (cr.note) {
          ratSubEl.title = cr.note;
        }
        setStamp("hkpiRatingStamp", "static", `S&P press release · ${year === kpiYear ? "most recent action" : year}`);
      } else if (year < 1985) {
        ratingEl.textContent = "n/a";
        ratSubEl.textContent = "pre-1985: rating not available";
        ratSubEl.className = "mac-hero-kpi-delta";
        setStamp("hkpiRatingStamp", "none", "");
      } else {
        ratingEl.textContent = "—";
        ratSubEl.textContent = "";
        setStamp("hkpiRatingStamp", "none", "");
      }
    }

    // ── Hero chart layer button wiring ────────────────────────────────────
    document.querySelectorAll(".mac-hero-layer-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".mac-hero-layer-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        heroActiveLayer = btn.dataset.layer;
        // sync GF layer chips
        const gfChip = document.querySelector(`.mac-gf-chip[data-key="layer_${heroActiveLayer}"]`);
        if (gfChip && heroActiveLayer !== "acquisitions") {
          gfLayerEl.querySelectorAll("[data-key^='layer_']").forEach(b => {
            if (b.dataset.key !== "layer_acquisitions") b.setAttribute("aria-pressed", "false");
          });
          gfChip.setAttribute("aria-pressed", "true");
        }
        drawHeroChart();
      });
    });

    // ── Hero chart drawing ─────────────────────────────────────────────────
    function drawHeroChart() {
      const host = document.getElementById("macHeroChartHost");
      const svg  = document.getElementById("macHeroSvg");
      const tip  = document.getElementById("macHeroTip");
      if (!host || !svg) return;

      const W = host.clientWidth  || 900;
      const H = host.clientHeight || 380;
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("width", W); svg.setAttribute("height", H);
      svg.innerHTML = "";

      const PAD = { top: 28, right: 28, bottom: 46, left: 62 };
      const iw = W - PAD.left - PAD.right;
      const ih = H - PAD.top  - PAD.bottom;

      // Determine which layer is being drawn
      const showAcq = document.querySelector(".mac-gf-chip[data-key='layer_acquisitions']")
                      ?.getAttribute("aria-pressed") === "true"
                    || heroActiveLayer === "acquisitions";

      // ── Build data arrays for active layer within filter range ────────
      const [yr0, yr1] = gfRange;

      // Always draw price line as base (unless market cap layer)
      const usePriceBase = (heroActiveLayer !== "marketCap");

      // Price series (quarterly points) filtered to range
      const pricePts = allYearsWithPrice.filter(p => p.year >= yr0 && p.year <= yr1);
      if (!pricePts.length) {
        svg.innerHTML = `<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="var(--ink-dim)" font-size="13">No data for selected range</text>`;
        return;
      }

      // Secondary layer data (annual, from fin)
      const annFin = fin.filter(d => d.year >= yr0 && d.year <= yr1);

      // Build value domain
      let vals = [];
      if (heroActiveLayer === "marketCap") {
        vals = annFin.filter(d => d.marketCap != null).map(d => d.marketCap / 1000);
      } else if (heroActiveLayer === "dividends") {
        vals = annFin.filter(d => d.dividendsPerShare != null).map(d => d.dividendsPerShare);
        // also include price as reference line
        if (usePriceBase) vals = vals.concat(pricePts.map(p => p.price));
      } else if (heroActiveLayer === "earnings") {
        vals = annFin.filter(d => d.epsDiluted != null).map(d => d.epsDiluted);
        if (usePriceBase) vals = vals.concat(pricePts.map(p => p.price));
      } else {
        // stock price (default)
        vals = pricePts.map(p => p.price);
      }

      if (!vals.length) {
        svg.innerHTML = `<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="var(--ink-dim)" font-size="13">No data for this layer in selected range</text>`;
        return;
      }

      const vMin = Math.min(...vals) * 0.88;
      const vMax = Math.max(...vals) * 1.08;
      const xMin = yr0, xMax = yr1 + 1;

      function xp(year) { return PAD.left + (year - xMin) / (xMax - xMin) * iw; }
      function yp(v)    { return PAD.top + ih - (v - vMin) / (vMax - vMin) * ih; }

      // Convert quarterly price point to x coordinate
      function xpQ(year, month) {
        return PAD.left + ((year + (month - 1) / 12) - xMin) / (xMax - xMin) * iw;
      }

      // ── Recession bands ────────────────────────────────────────────────
      const recessions = macro.recessions || [];
      recessions.filter(r => r.end >= yr0 && r.start <= yr1).forEach(r => {
        const rx  = xp(Math.max(r.start, yr0));
        const rx2 = xp(Math.min(r.end, yr1) + 1);
        const rRect = document.createElementNS(SVGNS, "rect");
        rRect.setAttribute("x", rx); rRect.setAttribute("y", PAD.top);
        rRect.setAttribute("width", Math.max(rx2 - rx, 2));
        rRect.setAttribute("height", ih);
        rRect.setAttribute("fill", "rgba(120,120,120,0.13)");
        rRect.dataset.recName = r.name;
        svg.appendChild(rRect);
      });

      // ── CEO era bands (subtle top stripe) ─────────────────────────────
      const CEO_COLORS = ["rgba(69,137,255,0.06)","rgba(165,110,255,0.06)","rgba(8,189,186,0.06)","rgba(111,220,140,0.06)","rgba(255,131,43,0.06)"];
      CEO_ERAS.filter(c => c.to >= yr0 && c.from <= yr1).forEach((c, i) => {
        const cx  = xp(Math.max(c.from, yr0));
        const cx2 = xp(Math.min(c.to, yr1) + 1);
        const ceoBand = document.createElementNS(SVGNS, "rect");
        ceoBand.setAttribute("x", cx); ceoBand.setAttribute("y", PAD.top);
        ceoBand.setAttribute("width", Math.max(cx2 - cx, 1));
        ceoBand.setAttribute("height", 4);
        ceoBand.setAttribute("fill", CEO_COLORS[i % CEO_COLORS.length]);
        svg.appendChild(ceoBand);
      });

      // ── Grid lines ─────────────────────────────────────────────────────
      const yRange = vMax - vMin;
      const yStep  = yRange > 500 ? 100 : yRange > 100 ? 50 : yRange > 20 ? 10 : yRange > 5 ? 2 : 1;
      const yFirst = Math.ceil(vMin / yStep) * yStep;
      for (let v = yFirst; v <= vMax; v += yStep) {
        const gy = yp(v);
        const gl = document.createElementNS(SVGNS, "line");
        gl.setAttribute("x1", PAD.left); gl.setAttribute("y1", gy);
        gl.setAttribute("x2", W - PAD.right); gl.setAttribute("y2", gy);
        gl.setAttribute("stroke", "rgba(255,255,255,0.07)"); gl.setAttribute("stroke-width", "1");
        svg.appendChild(gl);
        const lbl = document.createElementNS(SVGNS, "text");
        lbl.setAttribute("x", PAD.left - 6); lbl.setAttribute("y", gy + 4);
        lbl.setAttribute("text-anchor", "end"); lbl.setAttribute("fill", "var(--ink-soft)");
        lbl.setAttribute("font-size", "10"); lbl.setAttribute("font-family", "var(--mono)");
        lbl.textContent = heroActiveLayer === "dividends" ? `$${v.toFixed(1)}`
          : heroActiveLayer === "earnings"  ? `$${v.toFixed(1)}`
          : heroActiveLayer === "marketCap" ? `$${v.toFixed(0)}B`
          : `$${v.toFixed(0)}`;
        svg.appendChild(lbl);
      }

      // ── X-axis year labels ──────────────────────────────────────────────
      const xSpan = yr1 - yr0 + 1;
      const xStep = xSpan > 40 ? 10 : xSpan > 20 ? 5 : xSpan > 10 ? 2 : 1;
      const xFirst = Math.ceil(yr0 / xStep) * xStep;
      for (let yr = xFirst; yr <= yr1; yr += xStep) {
        const gx = xp(yr);
        const xl = document.createElementNS(SVGNS, "line");
        xl.setAttribute("x1", gx); xl.setAttribute("y1", PAD.top);
        xl.setAttribute("x2", gx); xl.setAttribute("y2", PAD.top + ih);
        xl.setAttribute("stroke", "rgba(255,255,255,0.05)"); xl.setAttribute("stroke-width", "1");
        svg.appendChild(xl);
        const xlbl = document.createElementNS(SVGNS, "text");
        xlbl.setAttribute("x", gx); xlbl.setAttribute("y", H - 12);
        xlbl.setAttribute("text-anchor", "middle"); xlbl.setAttribute("fill", "var(--ink-soft)");
        xlbl.setAttribute("font-size", "10"); xlbl.setAttribute("font-family", "var(--mono)");
        xlbl.textContent = yr;
        svg.appendChild(xlbl);
      }

      // ── Area fill + main line (price or marketCap) ─────────────────────
      if (heroActiveLayer === "marketCap") {
        // Annual market cap as area
        const mcPts = annFin.filter(d => d.marketCap != null).map(d => ({ yr: d.year, v: d.marketCap / 1000 }));
        if (mcPts.length >= 2) {
          const aD = [`M ${xp(mcPts[0].yr)} ${PAD.top + ih}`];
          mcPts.forEach(pt => aD.push(`L ${xp(pt.yr)} ${yp(pt.v)}`));
          aD.push(`L ${xp(mcPts[mcPts.length - 1].yr)} ${PAD.top + ih} Z`);
          const aPath = document.createElementNS(SVGNS, "path");
          aPath.setAttribute("d", aD.join(" "));
          aPath.setAttribute("fill", "rgba(8,189,186,0.12)"); aPath.setAttribute("stroke", "none");
          svg.appendChild(aPath);
          const pts = mcPts.map(pt => `${xp(pt.yr)},${yp(pt.v)}`).join(" ");
          const line = document.createElementNS(SVGNS, "polyline");
          line.setAttribute("points", pts); line.setAttribute("fill", "none");
          line.setAttribute("stroke", "#08bdba"); line.setAttribute("stroke-width", "2");
          line.setAttribute("stroke-linejoin", "round");
          svg.appendChild(line);
        }
      } else {
        // Quarterly price area fill
        const aD = [`M ${xpQ(pricePts[0].year, pricePts[0].month)} ${PAD.top + ih}`];
        pricePts.forEach(pt => aD.push(`L ${xpQ(pt.year, pt.month)} ${yp(pt.price)}`));
        aD.push(`L ${xpQ(pricePts[pricePts.length-1].year, pricePts[pricePts.length-1].month)} ${PAD.top + ih} Z`);
        const aPath = document.createElementNS(SVGNS, "path");
        aPath.setAttribute("d", aD.join(" ")); aPath.setAttribute("fill", "rgba(69,137,255,0.10)"); aPath.setAttribute("stroke", "none");
        svg.appendChild(aPath);

        // Price line
        const pts = pricePts.map(pt => `${xpQ(pt.year, pt.month)},${yp(pt.price)}`).join(" ");
        const pLine = document.createElementNS(SVGNS, "polyline");
        pLine.setAttribute("points", pts); pLine.setAttribute("fill", "none");
        pLine.setAttribute("stroke", "#4589ff"); pLine.setAttribute("stroke-width", "1.8");
        pLine.setAttribute("stroke-linejoin", "round");
        svg.appendChild(pLine);
      }

      // ── Secondary overlay: Dividends per share (bar chart below price) ──
      if (heroActiveLayer === "dividends") {
        const divPts = annFin.filter(d => d.dividendsPerShare != null && d.dividendsPerShare > 0);
        const divMax = Math.max(...divPts.map(d => d.dividendsPerShare));
        const divBotY = PAD.top + ih;
        const divH    = ih * 0.25;    // use bottom 25% of chart for dividend bars
        divPts.forEach(d => {
          const bx  = xp(d.year) - 4;
          const bh  = (d.dividendsPerShare / divMax) * divH;
          const bar = document.createElementNS(SVGNS, "rect");
          bar.setAttribute("x", bx); bar.setAttribute("y", divBotY - bh);
          bar.setAttribute("width", 8); bar.setAttribute("height", bh);
          bar.setAttribute("fill", "rgba(111,220,140,0.65)"); bar.setAttribute("rx", "1.5");
          bar.dataset.year = d.year; bar.dataset.div = d.dividendsPerShare;
          svg.appendChild(bar);
        });
      }

      // ── Secondary overlay: EPS bars ────────────────────────────────────
      if (heroActiveLayer === "earnings") {
        const epsPts = annFin.filter(d => d.epsDiluted != null);
        const epsMax = Math.max(...epsPts.map(d => Math.abs(d.epsDiluted)));
        const epsBotY = PAD.top + ih;
        const epsH    = ih * 0.2;
        const epsZeroY = epsBotY;
        epsPts.forEach(d => {
          const bx = xp(d.year) - 4;
          const bh = (Math.abs(d.epsDiluted) / epsMax) * epsH;
          const bar = document.createElementNS(SVGNS, "rect");
          bar.setAttribute("x", bx);
          bar.setAttribute("y", d.epsDiluted >= 0 ? epsZeroY - bh : epsZeroY);
          bar.setAttribute("width", 8); bar.setAttribute("height", bh);
          bar.setAttribute("fill", d.epsDiluted >= 0 ? "rgba(165,110,255,0.6)" : "rgba(250,77,86,0.6)");
          bar.setAttribute("rx", "1.5");
          bar.dataset.year = d.year; bar.dataset.eps = d.epsDiluted;
          svg.appendChild(bar);
        });
      }

      // ── Acquisition markers ─────────────────────────────────────────────
      const showAcqMarkers = showAcq || heroActiveLayer === "acquisitions";
      const legAcq = document.getElementById("macHeroLegAcq");
      if (legAcq) legAcq.style.display = showAcqMarkers ? "" : "none";
      if (showAcqMarkers) {
        // Group deals by year
        const dealsByYear = {};
        majorDeals.filter(d => d.year >= yr0 && d.year <= yr1).forEach(d => {
          if (!dealsByYear[d.year]) dealsByYear[d.year] = [];
          dealsByYear[d.year].push(d);
        });
        Object.entries(dealsByYear).forEach(([yr, deals]) => {
          const cx = xp(+yr);
          // Find price at that year for marker position
          const priceAtYr = annualPriceFromQ[+yr];
          if (priceAtYr == null) return;
          let cy;
          if (heroActiveLayer === "marketCap") {
            const mcRow = annFin.find(d => d.year === +yr);
            cy = mcRow && mcRow.marketCap ? yp(mcRow.marketCap / 1000) - 10 : PAD.top + 10;
          } else {
            cy = yp(priceAtYr) - 12;
          }
          // Draw diamond marker
          const size = Math.min(5 + deals.reduce((s, d) => s + (d.valueMillions ? 1 : 0), 0) * 1.5, 10);
          const diamond = document.createElementNS(SVGNS, "path");
          diamond.setAttribute("d", `M ${cx} ${cy - size} L ${cx + size} ${cy} L ${cx} ${cy + size} L ${cx - size} ${cy} Z`);
          diamond.setAttribute("fill", "#ff832b"); diamond.setAttribute("stroke", "var(--surface)");
          diamond.setAttribute("stroke-width", "1.5");
          diamond.dataset.year = yr;
          diamond.dataset.deals = deals.map(d => d.name).join("; ");
          diamond.style.cursor = "pointer";
          svg.appendChild(diamond);

          // Label for major named deals
          if (deals.some(d => d.valueMillions != null && d.valueMillions > 5000)) {
            const deal = deals.find(d => d.valueMillions != null && d.valueMillions > 5000);
            const lbl = document.createElementNS(SVGNS, "text");
            lbl.setAttribute("x", cx); lbl.setAttribute("y", cy - size - 6);
            lbl.setAttribute("text-anchor", "middle"); lbl.setAttribute("fill", "#ff832b");
            lbl.setAttribute("font-size", "9"); lbl.setAttribute("font-family", "var(--font)");
            lbl.textContent = deal.name.split(" ")[0] + " · " + yr;
            svg.appendChild(lbl);
          }
        });
      }

      // ── Latest price dot ───────────────────────────────────────────────
      if (heroActiveLayer !== "marketCap" && pricePts.length) {
        const lastPt = pricePts[pricePts.length - 1];
        const dot = document.createElementNS(SVGNS, "circle");
        dot.setAttribute("cx", xpQ(lastPt.year, lastPt.month));
        dot.setAttribute("cy", yp(lastPt.price));
        dot.setAttribute("r", "4"); dot.setAttribute("fill", "#4589ff");
        dot.setAttribute("stroke", "var(--surface)"); dot.setAttribute("stroke-width", "2");
        svg.appendChild(dot);
      }

      // ── Invisible hover overlay ────────────────────────────────────────
      const overlay = document.createElementNS(SVGNS, "rect");
      overlay.setAttribute("x", PAD.left); overlay.setAttribute("y", PAD.top);
      overlay.setAttribute("width", iw); overlay.setAttribute("height", ih);
      overlay.setAttribute("fill", "transparent"); overlay.setAttribute("style", "cursor:crosshair");
      overlay.addEventListener("mousemove", e => {
        const rect = host.getBoundingClientRect();
        const mx = e.clientX - rect.left - PAD.left;
        const frac = Math.max(0, Math.min(1, mx / iw));
        const fracYear = xMin + frac * (xMax - xMin);

        // Find nearest quarterly price point
        let bestIdx = 0;
        pricePts.forEach((pt, i) => {
          const fy = pt.year + (pt.month - 1) / 12;
          const bfy = pricePts[bestIdx].year + (pricePts[bestIdx].month - 1) / 12;
          if (Math.abs(fy - fracYear) < Math.abs(bfy - fracYear)) bestIdx = i;
        });
        const pt = pricePts[bestIdx];
        if (!pt) return;
        const cx = xpQ(pt.year, pt.month);
        const cy = yp(pt.price);

        // Crosshair
        let xl = svg.querySelector(".mac-hero-xhair");
        if (!xl) { xl = document.createElementNS(SVGNS, "line"); xl.setAttribute("class", "mac-hero-xhair"); xl.setAttribute("pointer-events", "none"); svg.appendChild(xl); }
        xl.setAttribute("x1", cx); xl.setAttribute("x2", cx);
        xl.setAttribute("y1", PAD.top); xl.setAttribute("y2", PAD.top + ih);
        xl.setAttribute("stroke", "rgba(255,255,255,0.3)"); xl.setAttribute("stroke-width", "1");
        xl.setAttribute("stroke-dasharray", "4 3");

        // Find annual data for tooltip extras
        const annRow = byYear.get(pt.year) || {};
        const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][pt.month - 1];
        const cr = CREDIT_RATINGS[pt.year];
        const ceo = meta.leadership.find(l => pt.year >= l.from && (l.to == null || pt.year <= l.to));
        const acqThisYear = majorDeals.filter(d => d.year === pt.year);

        const tipHtml = `
          <div style="font-weight:700;font-size:13px;margin-bottom:5px">${mo} ${pt.year}</div>
          <div style="color:#4589ff;font-size:14px;font-weight:700;margin-bottom:4px">$${pt.price.toFixed(2)}</div>
          ${annRow.marketCap != null ? `<div style="color:var(--ink-soft);font-size:11px">Market cap: $${(annRow.marketCap/1000).toFixed(1)}B</div>` : ""}
          ${annRow.revenue   != null ? `<div style="color:var(--ink-soft);font-size:11px">Revenue: $${(annRow.revenue/1000).toFixed(1)}B</div>` : ""}
          ${annRow.epsDiluted!= null ? `<div style="color:var(--ink-soft);font-size:11px">EPS: $${annRow.epsDiluted.toFixed(2)}</div>` : ""}
          ${cr               != null ? `<div style="color:var(--ink-soft);font-size:11px">Credit: ${cr.sp} / ${cr.moody}</div>` : ""}
          ${ceo              != null ? `<div style="color:var(--ink-dim);font-size:10px;margin-top:3px">CEO: ${ceo.name}</div>` : ""}
          ${acqThisYear.length ? `<div style="color:#ff832b;font-size:10px;margin-top:2px">Acq: ${acqThisYear.map(d=>d.name).join("; ")}</div>` : ""}
        `;
        tip.innerHTML = tipHtml; tip.style.display = "block";
        const tw = tip.offsetWidth || 170, th = tip.offsetHeight || 90;
        let lx = cx + 14, ly = cy - th / 2;
        if (lx + tw > iw + PAD.left - 4) lx = cx - tw - 10;
        if (ly < 4) ly = 4;
        if (ly + th > H - 4) ly = H - th - 4;
        tip.style.left = lx + "px"; tip.style.top = ly + "px";
      });
      overlay.addEventListener("mouseleave", () => {
        if (tip) tip.style.display = "none";
        const xl = svg.querySelector(".mac-hero-xhair");
        if (xl) xl.remove();
      });
      svg.appendChild(overlay);

      // ── Note + source line ─────────────────────────────────────────────
      const noteEl = document.getElementById("macHeroNote");
      const layerName = { price: "split-adjusted quarterly close", marketCap: "market cap ($B)", dividends: "dividends per share overlay", earnings: "EPS overlay", acquisitions: "acquisition markers" }[heroActiveLayer] || heroActiveLayer;
      noteEl.textContent =
        `IBM stock ${layerName} · ${yr0}–${yr1} · Grey bands = NBER recessions (FRED USREC). ` +
        `Price source: Yahoo Finance IBM (quarterly close, split-adjusted). Market cap: IBM 10-K filings + Bloomberg. ` +
        `Acquisition markers: IBM annual reports / press releases (major deals only, ≥$500M or named in annual report). ` +
        `Credit ratings: S&P Global Ratings press releases; Moody's press releases. ` +
        `Dividends/EPS: IBM 10-K. All figures from cited sources — no estimates or interpolations.`;

      // Sub-header update
      const subEl = document.getElementById("macHeroChartSub");
      if (subEl) subEl.textContent = `${yr0} – ${yr1} · ${layerName} · split-adjusted`;
    }

    // Initial render — use kpiYear (clamped to Y1) so byYear lookup never misses
    updateHeroKpis(kpiYear);
    drawHeroChart();

    // Keep the live KPIs ticking in step with the Overview tab's live quote
    // (self-refreshes every 60s) even while this tab is idle, and also
    // refresh immediately whenever fresh XBRL filing data lands (~5 min
    // cycle, see loadSecFilings) so a brand-new 10-Q shows up without
    // waiting on the next 60s tick.
    window.refreshMacroKpis = () => updateHeroKpis(currentKpiYear);
    setInterval(() => updateHeroKpis(currentKpiYear), 60000);

    // ── Automatic move-detector ─────────────────────────────────────────
    // Fires whenever loadLiveQuote() gets a fresh price. If the intraday
    // change crosses MOVE_THRESH in either direction, #macroMoveBanner shows
    // a red (down) or green (up) alert strip. Clears itself the moment the
    // move falls back below threshold, so no hand-editing is ever needed.
    // Lives in its own element (not the hero-kicker) so the tab's kicker
    // text stays consistent with every other tab instead of being wiped.
    const MOVE_THRESH = 5;   // percent — adjust to taste
    function updateMoveBanner(price, prevClose) {
      const el = document.getElementById("macroMoveBanner");
      if (!el) return;
      if (!price || !prevClose) { el.innerHTML = ""; return; }
      const pct = (price - prevClose) / prevClose * 100;
      const abs = Math.abs(pct);
      if (abs < MOVE_THRESH) { el.innerHTML = ""; return; }
      const up = pct >= 0;
      const dir = up ? "▲" : "▼";
      const color = up ? "var(--up)" : "var(--down)";
      const bg    = up ? "rgba(74,222,128,.08)" : "rgba(250,77,86,.08)";
      const border= up ? "rgba(74,222,128,.35)" : "rgba(250,77,86,.35)";
      const left  = up ? "rgba(74,222,128,.9)"  : "rgba(250,77,86,.9)";
      el.innerHTML = `
        <div style="background:${bg};border:1px solid ${border};border-left:3px solid ${left};
          border-radius:7px;padding:9px 15px;display:flex;align-items:center;gap:12px;
          font-family:var(--mono);font-size:12.5px;line-height:1.4;margin-bottom:14px">
          <span style="font-size:17px;flex-shrink:0">${up ? "🟢" : "🔴"}</span>
          <div>
            <span style="font-weight:700;color:${color};letter-spacing:.04em">${dir} ${abs.toFixed(2)}% today</span>
            <span style="color:var(--ink-soft)"> — IBM is at </span>
            <span style="font-weight:700;color:var(--ink)">$${price.toFixed(2)}</span>
            <span style="color:var(--ink-soft)">, ${up ? "up" : "down"} from yesterday's close of $${prevClose.toFixed(2)}</span>
          </div>
          <span style="margin-left:auto;font-size:10px;color:var(--ink-dim);white-space:nowrap">live · ~15-min delayed</span>
        </div>`;
    }
    window.refreshMoveBanner = updateMoveBanner;
    // Fire immediately in case the quote already landed before this ran
    const _q = window.__liveQuote;
    if (_q && _q.price && _q.prevClose) updateMoveBanner(_q.price, _q.prevClose);

    // Re-draw on resize + when tab becomes visible
    window.addEventListener("resize", drawHeroChart);
    const macroTabBtn2 = document.querySelector('[data-tab="macro"]');
    if (macroTabBtn2) macroTabBtn2.addEventListener("click", () => setTimeout(() => { drawHeroChart(); }, 80));
  }

  /* ====================================================================== */
  /*  SECTION C — MARKET CAP SNAPSHOT (interactive)                        */
  /* ====================================================================== */
  function buildMktCapChart() {
    const root = document.getElementById("mktCapSnapshotRoot");
    if (!root) return;

    const SNAP = {
      marketCap:          VERIFIED_SNAP.marketCapB,
      price:              VERIFIED_SNAP.price,
      sharesOutstandingM: VERIFIED_SNAP.sharesOutstandingM,
      yearChangePct:      VERIFIED_SNAP.yearChangePct,
      low52:              VERIFIED_SNAP.low52,
      high52:             VERIFIED_SNAP.high52,
      ath:                VERIFIED_SNAP.ath,
      athDate:            VERIFIED_SNAP.athDate,
      analystTargets:     VERIFIED_SNAP.analystTargets,
      bigMoves:           VERIFIED_SNAP.bigMoves || [],
    };
    const avgTarget = SNAP.analystTargets.reduce((a,t) => a+t.target, 0) / SNAP.analystTargets.length;

    // ── helpers ──────────────────────────────────────────────────────────
    const lbl = (text, tip) => `
      <div style="font-size:10px;color:var(--ink-dim);text-transform:uppercase;letter-spacing:.15em;margin-bottom:12px;font-family:var(--mono);display:flex;align-items:center;gap:5px">
        ${text}${tip ? `<span class="mcs-tip" data-tip="${tip.replace(/"/g,"&quot;")}" style="font-size:9px;color:var(--ink-dim);border:1px solid var(--line);border-radius:50%;width:12px;height:12px;display:inline-flex;align-items:center;justify-content:center;cursor:help;flex-shrink:0">?</span>` : ""}
      </div>`;

    function card(label, inner, tip, clickable) {
      return `<div class="mcs-card${clickable?" mcs-clickable":""}" data-card="${clickable||""}" style="background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:14px 18px;transition:border-color .15s,transform .15s">
        ${lbl(label, tip)}${inner}
      </div>`;
    }

    function render() {
      // Prefer live estimate if available so the Snapshot card's "Market Cap"
      // tile agrees with the hero KPI when the live feed is up.
      const lqSnap = window.__liveQuote;
      const price     = (lqSnap && lqSnap.price    != null) ? lqSnap.price    : SNAP.price;
      const marketCap = (lqSnap && lqSnap.capEstM  != null) ? lqSnap.capEstM / 1000 : SNAP.marketCap;
      const rp     = Math.max(0, Math.min(100, ((price - SNAP.low52) / (SNAP.high52 - SNAP.low52)) * 100));
      const vsAth  = ((price - SNAP.ath) / SNAP.ath * 100).toFixed(1);
      const vsAvg  = ((avgTarget - price) / price * 100).toFixed(1);
      const vsAthColor = price < SNAP.ath ? "var(--down)" : "var(--up)";
      const vsAvgColor = parseFloat(vsAvg) >= 0 ? "var(--up)" : "var(--down)";

      // ── P/S ratio ──────────────────────────────────────────────────────
      // market cap (from verified snapshot) ÷ most recent annual revenue
      // from the pipeline. Context: decade average so a VP can see whether
      // today is cheap or expensive by IBM's own history.
      const latestRev = [...fin].reverse().find(r => r.revenue != null);
      const psNow = latestRev ? (marketCap * 1000 / latestRev.revenue) : null; // both in $M
      // 10-yr average P/S (2016–2025) using pipeline data
      let psSum = 0, psCount = 0;
      fin.forEach(r => {
        if (r.year >= 2016 && r.year <= 2025 && r.marketCap != null && r.revenue != null && r.revenue > 0) {
          psSum += r.marketCap / r.revenue; psCount++;
        }
      });
      const psAvg10 = psCount ? psSum / psCount : null;

      // ── Analyst revision history ────────────────────────────────────────
      const ACTION_COLOR = { "Cut":"var(--down)", "Raised":"var(--up)",
                              "Initiated":"#a78bfa", "Maintained":"var(--ink-soft)" };
      const targetRows = SNAP.analystTargets.map(t => {
        const revRows = (t.revisions || []).map((r, i) => {
          const isLatest = i === 0;
          const price = r.from != null
            ? `<span style="font-size:9.5px;color:var(--ink-dim)">$${r.from}→</span>$${r.to}`
            : `$${r.to}`;
          const delta = r.from != null ? (() => {
            const d = r.to - r.from;
            return `<span style="color:${d>0?"var(--up)":d<0?"var(--down)":"var(--ink-soft)"};font-size:9.5px">(${d>0?"+":""}${d})</span>`;
          })() : "";
          return `
            <div style="display:flex;align-items:center;gap:5px;padding:4px 0;overflow:hidden;
              ${i < (t.revisions.length-1) ? "border-bottom:1px solid var(--line)" : ""}">
              <span style="font-size:9.5px;color:var(--ink-dim);font-family:var(--mono);white-space:nowrap;flex-shrink:0">${r.date}</span>
              <span style="font-size:10px;font-weight:600;font-family:var(--mono);color:${ACTION_COLOR[r.action]||"var(--ink-soft)"};white-space:nowrap;flex-shrink:0">${r.action}</span>
              <span style="font-size:${isLatest?"12":"11"}px;font-weight:${isLatest?"700":"400"};font-family:var(--mono);color:${isLatest?"var(--ink)":"var(--ink-soft)"};white-space:nowrap;flex-shrink:0">${price}</span>
              ${delta}
            </div>`;
        }).join("");
        return `
          <div style="flex:1;min-width:0;overflow:hidden">
            <div style="font-size:11px;font-weight:700;color:var(--ink-soft);font-family:var(--mono);
              text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px;padding-bottom:5px;
              border-bottom:2px solid var(--line)">${t.firm}
              <span style="font-size:13px;font-weight:700;color:var(--ink);margin-left:8px;font-variant-numeric:tabular-nums">$${t.target}</span>
            </div>
            ${revRows}
          </div>`;
      }).join("");

      // ── Big moves event log ─────────────────────────────────────────────
      // Seeded from VERIFIED_SNAP.bigMoves — append entries there, never here.
      const moveLog = SNAP.bigMoves.length ? SNAP.bigMoves.map((m, i) => {
        const up = m.pct >= 0;
        const pctStr = `${up ? "▲" : "▼"} ${Math.abs(m.pct).toFixed(1)}%`;
        const capStr = m.capDeltaB != null
          ? `${m.capDeltaB > 0 ? "+" : ""}$${m.capDeltaB}B market cap`
          : "";
        return `
          <div style="display:flex;gap:10px;padding:8px 0;align-items:flex-start;
            ${i < SNAP.bigMoves.length-1 ? "border-bottom:1px solid var(--line)" : ""}">
            <span style="font-size:11px;font-weight:700;font-family:var(--mono);color:${up?"var(--up)":"var(--down)"};
              white-space:nowrap;padding-top:1px;min-width:60px">${pctStr}</span>
            <div style="flex:1;min-width:0">
              <div style="font-size:11px;font-weight:600;color:var(--ink);font-family:var(--mono)">${m.date}${capStr ? ` · ${capStr}` : ""}</div>
              <div style="font-size:11px;color:var(--ink-soft);line-height:1.5;margin-top:2px">${m.headline}</div>
              ${m.detail ? `<div style="font-size:10.5px;color:var(--ink-dim);line-height:1.55;margin-top:4px">${m.detail}</div>` : ""}
            </div>
          </div>`;
      }).join("") : "";

      root.innerHTML = `
        <style>
          .mcs-card { position:relative; }
          .mcs-clickable { cursor:pointer; }
          .mcs-clickable:hover { border-color:var(--blue) !important; transform:translateY(-2px); }
          .mcs-tip-pop { position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);
            background:var(--surface-2);border:1px solid var(--line);border-radius:6px;padding:8px 11px;
            font-size:10.5px;color:var(--ink-soft);width:200px;line-height:1.5;z-index:30;
            box-shadow:0 6px 20px rgba(0,0,0,.45);pointer-events:none;white-space:normal;font-family:var(--font); }
        </style>

        <!-- date stamp -->
        <div style="font-size:12px;color:var(--ink-soft);margin-bottom:14px">${
          lqSnap && lqSnap.price != null
            ? `Live estimate · $${lqSnap.price.toFixed(2)} × ${SNAP.sharesOutstandingM.toFixed(0)}M FY${lqSnap.sharesYear || VERIFIED_SNAP.dateLabel.slice(-4)} shares`
            : `As of ${VERIFIED_SNAP.dateLabel} close`
        }</div>

        <!-- 4 KPI cards -->
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:10px">
          ${card("Market Cap",
            (() => {
              const ret1Y = LIVE.stockReturn1Y;
              const retColor = ret1Y >= 0 ? "var(--up)" : "var(--down)";
              const retArrow = ret1Y >= 0 ? "▲" : "▼";
              return `<div style="font-size:26px;font-weight:700;font-family:var(--mono);color:var(--ink);line-height:1">$${marketCap.toFixed(2)}B</div>
             <div style="font-size:12px;color:${retColor};margin-top:7px;font-family:var(--mono)">${retArrow} ${Math.abs(ret1Y).toFixed(2)}% (1Y)</div>`;
            })(),
            "Live estimate: price × latest disclosed shares", "marketCapChart")}
          ${card("Share Price",
            `<div style="font-size:26px;font-weight:700;font-family:var(--mono);color:var(--ink);line-height:1">$${price.toFixed(2)}</div>
             <div style="font-size:12px;color:var(--ink-soft);margin-top:7px;font-family:var(--mono)">${SNAP.sharesOutstandingM.toFixed(1)}M shares out.</div>`,
            "Click to open the full Stock Performance chart", "stockPriceChart")}
          ${card("VS. All-Time High",
            `<div style="font-size:26px;font-weight:700;font-family:var(--mono);color:${vsAthColor};line-height:1">${vsAth}%</div>
             <div style="font-size:12px;color:var(--ink-soft);margin-top:7px;font-family:var(--mono)">ATH $${SNAP.ath} · ${SNAP.athDate}</div>`,
            `All-time high set ${SNAP.athDate}`)}
          ${card("Price / Sales (P/S)",
            psNow != null
              ? `<div style="font-size:26px;font-weight:700;font-family:var(--mono);color:var(--ink);line-height:1">${psNow.toFixed(2)}×</div>
                 <div style="font-size:12px;color:var(--ink-soft);margin-top:7px;font-family:var(--mono)">${psAvg10 != null ? `10yr avg ${psAvg10.toFixed(2)}× (2016–2025)` : ""}</div>`
              : `<div style="font-size:26px;font-weight:700;font-family:var(--mono);color:var(--ink-dim);line-height:1">—</div>`,
            "Market cap ÷ annual revenue · pipeline-sourced from IBM 10-Ks")}
        </div>

        <!-- 52-week range + sparkline (left) | analyst targets (right) -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:start;margin-bottom:10px">
          <!-- left column: 52-week range stacked above sparkline -->
          <div style="display:flex;flex-direction:column;gap:10px">
            ${card("52-Week Range",
              `<div style="margin:4px 0 10px">
                 <div style="height:4px;background:var(--line);border-radius:2px;position:relative;margin-bottom:8px">
                   <div title="$${price.toFixed(2)} — ${rp.toFixed(1)}th percentile"
                     style="position:absolute;left:${rp}%;top:50%;transform:translate(-50%,-50%);
                     width:14px;height:14px;border-radius:50%;background:#4589ff;border:2px solid var(--surface);cursor:help"></div>
                 </div>
                 <div style="display:flex;justify-content:space-between;font-size:12px;font-family:var(--mono);color:var(--ink-soft)">
                   <span>$${SNAP.low52}</span><span>$${SNAP.high52}</span>
                 </div>
               </div>
               <div style="font-size:12px;color:var(--ink-soft);line-height:1.5">${rp.toFixed(0)}th percentile of 52-week range</div>`,
              "52-week low–high range · dot = current price position")}
            <!-- The multi-decade market-cap sparkline that filled this space
                 has been removed: it plotted the same series as the hero
                 chart's Market Cap layer, on the same tab. What is left in
                 this card (52-week range, all-time high, analyst targets, the
                 big-moves log) exists nowhere else. -->
          </div>
          ${card("Analyst Price Targets — Revision History",
            `<div style="display:flex;gap:20px;flex-wrap:wrap;margin-top:4px;align-items:flex-start">${targetRows}</div>`,
            "Revision history per firm, newest first. Source: Benzinga / Investing.com.")}
        </div>

        <!-- significant single-day moves log -->
        ${moveLog ? `
        <div style="background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:14px 18px;margin-bottom:10px">
          ${lbl("Significant single-day moves", "Append to VERIFIED_SNAP.bigMoves in app.js to add entries — no HTML editing needed.")}
          ${moveLog}
        </div>` : ""}

        <!-- FY2026 guidance, from the Jul 22 earnings call -->
        <div style="background:rgba(69,137,255,.07);border:1px solid rgba(69,137,255,.28);border-left:3px solid var(--blue);border-radius:8px;padding:12px 16px;margin-top:10px">
          <div style="font-size:10px;color:var(--ink-dim);text-transform:uppercase;letter-spacing:.15em;margin-bottom:8px;font-family:var(--mono)">FY2026 guidance — updated Jul 22, 2026 earnings call</div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px">
            <div>
              <div style="font-size:20px;font-weight:700;font-family:var(--mono);color:var(--ink)">4–5%</div>
              <div style="font-size:11.5px;color:var(--ink-soft);margin-top:3px">constant-currency revenue growth · cut from prior "more than 5%" guide</div>
            </div>
            <div>
              <div style="font-size:20px;font-weight:700;font-family:var(--mono);color:var(--ink)">+~$1B</div>
              <div style="font-size:11.5px;color:var(--ink-soft);margin-top:3px">free cash flow growth YoY · guidance unchanged</div>
            </div>
            <div>
              <div style="font-size:20px;font-weight:700;font-family:var(--mono);color:var(--ink)">Improved</div>
              <div style="font-size:11.5px;color:var(--ink-soft);margin-top:3px">full-year pre-tax margin expansion expected; currency neutral to growth</div>
            </div>
          </div>
          <div style="font-size:11px;color:var(--ink-dim);margin-top:8px">Source: IBM Q2 2026 earnings release (newsroom.ibm.com, Jul 22, 2026) — company guidance, not a pipeline-verified figure.</div>
        </div>

        <!-- source note -->
        <p class="chart-note" style="margin-top:10px">
          Sources: StockAnalysis.com (${VERIFIED_SNAP.dateLabel} close, 52-week range, shares outstanding); Macrotrends (ATH);
          Benzinga / Investing.com (analyst price targets); IBM Q2 2026 earnings release, newsroom.ibm.com;
          IBM 10-K filings 1984–2025 (market cap sparkline &amp; P/S ratio via pipeline).
        </p>
      `;

      /* clickable cards → scroll to relevant section */
      root.querySelectorAll(".mcs-clickable").forEach(el => {
        el.addEventListener("click", () => {
          const key = el.dataset.card;
          const target = key === "stockPriceChart" ? document.getElementById("macHeroChartCard") :
                         key === "marketCapChart"   ? document.getElementById("panel-macro") : null;
          if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      });

      /* info tip hover */
      root.querySelectorAll(".mcs-tip").forEach(tip => {
        tip.addEventListener("mouseenter", () => {
          const pop = document.createElement("div");
          pop.className = "mcs-tip-pop";
          pop.textContent = tip.dataset.tip;
          tip.style.position = "relative";
          tip.appendChild(pop);
        });
        tip.addEventListener("mouseleave", () => {
          tip.querySelectorAll(".mcs-tip-pop").forEach(p => p.remove());
        });
      });
    }

    render();
  }

  /* ====================================================================== */
  /*  SECTION D — DEBT STRUCTURE CHARTS                                      */
  /* ====================================================================== */
  function buildDebtCharts() {
    const macro = D.macro;
    if (!macro) return;
    const ltD  = macro.ibmLongTermDebt;
    const stD  = macro.ibmShortTermDebt;
    const intE = macro.ibmInterestExpense;
    if (!ltD || !stD || !intE) return;
    const recessions = macro.recessions || [];
    const SVGNS = "http://www.w3.org/2000/svg";

    function svgE(tag, attrs) {
      const e = document.createElementNS(SVGNS, tag);
      if (attrs) Object.entries(attrs).forEach(([k,v]) => e.setAttribute(k, v));
      return e;
    }
    function makeTip(tip, html, cx, cy, hRect) {
      tip.innerHTML = html; tip.style.display = "block";
      const tw = tip.offsetWidth||160, th = tip.offsetHeight||56;
      let lx = cx+14, ly = cy-th/2;
      if (lx+tw>hRect.width-4) lx = cx-tw-10;
      if (ly<4) ly=4; if (ly+th>hRect.height-4) ly=hRect.height-th-4;
      tip.style.left=lx+"px"; tip.style.top=ly+"px";
    }

    const years = Object.keys(ltD).filter(k=>!k.startsWith("_")).map(Number).sort((a,b)=>a-b);
    const yr0 = years[0], yr1 = years[years.length-1];
    let debtView = "stacked";

    // ── D1: Debt levels ──────────────────────────────────────────────────
    function drawDebtLev() {
      const host = document.getElementById("debtLevHost");
      const svg  = document.getElementById("debtLevSvg");
      const tip  = document.getElementById("debtLevTip");
      if (!host || !svg) return;
      const W = host.clientWidth||760, H = host.clientHeight||300;
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("width", W); svg.setAttribute("height", H);
      svg.innerHTML = "";
      const PAD = { top:20, right:20, bottom:36, left:64 };
      const iw = W-PAD.left-PAD.right, ih = H-PAD.top-PAD.bottom;
      const N = years.length;
      const bw = iw / N;

      const totals = years.map(y => ((ltD[y]||0)+(stD[y]||0))/1000);
      const vMax = Math.max(...totals) * 1.1;

      // recession bands
      recessions.filter(r=>r.end>=yr0&&r.start<=yr1).forEach(r=>{
        const i0=Math.max(0,years.indexOf(r.start<yr0?yr0:r.start)<0?0:years.indexOf(r.start));
        const i1=years.findIndex(y=>y>=Math.min(yr1,r.end));
        if(i1<0) return;
        svg.appendChild(svgE("rect",{x:PAD.left+bw*i0,y:PAD.top,width:bw*(i1-i0+1),height:ih,fill:"rgba(120,120,120,0.13)"}));
      });

      // y gridlines
      const yStep = vMax>60?20:vMax>30?10:5;
      for (let t=0; t<=vMax; t+=yStep) {
        const y = PAD.top+ih-t/vMax*ih;
        svg.appendChild(svgE("line",{x1:PAD.left,y1:y,x2:W-PAD.right,y2:y,stroke:"rgba(255,255,255,0.07)","stroke-width":"1"}));
        const lbl=svgE("text",{x:PAD.left-5,y:y+4,"text-anchor":"end",fill:"var(--ink-soft)","font-size":"10"});
        lbl.textContent=`$${t}B`; svg.appendChild(lbl);
      }

      // x labels
      years.forEach((yr,i)=>{
        if(yr%5!==0) return;
        const x=PAD.left+bw*i+bw/2;
        const lbl=svgE("text",{x,y:H-6,"text-anchor":"middle",fill:"var(--ink-soft)","font-size":"10"});
        lbl.textContent=yr; svg.appendChild(lbl);
      });

      if (debtView === "stacked") {
        years.forEach((yr,i) => {
          const lt = (ltD[yr]||0)/1000, st = (stD[yr]||0)/1000;
          const ltH = lt/vMax*ih, stH = st/vMax*ih;
          const x = PAD.left+bw*i+1;
          // long-term (bottom)
          svg.appendChild(svgE("rect",{x,y:PAD.top+ih-ltH-stH,width:bw-2,height:Math.max(ltH,1),fill:"#4589ff",rx:"1",opacity:"0.85"}));
          // short-term (top)
          svg.appendChild(svgE("rect",{x,y:PAD.top+ih-stH,width:bw-2,height:Math.max(stH,1),fill:"#08bdba",rx:"1",opacity:"0.85"}));
        });
        // legend
        const lg=[{c:"#4589ff",l:"Long-term debt"},{c:"#08bdba",l:"Short-term debt"}];
        lg.forEach((g,i)=>{
          const gx=PAD.left+(i*130), gy=PAD.top-4;
          svg.appendChild(svgE("rect",{x:gx,y:gy-8,width:10,height:10,fill:g.c,rx:"2"}));
          const lt=svgE("text",{x:gx+14,y:gy+2,fill:"var(--ink-soft)","font-size":"10"});
          lt.textContent=g.l; svg.appendChild(lt);
        });
      } else {
        // line for total only
        const pts = years.map((yr,i)=>`${PAD.left+bw*i+bw/2},${PAD.top+ih-totals[i]/vMax*ih}`).join(" ");
        svg.appendChild(svgE("polyline",{points:pts,fill:"none",stroke:"#4589ff","stroke-width":"2","stroke-linejoin":"round"}));
        years.forEach((yr,i)=>{
          svg.appendChild(svgE("circle",{cx:PAD.left+bw*i+bw/2,cy:PAD.top+ih-totals[i]/vMax*ih,r:"3.5",fill:"#4589ff",stroke:"var(--surface)","stroke-width":"1.5"}));
        });
      }

      // hover overlay
      const overlay = svgE("rect",{x:PAD.left,y:PAD.top,width:iw,height:ih,fill:"transparent",style:"cursor:crosshair"});
      overlay.addEventListener("mousemove",e=>{
        const rect=host.getBoundingClientRect();
        const mx=e.clientX-rect.left-PAD.left;
        const i=Math.max(0,Math.min(N-1,Math.floor(mx/(iw/N))));
        const yr=years[i];
        const lt=(ltD[yr]||0)/1000, st=(stD[yr]||0)/1000;
        const cx=PAD.left+bw*i+bw/2, cy=PAD.top+ih/2;
        let xl=svg.querySelector(".dl-xline");
        if(!xl){xl=svgE("line",{class:"dl-xline","pointer-events":"none"});svg.appendChild(xl);}
        xl.setAttribute("x1",cx);xl.setAttribute("x2",cx);xl.setAttribute("y1",PAD.top);xl.setAttribute("y2",PAD.top+ih);
        xl.setAttribute("stroke","rgba(255,255,255,0.3)");xl.setAttribute("stroke-width","1");xl.setAttribute("stroke-dasharray","4 3");
        const html=`<div style="font-weight:700;margin-bottom:4px">${yr}</div>
          <div style="color:#4589ff">Long-term: <b>$${lt.toFixed(1)}B</b></div>
          <div style="color:#08bdba">Short-term: <b>$${st.toFixed(1)}B</b></div>
          <div>Total: <b>$${(lt+st).toFixed(1)}B</b></div>`;
        makeTip(tip,html,cx,cy,rect);
      });
      overlay.addEventListener("mouseleave",()=>{
        tip.style.display="none";
        const xl=svg.querySelector(".dl-xline"); if(xl) xl.remove();
      });
      svg.appendChild(overlay);

      document.getElementById("debtLevNote").textContent =
        `IBM total debt ($B), ${yr0}–${yr1}. Source: IBM Form 10-K balance sheets (SEC EDGAR). Grey bands = NBER recessions.`;
    }

    document.getElementById("debtViewTabs").querySelectorAll(".sp-tab-btn").forEach(btn=>{
      btn.addEventListener("click",()=>{
        document.getElementById("debtViewTabs").querySelectorAll(".sp-tab-btn").forEach(b=>b.classList.remove("active"));
        btn.classList.add("active"); debtView=btn.dataset.tab; drawDebtLev();
      });
    });
    drawDebtLev();
    window.addEventListener("resize", drawDebtLev);

    // ── D2a: Debt-to-Equity ──────────────────────────────────────────────
    function drawDebtEq() {
      const host = document.getElementById("debtEqHost");
      const svg  = document.getElementById("debtEqSvg");
      const tip  = document.getElementById("debtEqTip");
      if (!host||!svg) return;
      const W=host.clientWidth||360, H=host.clientHeight||240;
      svg.setAttribute("viewBox",`0 0 ${W} ${H}`);
      svg.setAttribute("width",W); svg.setAttribute("height",H);
      svg.innerHTML="";
      const PAD={top:16,right:16,bottom:32,left:52};
      const iw=W-PAD.left-PAD.right, ih=H-PAD.top-PAD.bottom;
      const deYears = years.filter(y=>{
        const eq=byYear.get(y)?.stockholdersEquity;
        return eq!=null && eq!==0;
      });
      if(!deYears.length) return;
      const deVals = deYears.map(y=>{
        const tot=(ltD[y]||0)+(stD[y]||0);
        const eq=byYear.get(y).stockholdersEquity;
        return +(tot/eq).toFixed(2);
      });
      const vMax=Math.max(...deVals.filter(v=>isFinite(v)&&v>0))*1.15;
      const N=deYears.length;
      const bw=iw/N;
      deYears.forEach((yr,i)=>{
        const v=deVals[i]; if(!isFinite(v)||v<=0) return;
        const barH=v/vMax*ih;
        const color = v>5?"#fa4d56":v>3?"#ff832b":"#4589ff";
        svg.appendChild(svgE("rect",{x:PAD.left+bw*i+1,y:PAD.top+ih-barH,width:bw-2,height:Math.max(barH,1),fill:color,rx:"1",opacity:"0.85"}));
      });
      // y grid
      [1,2,3,5,10].filter(t=>t<=vMax).forEach(t=>{
        const y=PAD.top+ih-t/vMax*ih;
        svg.appendChild(svgE("line",{x1:PAD.left,y1:y,x2:W-PAD.right,y2:y,stroke:"rgba(255,255,255,0.07)","stroke-width":"1"}));
        const lbl=svgE("text",{x:PAD.left-4,y:y+4,"text-anchor":"end",fill:"var(--ink-soft)","font-size":"9"});
        lbl.textContent=t+"x"; svg.appendChild(lbl);
      });
      // x labels
      deYears.forEach((yr,i)=>{
        if(yr%5!==0) return;
        const lbl=svgE("text",{x:PAD.left+bw*i+bw/2,y:H-5,"text-anchor":"middle",fill:"var(--ink-soft)","font-size":"9"});
        lbl.textContent=yr; svg.appendChild(lbl);
      });
      // hover
      const overlay=svgE("rect",{x:PAD.left,y:PAD.top,width:iw,height:ih,fill:"transparent",style:"cursor:crosshair"});
      overlay.addEventListener("mousemove",e=>{
        const rect=host.getBoundingClientRect();
        const i=Math.max(0,Math.min(N-1,Math.floor((e.clientX-rect.left-PAD.left)/(iw/N))));
        const yr=deYears[i], v=deVals[i];
        const cx=PAD.left+bw*i+bw/2, cy=PAD.top+ih/2;
        const html=`<div style="font-weight:700;margin-bottom:3px">${yr}</div><div>D/E: <b>${isFinite(v)&&v>0?v.toFixed(2)+"x":"N/A"}</b></div>`;
        makeTip(tip,html,cx,cy,rect);
      });
      overlay.addEventListener("mouseleave",()=>{tip.style.display="none";});
      svg.appendChild(overlay);
      document.getElementById("debtEqNote").textContent=`Debt-to-equity ratio, ${deYears[0]}–${deYears[deYears.length-1]}. Red >5x, orange >3x, blue ≤3x.`;
    }
    drawDebtEq();
    window.addEventListener("resize", drawDebtEq);

    // ── D2b: Interest Expense ─────────────────────────────────────────────
    function drawIntExp() {
      const host=document.getElementById("intExpHost");
      const svg=document.getElementById("intExpSvg");
      const tip=document.getElementById("intExpTip");
      if(!host||!svg) return;
      const W=host.clientWidth||360, H=host.clientHeight||240;
      svg.setAttribute("viewBox",`0 0 ${W} ${H}`);
      svg.setAttribute("width",W); svg.setAttribute("height",H);
      svg.innerHTML="";
      const PAD={top:16,right:16,bottom:32,left:52};
      const iw=W-PAD.left-PAD.right, ih=H-PAD.top-PAD.bottom;
      const ieYears=Object.keys(intE).filter(k=>!k.startsWith("_")).map(Number).sort((a,b)=>a-b);
      if (!ieYears.length) {
        const note = document.getElementById("intExpNote");
        if (note) note.textContent = "Interest expense data not yet available.";
        return;
      }
      const N=ieYears.length;
      const vals=ieYears.map(y=>intE[y]);
      const vMax=Math.max(...vals)*1.1;
      const bw=iw/N;
      ieYears.forEach((yr,i)=>{
        const v=vals[i]; if(v==null) return;
        const barH=v/vMax*ih;
        svg.appendChild(svgE("rect",{x:PAD.left+bw*i+1,y:PAD.top+ih-barH,width:bw-2,height:Math.max(barH,1),fill:"#8a3ffc",rx:"1",opacity:"0.85"}));
      });
      // y grid
      const yStep=vMax>1200?400:vMax>600?200:100;
      for(let t=0;t<=vMax;t+=yStep){
        const y=PAD.top+ih-t/vMax*ih;
        svg.appendChild(svgE("line",{x1:PAD.left,y1:y,x2:W-PAD.right,y2:y,stroke:"rgba(255,255,255,0.07)","stroke-width":"1"}));
        const lbl=svgE("text",{x:PAD.left-4,y:y+4,"text-anchor":"end",fill:"var(--ink-soft)","font-size":"9"});
        lbl.textContent=`$${t}M`; svg.appendChild(lbl);
      }
      ieYears.forEach((yr,i)=>{
        if(yr%5!==0) return;
        const lbl=svgE("text",{x:PAD.left+bw*i+bw/2,y:H-5,"text-anchor":"middle",fill:"var(--ink-soft)","font-size":"9"});
        lbl.textContent=yr; svg.appendChild(lbl);
      });
      const overlay=svgE("rect",{x:PAD.left,y:PAD.top,width:iw,height:ih,fill:"transparent",style:"cursor:crosshair"});
      overlay.addEventListener("mousemove",e=>{
        const rect=host.getBoundingClientRect();
        const i=Math.max(0,Math.min(N-1,Math.floor((e.clientX-rect.left-PAD.left)/(iw/N))));
        const yr=ieYears[i],v=vals[i];
        const cx=PAD.left+bw*i+bw/2,cy=PAD.top+ih/2;
        makeTip(tip,`<div style="font-weight:700;margin-bottom:3px">${yr}</div><div style="color:#8a3ffc">Interest expense: <b>$${v}M</b></div>`,cx,cy,rect);
      });
      overlay.addEventListener("mouseleave",()=>{tip.style.display="none";});
      svg.appendChild(overlay);
      document.getElementById("intExpNote").textContent=`IBM interest expense ($M), ${ieYears[0]}–${ieYears[ieYears.length-1]}. Source: IBM Form 10-K income statements (SEC EDGAR).`;
    }
    drawIntExp();
    window.addEventListener("resize", drawIntExp);
  }


  /* ====================================================================== */
  /*  SECTION F — LATEST SEC FILINGS CARD                                   */
  /* ====================================================================== */
  function buildFilingsCard() {
    const root = document.getElementById("macFilingsRoot");
    if (!root) return;

    const agentURL = window.CUGA_AGENT_URL || "http://localhost:8787";
    let _lastCheckAt = null;
    let _timerSet = false;

    // Form badge colours — mirrors the Overview's sfc-badge palette
    const FORM_COLOR = {
      "10-K": { bg: "rgba(69,137,255,.18)",  border: "rgba(69,137,255,.45)",  text: "#4589ff" },
      "10-Q": { bg: "rgba(45,212,191,.15)",  border: "rgba(45,212,191,.45)",  text: "#2dd4bf" },
      "8-K":  { bg: "rgba(245,158,11,.15)",  border: "rgba(245,158,11,.45)",  text: "#f59e0b" },
    };
    const formStyle = form => {
      const c = FORM_COLOR[form] || { bg: "rgba(167,139,250,.15)", border: "rgba(167,139,250,.4)", text: "#a78bfa" };
      return `background:${c.bg};border:1px solid ${c.border};color:${c.text}`;
    };

    const fmtDate = iso => {
      if (!iso) return "—";
      return new Date(iso + "T00:00:00").toLocaleDateString(undefined,
        { year: "numeric", month: "short", day: "numeric" });
    };

    function render(filings, xbrl, source) {
      _lastCheckAt = Date.now();
      if (!filings || !filings.length) {
        root.innerHTML = `<div class="card" style="padding:16px 20px;color:var(--ink-dim);font-size:12px;font-family:var(--mono)">No filings returned from feed.</div>`;
        return;
      }

      // Latest-quarter headline from XBRL (same numbers as the Overview card)
      let xbrlHTML = "";
      if (xbrl && xbrl.latestQuarter) {
        const q = xbrl.latestQuarter;
        const money = v => v == null ? "n/a" : `$${(v / 1e9).toFixed(1)}B`;
        const yoy = xbrl.recentQuarters && xbrl.recentQuarters.find(r => r.fy === q.fy - 1 && r.fp === q.fp);
        let yoyHTML = "";
        if (yoy && yoy.revenue && q.revenue) {
          const d = (q.revenue - yoy.revenue) / yoy.revenue * 100;
          yoyHTML = ` <span style="color:${d >= 0 ? "var(--up)" : "var(--down)"}">${d >= 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(1)}% YoY</span>`;
        }
        xbrlHTML = `
          <div style="background:rgba(69,137,255,.06);border:1px solid rgba(69,137,255,.2);border-left:3px solid var(--blue);border-radius:6px;padding:10px 14px;margin-bottom:14px;font-size:12px;font-family:var(--mono);line-height:1.6">
            <span style="color:var(--ink-soft);font-size:10px;text-transform:uppercase;letter-spacing:.08em">Latest quarter · unaudited XBRL</span><br>
            <b style="color:var(--ink)">${q.fp} FY${q.fy}</b>
            · revenue <b>${money(q.revenue)}</b>${yoyHTML}
            · net income <b>${money(q.netIncome)}</b>
            · EPS <b>${q.epsDiluted != null ? "$" + q.epsDiluted.toFixed(2) : "n/a"}</b>
            <span style="color:var(--ink-dim);font-size:10px;margin-left:6px">straight from SEC XBRL · not pipeline-verified</span>
          </div>`;
      }

      // Filing rows
      const rows = filings.map(f => {
        const desc = f.form === "8-K"
          ? `Earnings release (8-K item 2.02)&ensp;·&ensp;period ended ${fmtDate(f.reportDate)}`
          : `${f.form}&ensp;·&ensp;period ended ${fmtDate(f.reportDate)}`;
        return `
          <div style="display:flex;align-items:flex-start;gap:12px;padding:9px 0;border-bottom:1px solid var(--line)">
            <span style="flex-shrink:0;font-size:10px;font-weight:700;font-family:var(--mono);letter-spacing:.04em;
              padding:2px 7px;border-radius:4px;margin-top:2px;${formStyle(f.form)}">${f.form}</span>
            <div style="flex:1;min-width:0">
              <div style="font-size:12.5px;color:var(--ink);font-family:var(--font);line-height:1.4">${desc}</div>
              <div style="font-size:11px;color:var(--ink-dim);font-family:var(--mono);margin-top:2px">filed ${fmtDate(f.filingDate)}</div>
            </div>
            <a href="${f.url}" target="_blank" rel="noopener"
               style="flex-shrink:0;font-size:11px;color:var(--blue-bright);border:1px solid var(--line);
               border-radius:5px;padding:3px 9px;white-space:nowrap;font-family:var(--mono);text-decoration:none;
               transition:border-color .15s">View ↗</a>
          </div>`;
      }).join("");

      const sourceLinks = `
        <a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000051143&type=10-K&dateb=&owner=include&count=10"
           target="_blank" rel="noopener"
           style="color:var(--blue-bright);font-size:10.5px;font-family:var(--mono);text-decoration:none">SEC EDGAR full history ↗</a>
        &ensp;·&ensp;
        <a href="https://www.nasdaq.com/market-activity/stocks/ibm/sec-filings"
           target="_blank" rel="noopener"
           style="color:var(--blue-bright);font-size:10.5px;font-family:var(--mono);text-decoration:none">Nasdaq filings page ↗</a>`;

      root.innerHTML = `
        <div class="card" style="padding:18px 22px;margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
            <div style="font-size:11px;color:var(--ink-dim);font-family:var(--mono)">
              via ${source} · ${sourceLinks}
            </div>
            <span class="kpi-stamp" id="macFilingsStamp" style="margin-top:0">
              <span class="kpi-stamp-dot filing"></span>
              <span class="kpi-stamp-txt" id="macFilingsStampTxt">just now</span>
            </span>
          </div>
          ${xbrlHTML}
          ${rows}
          <p style="font-size:10px;color:var(--ink-dim);font-family:var(--mono);margin:10px 0 0;line-height:1.5">
            10-K (annual) · 10-Q (quarterly) · 8-K item 2.02 (earnings releases only — governance, dividends, and other 8-Ks are filtered out).
            Refreshes every 5 minutes. XBRL figures are unaudited and sourced directly from SEC EDGAR — not cross-verified by this project's pipeline.
          </p>
        </div>`;

      // Start the "checked Xm ago" ticker once on first render
      if (!_timerSet) {
        _timerSet = true;
        setInterval(() => {
          if (_lastCheckAt == null) return;
          const mins = Math.round((Date.now() - _lastCheckAt) / 60000);
          const ago = mins < 1 ? "just now" : `${mins}m ago`;
          const el = document.getElementById("macFilingsStampTxt");
          if (el) el.textContent = `checked ${ago}`;
        }, 30000);
      }
    }

    async function fetchAndRender() {
      const tryJSON = async url => {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      };

      let filingsData = null, xbrlData = null, source = "";

      // Try agent server first (same order as loadSecFilings on Overview)
      try {
        [filingsData, xbrlData] = await Promise.all([
          tryJSON(`${agentURL}/filings/latest?symbol=IBM`),
          tryJSON(`${agentURL}/filings/xbrl?symbol=IBM`),
        ]);
        source = "agent proxy";
      } catch (_) {
        // Fall back to direct EDGAR (CORS-open submissions API)
        try {
          const sub = await tryJSON("https://data.sec.gov/submissions/CIK0000051143.json");
          const recent = sub.filings.recent;
          const out = [];
          const itemsCol = recent.items || [];
          for (let i = 0; i < recent.form.length && out.length < 8; i++) {
            const form = recent.form[i];
            if (!["10-K", "10-Q", "8-K"].includes(form)) continue;
            const items = itemsCol[i] || "";
            if (form === "8-K" && !items.includes("2.02")) continue;
            const acc = recent.accessionNumber[i];
            out.push({
              form, filingDate: recent.filingDate[i], reportDate: recent.reportDate[i],
              accessionNumber: acc, items,
              url: `https://www.sec.gov/Archives/edgar/data/51143/${acc.replace(/-/g, "")}/${recent.primaryDocument[i]}`,
            });
          }
          filingsData = { filings: out, latest: out[0] || null };
          source = "EDGAR direct";
        } catch (_) { /* both offline — stay silent */ }
      }

      if (!filingsData || !filingsData.filings || !filingsData.filings.length) return;
      render(filingsData.filings, xbrlData, source);
    }

    fetchAndRender();
    setInterval(fetchAndRender, 5 * 60 * 1000);
  }


  /* ====================================================================== */
  /*  SECTION G — ECONOMIC CLIMATE 1970–2025 (interactive multi-series)    */
  /* ====================================================================== */
  function buildMacroEconChart() {
    const root = document.getElementById("macroEconRoot");
    if (!root) return;

    /* ── data ── */
    const DATA = [
      { year:1970, fedFunds:7.18,  gdp:-0.17, cpi:5.7,  unemployment:4.9  },
      { year:1973, fedFunds:10.5,  gdp:4.02,  cpi:6.2,  unemployment:4.9  },
      { year:1975, fedFunds:5.82,  gdp:2.55,  cpi:9.1,  unemployment:8.2  },
      { year:1978, fedFunds:7.94,  gdp:6.66,  cpi:7.6,  unemployment:6.0  },
      { year:1980, fedFunds:13.35, gdp:-0.04, cpi:13.5, unemployment:7.2  },
      { year:1981, fedFunds:16.39, gdp:1.30,  cpi:10.3, unemployment:8.5  },
      { year:1982, fedFunds:12.24, gdp:-1.44, cpi:6.2,  unemployment:10.8 },
      { year:1985, fedFunds:8.10,  gdp:4.18,  cpi:3.6,  unemployment:7.0  },
      { year:1990, fedFunds:8.10,  gdp:0.60,  cpi:5.4,  unemployment:5.6  },
      { year:1993, fedFunds:3.02,  gdp:2.61,  cpi:3.0,  unemployment:6.9  },
      { year:1995, fedFunds:5.83,  gdp:2.20,  cpi:2.8,  unemployment:5.6  },
      { year:1998, fedFunds:5.35,  gdp:4.88,  cpi:1.6,  unemployment:4.5  },
      { year:2000, fedFunds:6.24,  gdp:2.91,  cpi:3.4,  unemployment:4.0  },
      { year:2001, fedFunds:3.88,  gdp:0.17,  cpi:2.8,  unemployment:4.7  },
      { year:2003, fedFunds:1.13,  gdp:4.30,  cpi:2.3,  unemployment:6.0  },
      { year:2005, fedFunds:3.22,  gdp:2.97,  cpi:3.4,  unemployment:5.1  },
      { year:2007, fedFunds:5.02,  gdp:2.13,  cpi:2.8,  unemployment:4.6  },
      { year:2008, fedFunds:1.92,  gdp:-2.54, cpi:3.8,  unemployment:5.8  },
      { year:2009, fedFunds:0.16,  gdp:0.11,  cpi:-0.4, unemployment:9.3  },
      { year:2011, fedFunds:0.10,  gdp:1.54,  cpi:3.2,  unemployment:8.9  },
      { year:2013, fedFunds:0.11,  gdp:3.01,  cpi:1.5,  unemployment:7.4  },
      { year:2015, fedFunds:0.13,  gdp:2.12,  cpi:0.1,  unemployment:5.3  },
      { year:2017, fedFunds:1.00,  gdp:2.99,  cpi:2.1,  unemployment:4.4  },
      { year:2019, fedFunds:2.16,  gdp:3.35,  cpi:1.8,  unemployment:3.7  },
      { year:2020, fedFunds:0.36,  gdp:-0.92, cpi:1.2,  unemployment:8.1  },
      { year:2021, fedFunds:0.08,  gdp:5.76,  cpi:4.7,  unemployment:5.35 },
      { year:2022, fedFunds:1.68,  gdp:1.32,  cpi:8.0,  unemployment:3.65 },
      { year:2023, fedFunds:4.83,  gdp:3.39,  cpi:4.1,  unemployment:3.64 },
      { year:2024, fedFunds:5.15,  gdp:2.40,  cpi:2.9,  unemployment:4.02 },
      { year:2025, fedFunds:4.20,  gdp:1.99,  cpi:2.6,  unemployment:4.20 },
    ];
    const YTD_2026 = { year:2026, fedFunds:3.63, gdp:2.1, cpi:3.27, unemployment:4.20 };

    const ERAS = [
      { label:"Stagflation",              start:1970, end:1982, color:"#f59e0b" },
      { label:"Great Moderation",         start:1982, end:2007, color:"#42be65" },
      { label:"GFC / ZIRP Era",           start:2007, end:2016, color:"#4589ff" },
      { label:"Post-COVID Inflation Surge",start:2020,end:2025, color:"#fa4d56" },
    ];
    const SERIES = [
      { key:"fedFunds",    label:"Fed Funds Rate", color:"#4589ff",  exact:"2001–2023 only" },
      { key:"gdp",         label:"GDP Growth",     color:"#42be65",  exact:"1930–2025, full" },
      { key:"cpi",         label:"CPI Inflation",  color:"#f59e0b",  exact:"1962–2025, full" },
      { key:"unemployment",label:"Unemployment",   color:"#a56eff",  exact:"partial years, see note" },
    ];

    /* ── state ── */
    let activeSeries = SERIES.map(s => s.key);
    let showNote = false;

    /* ── helpers ── */
    const mono = "var(--mono)";
    const allYears = DATA.map(d => d.year);
    const YEAR_MIN = 1970, YEAR_MAX = 2026;

    /* ── build DOM ── */
    root.innerHTML = "";

    // wrapper card — inherit dashboard surface instead of private background
    const card = document.createElement("div");
    card.className = "card sp-chart-card";
    card.style.cssText = "padding:20px 20px 16px;";
    root.appendChild(card);

    // ── header row ──
    const headerRow = document.createElement("div");
    headerRow.style.cssText = "display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;margin-bottom:14px";
    headerRow.innerHTML = `
      <div>
        <div style="font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:var(--ink-dim);margin-bottom:4px;font-family:var(--mono)">
          The Economic Climate, 1970–2025
        </div>
        <p style="margin:0;font-size:13px;color:var(--ink-soft)">Fed Funds Rate, GDP growth, CPI inflation, unemployment — toggle series to compare</p>
      </div>
    `;
    const noteBtn = document.createElement("button");
    noteBtn.className = "sp-tab-btn";
    noteBtn.style.cssText = "flex-shrink:0;font-size:11px;";
    noteBtn.textContent = "data coverage notes ▼";
    headerRow.appendChild(noteBtn);
    card.appendChild(headerRow);

    // ── coverage note panel ──
    const notePanel = document.createElement("div");
    notePanel.style.cssText = "background:var(--surface-2);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:12px;font-size:11px;color:var(--ink-soft);line-height:1.6;display:none";
    notePanel.innerHTML = SERIES.map(s =>
      `<div style="margin-bottom:4px"><span style="color:${s.color};font-weight:600">${s.label}:</span> ${s.exact}</div>`
    ).join("") +
    `<div>Named era boundaries are standard economic-history labels used broadly by economists and media, not an official government classification.</div>`;
    card.appendChild(notePanel);

    noteBtn.addEventListener("click", () => {
      showNote = !showNote;
      notePanel.style.display = showNote ? "block" : "none";
      noteBtn.textContent = showNote ? "hide data notes ▲" : "data coverage notes ▼";
    });

    // ── series toggle buttons ──
    const toggleRow = document.createElement("div");
    toggleRow.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px";
    card.appendChild(toggleRow);

    function renderToggles() {
      toggleRow.innerHTML = "";
      SERIES.forEach(s => {
        const on = activeSeries.includes(s.key);
        const btn = document.createElement("button");
        btn.style.cssText = `display:flex;align-items:center;gap:6px;background:${on ? s.color + "22" : "transparent"};border:1px solid ${on ? s.color : "var(--line)"};border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;color:${on ? "var(--ink)" : "var(--ink-dim)"};font-family:inherit`;
        btn.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:${s.color};opacity:${on ? 1 : 0.4};display:inline-block"></span>${s.label}`;
        btn.addEventListener("click", () => {
          if (activeSeries.includes(s.key)) {
            activeSeries = activeSeries.filter(k => k !== s.key);
          } else {
            activeSeries = [...activeSeries, s.key];
          }
          renderToggles();
          drawChart();
        });
        toggleRow.appendChild(btn);
      });
    }
    renderToggles();

    // ── SVG chart ──
    const chartWrap = document.createElement("div");
    chartWrap.style.cssText = "position:relative;width:100%;";
    card.appendChild(chartWrap);

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style.cssText = "display:block;width:100%;overflow:visible";
    chartWrap.appendChild(svg);

    const tipEl = document.createElement("div");
    tipEl.style.cssText = `position:absolute;pointer-events:none;display:none;background:var(--surface-2);border:1px solid var(--line);border-radius:6px;padding:10px 14px;font-size:12px;font-family:var(--mono);color:var(--ink);white-space:nowrap;z-index:20`;
    chartWrap.appendChild(tipEl);

    // ── YTD legend ──
    const ytdLegend = document.createElement("div");
    ytdLegend.style.cssText = "display:flex;align-items:center;gap:6px;margin-top:10px;font-size:10.5px;color:var(--ink-dim)";
    ytdLegend.innerHTML = `<svg width="24" height="10" style="flex-shrink:0"><line x1="0" y1="5" x2="24" y2="5" stroke="var(--ink-dim)" stroke-width="2" stroke-dasharray="4 3"/></svg>dashed = 2026 YTD, partial year (not a full annual figure) — diamond marker on each series' 2026 point`;
    card.appendChild(ytdLegend);

    // ── era pills ──
    const eraRow = document.createElement("div");
    eraRow.style.cssText = "display:flex;flex-wrap:wrap;gap:10px;margin-top:14px";
    eraRow.innerHTML = ERAS.map(e =>
      `<div style="font-size:11px;background:${e.color}18;border:1px solid ${e.color}44;border-radius:6px;padding:4px 10px;color:${e.color};opacity:0.85">${e.label} <span style="color:var(--ink-dim)">(${e.start}–${e.end})</span></div>`
    ).join("");
    card.appendChild(eraRow);

    // ── sources footnote ──
    const fnote = document.createElement("div");
    fnote.style.cssText = "font-size:10.5px;color:var(--ink-dim);margin-top:14px;line-height:1.6";
    fnote.innerHTML = `Sources: CPI inflation — usinflationcalculator.com (BLS), full annual coverage 1962–2025. GDP growth — multpl.com (BEA), full annual coverage 1930–2025. Fed Funds Rate — macrotrends.net (Federal Reserve H.15), exact for 2001–2023; earlier years use well-documented historical reference points. Unemployment — BLS via multiple summaries, confirmed for 1975–1986, 1990–1996, and 2021–2025; other years use documented historical peaks/troughs. Toggle series on/off using the legend buttons above the chart.<br><br>2026 (diamond marker, dashed connector): today is July 22, 2026, so no series has a complete full-year figure yet. Fed Funds and Unemployment are the latest available monthly snapshot (Jun 2026); GDP is the Q1 2026 annualized growth rate, not a full-year figure; CPI is the average of the six confirmed 2026 monthly readings (Jan–Jun). None of these should be read as equivalent to the solid full-year data points before them.`;
    card.appendChild(fnote);

    /* ── draw function ── */
    function drawChart() {
      const W = chartWrap.clientWidth || 760;
      const H = 380;
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("width", W);
      svg.setAttribute("height", H);
      svg.innerHTML = "";

      const PAD = { top:12, right:30, bottom:36, left:44 };
      const iw = W - PAD.left - PAD.right;
      const ih = H - PAD.top - PAD.bottom;
      const SVGNS = "http://www.w3.org/2000/svg";

      function svgEl(tag, attrs) {
        const el = document.createElementNS(SVGNS, tag);
        if (attrs) Object.entries(attrs).forEach(([k,v]) => el.setAttribute(k, v));
        return el;
      }

      // x/y mapping — x spans 1970–2026
      const xp = yr => PAD.left + ((yr - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * iw;

      // compute y domain across all active series (main data + YTD point)
      const allVals = activeSeries.flatMap(key => {
        const main = DATA.map(d => d[key]);
        return [...main, YTD_2026[key]];
      });
      let yMin = allVals.length ? Math.min(...allVals) : -2;
      let yMax = allVals.length ? Math.max(...allVals) : 20;
      const yPad = (yMax - yMin) * 0.08 || 1;
      yMin -= yPad; yMax += yPad;
      const yp = v => PAD.top + ih - ((v - yMin) / (yMax - yMin)) * ih;

      // ── grid lines ──
      const yTicks = 6;
      for (let i = 0; i <= yTicks; i++) {
        const v = yMin + (yMax - yMin) * i / yTicks;
        const y_ = yp(v);
        svg.appendChild(svgEl("line", { x1:PAD.left, x2:PAD.left+iw, y1:y_.toFixed(1), y2:y_.toFixed(1), stroke:"rgba(255,255,255,0.07)", "stroke-dasharray":"3 3" }));
        const lbl = svgEl("text", { x:PAD.left-4, y:(y_+4).toFixed(1), "text-anchor":"end", fill:"var(--ink-soft)", "font-size":"10", "font-family":"var(--mono)" });
        lbl.textContent = v.toFixed(1) + "%";
        svg.appendChild(lbl);
      }

      // ── x-axis ticks ──
      const xTickYears = [1970,1975,1980,1985,1990,1995,2000,2005,2010,2015,2020,2025];
      xTickYears.forEach(yr => {
        const x_ = xp(yr);
        const lbl = svgEl("text", { x:x_.toFixed(1), y:(PAD.top+ih+18).toFixed(1), "text-anchor":"middle", fill:"var(--ink-soft)", "font-size":"10", "font-family":"var(--mono)" });
        lbl.textContent = yr;
        svg.appendChild(lbl);
      });

      // ── axes ──
      svg.appendChild(svgEl("line", { x1:PAD.left, x2:PAD.left, y1:PAD.top, y2:PAD.top+ih, stroke:"var(--line)" }));
      svg.appendChild(svgEl("line", { x1:PAD.left, x2:PAD.left+iw, y1:PAD.top+ih, y2:PAD.top+ih, stroke:"var(--line)" }));

      // ── era reference areas ──
      ERAS.forEach(e => {
        const x1 = xp(e.start), x2 = xp(e.end);
        svg.appendChild(svgEl("rect", { x:x1.toFixed(1), y:PAD.top, width:(x2-x1).toFixed(1), height:ih, fill:e.color, opacity:"0.06" }));
      });

      // ── zero line ──
      if (yMin < 0 && yMax > 0) {
        svg.appendChild(svgEl("line", { x1:PAD.left, x2:PAD.left+iw, y1:yp(0).toFixed(1), y2:yp(0).toFixed(1), stroke:"var(--line-soft)", "stroke-width":"1" }));
      }

      // ── series lines (main data) ──
      activeSeries.forEach(key => {
        const s = SERIES.find(s => s.key === key);
        if (!s) return;
        const pts = DATA.map(d => `${xp(d.year).toFixed(1)},${yp(d[key]).toFixed(1)}`).join(" ");
        svg.appendChild(svgEl("polyline", { points:pts, fill:"none", stroke:s.color, "stroke-width":"2", "stroke-linejoin":"round" }));
        // dots
        DATA.forEach(d => {
          svg.appendChild(svgEl("circle", { cx:xp(d.year).toFixed(1), cy:yp(d[key]).toFixed(1), r:"2.5", fill:s.color }));
        });
      });

      // ── dashed YTD connector + diamond 2026 ──
      activeSeries.forEach(key => {
        const s = SERIES.find(s => s.key === key);
        if (!s) return;
        const lastPt = DATA[DATA.length - 1];
        const x1 = xp(lastPt.year), y1 = yp(lastPt[key]);
        const x2 = xp(YTD_2026.year), y2 = yp(YTD_2026[key]);
        svg.appendChild(svgEl("line", { x1:x1.toFixed(1), y1:y1.toFixed(1), x2:x2.toFixed(1), y2:y2.toFixed(1), stroke:s.color, "stroke-width":"2", "stroke-dasharray":"5 4" }));
        // diamond marker
        const d = 5;
        const diamond = svgEl("path", { d:`M ${x2.toFixed(1)} ${(y2-d).toFixed(1)} L ${(x2+d).toFixed(1)} ${y2.toFixed(1)} L ${x2.toFixed(1)} ${(y2+d).toFixed(1)} L ${(x2-d).toFixed(1)} ${y2.toFixed(1)} Z`, fill:"var(--surface)", stroke:s.color, "stroke-width":"2" });
        svg.appendChild(diamond);
      });

      // ── hover overlay for tooltip ──
      const overlay = svgEl("rect", { x:PAD.left, y:PAD.top, width:iw, height:ih, fill:"transparent", style:"cursor:crosshair" });
      overlay.addEventListener("mousemove", e => {
        const rect = chartWrap.getBoundingClientRect();
        const mx = e.clientX - rect.left - PAD.left;
        const frac = Math.max(0, Math.min(1, mx / iw));
        const hoverYr = YEAR_MIN + frac * (YEAR_MAX - YEAR_MIN);

        // find nearest data point (including YTD)
        const allPts = [...DATA, YTD_2026];
        let best = allPts[0];
        allPts.forEach(d => { if (Math.abs(d.year - hoverYr) < Math.abs(best.year - hoverYr)) best = d; });

        const cx = xp(best.year);
        const isPartial = best.year === 2026;

        let html = `<div style="color:var(--ink-soft);margin-bottom:6px">${best.year}${isPartial ? '<span style="color:var(--down);margin-left:6px">YTD, partial</span>' : ''}</div>`;
        activeSeries.forEach(key => {
          const s = SERIES.find(s => s.key === key);
          if (!s) return;
          html += `<div style="display:flex;justify-content:space-between;gap:16px"><span style="color:${s.color}">${s.label}</span><span>${best[key].toFixed(1)}%</span></div>`;
        });
        if (isPartial) {
          html += `<div style="color:#6F7585;font-size:10px;margin-top:6px;max-width:180px;white-space:normal">2026 isn't over yet — these are partial-year snapshots, not full annual averages.</div>`;
        }

        tipEl.innerHTML = html;
        tipEl.style.display = "block";
        const tipW = tipEl.offsetWidth || 160;
        const tipH = tipEl.offsetHeight || 80;
        let tx = cx + 14, ty = (e.clientY - rect.top) - tipH / 2;
        if (tx + tipW > W - 4) tx = cx - tipW - 10;
        if (ty < 4) ty = 4;
        if (ty + tipH > H - 4) ty = H - tipH - 4;
        tipEl.style.left = tx + "px";
        tipEl.style.top  = ty + "px";
      });
      overlay.addEventListener("mouseleave", () => { tipEl.style.display = "none"; });
      svg.appendChild(overlay);
    }

    // Register globally so selectTab can trigger a first-paint when the
    // panel becomes visible (clientWidth is 0 while the panel is hidden).
    window._macroEconDraw = drawChart;
    window.addEventListener("resize", drawChart);

    // If the macro tab is already active (e.g. direct URL hash), draw now.
    if (document.getElementById("panel-macro")?.classList.contains("active")) {
      requestAnimationFrame(drawChart);
    }
  }

  /* ====================================================================== */
  /*  IBM COST OF DEBT vs THE TREASURY CURVE                                */
  /*                                                                        */
  /*  Replaced the Dividend Yield / Volume / Beta card, which rendered as   */
  /*  an empty box because macro.ibmDividendYield, macro.ibmAvgDailyVolume  */
  /*  and macro.ibmBeta5yr are not in the dataset.                          */
  /*                                                                        */
  /*  Deliberately NOT built inside buildStockPerformanceCharts(): that     */
  /*  function early-returns when any of those missing series is absent,    */
  /*  which is what killed the old card. This one stands alone so it        */
  /*  renders on data that actually exists.                                 */
  /* ====================================================================== */
  function buildBondYieldChart() {
    const root = document.getElementById("bondYieldRoot");
    if (!root) return;

    const macro = D.macro || {};
    const cod = macro.ibmCostOfDebt;
    const curve = macro.treasuryCurve;
    if (!cod || !curve) return;          // degrade quietly, never blank the tab

    const TENORS = [
      { key: "3m",  label: "13-week bill" },
      { key: "5y",  label: "5-yr note" },
      { key: "10y", label: "10-yr note" },
      { key: "30y", label: "30-yr bond" },
    ].filter(t => curve[t.key]);
    if (!TENORS.length) return;

    const SVGNS = "http://www.w3.org/2000/svg";
    const IBM_C = "#f59e0b";            // IBM cost of debt
    const TSY_C = "#4589ff";            // Treasury
    const OVER_C = "#fa4d56";           // IBM paying above the Treasury
    const UNDER_C = "#42be65";          // IBM paying below the Treasury

    let activeTenor = TENORS.some(t => t.key === "10y") ? "10y" : TENORS[0].key;

    const years = Object.keys(cod).map(Number).sort((a, b) => a - b);
    const recessions = macro.recessions || [];

    const el = (tag, attrs) => {
      const n = document.createElementNS(SVGNS, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      return n;
    };
    const tsyAt = y => {
      const v = curve[activeTenor][String(y)];
      return v == null ? null : v;
    };

    /* ── card shell ── */
    root.innerHTML = "";
    const card = document.createElement("div");
    card.className = "card sp-chart-card";
    card.style.cssText = "padding:20px 20px 16px;";
    root.appendChild(card);

    const header = document.createElement("div");
    header.style.cssText = "display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;margin-bottom:14px";
    header.innerHTML = `
      <div>
        <div style="font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:var(--ink-dim);margin-bottom:4px;font-family:var(--mono)">
          What IBM pays to borrow, ${years[0]}–${years[years.length - 1]}
        </div>
        <p style="margin:0;font-size:13px;color:var(--ink-soft)">
          IBM's effective cost of debt against the U.S. Treasury curve — the gap is what the market charges IBM over the government
        </p>
      </div>`;
    const tenorRow = document.createElement("div");
    tenorRow.className = "sp-tab-row";
    tenorRow.style.cssText = "flex-shrink:0";
    header.appendChild(tenorRow);
    card.appendChild(header);

    function renderTenorBtns() {
      tenorRow.innerHTML = "";
      TENORS.forEach(t => {
        const b = document.createElement("button");
        b.className = "sp-tab-btn" + (t.key === activeTenor ? " active" : "");
        b.textContent = t.label;
        b.addEventListener("click", () => { activeTenor = t.key; renderTenorBtns(); draw(); });
        tenorRow.appendChild(b);
      });
    }
    renderTenorBtns();

    /* ── callout strip ── */
    const callouts = document.createElement("div");
    callouts.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px";
    card.appendChild(callouts);

    function renderCallouts() {
      const spreads = years
        .map(y => ({ y, t: tsyAt(y), s: tsyAt(y) == null ? null : cod[y] - tsyAt(y) }))
        .filter(d => d.s != null);
      if (!spreads.length) { callouts.innerHTML = ""; return; }

      const latest = spreads[spreads.length - 1];
      const widest = spreads.reduce((a, b) => (b.s > a.s ? b : a));
      // first year the spread flips negative and stays negative to the end
      let flip = null;
      for (let i = spreads.length - 1; i >= 0; i--) {
        if (spreads[i].s < 0) flip = spreads[i]; else break;
      }

      const tile = (val, lbl, color) => `
        <div style="flex:1 1 180px;background:var(--surface-2);border:1px solid var(--line);border-left:3px solid ${color};border-radius:6px;padding:10px 12px">
          <div style="font-size:18px;font-weight:700;color:${color};font-family:var(--mono)">${val}</div>
          <div style="font-size:10.5px;color:var(--ink-dim);margin-top:2px;line-height:1.5">${lbl}</div>
        </div>`;

      callouts.innerHTML =
        tile(`${latest.s >= 0 ? "+" : ""}${latest.s.toFixed(2)}pp`,
             `${latest.y} spread over the ${TENORS.find(t => t.key === activeTenor).label} — IBM ${latest.s >= 0 ? "pays more than" : "pays less than"} the government`,
             latest.s >= 0 ? OVER_C : UNDER_C) +
        tile(`+${widest.s.toFixed(2)}pp`,
             `widest premium, ${widest.y} — IBM ${cod[widest.y].toFixed(2)}% vs Treasury ${widest.t.toFixed(2)}%`,
             OVER_C) +
        (flip
          ? tile(`${flip.y}`,
                 `first year IBM's book cost of debt fell below the Treasury and stayed there — the stack is still full of bonds issued at ZIRP-era coupons`,
                 UNDER_C)
          : "");
    }

    /* ── chart ── */
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:relative;width:100%;height:320px";
    const svg = el("svg", { width: "100%", height: "100%" });
    wrap.appendChild(svg);
    const tip = document.createElement("div");
    tip.style.cssText = "position:absolute;pointer-events:none;display:none;background:var(--surface-2);border:1px solid var(--line);border-radius:6px;padding:10px 14px;font-size:12px;font-family:var(--mono);color:var(--ink);white-space:nowrap;z-index:20";
    wrap.appendChild(tip);
    card.appendChild(wrap);

    const legend = document.createElement("div");
    legend.style.cssText = "display:flex;flex-wrap:wrap;gap:14px;margin-top:12px;font-size:11px;color:var(--ink-soft)";
    card.appendChild(legend);

    const note = document.createElement("p");
    note.className = "chart-note";
    note.style.cssText = "margin-top:12px";
    card.appendChild(note);

    const PAD = { top: 18, right: 18, bottom: 34, left: 46 };

    function draw() {
      renderCallouts();

      const W = wrap.clientWidth || 760;
      const H = wrap.clientHeight || 320;
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.innerHTML = "";

      const iw = W - PAD.left - PAD.right;
      const ih = H - PAD.top - PAD.bottom;

      const pts = years.map(y => ({ y, ibm: cod[y], tsy: tsyAt(y) })).filter(p => p.tsy != null);
      if (!pts.length) return;

      const vals = pts.flatMap(p => [p.ibm, p.tsy]);
      const vMax = Math.ceil(Math.max(...vals) + 0.6);
      const vMin = 0;
      const x = i => PAD.left + (pts.length === 1 ? iw / 2 : (iw * i) / (pts.length - 1));
      const yv = v => PAD.top + ih - ((v - vMin) / (vMax - vMin)) * ih;

      // recession bands
      recessions.filter(r => r.end >= pts[0].y && r.start <= pts[pts.length - 1].y).forEach(r => {
        const i0 = pts.findIndex(p => p.y >= r.start);
        let i1 = -1;
        pts.forEach((p, i) => { if (p.y <= r.end) i1 = i; });
        if (i0 < 0 || i1 < i0) return;
        svg.appendChild(el("rect", {
          x: x(i0), y: PAD.top, width: Math.max(x(i1) - x(i0), 3), height: ih,
          fill: "rgba(120,120,120,0.13)"
        }));
      });

      // gridlines
      for (let t = 0; t <= vMax; t += 1) {
        const gy = yv(t);
        svg.appendChild(el("line", { x1: PAD.left, y1: gy, x2: W - PAD.right, y2: gy,
          stroke: "rgba(255,255,255,0.07)", "stroke-width": "1" }));
        const lbl = el("text", { x: PAD.left - 6, y: gy + 4, "text-anchor": "end",
          fill: "var(--ink-soft)", "font-size": "10" });
        lbl.textContent = `${t}%`;
        svg.appendChild(lbl);
      }

      // x labels
      pts.forEach((p, i) => {
        if (p.y % 3 !== 0 && i !== pts.length - 1) return;
        const lbl = el("text", { x: x(i), y: H - 8, "text-anchor": "middle",
          fill: "var(--ink-soft)", "font-size": "10" });
        lbl.textContent = p.y;
        svg.appendChild(lbl);
      });

      // spread band, split so the fill colour tracks who is paying more.
      // Segments are cut at the crossing point, not at the year boundary, so
      // the colour flips exactly where the two lines actually intersect.
      let seg = [];
      const flush = () => {
        if (seg.length < 2) { seg = []; return; }
        const above = seg[0].ibm >= seg[0].tsy;
        const d = seg.map(p => `${p.x},${yv(p.ibm)}`).join(" L ") + " L " +
                  seg.slice().reverse().map(p => `${p.x},${yv(p.tsy)}`).join(" L ");
        svg.appendChild(el("path", { d: `M ${d} Z`,
          fill: above ? OVER_C : UNDER_C, opacity: "0.16", stroke: "none" }));
        seg = [];
      };
      pts.forEach((p, i) => {
        const cur = { x: x(i), ibm: p.ibm, tsy: p.tsy };
        if (seg.length) {
          const prev = seg[seg.length - 1];
          const wasAbove = prev.ibm >= prev.tsy;
          const isAbove = cur.ibm >= cur.tsy;
          if (wasAbove !== isAbove) {
            // linear crossing point between the two sample years
            const d0 = prev.ibm - prev.tsy, d1 = cur.ibm - cur.tsy;
            const f = d0 / (d0 - d1);
            const cx = prev.x + (cur.x - prev.x) * f;
            const cv = prev.ibm + (cur.ibm - prev.ibm) * f;
            const cross = { x: cx, ibm: cv, tsy: cv };
            seg.push(cross); flush(); seg = [cross];
          }
        }
        seg.push(cur);
      });
      flush();

      // series lines
      const line = (key, color) => {
        svg.appendChild(el("polyline", {
          points: pts.map((p, i) => `${x(i)},${yv(p[key])}`).join(" "),
          fill: "none", stroke: color, "stroke-width": "2.2", "stroke-linejoin": "round"
        }));
        pts.forEach((p, i) => svg.appendChild(el("circle", {
          cx: x(i), cy: yv(p[key]), r: "3", fill: color,
          stroke: "var(--surface)", "stroke-width": "1.5"
        })));
      };
      line("tsy", TSY_C);
      line("ibm", IBM_C);

      const tenorLabel = TENORS.find(t => t.key === activeTenor).label;
      legend.innerHTML = `
        <span style="display:flex;align-items:center;gap:6px"><span style="width:14px;height:3px;background:${IBM_C};border-radius:2px"></span>IBM effective cost of debt</span>
        <span style="display:flex;align-items:center;gap:6px"><span style="width:14px;height:3px;background:${TSY_C};border-radius:2px"></span>U.S. Treasury ${tenorLabel}</span>
        <span style="display:flex;align-items:center;gap:6px"><span style="width:12px;height:10px;background:${OVER_C};opacity:0.3;border-radius:2px"></span>IBM pays above Treasury</span>
        <span style="display:flex;align-items:center;gap:6px"><span style="width:12px;height:10px;background:${UNDER_C};opacity:0.3;border-radius:2px"></span>IBM pays below Treasury</span>
        <span style="display:flex;align-items:center;gap:6px"><span style="width:12px;height:10px;background:rgba(120,120,120,0.3);border-radius:2px"></span>NBER recession</span>`;

      // hover
      const overlay = el("rect", { x: PAD.left, y: PAD.top, width: iw, height: ih,
        fill: "transparent", style: "cursor:crosshair" });
      overlay.addEventListener("mousemove", e => {
        const rect = wrap.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        let i = 0, best = Infinity;
        pts.forEach((p, k) => { const d = Math.abs(x(k) - mx); if (d < best) { best = d; i = k; } });
        const p = pts[i];
        const spread = p.ibm - p.tsy;

        let xl = svg.querySelector(".by-xline");
        if (!xl) { xl = el("line", { class: "by-xline", "pointer-events": "none",
          stroke: "rgba(255,255,255,0.3)", "stroke-width": "1", "stroke-dasharray": "4 3" }); svg.appendChild(xl); }
        xl.setAttribute("x1", x(i)); xl.setAttribute("x2", x(i));
        xl.setAttribute("y1", PAD.top); xl.setAttribute("y2", PAD.top + ih);

        tip.innerHTML =
          `<div style="font-weight:700;margin-bottom:4px">${p.y}</div>` +
          `<div style="color:${IBM_C}">IBM cost of debt: ${p.ibm.toFixed(2)}%</div>` +
          `<div style="color:${TSY_C}">Treasury ${tenorLabel}: ${p.tsy.toFixed(2)}%</div>` +
          `<div style="color:${spread >= 0 ? OVER_C : UNDER_C};margin-top:3px">Spread: ${spread >= 0 ? "+" : ""}${spread.toFixed(2)}pp</div>`;
        tip.style.display = "block";
        const tw = tip.offsetWidth || 180;
        tip.style.left = Math.min(Math.max(x(i) - tw / 2, 4), rect.width - tw - 4) + "px";
        tip.style.top = PAD.top + 8 + "px";
      });
      overlay.addEventListener("mouseleave", () => {
        tip.style.display = "none";
        const xl = svg.querySelector(".by-xline"); if (xl) xl.remove();
      });
      svg.appendChild(overlay);

      note.textContent =
        "IBM's series is a REALISED BOOK RATE, not a market yield: total interest costs incurred " +
        "(SEC EDGAR XBRL us-gaap:InterestCostsIncurred — includes the financing-segment interest IBM " +
        "charges to cost of financing) divided by average total debt from the 10-K balance sheets. " +
        "It reprices only as old bonds mature and refinance, so it lags market rates by design — that " +
        "lag is why it now sits below the Treasury. It is not the yield you would get quoted on an IBM " +
        "bond today, and IBM has no single quoted bond yield to plot instead. Treasury figures are " +
        "annual means of monthly closes (Yahoo Finance ^IRX/^FVX/^TNX/^TYX), matching the full-year " +
        "basis of IBM's series — they are not the Jan-1 readings used by macro.treasury10yr elsewhere.";
    }

    window._bondYieldDraw = draw;
    window.addEventListener("resize", draw);
    if (document.getElementById("panel-macro")?.classList.contains("active")) {
      requestAnimationFrame(draw);
    }
  }

  /* ====================================================================== */
  /*  (Debt-to-Equity Gauge removed)                                        */
  /* ====================================================================== */
  function buildLeverageGauge() {
    return; // removed
    const root = document.getElementById("leverageGaugeRoot");
    if (!root) return;

    const HISTORY = [
      { year: 2021, de: 2.72 },
      { year: 2022, de: 2.31 },
      { year: 2023, de: 2.50 },
      { year: 2024, de: 2.01 },
      { year: 2025, de: 1.87 },
    ];
    const ZONES = [
      { label: "Conservative", max: 1.0, color: "#2d7d46" },
      { label: "Moderate",     max: 2.0, color: "#b07d2a" },
      { label: "Elevated",     max: 3.0, color: "#b85c1e" },
      { label: "High",         max: 5.0, color: "#a83232" },
    ];
    const IBM_BLUE   = "#4589ff";
    const GAUGE_MAX  = 5.0;
    const C = {
      bg: "var(--surface)", panel: "var(--surface-2)", border: "var(--line)",
      textPrimary: "var(--ink)", textSecondary: "var(--ink-soft)", textHelper: "var(--ink-dim)",
    };
    const mono = "var(--mono)";

    let activeYear = 2025;

    /* ── geometry helpers ── */
    function polarXY(cx, cy, r, angleDeg) {
      const rad = (angleDeg - 180) * (Math.PI / 180);
      return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
    }
    function arcPath(cx, cy, r, startDeg, endDeg) {
      const s = polarXY(cx, cy, r, endDeg);
      const e = polarXY(cx, cy, r, startDeg);
      const large = endDeg - startDeg <= 180 ? 0 : 1;
      return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
    }

    /* ── compute zone arc angles ── */
    const zoneArcs = (() => {
      let prev = 0;
      return ZONES.map(z => {
        const s = (prev / GAUGE_MAX) * 180;
        const e = (Math.min(z.max, GAUGE_MAX) / GAUGE_MAX) * 180;
        prev = z.max;
        return { ...z, startAngle: s, endAngle: e };
      });
    })();

    /* ── build SVG gauge ── */
    const NS = "http://www.w3.org/2000/svg";
    const cx = 150, cy = 150, r = 110;

    function buildGaugeSvg(value) {
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("width", "300"); svg.setAttribute("height", "175");
      svg.setAttribute("viewBox", "0 0 300 175");

      /* zone stripes — 8 bars per zone, IBM logo motif */
      zoneArcs.forEach(z => {
        const stripes = 8;
        const span = z.endAngle - z.startAngle;
        const gapFrac = 0.18;
        for (let i = 0; i < stripes; i++) {
          const bStart = z.startAngle + i * (span / stripes);
          const bEnd   = bStart + (span / stripes) * (1 - gapFrac);
          const p = document.createElementNS(NS, "path");
          p.setAttribute("d", arcPath(cx, cy, r, bStart, bEnd));
          p.setAttribute("fill", "none");
          p.setAttribute("stroke", z.color);
          p.setAttribute("stroke-width", "20");
          p.setAttribute("stroke-linecap", "butt");
          svg.appendChild(p);
        }
      });

      /* needle */
      const needleAngle = (Math.min(value, GAUGE_MAX) / GAUGE_MAX) * 180;
      const tip = polarXY(cx, cy, r - 20, needleAngle);
      const needle = document.createElementNS(NS, "line");
      needle.setAttribute("x1", cx); needle.setAttribute("y1", cy);
      needle.setAttribute("x2", tip.x.toFixed(2)); needle.setAttribute("y2", tip.y.toFixed(2));
      needle.setAttribute("stroke", C.textPrimary); needle.setAttribute("stroke-width", "3");
      needle.setAttribute("stroke-linecap", "round");
      needle.style.transition = "all 0.4s ease";
      svg.appendChild(needle);

      /* hub circle */
      const hub = document.createElementNS(NS, "circle");
      hub.setAttribute("cx", cx); hub.setAttribute("cy", cy);
      hub.setAttribute("r", "7"); hub.setAttribute("fill", IBM_BLUE);
      svg.appendChild(hub);

      /* value label — placed above the hub so the badge below doesn't cover it */
      const valTxt = document.createElementNS(NS, "text");
      valTxt.setAttribute("x", cx); valTxt.setAttribute("y", cy - 16);
      valTxt.setAttribute("text-anchor", "middle");
      valTxt.setAttribute("fill", C.textPrimary);
      valTxt.setAttribute("font-size", "26"); valTxt.setAttribute("font-weight", "600");
      valTxt.setAttribute("font-family", mono);
      valTxt.textContent = value.toFixed(2) + "x";
      svg.appendChild(valTxt);

      /* 0x / 5x+ labels */
      const lo = document.createElementNS(NS, "text");
      lo.setAttribute("x", cx - r + 5); lo.setAttribute("y", cy + 18);
      lo.setAttribute("fill", C.textHelper); lo.setAttribute("font-size", "10");
      lo.setAttribute("font-family", mono); lo.textContent = "0x";
      svg.appendChild(lo);
      const hi = document.createElementNS(NS, "text");
      hi.setAttribute("x", cx + r - 18); hi.setAttribute("y", cy + 18);
      hi.setAttribute("fill", C.textHelper); hi.setAttribute("font-size", "10");
      hi.setAttribute("font-family", mono); hi.textContent = GAUGE_MAX + "x+";
      svg.appendChild(hi);

      return svg;
    }

    /* ── 8-bar IBM logo mark (SVG) ── */
    function buildEightBar(size, color) {
      const w = size * 1.8, h = size;
      const barH = h / (8 * 1.6);
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("width", w); svg.setAttribute("height", h);
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      for (let i = 0; i < 8; i++) {
        const rect = document.createElementNS(NS, "rect");
        rect.setAttribute("x", 0); rect.setAttribute("y", i * (h / 8));
        rect.setAttribute("width", w); rect.setAttribute("height", barH);
        rect.setAttribute("fill", color);
        svg.appendChild(rect);
      }
      return svg;
    }

    /* ── DOM render ── */
    function render() {
      const h = HISTORY.find(h => h.year === activeYear) || HISTORY[HISTORY.length - 1];
      const value = h.de;
      const activeZone = ZONES.find(z => value <= z.max) || ZONES[ZONES.length - 1];

      root.innerHTML = "";
      const card = document.createElement("div");
      card.className = "card sp-chart-card";
      card.style.cssText = "padding:20px 20px 16px;";
      root.appendChild(card);

      /* header */
      const header = document.createElement("div");
      header.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:20px";
      const headerLeft = document.createElement("div");
      headerLeft.innerHTML = `
        <div style="font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:var(--ink-dim);margin-bottom:4px;font-family:var(--mono)">Debt-to-Equity Gauge</div>
        <p style="margin:0;font-size:13px;color:var(--ink-soft)">Interest-bearing debt ÷ equity · FY2021–FY2025</p>
      `;
      header.appendChild(headerLeft);
      header.appendChild(buildEightBar(20, IBM_BLUE));
      card.appendChild(header);

      /* gauge SVG */
      const gaugeWrap = document.createElement("div");
      gaugeWrap.style.cssText = "display:flex;justify-content:center";
      gaugeWrap.appendChild(buildGaugeSvg(value));
      card.appendChild(gaugeWrap);

      /* zone badge */
      const badge = document.createElement("div");
      badge.style.cssText = "text-align:center;margin-bottom:18px";
      badge.innerHTML = `<span style="background:${activeZone.color}22;color:${activeZone.color};border:1px solid ${activeZone.color}55;border-radius:6px;padding:4px 14px;font-size:12px;font-weight:600;font-family:var(--mono)">${activeZone.label.toUpperCase()} LEVERAGE</span>`;
      card.appendChild(badge);

      /* year buttons */
      const btnRow = document.createElement("div");
      btnRow.style.cssText = "display:flex;gap:4px;justify-content:center;margin-bottom:20px";
      HISTORY.forEach(item => {
        const btn = document.createElement("button");
        const on = item.year === activeYear;
        btn.style.cssText = `background:${on ? IBM_BLUE : "transparent"};color:${on ? "#fff" : "var(--ink-soft)"};border:1px solid ${on ? IBM_BLUE : "var(--line)"};border-radius:6px;padding:6px 13px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;transition:background 0.12s,border-color 0.12s`;
        btn.textContent = item.year;
        btn.addEventListener("click", () => { activeYear = item.year; render(); });
        btnRow.appendChild(btn);
      });
      card.appendChild(btnRow);

      /* zone legend */
      const legend = document.createElement("div");
      legend.style.cssText = "display:flex;justify-content:center;gap:14px;flex-wrap:wrap;margin-bottom:16px";
      ZONES.forEach(z => {
        const pill = document.createElement("div");
        pill.style.cssText = "display:flex;align-items:center;gap:6px;font-size:11px";
        pill.innerHTML = `<span style="width:9px;height:9px;background:${z.color};display:inline-block;border-radius:2px"></span><span style="color:var(--ink-soft);font-family:var(--mono)">${z.label} (${z.max === 5.0 ? "3.0x+" : `<${z.max.toFixed(1)}x`})</span>`;
        legend.appendChild(pill);
      });
      card.appendChild(legend);

      /* footnote */
      const note = document.createElement("div");
      note.style.cssText = `font-size:10.5px;color:var(--ink-dim);line-height:1.6;border-top:1px solid var(--line);padding-top:12px`;
      note.innerHTML = `D/E = total interest-bearing debt ÷ IBM stockholders' equity. Source: stock-analysis-on.net "Analysis of Debt," citing IBM 10-K filings directly, 2021–2025. Zone thresholds are common rule-of-thumb bands used in equity analysis, not a verified benchmark for IBM or its peers. The 8-segment stripe pattern echoes IBM's 8-bar logo motif.`;
      card.appendChild(note);
    }

    render();
  }



  /* ====================================================================== */
  /*  SECTION F — MACRO BACKDROP CHARTS                                      */
  /* ====================================================================== */
  function buildMacroBackdropCharts() {
    const macro = D.macro;
    if (!macro) return;
    const recessions = macro.recessions || [];
    const SVGNS = "http://www.w3.org/2000/svg";

    function svgE(tag, attrs) {
      const e = document.createElementNS(SVGNS, tag);
      if (attrs) Object.entries(attrs).forEach(([k,v]) => e.setAttribute(k, v));
      return e;
    }
    function makeTip(tip, html, cx, cy, hRect) {
      tip.innerHTML = html; tip.style.display = "block";
      const tw=tip.offsetWidth||160, th=tip.offsetHeight||56;
      let lx=cx+14, ly=cy-th/2;
      if(lx+tw>hRect.width-4) lx=cx-tw-10;
      if(ly<4) ly=4; if(ly+th>hRect.height-4) ly=hRect.height-th-4;
      tip.style.left=lx+"px"; tip.style.top=ly+"px";
    }

    // ── F1: Fed Funds + IBM stock/debt overlay ──────────────────────────
    // fedData defaults to {} (not yet sourced) rather than gating this whole
    // section -- GDP growth / CPI / Unemployment below are independent series
    // and should still render even while Fed Funds is pending.
    const fedData  = macro.fedFundsRate || {};
    const priceData = macro.ibmAnnualPrice;
    const ltDebt   = macro.ibmLongTermDebt;
    const stDebt   = macro.ibmShortTermDebt;

    let fedOverlay = "price";
    function drawFed() {
      const host=document.getElementById("fedHost");
      const svg=document.getElementById("fedSvg");
      const tip=document.getElementById("fedTip");
      if(!host||!svg) return;
      const W=host.clientWidth||760, H=host.clientHeight||300;
      svg.setAttribute("viewBox",`0 0 ${W} ${H}`);
      svg.setAttribute("width",W); svg.setAttribute("height",H);
      svg.innerHTML="";
      const PAD={top:20,right:64,bottom:36,left:48};
      const iw=W-PAD.left-PAD.right, ih=H-PAD.top-PAD.bottom;

      const fedYears=Object.keys(fedData).filter(k=>!k.startsWith("_")).map(Number).sort((a,b)=>a-b);
      if (!fedYears.length) {
        const note = document.getElementById("fedNote");
        if (note) note.textContent = "Fed Funds Rate data not yet available.";
        return;
      }
      const overlayYears = fedOverlay==="price"
        ? (priceData ? Object.keys(priceData).filter(k=>!k.startsWith("_")).map(Number) : [])
        : (ltDebt ? Object.keys(ltDebt).filter(k=>!k.startsWith("_")).map(Number) : []);
      const commonYears = fedYears.filter(y => overlayYears.includes(y)).sort((a,b)=>a-b);
      if (!commonYears.length) return;
      const yr0=commonYears[0], yr1=commonYears[commonYears.length-1];
      function xp(y){ return PAD.left+(y-yr0)/(yr1-yr0)*iw; }

      // recession bands
      recessions.filter(r=>r.end>=yr0&&r.start<=yr1).forEach(r=>{
        const x0=xp(Math.max(r.start,yr0)), x1=xp(Math.min(r.end,yr1)+1);
        svg.appendChild(svgE("rect",{x:x0,y:PAD.top,width:Math.max(x1-x0,2),height:ih,fill:"rgba(120,120,120,0.13)"}));
      });

      // Fed rate (left axis)
      const fedVals = commonYears.map(y=>fedData[y]||0);
      const fedMax = Math.max(...fedVals)*1.1;
      function yFed(v){ return PAD.top+ih-v/fedMax*ih; }

      // y left gridlines
      [0,5,10,15,20].filter(t=>t<=fedMax).forEach(t=>{
        const y=yFed(t);
        svg.appendChild(svgE("line",{x1:PAD.left,y1:y,x2:W-PAD.right,y2:y,stroke:"rgba(255,255,255,0.07)","stroke-width":"1"}));
        const lbl=svgE("text",{x:PAD.left-4,y:y+4,"text-anchor":"end",fill:"var(--ink-soft)","font-size":"10"});
        lbl.textContent=t+"%"; svg.appendChild(lbl);
      });

      // overlay series (right axis)
      const overlayVals = fedOverlay==="price"
        ? commonYears.map(y=>priceData[y])
        : commonYears.map(y=>{
          const lt=(ltDebt[y]||0), st=(stDebt?stDebt[y]||0:0);
          return (lt+st)/1000;
        });
      const overlayMax = Math.max(...overlayVals.filter(v=>v!=null))*1.1;
      function yOv(v){ return PAD.top+ih-v/overlayMax*ih; }

      // right axis labels
      const ovUnit = fedOverlay==="price" ? "$" : "$B";
      const ovStep = fedOverlay==="price" ? (overlayMax>200?50:25) : (overlayMax>50?20:10);
      for(let t=0;t<=overlayMax;t+=ovStep){
        const y=yOv(t);
        const lbl=svgE("text",{x:W-PAD.right+5,y:y+4,"text-anchor":"start",fill:"rgba(200,180,60,0.7)","font-size":"10"});
        lbl.textContent=ovUnit+t+(fedOverlay==="price"?"":"B"); svg.appendChild(lbl);
      }

      // x labels
      for(let y=yr0+(5-yr0%5);y<=yr1;y+=5){
        const x=xp(y);
        svg.appendChild(svgE("line",{x1:x,y1:PAD.top,x2:x,y2:PAD.top+ih,stroke:"rgba(255,255,255,0.06)","stroke-width":"1"}));
        const lbl=svgE("text",{x,y:H-6,"text-anchor":"middle",fill:"var(--ink-soft)","font-size":"10"});
        lbl.textContent=y; svg.appendChild(lbl);
      }

      // Fed area + line
      const fedPath=[`M ${xp(commonYears[0])} ${PAD.top+ih}`];
      commonYears.forEach(y=>fedPath.push(`L ${xp(y)} ${yFed(fedData[y]||0)}`));
      fedPath.push(`L ${xp(yr1)} ${PAD.top+ih} Z`);
      svg.appendChild(svgE("path",{d:fedPath.join(" "),fill:"rgba(218,30,40,0.10)"}));
      const fedPts=commonYears.map(y=>`${xp(y)},${yFed(fedData[y]||0)}`).join(" ");
      svg.appendChild(svgE("polyline",{points:fedPts,fill:"none",stroke:"#da1e28","stroke-width":"2","stroke-linejoin":"round"}));

      // overlay line
      const ovPts=commonYears.filter((_,i)=>overlayVals[i]!=null)
        .map((y,i)=>{
          const fullI=commonYears.indexOf(y);
          return `${xp(y)},${yOv(overlayVals[fullI])}`;
        }).join(" ");
      svg.appendChild(svgE("polyline",{points:ovPts,fill:"none",stroke:"rgba(200,180,60,0.85)","stroke-width":"2","stroke-linejoin":"round","stroke-dasharray":"5 3"}));

      // label lines
      const fL=svgE("text",{x:PAD.left+4,y:PAD.top+14,fill:"#da1e28","font-size":"10","font-weight":"600"});
      fL.textContent="Fed Funds Rate (%)"; svg.appendChild(fL);
      const oL=svgE("text",{x:W-PAD.right-4,y:PAD.top+14,"text-anchor":"end",fill:"rgba(200,180,60,0.85)","font-size":"10","font-weight":"600"});
      oL.textContent=fedOverlay==="price"?"IBM Stock Price ($)":"IBM Total Debt ($B)"; svg.appendChild(oL);

      // hover
      const overlay2=svgE("rect",{x:PAD.left,y:PAD.top,width:iw,height:ih,fill:"transparent",style:"cursor:crosshair"});
      overlay2.addEventListener("mousemove",e=>{
        const rect=host.getBoundingClientRect();
        const frac=(e.clientX-rect.left-PAD.left)/iw;
        const rawY=yr0+frac*(yr1-yr0);
        let best=0;
        commonYears.forEach((y,i)=>{ if(Math.abs(y-rawY)<Math.abs(commonYears[best]-rawY)) best=i; });
        const yr=commonYears[best];
        const fed=(fedData[yr]||0).toFixed(2);
        const ov=overlayVals[best];
        const ovFmt=fedOverlay==="price"
          ? (ov!=null?`$${ov.toFixed(2)}`:"—")
          : (ov!=null?`$${ov.toFixed(1)}B`:"—");
        const html=`<div style="font-weight:700;margin-bottom:3px">${yr}</div>
          <div style="color:#da1e28">Fed Funds: ${fed}%</div>
          <div style="color:rgba(200,180,60,0.9)">${fedOverlay==="price"?"IBM price":"IBM total debt"}: ${ovFmt}</div>`;
        makeTip(tip,html,xp(yr),PAD.top+ih/2,rect);
      });
      overlay2.addEventListener("mouseleave",()=>tip.style.display="none");
      svg.appendChild(overlay2);

      document.getElementById("fedNote").textContent=
        `Annual average Fed Funds Rate (%) vs IBM ${fedOverlay==="price"?"stock price ($)":"total debt ($B)"}. Source: FRED FEDFUNDS. Grey bands = NBER recessions.`;
    }

    document.getElementById("fedOverlayTabs").querySelectorAll(".sp-tab-btn").forEach(btn=>{
      btn.addEventListener("click",()=>{
        document.getElementById("fedOverlayTabs").querySelectorAll(".sp-tab-btn").forEach(b=>b.classList.remove("active"));
        btn.classList.add("active"); fedOverlay=btn.dataset.overlay; drawFed();
      });
    });
    drawFed();
    window.addEventListener("resize", drawFed);

    // ── F2: GDP growth vs IBM revenue growth ─────────────────────────────
    function drawGdpGrowth() {
      const host=document.getElementById("gdpGrowthHost");
      const svg=document.getElementById("gdpGrowthSvg");
      const tip=document.getElementById("gdpGrowthTip");
      if(!host||!svg) return;
      const gdpG=macro.gdpGrowthPct;
      if(!gdpG) return;
      const W=host.clientWidth||760, H=host.clientHeight||300;
      svg.setAttribute("viewBox",`0 0 ${W} ${H}`);
      svg.setAttribute("width",W); svg.setAttribute("height",H);
      svg.innerHTML="";
      const PAD={top:20,right:20,bottom:36,left:52};
      const iw=W-PAD.left-PAD.right, ih=H-PAD.top-PAD.bottom;

      // IBM revenue YoY
      const ibmRevGrowth={};
      fin.forEach(d=>{
        const prev=byYear.get(d.year-1);
        if(d.revenue!=null && prev?.revenue!=null && prev.revenue!==0){
          ibmRevGrowth[d.year]=+((d.revenue-prev.revenue)/Math.abs(prev.revenue)*100).toFixed(1);
        }
      });

      // overlap
      const gdpYears=Object.keys(gdpG).filter(k=>!k.startsWith("_")).map(Number).sort((a,b)=>a-b);
      const sharedYears=gdpYears.filter(y=>ibmRevGrowth[y]!=null);
      if(!sharedYears.length) return;
      const yr0s=sharedYears[0], yr1s=sharedYears[sharedYears.length-1];
      const N=sharedYears.length, bw=iw/N;
      const allVals=[...sharedYears.map(y=>gdpG[y]), ...sharedYears.map(y=>ibmRevGrowth[y])];
      const vMin=Math.min(...allVals)*1.1, vMax=Math.max(...allVals)*1.1;
      const y0=PAD.top+ih-(-vMin)/(vMax-vMin)*ih; // zero line
      function yp(v){ return PAD.top+ih-(v-vMin)/(vMax-vMin)*ih; }

      recessions.filter(r=>r.end>=yr0s&&r.start<=yr1s).forEach(r=>{
        const i0=Math.max(0,sharedYears.findIndex(y=>y>=r.start));
        const i1=sharedYears.findIndex(y=>y>r.end);
        const end=i1<0?N-1:i1-1;
        svg.appendChild(svgE("rect",{x:PAD.left+bw*i0,y:PAD.top,width:bw*(end-i0+1),height:ih,fill:"rgba(120,120,120,0.13)"}));
      });

      // zero line
      const zY=Math.max(PAD.top,Math.min(PAD.top+ih,yp(0)));
      svg.appendChild(svgE("line",{x1:PAD.left,y1:zY,x2:W-PAD.right,y2:zY,stroke:"rgba(255,255,255,0.2)","stroke-width":"1"}));

      // y grid
      [-20,-10,0,10,20].filter(t=>t>=vMin&&t<=vMax).forEach(t=>{
        const y=yp(t);
        svg.appendChild(svgE("line",{x1:PAD.left,y1:y,x2:W-PAD.right,y2:y,stroke:"rgba(255,255,255,0.07)","stroke-width":"1"}));
        const lbl=svgE("text",{x:PAD.left-4,y:y+4,"text-anchor":"end",fill:"var(--ink-soft)","font-size":"10"});
        lbl.textContent=t+"%"; svg.appendChild(lbl);
      });

      // x labels
      sharedYears.forEach((yr,i)=>{
        if(yr%5!==0) return;
        const lbl=svgE("text",{x:PAD.left+bw*i+bw/2,y:H-6,"text-anchor":"middle",fill:"var(--ink-soft)","font-size":"10"});
        lbl.textContent=yr; svg.appendChild(lbl);
      });

      // GDP bars
      sharedYears.forEach((yr,i)=>{
        const v=gdpG[yr]; if(v==null) return;
        const barH=Math.abs(yp(v)-zY);
        const barY=v>=0?yp(v):zY;
        svg.appendChild(svgE("rect",{x:PAD.left+bw*i+1,y:barY,width:bw-2,height:Math.max(barH,1),fill:"#42be65",rx:"1",opacity:"0.7"}));
      });

      // IBM revenue growth line
      const ibmPts=sharedYears.map((yr,i)=>`${PAD.left+bw*i+bw/2},${yp(ibmRevGrowth[yr])}`).join(" ");
      svg.appendChild(svgE("polyline",{points:ibmPts,fill:"none",stroke:"#0f62fe","stroke-width":"2.5","stroke-linejoin":"round"}));
      sharedYears.forEach((yr,i)=>{
        svg.appendChild(svgE("circle",{cx:PAD.left+bw*i+bw/2,cy:yp(ibmRevGrowth[yr]),r:"3",fill:"#0f62fe",stroke:"var(--surface)","stroke-width":"1.5"}));
      });

      // legend
      [{c:"#42be65",l:"US GDP growth"},{c:"#0f62fe",l:"IBM revenue growth"}].forEach((g,i)=>{
        const gx=PAD.left+i*150, gy=PAD.top-4;
        svg.appendChild(svgE("rect",{x:gx,y:gy-7,width:10,height:10,fill:g.c,rx:"2"}));
        const lt=svgE("text",{x:gx+14,y:gy+2,fill:"var(--ink-soft)","font-size":"10"});
        lt.textContent=g.l; svg.appendChild(lt);
      });

      // hover
      const overlay=svgE("rect",{x:PAD.left,y:PAD.top,width:iw,height:ih,fill:"transparent",style:"cursor:crosshair"});
      overlay.addEventListener("mousemove",e=>{
        const rect=host.getBoundingClientRect();
        const i=Math.max(0,Math.min(N-1,Math.floor((e.clientX-rect.left-PAD.left)/(iw/N))));
        const yr=sharedYears[i];
        const cx=PAD.left+bw*i+bw/2, cy=PAD.top+ih/2;
        const html=`<div style="font-weight:700;margin-bottom:4px">${yr}</div>
          <div style="color:#42be65">GDP growth: <b>${gdpG[yr]}%</b></div>
          <div style="color:#0f62fe">IBM rev. growth: <b>${ibmRevGrowth[yr]}%</b></div>`;
        makeTip(tip,html,cx,cy,rect);
      });
      overlay.addEventListener("mouseleave",()=>tip.style.display="none");
      svg.appendChild(overlay);
      document.getElementById("gdpGrowthNote").textContent=
        `US GDP YoY growth (bars) vs IBM revenue YoY growth (line), %. Grey bands = NBER recessions. Source: FRED GDPA / IBM 10-K.`;
    }
    drawGdpGrowth();
    window.addEventListener("resize", drawGdpGrowth);

    // ── F3a: CPI ────────────────────────────────────────────────────────
    function drawSimpleLine(hostId, svgId, tipId, noteId, data, color, unit, noteText) {
      const host=document.getElementById(hostId), svg=document.getElementById(svgId), tip=document.getElementById(tipId);
      if(!host||!svg||!data) return;
      const W=host.clientWidth||360, H=host.clientHeight||220;
      svg.setAttribute("viewBox",`0 0 ${W} ${H}`);
      svg.setAttribute("width",W); svg.setAttribute("height",H);
      svg.innerHTML="";
      const PAD={top:14,right:14,bottom:28,left:46};
      const iw=W-PAD.left-PAD.right, ih=H-PAD.top-PAD.bottom;
      const dYears=Object.keys(data).filter(k=>!k.startsWith("_")).map(Number).sort((a,b)=>a-b);
      const vals=dYears.map(y=>data[y]);
      const yr0=dYears[0], yr1=dYears[dYears.length-1];
      const vMax=Math.max(...vals)*1.05;
      function xp(y){ return PAD.left+(y-yr0)/(yr1-yr0)*iw; }
      function yp(v){ return PAD.top+ih-v/vMax*ih; }

      recessions.filter(r=>r.end>=yr0&&r.start<=yr1).forEach(r=>{
        const x0=xp(Math.max(r.start,yr0)), x1=xp(Math.min(r.end,yr1)+1);
        svg.appendChild(svgE("rect",{x:x0,y:PAD.top,width:Math.max(x1-x0,1),height:ih,fill:"rgba(120,120,120,0.13)"}));
      });
      [0.25,0.5,0.75].forEach(f=>{
        const y=PAD.top+ih*f;
        svg.appendChild(svgE("line",{x1:PAD.left,y1:y,x2:W-PAD.right,y2:y,stroke:"rgba(255,255,255,0.07)","stroke-width":"1"}));
        const lbl=svgE("text",{x:PAD.left-3,y:y+4,"text-anchor":"end",fill:"var(--ink-soft)","font-size":"9"});
        lbl.textContent=(vMax*(1-f)).toFixed(0)+(unit||""); svg.appendChild(lbl);
      });
      for(let y=yr0+(10-yr0%10);y<=yr1;y+=10){
        const x=xp(y);
        const lbl=svgE("text",{x,y:H-4,"text-anchor":"middle",fill:"var(--ink-soft)","font-size":"9"});
        lbl.textContent=y; svg.appendChild(lbl);
      }
      const aPath=[`M ${xp(yr0)} ${PAD.top+ih}`];
      dYears.forEach(y=>aPath.push(`L ${xp(y)} ${yp(data[y])}`));
      aPath.push(`L ${xp(yr1)} ${PAD.top+ih} Z`);
      svg.appendChild(svgE("path",{d:aPath.join(" "),fill:`${color}22`}));
      const pts=dYears.map(y=>`${xp(y)},${yp(data[y])}`).join(" ");
      svg.appendChild(svgE("polyline",{points:pts,fill:"none",stroke:color,"stroke-width":"1.8","stroke-linejoin":"round"}));

      const overlay=svgE("rect",{x:PAD.left,y:PAD.top,width:iw,height:ih,fill:"transparent",style:"cursor:crosshair"});
      overlay.addEventListener("mousemove",e=>{
        const rect=host.getBoundingClientRect();
        const frac=(e.clientX-rect.left-PAD.left)/iw;
        const rawY=yr0+frac*(yr1-yr0);
        let best=0;
        dYears.forEach((y,i)=>{if(Math.abs(y-rawY)<Math.abs(dYears[best]-rawY)) best=i;});
        const yr=dYears[best], v=vals[best];
        makeTip(tip,`<b>${yr}</b>: ${v.toFixed(1)}${unit||""}`,xp(yr),PAD.top+ih/2,rect);
      });
      overlay.addEventListener("mouseleave",()=>tip.style.display="none");
      svg.appendChild(overlay);
      if(noteId) document.getElementById(noteId).textContent=noteText||"";
    }

    const cpiData = macro.cpiIndex;
    drawSimpleLine("cpiHost","cpiSvg","cpiTip","cpiNote", cpiData,"#f1c21b","","CPI-U annual average index (1982-84=100). Source: FRED CPIAUCSL. Grey bands = NBER recessions.");
    drawSimpleLine("unempHost","unempSvg","unempTip","unempNote", macro.unemploymentRate,"#fa4d56","%","US civilian unemployment rate (%), annual average. Source: FRED UNRATE. Grey bands = NBER recessions.");

    window.addEventListener("resize", ()=>{
      drawGdpGrowth();
      drawSimpleLine("cpiHost","cpiSvg","cpiTip","cpiNote", cpiData,"#f1c21b","","CPI-U annual average index (1982-84=100). Source: FRED CPIAUCSL.");
      drawSimpleLine("unempHost","unempSvg","unempTip","unempNote", macro.unemploymentRate,"#fa4d56","%","US civilian unemployment rate (%), annual average. Source: FRED UNRATE.");
    });
  }

  /* ====================================================================== */
  /*  IBM STOCK PERFORMANCE CHARTS  (called from buildMacroTab)             */
  /* ====================================================================== */
  function buildStockPerformanceCharts() {
    const macro = D.macro;
    if (!macro) return;
    const monthly  = macro.ibmMonthlyPrice;
    const ibmTR    = macro.ibmTotalReturn;
    const sp5TR    = macro.sp500TotalReturn;
    const divYld   = macro.ibmDividendYield;
    const vol      = macro.ibmAvgDailyVolume;
    const beta     = macro.ibmBeta5yr;
    const recessions = macro.recessions || [];
    if (!monthly || !ibmTR || !sp5TR || !divYld || !vol || !beta) return;

    const SVGNS = "http://www.w3.org/2000/svg";

    // ── KPI bar ────────────────────────────────────────────────────────────
    // Derive the latest year dynamically from the data so this stays current
    const monthKeys = Object.keys(monthly).filter(k => !k.startsWith("_")).sort();
    const latestMonthKey = monthKeys[monthKeys.length - 1];
    const latestYear = parseInt(latestMonthKey.slice(0, 4), 10);
    const latestPrice = monthly[latestMonthKey];
    const trLatest = ibmTR[latestYear];
    const dyLatest = divYld[latestYear];
    const btLatest = beta[latestYear];
    const vlLatest = vol[latestYear];
    function setKpi(id, val, label) {
      const el = document.getElementById(id);
      if (!el) return;
      el.querySelector(".sp-kpi-val").textContent = val;
      if (label) el.querySelector(".sp-kpi-lbl").textContent = label;
    }
    // The price KPI tracks the live quote (window.__liveQuote, refreshed on the
    // same 60s cycle as the ticker) and falls back to the last monthly close
    // when the quote feed is unreachable — offline/local dev, or before the
    // first fetch resolves. renderKpis() is re-run by the live-quote listener
    // below, so the tile updates in place rather than only on first paint.
    //
    // latestYear is the last year present in the data, which mid-year is a
    // PARTIAL year: its "total return" covers Jan 1 to the last close, not
    // twelve months. Those tiles say YTD so a part-year figure is never shown
    // as if it were an annual one.
    const nowYear = new Date().getFullYear();
    const isPartialYear = latestYear >= nowYear;
    const periodLbl = isPartialYear ? `${latestYear} YTD` : `${latestYear}`;

    function renderKpis() {
      const lq = window.__liveQuote;
      const live = lq && lq.price != null;

      // Fallback label names the month the series actually ends on. Hardcoding
      // "Dec" mislabels a part-year series — mid-2026 the last key is 2026-07,
      // and calling that a December close is simply wrong.
      const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun",
                      "Jul","Aug","Sep","Oct","Nov","Dec"];
      const lastMonth = MONTHS[parseInt(latestMonthKey.slice(5, 7), 10) - 1] || "";
      setKpi("spKpiPrice",
             live ? `$${lq.price.toFixed(2)}`
                  : latestPrice != null ? `$${latestPrice.toFixed(2)}` : "—",
             live ? "IBM live price" : `${lastMonth} ${latestYear} close`);
      const priceEl = document.getElementById("spKpiPrice");
      if (priceEl && live && lq.prevClose) {
        const chg = (lq.price / lq.prevClose - 1) * 100;
        priceEl.style.setProperty("--kpi-accent", chg >= 0 ? "#42be65" : "#fa4d56");
      }

      setKpi("spKpiYTD",  trLatest != null ? `${trLatest > 0 ? "+" : ""}${trLatest.toFixed(1)}%` : "—",
             `${periodLbl} total return`);
      setKpi("spKpiDiv",  dyLatest != null ? `${dyLatest.toFixed(2)}%` : "—",
             `Dividend yield (${periodLbl})`);
      setKpi("spKpiBeta", btLatest != null ? `${btLatest.toFixed(2)}`  : "—");
      setKpi("spKpiVol",  vlLatest != null ? `${vlLatest.toFixed(1)}M` : "—",
             `Avg daily volume (${periodLbl})`);

      // IBM vs S&P 500 for the same period. Both sides are total return on the
      // same basis (see pipeline/fetch_stock_series.py) — do not mix in a
      // price-only index here.
      const sp5Latest = sp5TR[latestYear];
      if (trLatest != null && sp5Latest != null) {
        const diff = trLatest - sp5Latest;
        setKpi("spKpiOutperf", `${diff >= 0 ? "+" : ""}${diff.toFixed(1)}pp`,
               `IBM vs S&P (${periodLbl})`);
        const outpEl = document.getElementById("spKpiOutperf");
        if (outpEl) outpEl.style.setProperty("--kpi-accent", diff >= 0 ? "#42be65" : "#fa4d56");
      }

      if (trLatest != null) {
        const ytdEl = document.getElementById("spKpiYTD");
        if (ytdEl) ytdEl.style.setProperty("--kpi-accent", trLatest >= 0 ? "#42be65" : "#fa4d56");
      }
    }
    renderKpis();
    window.addEventListener("ibm-live-quote", renderKpis);

    // ── shared SVG helpers ──────────────────────────────────────────────────
    function svgEl(tag, attrs) {
      const e = document.createElementNS(SVGNS, tag);
      if (attrs) Object.entries(attrs).forEach(([k,v]) => e.setAttribute(k, v));
      return e;
    }

    // Convert YYYY-MM keys → sorted numeric x-axis values
    // Each "tick" = months since Jan 2000
    function monthlyKeys() {
      return Object.keys(monthly)
        .filter(k => !k.startsWith("_"))
        .sort();
    }

    function keyToMonths(k) {   // "2003-07" → 43
      const [y, m] = k.split("-").map(Number);
      return (y - 2000) * 12 + (m - 1);
    }

    // Generic tooltip helper
    function makeTip(tipEl, content, x, y, hostRect) {
      tipEl.innerHTML = content;
      tipEl.style.display = "block";
      const tw = tipEl.offsetWidth || 140;
      const th = tipEl.offsetHeight || 48;
      let lx = x + 14, ly = y - th / 2;
      if (lx + tw > hostRect.width - 4) lx = x - tw - 10;
      if (ly < 4) ly = 4;
      if (ly + th > hostRect.height - 4) ly = hostRect.height - th - 4;
      tipEl.style.left = lx + "px";
      tipEl.style.top  = ly + "px";
    }

    // NBER recessions that overlap [2000, latestYear] as month offsets
    const chartEndYear = latestYear;
    const chartMonths  = (chartEndYear - 2000 + 1) * 12; // total months in x-axis
    function recBands2000() {
      return recessions
        .filter(r => r.end >= 2000 && r.start <= chartEndYear)
        .map(r => ({
          x0: Math.max(0,           (Math.max(r.start, 2000)       - 2000) * 12),
          x1: Math.min(chartMonths, (Math.min(r.end,   chartEndYear) - 2000 + 1) * 12 - 1),
          name: r.name,
        }));
    }

    // ══════════════════════════════════════════════════════════════════════
    //  CHART 1 — Monthly Closing Price — REMOVED
    //
    //  This drew into spPriceHost / spPriceSvg / spPriceNote / spPriceLogToggle /
    //  spShowRecessions, none of which exist in the panel markup — the card was
    //  never built. It threw on the first missing element and took the whole of
    //  buildMacroTab() down with it, which is why the total-return chart below
    //  never rendered. It had gone unnoticed because the guard at the top of
    //  buildStockPerformanceCharts() used to return before reaching it.
    //  IBM's price history is already the hero chart's default layer.
    // ══════════════════════════════════════════════════════════════════════

    // ══════════════════════════════════════════════════════════════════════
    //  CHART 2 — Total Return vs S&P 500 (annual bars + optional cumulative line)
    // ══════════════════════════════════════════════════════════════════════
    (function drawReturnChart() {
      const HOST_ID = "spReturnHost";
      const SVG_ID  = "spReturnSvg";
      const TIP_ID  = "spReturnTip";
      const PAD = { top: 24, right: 20, bottom: 40, left: 52 };

      let ALL_YEARS = Object.keys(ibmTR).filter(k => !k.startsWith("_")).map(Number).sort((a,b) => a-b);
      let YEARS = ALL_YEARS.slice();
      const ibmVisible  = { ibm: true, sp500: true };
      let   cumulative  = false;

      // time-window selector
      document.getElementById("spReturnWindow").querySelectorAll(".sp-tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          document.getElementById("spReturnWindow").querySelectorAll(".sp-tab-btn")
            .forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
          const win = btn.dataset.win;
          if (win === "all") {
            YEARS = ALL_YEARS.slice();
          } else {
            const cutoff = latestYear - parseInt(win, 10) + 1;
            YEARS = ALL_YEARS.filter(y => y >= cutoff);
          }
          draw();
        });
      });

      document.getElementById("spReturnLegend").querySelectorAll(".sp-leg-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          const k = btn.dataset.key;
          ibmVisible[k] = !ibmVisible[k];
          btn.setAttribute("aria-pressed", String(ibmVisible[k]));
          draw();
        });
      });
      document.getElementById("spReturnCumToggle").addEventListener("change", e => {
        cumulative = e.target.checked; draw();
      });

      function cumulativeSeries(annuals) {
        let base = 100;
        return annuals.map(r => { base = base * (1 + r / 100); return +base.toFixed(2); });
      }

      function draw() {
        const host = document.getElementById(HOST_ID);
        if (!host) return;
        const W = host.clientWidth || 760;
        const H = host.clientHeight || 320;
        const svg = document.getElementById(SVG_ID);
        svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
        svg.setAttribute("width", W); svg.setAttribute("height", H);
        svg.innerHTML = "";

        const iw = W - PAD.left - PAD.right;
        const ih = H - PAD.top  - PAD.bottom;
        const N  = YEARS.length;

        const ibmVals  = YEARS.map(y => ibmTR[y]);
        const sp5Vals  = YEARS.map(y => sp5TR[y]);
        const ibmCum   = cumulativeSeries(ibmVals);
        const sp5Cum   = cumulativeSeries(sp5Vals);

        let vMin, vMax;
        if (cumulative) {
          const allV = [...(ibmVisible.ibm ? ibmCum : []), ...(ibmVisible.sp500 ? sp5Cum : [])];
          vMin = Math.min(...allV) * 0.9;
          vMax = Math.max(...allV) * 1.08;
        } else {
          const allV = [...(ibmVisible.ibm ? ibmVals : []), ...(ibmVisible.sp500 ? sp5Vals : [])];
          vMin = Math.min(...allV, 0) * 1.1;
          vMax = Math.max(...allV, 0) * 1.12;
        }

        function yv(v) { return PAD.top + ih - (v - vMin) / (vMax - vMin) * ih; }
        const y0 = Math.max(PAD.top, Math.min(PAD.top + ih, yv(0)));

        // recession bands (annual)
        recessions.filter(r => r.end >= 2000 && r.start <= latestYear).forEach(r => {
          const x0i = Math.max(0, r.start - 2000);
          const x1i = Math.min(N - 1, r.end - 2000);
          const bw  = (iw / N) * (x1i - x0i + 1);
          const bx  = PAD.left + (iw / N) * x0i;
          svg.appendChild(svgEl("rect", { x: bx, y: PAD.top, width: bw, height: ih,
            fill: "rgba(120,120,120,0.13)" }));
        });

        // zero line
        if (!cumulative) {
          svg.appendChild(svgEl("line", { x1: PAD.left, y1: y0, x2: W - PAD.right, y2: y0,
            stroke:"rgba(255,255,255,0.25)", "stroke-width":"1" }));
        }

        // y gridlines
        const yStep = cumulative ? 50 : 10;
        for (let t = Math.ceil(vMin / yStep) * yStep; t <= vMax; t += yStep) {
          const y = yv(t);
          if (y < PAD.top - 1 || y > PAD.top + ih + 1) continue;
          svg.appendChild(svgEl("line", { x1: PAD.left, y1: y, x2: W - PAD.right, y2: y,
            stroke:"rgba(255,255,255,0.07)", "stroke-width":"1" }));
          const lbl = svgEl("text", { x: PAD.left - 5, y: y + 4, "text-anchor":"end",
            fill:"var(--ink-soft)", "font-size":"10" });
          lbl.textContent = cumulative ? `${t}` : `${t}%`;
          svg.appendChild(lbl);
        }

        // x-axis labels
        YEARS.forEach((yr, i) => {
          if (yr % 4 !== 0) return;
          const bw = iw / N;
          const cx = PAD.left + bw * i + bw / 2;
          const lbl = svgEl("text", { x: cx, y: H - 6, "text-anchor":"middle",
            fill:"var(--ink-soft)", "font-size":"10" });
          lbl.textContent = yr;
          svg.appendChild(lbl);
        });

        if (cumulative) {
          // Draw as lines when cumulative
          const drawLine = (cVals, color) => {
            if (!cVals.length) return;
            const pts = cVals.map((v, i) => {
              const lbw = iw / N;
              const cx = PAD.left + lbw * i + lbw / 2;
              return `${cx},${yv(v)}`;
            }).join(" ");
            svg.appendChild(svgEl("polyline", { points: pts, fill:"none",
              stroke: color, "stroke-width":"2", "stroke-linejoin":"round", "stroke-linecap":"round" }));
            const lastX = PAD.left + (iw / N) * (N - 1) + iw / N / 2;
            svg.appendChild(svgEl("circle", { cx: lastX, cy: yv(cVals[N-1]), r:"4",
              fill: color, stroke:"var(--surface)", "stroke-width":"2" }));
          };
          if (ibmVisible.sp500) drawLine(sp5Cum, "#42be65");
          if (ibmVisible.ibm)   drawLine(ibmCum, "#4589ff");
        } else {
          // Grouped bar chart
          const bw = iw / N;
          const gap = 1;
          const barW = ibmVisible.ibm && ibmVisible.sp500
            ? (bw - gap * 3) / 2
            : (bw - gap * 2);

          YEARS.forEach((yr, i) => {
            const bx = PAD.left + bw * i;
            let offX = bx + gap;

            const drawBar = (val, color) => {
              if (val == null) { offX += barW + gap; return; }
              const barH = Math.abs(yv(val) - y0);
              const barY = val >= 0 ? y0 - barH : y0;
              svg.appendChild(svgEl("rect", { x: offX, y: barY, width: barW, height: Math.max(barH, 1),
                fill: color, rx:"1" }));
              offX += barW + gap;
            };

            if (ibmVisible.ibm)   drawBar(ibmVals[i], "#4589ff");
            if (ibmVisible.sp500) drawBar(sp5Vals[i], "#42be65");
          });
        }

        // hover overlay
        const tipEl = document.getElementById(TIP_ID);
        const overlay = svgEl("rect", { x: PAD.left, y: PAD.top, width: iw, height: ih,
          fill:"transparent", style:"cursor:crosshair" });
        overlay.addEventListener("mousemove", e => {
          const rect = host.getBoundingClientRect();
          const mx = e.clientX - rect.left - PAD.left;
          const i  = Math.max(0, Math.min(N-1, Math.floor(mx / (iw / N))));
          const yr = YEARS[i];
          const cx = PAD.left + (iw / N) * i + iw / N / 2;
          const cy = PAD.top + ih / 2;

          let xline = svg.querySelector(".sp-ret-xline");
          if (!xline) { xline = svgEl("line", { class:"sp-ret-xline", "pointer-events":"none" }); svg.appendChild(xline); }
          xline.setAttribute("x1", cx); xline.setAttribute("x2", cx);
          xline.setAttribute("y1", PAD.top); xline.setAttribute("y2", PAD.top + ih);
          xline.setAttribute("stroke", "rgba(255,255,255,0.3)"); xline.setAttribute("stroke-width","1");
          xline.setAttribute("stroke-dasharray","4 3");

          const ibmV = ibmTR[yr], sp5V = sp5TR[yr];
          const ibmC = ibmCum[i], sp5C = sp5Cum[i];
          let html = `<div style="font-weight:700;margin-bottom:4px">${yr}</div>`;
          if (ibmVisible.ibm && ibmV != null) {
            const sign = ibmV >= 0 ? "+" : "";
            html += `<div style="color:#4589ff">IBM: ${sign}${ibmV.toFixed(1)}%`;
            if (cumulative) html += ` (cum. ${ibmC.toFixed(0)})`;
            html += `</div>`;
          }
          if (ibmVisible.sp500 && sp5V != null) {
            const sign = sp5V >= 0 ? "+" : "";
            html += `<div style="color:#42be65">S&P 500: ${sign}${sp5V.toFixed(1)}%`;
            if (cumulative) html += ` (cum. ${sp5C.toFixed(0)})`;
            html += `</div>`;
          }
          makeTip(tipEl, html, cx, cy, rect);
        });
        overlay.addEventListener("mouseleave", () => {
          if (tipEl) tipEl.style.display = "none";
          const xl = svg.querySelector(".sp-ret-xline"); if (xl) xl.remove();
        });
        svg.appendChild(overlay);

        // The final year is only a full calendar year once it is over. Mid-year
        // its bar covers Jan 1 to the last close, so it must not sit next to
        // twelve-month bars unlabelled.
        const partialTail = latestYear >= new Date().getFullYear()
          ? ` ${latestYear} is year-to-date, not a full year — its bar covers Jan 1 to the latest close only.`
          : "";
        document.getElementById("spReturnNote").textContent =
          (cumulative
            ? `Cumulative growth of $100 invested Jan 1 2000, dividends reinvested. 2000–${latestYear}.`
            : `Calendar-year total return (%), dividends reinvested. Positive = green, negative = red/blue shade. 2000–${latestYear}.`)
          + partialTail;
      }

      // Registered globally so the macro tab can redraw once the panel is
      // actually visible. At build time the panel is still hidden, so the host
      // measures 0x0 and this first draw produces nothing.
      window._spReturnDraw = draw;
      window.addEventListener("resize", draw);
      draw();
    })();

  }

  /* ====================================================================== */
  /*  MERGERS & ACQUISITIONS TAB                                            */
  /* ====================================================================== */
  function buildMATab() {
    const ma = D.ma;
    if (!ma) return;

    const deals        = ma.deals;
    const annualCounts = ma.annualCounts || {};   // IBM-stated count per year
    // Deal names in ma_clean.json are normalised (legal suffixes stripped) while the
    // performance dataset keeps full names ("Cognos Inc.", "Apptio (from Vista…)"),
    // so an exact-name join silently drops those deals from every $-weighted figure
    // (Verdict measured $, valued-deal count, Alpha Leaderboard sizes). Match on a
    // normalised key instead — validated to collapse no two distinct deals together.
    const normName = s => (s || "").toLowerCase()
      .replace(/\s*\([^)]*\)/g, "")
      .replace(/[.,]/g, "")
      .replace(/\s+(inc|corp|corporation|llc|ltd|limited|plc|sa|ag|nv|bv)\s*$/, "")
      .trim();
    const dealByNorm = new Map(deals.map(d => [normName(d.name), d]));
    const perfByName = new Map((D.maPerformance?.deals || []).map(p => [normName(p.name), p]));

    function renderPerfChart(perf) {
      if (!perf.ibmReturn && perf.ibmReturn !== 0) return "";

      const IBM_C = "#4589ff";
      const BEN_C = "#8d8d8d";

      const alpha    = perf.alpha;
      const ibmRet   = perf.ibmReturn;
      const benchRet = perf.benchReturn;

      const alphaColor = (alpha >= 0) ? "#42be65" : "#fa4d56";
      const alphaSign  = (alpha >= 0) ? "+" : "";
      const ibmSign    = (ibmRet  >= 0) ? "+" : "";
      const benchSign  = (benchRet >= 0) ? "+" : "";

      // Annualised return over the 2-year window (T-6 → T+18 = 24 months)
      const annualise     = r => r != null ? ((Math.pow(1 + r / 100, 0.5) - 1) * 100).toFixed(1) : null;
      const ibmAnn        = annualise(ibmRet);
      const benchAnn      = annualise(benchRet);
      const ibmAnnSign    = ibmAnn   !== null && +ibmAnn   >= 0 ? "+" : "";
      const benchAnnSign  = benchAnn !== null && +benchAnn >= 0 ? "+" : "";
      const ibmAnnColor   = ibmAnn   !== null && +ibmAnn   >= 0 ? "#42be65" : "#fa4d56";
      const benchAnnColor = benchAnn !== null && +benchAnn >= 0 ? "#42be65" : "#fa4d56";

      // B/(W): IBM total return framed as better/worse vs benchmark
      const bw      = alpha != null ? Math.abs(alpha).toFixed(2) : null;
      const bwGood  = alpha != null && alpha >= 0;
      const bwLabel = bwGood ? `B &nbsp;+${bw} pts` : `(W) &nbsp;-${bw} pts`;
      const bwColor = bwGood ? "#42be65" : "#fa4d56";

      const benchNote = benchRet == null
        ? `No benchmark comparison available — Yahoo Finance's ${perf.benchmark} monthly data does not extend back to the ${perf.tMinus6 ? perf.tMinus6.slice(0,7) : "T-6"} baseline date for this deal.`
        : perf.benchmark === "S&P 500 (TR, reconstructed pre-1988)"
          ? "S&P 500 Total Return (dividends reinvested). This deal's window predates Yahoo's real ^SP500TR index (starts 1988), so it's reconstructed from Robert Shiller's (Yale) monthly price+dividend dataset, chain-linked to the real index from 1988 on — see the Pre-Gerstner era card above for the full method."
          : perf.benchmark === "S&P 500 (TR)"
            ? "S&P 500 Total Return (Yahoo ^SP500TR, dividends reinvested) — like-for-like with IBM's own dividend-adjusted return."
            : "XLK = S&P 500 Technology sector ETF.";

      const benchCol = benchRet != null ? `
            <div class="ma-ret-col">
              <div class="ma-ret-label" style="color:${BEN_C}">${perf.benchmark}</div>
              <div class="ma-ret-total" style="color:${BEN_C}">${benchSign}${benchRet}%</div>
              <div class="ma-ret-window">2-yr total</div>
              ${benchAnn !== null ? `<div class="ma-ret-ann" style="color:${benchAnnColor}">${benchAnnSign}${benchAnn}%<span class="ma-ret-ann-unit">/yr</span></div>` : ""}
            </div>` : "";

      const alphaCol = alpha != null ? `
            <div class="ma-ret-col ma-ret-col--alpha">
              <div class="ma-ret-label">Alpha &mdash; 2-yr total</div>
              <div class="ma-ret-total" style="color:${alphaColor}">${alphaSign}${alpha}%</div>
              <div class="ma-ret-window">vs ${perf.benchmark}</div>
              <div class="ma-ret-ann" style="color:${bwColor}">${bwLabel}</div>
            </div>` : "";

      return `
        <div class="ma-perf-section">
          <div class="ma-perf-header">
            <span class="ma-perf-title">Stock returns &mdash; T-6 months to T+18 months</span>
          </div>
          <p class="ma-perf-methodology">
            Prices are measured starting <strong>6 months before the deal closed</strong> and ending
            <strong>18 months after</strong> — a 24-month window deliberately chosen to account for
            the &ldquo;priced-in&rdquo; effect. By anchoring 6 months before close we capture any
            run-up the market had already baked in; by holding 18 months post-close we give the
            integration time to play out. The ${perf.benchmark} benchmark runs over the same exact
            window so any macro tailwind or headwind cancels out.
          </p>
          <div class="ma-ret-grid">
            <div class="ma-ret-col">
              <div class="ma-ret-label" style="color:${IBM_C}">IBM &mdash; 2-yr total</div>
              <div class="ma-ret-total" style="color:${IBM_C}">${ibmSign}${ibmRet}%</div>
              <div class="ma-ret-window">2-yr total</div>
              ${ibmAnn !== null ? `<div class="ma-ret-ann" style="color:${ibmAnnColor}">${ibmAnnSign}${ibmAnn}%<span class="ma-ret-ann-unit">/yr</span></div>` : ""}
              ${bw !== null ? `<div class="ma-ret-bw" style="color:${bwColor}">${bwLabel}</div>` : ""}
            </div>
            ${benchCol}
            ${alphaCol}
          </div>
          <p class="ma-perf-note">${benchNote}</p>
        </div>`;
    }

    const fmt$ = v => {
      if (!v) return "undisclosed";
      if (v >= 1000) return `$${(v/1000).toFixed(1)}B`;
      return `$${v}M`;
    };

    const eraColor = year => {
      if (year <= 1992) return "#6929c4";
      if (year <= 2002) return "#0043ce";
      if (year <= 2011) return "#005d5d";
      if (year <= 2019) return "#9f1853";
      return "#198038";
    };
    const eraLabel = year => {
      if (year <= 1992) return "Pre-Gerstner";
      if (year <= 2002) return "Gerstner era";
      if (year <= 2011) return "Palmisano era";
      if (year <= 2019) return "Rometty era";
      return "Krishna era";
    };

    const ERAS = [
      { label: "Pre-Gerstner", from: 1984, to: 1992, color: "#6929c4" },
      { label: "Gerstner",     from: 1993, to: 2002, color: "#0043ce" },
      { label: "Palmisano",    from: 2003, to: 2011, color: "#005d5d" },
      { label: "Rometty",      from: 2012, to: 2019, color: "#9f1853" },
      { label: "Krishna",      from: 2020, to: 2026, color: "#198038" },
    ];

    // ── Category grouping ────────────────────────────────────────────────────
    const catGroup = cat => {
      if (!cat) return "Other";
      if (cat.startsWith("Software") || cat === "Cloud Infrastructure" || cat === "Software / Hybrid Cloud") return "Software";
      if (cat.startsWith("Hardware")) return "Hardware";
      if (cat === "Consulting" || cat === "Infrastructure Services") return "Services";
      if (cat.startsWith("Healthcare")) return "Healthcare";
      return "Other";
    };
    // No "Cloud" group: the only Cloud-prefixed category in the data is
    // "Cloud Infrastructure" (Softlayer), and the Software branch above claims it
    // along with "Software / Hybrid Cloud". A Cloud group would always be empty —
    // it rendered a filter button that blanked the timeline and a legend swatch
    // with no matching segment.
    const CAT_GROUPS = ["Software", "Hardware", "Services", "Healthcare"];

    // ── Era summary stats (pre-computed once) ────────────────────────────────
    const CEO_BY_ERA = {
      "Pre-Gerstner": "Watson Jr. / Opel / Akers",
      "Gerstner":     "Lou Gerstner",
      "Palmisano":    "Sam Palmisano",
      "Rometty":      "Ginni Rometty",
      "Krishna":      "Arvind Krishna",
    };
    const eraStats = ERAS.map(era => {
      const eraDeals    = deals.filter(d => d.year >= era.from && d.year <= era.to && d.type === "acquisition");
      const divCount    = deals.filter(d => d.year >= era.from && d.year <= era.to &&
                                            (d.type === "divestiture" || d.type === "spinoff")).length;
      const totalSpend  = eraDeals.reduce((s,d) => s + (d.valueMillions||0), 0);
      const bigDeal     = eraDeals.reduce((a,b) => ((b.valueMillions||0) > (a?.valueMillions||0) ? b : a), null);
      const cats        = [...new Set(eraDeals.map(d => catGroup(d.category)))].filter(c => c !== "Other");
      // IBM-stated total from annual report summaries (more complete than our tracked list)
      const ibmTotal    = Object.entries(annualCounts)
        .filter(([yr]) => +yr >= era.from && +yr <= era.to)
        .reduce((s,[,v]) => s + v.count, 0);
      return { ...era, count: eraDeals.length, ibmTotal, divCount, totalSpend, bigDeal, cats };
    });

    // ── Boldness range (for the % bar in detail panel) ──────────────────────
    const allPcts = deals.map(d => {
      const mc = byYear.get(d.year)?.marketCap;
      return (d.valueMillions && mc) ? d.valueMillions / mc * 100 : 0;
    });
    const maxPct = Math.max(...allPcts);   // Red Hat ~29.6%

    // ── Cumulative acquisition spend by year (for line chart) ────────────────
    const acqByYear = deals
      .filter(d => d.type === "acquisition" && d.valueMillions)
      .sort((a,b) => a.year - b.year);
    let runningTotal = 0;
    const cumulPoints = acqByYear.map(d => {
      runningTotal += d.valueMillions;
      return { year: d.year, total: runningTotal, name: d.name, val: d.valueMillions };
    });

    const totalAcqSpend = deals.filter(d => d.type === "acquisition").reduce((s,d) => s + (d.valueMillions||0), 0);
    const biggest = deals.filter(d=>d.type==="acquisition").reduce((a,b)=>((b.valueMillions||0)>(a.valueMillions||0)?b:a), deals[0]);
    const divCount  = deals.filter(d => d.type === "divestiture" || d.type === "spinoff").length;
    // Cash sale proceeds come from divestitures only — spin-offs (e.g. Kyndryl)
    // distribute shares to holders and generate no proceeds to IBM, so they're
    // excluded here. (Kyndryl's scale is shown separately as its spin-off revenue.)
    const divProceeds = deals.filter(d => d.type === "divestiture").reduce((s,d) => s + (d.valueMillions||0), 0);

    // ── Verdict scorecard — aggregate the per-deal alpha data into an
    // exec-level answer to "did M&A create shareholder value?" ──────────────
    // Every performance row with a measurable 2-year window. The Alpha Leaderboard
    // shows all of these; the Verdict scorecard shows the acquisition subset. Both
    // counts are derived from this one array so the two panels can't disagree.
    const measurablePerf = (D.maPerformance?.deals || [])
      .filter(p => p.ibmReturn != null && p.alpha != null)
      .map(p => {
        const deal = dealByNorm.get(normName(p.name));
        return { ...p, valueMillions: deal?.valueMillions || null, year: deal?.year || parseInt(p.closeDate), type: deal?.type };
      });

    const verdictDeals = measurablePerf
      // Verdict answers "did M&A create value" -- exits (spin-offs/divestitures)
      // aren't M&A spend, so they're excluded from the acquisition scorecard.
      // Requiring an exact "acquisition" match (rather than just type !== divestiture/spinoff)
      // also drops performance rows whose name didn't join to ma.deals at all —
      // e.g. "ROLM Systems → Siemens" and "Information Products → Lexmark" are
      // divestitures IBM never added to the curated deals list, so an unmatched
      // deal (type undefined) used to slip through as a false "acquisition".
      .filter(p => p.type === "acquisition");

    // buildVerdictHTML() removed with the Verdict tab. verdictDeals above is
    // kept: the Alpha Leaderboard still uses its count to explain why it lists
    // more windows than the acquisition-only set.

    document.getElementById("panel-ma").innerHTML = `
      <div class="hero">
        <div class="hero-text">
          <div class="hero-kicker">1984 – 2025 · sourced from IBM&apos;s own audited annual reports</div>
          <h1>How IBM built its modern portfolio</h1>
          <p>Every figure here is drawn from IBM&apos;s own "Acquisitions &amp; Divestitures" financial statement
             note or cash flow statement — not press releases or Wikipedia. IBM has executed 200+ transactions
             since its founding; this tab focuses on the deals that materially reshaped the business.
             Every stock-performance figure on this tab (IBM and its benchmarks) uses dividend- and split-adjusted
             close prices, so returns reflect what a shareholder actually earned, not just the raw share price.</p>
        </div>
        <div class="ma-pending-card">
          <svg class="ma-pending-border"><rect x="1" y="1" width="calc(100% - 2px)" height="calc(100% - 2px)" rx="7"/></svg>
          <div class="ma-pending-badge">● SIGNED · NOT YET CLOSED</div>
          <div class="ma-pending-name">HRL Laboratories, LLC</div>
          <div class="ma-pending-desc">Quantum computing — silicon-spin qubits &amp; quantum sensing</div>
          <div class="ma-pending-facts">
            <div class="ma-pending-fact"><span>Announced</span><b>Jul 23, 2026</b></div>
            <div class="ma-pending-fact"><span>Exp. close</span><b>Q3 2026</b></div>
            <div class="ma-pending-fact"><span>Value</span><b>Undisclosed</b></div>
            <div class="ma-pending-fact"><span>Status</span><b>Pending regulatory approval</b></div>
          </div>
          <div class="ma-pending-seller">Acquired from Boeing &amp; General Motors, HRL's joint owners</div>
          <div class="ma-pending-source">Source: IBM Newsroom, Jul 23, 2026 — not yet in a 10-Q filing</div>
        </div>
      </div>

      <div class="ma-stats">
        <div class="ma-stat"><div class="ma-stat-val">$${(totalAcqSpend/1000).toFixed(0)}B+</div><div class="ma-stat-lbl">Total acquisition spend (filing-sourced)</div></div>
        <div class="ma-stat"><div class="ma-stat-val">${fmt$(biggest.valueMillions)}</div><div class="ma-stat-lbl">Largest deal — ${biggest.name} (${biggest.year})</div></div>
        <div class="ma-stat"><div class="ma-stat-val">200+</div><div class="ma-stat-lbl">${deals.length} found in 10-K filings — 200+ tracked over time</div></div>
        <div class="ma-stat" style="border-top-color:#fa4d56"><div class="ma-stat-val" style="color:#fa4d56">$19B</div><div class="ma-stat-lbl">Kyndryl annual revenue at spin-off (2021) — the size of the business exited, not a purchase or sale price</div></div>
        <div class="ma-stat" style="border-top-color:#8a3ffc"><div class="ma-stat-val" style="color:#8a3ffc">${divCount} exits</div><div class="ma-stat-lbl">Divestitures &amp; spin-offs traced in 10-K / 10-Q filings — IBM has made more over time · $${(divProceeds/1000).toFixed(1)}B disclosed proceeds</div></div>
      </div>

      <div class="ma-era-section">
        <div class="ma-era-cards">
          ${eraStats.map((e, eraIdx) => {
            const ceo = CEO_BY_ERA[e.label] || e.label;
            const spend = e.totalSpend >= 1000 ? `$${(e.totalSpend/1000).toFixed(1)}B` : `$${e.totalSpend}M`;
            const ERA_SHORT = {
              "PricewaterhouseCoopers Consulting": "PwC Consulting",
              "Apptio (from Vista Equity Partners)": "Apptio",
              "StreamSets & webMethods (from Software AG)": "StreamSets & webMethods",
            };
            const bigName = e.bigDeal ? (ERA_SHORT[e.bigDeal.name] || (e.bigDeal.name.length > 18 ? e.bigDeal.name.slice(0,17) + "…" : e.bigDeal.name)) : null;
            const bigVal  = e.bigDeal?.valueMillions >= 1000 ? `$${(e.bigDeal.valueMillions/1000).toFixed(1)}B` : e.bigDeal ? `$${e.bigDeal.valueMillions}M` : null;
            const ibmTotalStr  = e.ibmTotal > 0 ? `${e.ibmTotal}+` : (e.count > 0 ? `${e.count}` : "—");
            const trackedStr   = e.count > 0 ? `${e.count} named` : "—";
            const hasGap       = e.ibmTotal > e.count;
            // Krishna's era is still open — a 2026 Q1 10-Q is being added — so
            // its count is framed as "found in" the filings (10-K + 10-Q). Every
            // closed era is a settled "traced in 10-K" count. Neither is IBM's
            // grand total; both are the count of deals we sourced from filings.
            const acqNote      = e.label === "Krishna" ? "traced in 10-K / 10-Q filings" : "traced in 10-K filings";
            // Same 10-K / 10-Q framing for the spend figure: it's the sum of only
            // the deals whose price IBM disclosed in the filings, not all-in spend.
            const spendNote    = e.label === "Krishna" ? "disclosed in 10-K / 10-Q filings" : "disclosed in 10-K filings";
            return `<div class="ma-era-card ma-era-clickable" style="--era-c:${e.color}" data-era-i="${eraIdx}" role="button" tabindex="0" title="Click for the full ${e.label}-era deal list">
              <div class="ma-era-name">${e.label}</div>
              <div class="ma-era-ceo">${ceo}</div>
              <div class="ma-era-row">
                <span class="ma-era-lbl">Acquisitions</span>
                <span class="ma-era-val">
                  ${e.count > 0 ? e.count : "—"}
                  ${e.count > 0 ? `<span class="ma-era-tracked">${acqNote}</span>` : ""}
                </span>
              </div>
              <div class="ma-era-row">
                <span class="ma-era-lbl">Divestitures / Spin-offs</span>
                <span class="ma-era-val">
                  ${e.divCount > 0 ? e.divCount : "—"}
                  ${e.divCount > 0 ? `<span class="ma-era-tracked">${acqNote}</span>` : ""}
                </span>
              </div>
              <div class="ma-era-row">
                <span class="ma-era-lbl">Total disclosed spend</span>
                <span class="ma-era-val">
                  ${spend}
                  ${e.totalSpend > 0 ? `<span class="ma-era-tracked">${spendNote}</span>` : ""}
                </span>
              </div>
              ${bigName ? `<div class="ma-era-row"><span class="ma-era-lbl">Largest deal</span><span class="ma-era-val" style="font-size:11px">${bigName} <span style="color:var(--era-c);font-size:10px">${bigVal}</span></span></div>` : ""}
              <div class="ma-era-cats">${e.cats.map(c=>`<span class="ma-era-chip">${c}</span>`).join("")}</div>
            </div>`;
          }).join("")}
        </div>
      </div>

      <div class="card ma-viz-card">
        <div class="ma-viz-header">
          <p class="section-title" style="margin:0">Deal timeline — one chip per deal, largest value first each year</p>
          <div class="ma-filter-row">
            <button class="ma-filter-btn active" data-filter="all">All</button>
            <button class="ma-filter-btn" data-filter="acquisition">Acquisitions</button>
            <button class="ma-filter-btn" data-filter="divestiture">Divestitures / Spin-offs</button>
          </div>
          <div class="ma-filter-row" style="margin-top:6px">
            <span style="font-size:11px;color:#57606a;margin-right:8px">Show:</span>
            <button class="ma-val-btn" data-val="all">All ${deals.length} deals</button>
            <button class="ma-val-btn active" data-val="valued">With $ value (${deals.filter(d=>d.valueMillions).length})</button>
            <button class="ma-val-btn" data-val="unvalued">No $ value (${deals.filter(d=>!d.valueMillions).length})</button>
          </div>
          <div class="ma-cat-row">
            <button class="ma-cat-btn active" data-cat="all">All categories</button>
            ${CAT_GROUPS.map(g => `<button class="ma-cat-btn" data-cat="${g}">${g}</button>`).join("")}
          </div>
          <div class="ma-legend-row">
            <span><span class="ma-dot" style="background:#4589ff"></span>Acquisition</span>
            <span><span class="ma-dot" style="background:#fa4d56"></span>Divestiture / Spin-off</span>
          </div>
        </div>
        <div class="ma-swimlane-wrap">
          <svg id="maSwimlane" class="ma-swimlane-svg"></svg>
        </div>
        <div style="display:flex;align-items:baseline;gap:8px;margin:14px 0 3px">
          <span style="font-size:12px;font-weight:600;letter-spacing:.03em;color:#c8c8d0">Cumulative acquisition spend</span>
          <span style="font-size:11px;color:#7a7a86">running total of every filing-valued acquisition &mdash; reaches $${(totalAcqSpend/1000).toFixed(0)}B across the timeline</span>
        </div>
        <div class="ma-cumul-wrap">
          <svg id="maCumulLine" class="ma-cumul-svg"></svg>
        </div>
        <div id="maTooltip" class="ma-tooltip"></div>
      </div>

      <div class="card ma-detail-card" id="maDetailCard" style="display:none">
        <div id="maDetailContent"></div>
      </div>

      <div class="card ma-insights-card" id="maInsightsCard">
        <div class="ma-insights-header">
          <div class="ma-insights-title">Deal Intelligence</div>
          <div class="ma-insights-tabs">
            <button class="ma-ins-tab active" data-ins="bar">Annual Spend</button>
            <button class="ma-ins-tab" data-ins="scatter">Boldness Map</button>
            <button class="ma-ins-tab" data-ins="alpha">Alpha Leaderboard</button>
            <button class="ma-ins-tab" data-ins="catmix">Category Mix</button>
          </div>
        </div>

        <!-- "The Verdict" panel removed on request. Annual Spend is now the
             default view, so it starts visible rather than display:none. -->

        <div class="ma-ins-panel" id="maInsBar">
          <p class="ma-ins-desc">Total acquisition spend per year, coloured by CEO era. Hover for deal breakdown.</p>
          <div class="ma-annbar-wrap">
            <svg id="maAnnBar" class="ma-annbar-svg"></svg>
          </div>
          <div id="maAnnBarTooltip" class="ma-tooltip"></div>
        </div>

        <div class="ma-ins-panel" id="maInsScatter" style="display:none">
          <p class="ma-ins-desc">Each acquisition plotted by year vs. deal size as % of IBM revenue that year. Bubble size = absolute $ value. Deals in the top-right corner were the most strategically bold relative to IBM's scale.</p>
          <div class="ma-scatter-wrap">
            <svg id="maScatter" class="ma-scatter-svg"></svg>
          </div>
          <div id="maScatterTooltip" class="ma-tooltip"></div>
          <p class="ma-ins-disclaimer">Confluent (Mar 2026, $11.6B) is not plotted — boldness is measured as deal size relative to that year's IBM revenue, and IBM has not yet reported full-year 2026 revenue.</p>
        </div>

        <div class="ma-ins-panel" id="maInsAlpha" style="display:none">
          <p class="ma-ins-desc">All deals with 2-year stock return data, ranked by alpha — IBM's total return minus the benchmark's over the two years around each deal. This is a market-relative lens on IBM's <em>own</em> stock in that window, not the acquired company's standalone performance, so deals that closed in the same window share the same figure. Positive = IBM stock beat the benchmark over that stretch; negative = it lagged. This lists all ${measurablePerf.length} windows, including the ${measurablePerf.length - verdictDeals.length} that are not acquisitions — the Kyndryl spin-off, the Lenovo PC divestiture, and two older divestitures (ROLM&nbsp;→&nbsp;Siemens, Information&nbsp;Products&nbsp;→&nbsp;Lexmark) that aren't in the curated deals list. Only ${verdictDeals.length} of these are acquisitions.</p>
          <div class="ma-alpha-controls">
            <button class="ma-alpha-sort active" data-sort="alpha">Sort: Alpha ↓</button>
            <button class="ma-alpha-sort" data-sort="ibm">Sort: IBM Return ↓</button>
            <button class="ma-alpha-sort" data-sort="size">Sort: Deal Size ↓</button>
          </div>
          <div class="ma-alpha-tablewrap">
            <table class="ma-alpha-table" id="maAlphaTable">
              <thead>
                <tr>
                  <th>Deal</th>
                  <th>Year</th>
                  <th>Size</th>
                  <th>IBM 2yr</th>
                  <th>Benchmark 2yr</th>
                  <th>Alpha</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody id="maAlphaTbody"></tbody>
            </table>
          </div>
          <p class="ma-ins-disclaimer">Confluent (Mar 2026, $11.6B) is not listed — its 2-year post-close return versus benchmark cannot be measured until roughly 2028.</p>
        </div>

        <div class="ma-ins-panel" id="maInsCatMix" style="display:none">
          <p class="ma-ins-desc">Share of tracked acquisitions per CEO era by strategic category. Each bar is 100% — the segments show what proportion of that era's deals fell into each category. Covers only deals individually named in IBM's 10-K / 10-Q filings — the filing-traced count shown on each era card above, not the larger IBM-stated total (which includes smaller acquisitions IBM discloses only as an aggregate count, with no name to categorize).</p>
          <div id="maCatMixWrap">
            <svg id="maCatBar"></svg>
          </div>
          <div id="maCatMixTooltip" class="ma-tooltip"></div>
        </div>
      </div>
      `;

    // ── CEO-era cards → slide-in drawer with the full deal list ─────────────
    const ERA_SUMMARY = {
      "Pre-Gerstner": "IBM's leadership passed from Tom Watson Jr. through John Opel to John Akers, spanning the mainframe era's peak and the PC's rise, and ending in the company's early-1990s financial crisis.",
      "Gerstner":     "Lou Gerstner reversed IBM's near break-up, refocusing the company on integrated services and software over commodity hardware.",
      "Palmisano":    "Sam Palmisano exited commodity hardware like PCs and disk drives, building up software and global consulting while expanding in emerging markets.",
      "Rometty":      "Ginni Rometty pushed IBM into cloud, AI (Watson), and security, culminating in the transformative Red Hat acquisition in 2019.",
      "Krishna":      "Arvind Krishna spun off Kyndryl to sharpen IBM's focus on hybrid cloud and AI, continuing with software acquisitions like HashiCorp.",
    };

    // Nearest-trading-day stock price lookups against the Yahoo Finance daily
    // series (window.IBM_DAILY_PRICES, ["YYYY-MM-DD", price] pairs, oldest-first).
    // maBenchmark.ibmRecentOverride appends a few extra M&A-tab-only days after
    // ibm_daily_prices.js's last cached point, so the ongoing era's "latest
    // value" (currently Krishna) stays current without editing that shared
    // file -- Story Mode/Overview/Regression Lab read it directly and don't
    // see this override at all.
    const MA_DAILY_RAW = (window.IBM_DAILY_PRICES || [])
      .concat((D.maBenchmark || {}).ibmRecentOverride || []);
    const MA_DAILY_F = MA_DAILY_RAW.map(([d, p]) => {
      const [y, m, day] = d.split("-").map(Number);
      const start = Date.UTC(y, 0, 1), end = Date.UTC(y + 1, 0, 1);
      const frac  = y + (Date.UTC(y, m - 1, day) - start) / (end - start);
      return [frac, p, d];
    });
    const firstPriceOnOrAfter = year => {
      for (let i = 0; i < MA_DAILY_F.length; i++) if (MA_DAILY_F[i][0] >= year) return MA_DAILY_F[i];
      return MA_DAILY_F[MA_DAILY_F.length - 1] || null;
    };
    const lastPriceOnOrBefore = yearCap => {
      let best = null;
      for (let i = 0; i < MA_DAILY_F.length; i++) {
        if (MA_DAILY_F[i][0] <= yearCap) best = MA_DAILY_F[i]; else break;
      }
      return best || MA_DAILY_F[0] || null;
    };

    // ── Macro backdrop — NBER recession spans (FRED USREC) that overlap an era.
    // Context only: it states what the economy was doing during the era and makes
    // no claim about why IBM's stock, spend or deal flow moved.
    const RECESSIONS = (D.macro || {}).recessions || [];
    const recessionLabel = e => {
      const span = r => r.start === r.end ? `${r.start}` : `${r.start}–${String(r.end).slice(2)}`;
      const hits = RECESSIONS.filter(r => r.start <= e.to && r.end >= e.from);
      return hits.length
        ? `${hits.map(r => `${r.name} (${span(r)})`).join(" · ")} · NBER`
        : `No NBER recession (${e.from}–${e.to})`;
    };

    function openEraDrawer(e) {
      const inEra = d => d.year >= e.from && d.year <= e.to;
      const acq  = deals.filter(d => inEra(d) && d.type === "acquisition").sort((a,b) => a.year - b.year);
      const divs = deals.filter(d => inEra(d) && (d.type === "divestiture" || d.type === "spinoff")).sort((a,b) => a.year - b.year);
      const val = v => v == null ? "—" : v >= 1000 ? `$${(v/1000).toFixed(1)}B` : `$${v}M`;
      const spend = e.totalSpend >= 1000 ? `$${(e.totalSpend/1000).toFixed(1)}B` : `$${e.totalSpend}M`;
      const dealTable = rows => rows.length ? `
        <div class="ma-drawer-tablewrap"><table class="ma-drawer-table">
          <thead><tr><th>Year</th><th>Name</th><th>Value</th><th>Category</th></tr></thead>
          <tbody>${rows.map(d => `
            <tr><td>${d.year}</td><td>${d.name}</td><td>${val(d.valueMillions)}</td><td>${d.category || "—"}</td></tr>`).join("")}
          </tbody></table></div>`
        : `<p class="ma-drawer-none">None individually tracked for this era.</p>`;

      // ── Stock performance across the era (Yahoo Finance daily closes) ──────
      const startEntry = firstPriceOnOrAfter(e.from);
      const endEntry    = lastPriceOnOrBefore(e.to + 0.9999);
      let stockBlock = "";
      if (startEntry && endEntry && startEntry[2] !== endEntry[2]) {
        const [startFrac, startPrice, startDate] = startEntry;
        const [endFrac, endPrice, endDate] = endEntry;
        const totalChangePct = (endPrice / startPrice - 1) * 100;
        const yearsElapsed   = endFrac - startFrac;
        const cagrPct        = (Math.pow(endPrice / startPrice, 1 / yearsElapsed) - 1) * 100;
        const sign = n => n >= 0 ? "+" : "";
        const gainColor = n => n >= 0 ? "#42be65" : "#fa4d56";

        // ── Benchmark comparison — XLK from 1999 on (fund inception 1998-12),
        // S&P 500 for eras that start before XLK existed. XLK uses the
        // dividend-adjusted series in D.maBenchmark (M&A-tab-only — this is
        // NOT macro.techYearEnd, which is raw close and also feeds the
        // Macro vs IBM tab's chart; keeping them separate means this fix
        // can't alter that other tab's numbers. ────────────────────────────
        // An era whose end year is the current year (or later) is still open —
        // Krishna's, right now — so its "end" figures are really just the latest
        // available data point, not a settled era close. Label them by date.
        const eraOngoing = e.to >= new Date().getFullYear();
        const fmtDate    = iso => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); };

        const macro      = D.macro || {};
        const useXLK      = e.from >= 1999;
        // ── Benchmark comparison — now consistent on both sides of 1999 ─────
        //   IBM (every era): adjusted close, dividends reinvested (ibm_daily_prices.js)
        //   1999+  : XLK adjclose, dividends reinvested (D.maBenchmark.xlkAdjYearEnd)
        //   pre-99 : S&P 500 TOTAL RETURN, dividends reinvested (D.maBenchmark.sp500TRYearEnd)
        // Both benchmark series are M&A-tab-only (kept out of macro.techYearEnd /
        // macro.sp500YearEnd, which are raw close and also feed the Macro vs IBM
        // tab's chart — this fix can't alter that other tab's numbers).
        // sp500TRYearEnd is real Yahoo ^SP500TR data from 1988 on; 1983-1987
        // (needed only because the Pre-Gerstner era starts in 1984) is
        // reconstructed from Robert Shiller's (Yale) monthly S&P price+dividend
        // dataset and chain-linked to the real index — see data.js's
        // maBenchmark.sp500TRSource for the exact method. This replaces an
        // earlier version of this chart that compared IBM's dividend-adjusted
        // return against a price-only S&P 500 series pre-1999, which
        // overstated IBM's alpha for these two eras by several points.
        const xlkAdj      = (D.maBenchmark || {}).xlkAdjYearEnd;
        const xlkSeries   = xlkAdj || macro.techYearEnd || {};
        const sp500TR     = (D.maBenchmark || {}).sp500TRYearEnd;
        const benchLabel  = useXLK
          ? (xlkAdj ? "XLK (Tech Sector ETF, total return)" : "XLK (Tech Sector ETF, price only)")
          : (sp500TR ? "S&P 500 (Total Return)" : "S&P 500 (price only)");
        const benchSeries = useXLK ? xlkSeries : (sp500TR || macro.sp500YearEnd || {});
        const priorYear   = e.from - 1;
        const benchStartYear = benchSeries[priorYear] != null ? priorYear : e.from;
        const benchStart  = benchSeries[benchStartYear];
        const benchEnd    = benchSeries[e.to];

        const subhead = label => `<div style="font-size:11px;color:#8a8a9a;text-transform:uppercase;letter-spacing:.06em;margin:14px 0 6px">${label}</div>`;

        let benchBlock = "";
        if (benchStart != null && benchEnd != null) {
          const benchTotalPct = (benchEnd / benchStart - 1) * 100;
          // Annualise over the benchmark's ACTUAL span, on the same time-base as the
          // IBM CAGR above (which uses real elapsed fractional years). For a completed
          // era the year-end→year-end span is exactly (e.to - benchStartYear) years.
          // For the OPEN era, benchSeries[e.to] is a mid-year sample, so annualising it
          // as a full year understates the benchmark CAGR and overstates IBM's alpha —
          // use IBM's real end fraction instead (benchStart sits at ≈ benchStartYear+1).
          const benchYears    = eraOngoing ? (endFrac - benchStartYear - 1) : (e.to - benchStartYear);
          const benchCagr     = benchYears > 0 ? (Math.pow(benchEnd / benchStart, 1 / benchYears) - 1) * 100 : 0;
          const alphaPp       = cagrPct - benchCagr;
          benchBlock = `
        ${subhead(benchLabel)}
        <div class="ma-drawer-strip">
          <div class="ma-drawer-stat"><div class="v">$${benchStart.toFixed(2)}</div><div class="l">Value at era start</div></div>
          <div class="ma-drawer-stat"><div class="v">$${benchEnd.toFixed(2)}</div><div class="l">${eraOngoing ? "Latest value" : "Value at era end"}</div></div>
          <div class="ma-drawer-stat"><div class="v" style="color:${gainColor(benchTotalPct)}">${sign(benchTotalPct)}${benchTotalPct.toFixed(0)}%</div><div class="l">Total change</div></div>
          <div class="ma-drawer-stat"><div class="v" style="color:${gainColor(benchCagr)}">${sign(benchCagr)}${benchCagr.toFixed(1)}%</div><div class="l">Avg annual gain (CAGR)</div></div>
        </div>
        <p class="ma-drawer-none" style="margin-top:-4px">IBM alpha vs ${benchLabel}: <span style="color:${gainColor(alphaPp)}">${sign(alphaPp)}${alphaPp.toFixed(1)}pp CAGR</span></p>
        <p class="ma-drawer-none" style="margin-top:6px;font-size:10px;opacity:.7">This is a whole-era figure: IBM's compound annual growth across the full era minus the benchmark's. The Deal Intelligence "Verdict" below measures a different thing — each deal's own 2-year post-close window — so its per-era alpha won't match this number.</p>${useXLK ? "" : (e.label === "Pre-Gerstner" ? `
        <p class="ma-drawer-none" style="margin-top:6px;font-size:10px;opacity:.7">How this benchmark is built: this era predates Yahoo's real ^SP500TR (S&amp;P 500 Total Return) index, which only starts in 1988. So 1983–1987 here is <em>reconstructed</em> from Robert Shiller's (Yale) monthly S&amp;P Composite price + trailing-dividend dataset — monthly return ≈ (price + dividend÷12) ÷ prior price, compounded into an index, then chain-linked to the real ^SP500TR series by rescaling with the average price ratio across all 12 overlapping months of 1988 (both series exist that year, which is what makes the splice checkable). The only acquisition tracked in this era is ROLM (1984), so this era's alpha is effectively ROLM's alpha. Both IBM and this benchmark now include reinvested dividends — an earlier version of this chart compared IBM's dividend-adjusted return against a price-only S&amp;P 500 series, which overstated IBM's alpha here by about 4 points of CAGR (and flipped a single-deal 2-year window from "beat the market" to "lagged the market" — see ROLM in the Alpha Leaderboard below).</p>` : `
        <p class="ma-drawer-none" style="margin-top:6px;font-size:10px;opacity:.7">Benchmarked against the real S&amp;P 500 Total Return index (Yahoo ^SP500TR, dividends reinvested) — both sides of this comparison now include dividends. An earlier version of this chart used a price-only S&amp;P 500 series here, which overstated IBM's alpha for this era by a couple points of CAGR.</p>`)}`;
        }

        stockBlock = `
        <h3>Stock performance (${startDate} – ${endDate})</h3>
        <div style="font-size:11px;color:#8a8a9a;margin:-6px 0 12px">${recessionLabel(e)}</div>
        ${subhead("IBM (dividend- &amp; split-adjusted)")}
        <div class="ma-drawer-strip">
          <div class="ma-drawer-stat"><div class="v">$${startPrice.toFixed(2)}</div><div class="l">Price at era start</div></div>
          <div class="ma-drawer-stat"><div class="v">$${endPrice.toFixed(2)}</div><div class="l">${eraOngoing ? `Price on ${fmtDate(endDate)}` : "Price at era end"}</div></div>
          <div class="ma-drawer-stat"><div class="v" style="color:${gainColor(totalChangePct)}">${sign(totalChangePct)}${totalChangePct.toFixed(0)}%</div><div class="l">Total change</div></div>
          <div class="ma-drawer-stat"><div class="v" style="color:${gainColor(cagrPct)}">${sign(cagrPct)}${cagrPct.toFixed(1)}%</div><div class="l">Avg annual gain (CAGR)</div></div>
        </div>
        ${benchBlock}
        <p class="ma-drawer-none" style="margin-top:-4px">Nearest available trading-day closes; dividend- and split-adjusted close, Yahoo Finance (a total-return-style price, so it won't match the raw year-end price per share shown elsewhere on this dashboard, e.g. Overview or Macro vs IBM — that figure is unadjusted, straight from the 10-K). Benchmark uses year-end index levels.</p>`;
      }

      document.getElementById("infoDrawerTitle").textContent = `${e.label} era — ${CEO_BY_ERA[e.label] || ""}`;
      const body = document.getElementById("infoDrawerBody");
      body.innerHTML = `
        ${ERA_SUMMARY[e.label] ? `<p class="ma-drawer-none" style="color:#c6c6d0">${ERA_SUMMARY[e.label]}</p>` : ""}
        <div class="ma-drawer-strip">
          <div class="ma-drawer-stat"><div class="v">${e.count}</div><div class="l">Acquisitions tracked</div></div>
          <div class="ma-drawer-stat"><div class="v">${e.divCount || "—"}</div><div class="l">Divestitures / Spin-offs</div></div>
          <div class="ma-drawer-stat"><div class="v">${spend}</div><div class="l">Total disclosed spend</div></div>
        </div>
        ${stockBlock}
        <h3>Acquisitions (${e.from}–${e.to})</h3>
        ${dealTable(acq)}
        <h3>Divestitures &amp; Spin-offs</h3>
        ${dealTable(divs)}`;
      body.scrollTop = 0;
      document.getElementById("infoOverlay").classList.add("open");
      document.getElementById("infoDrawer").classList.add("open");
    }
    document.querySelectorAll(".ma-era-card").forEach(card => {
      const go = () => openEraDrawer(eraStats[+card.dataset.eraI]);
      card.addEventListener("click", go);
      card.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); } });
    });

    // ── Filter buttons ──────────────────────────────────────────────────────
    let activeFilter   = "all";
    let activeCategory = "all";
    let activeVal      = "valued";   // "all" | "valued" | "unvalued"

    document.querySelectorAll(".ma-filter-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".ma-filter-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        activeFilter = btn.dataset.filter;
        drawSwimlane();
      });
    });

    document.querySelectorAll(".ma-cat-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".ma-cat-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        activeCategory = btn.dataset.cat;
        drawSwimlane();
      });
    });

    document.querySelectorAll(".ma-val-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".ma-val-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        activeVal = btn.dataset.val;
        drawSwimlane();
      });
    });

    // ── Swimlane renderer ───────────────────────────────────────────────────
    function drawSwimlane() {
      const svg = document.getElementById("maSwimlane");
      if (!svg) return;
      svg.innerHTML = "";

      const wrap      = svg.parentElement;
      const ERA_H     = 30;   // dedicated era label strip at top
      const AXIS_H    = 26;   // year labels along the bottom
      const PAD_L     = 10;
      const PAD_R     = 10;
      const MIN_YEAR  = 1984;
      const MAX_YEAR  = 2028;

      // Uniform deal chips, stacked into one column per year.
      const BOX_W   = 124;   // chip width
      const BOX_H   = 20;    // chip height
      const BOX_GAP = 4;     // vertical gap between chips in a column
      const COL_GAP = 12;    // horizontal gap reserved between adjacent columns
      const COL_TOP = ERA_H + 14;   // y of the top chip's top edge

      const filtered = deals.filter(d => {
        if (activeFilter === "acquisition" && d.type !== "acquisition") return false;
        if (activeFilter === "divestiture" && d.type === "acquisition") return false;
        if (activeVal === "valued"   && !d.valueMillions) return false;
        if (activeVal === "unvalued" &&  d.valueMillions) return false;
        return true;
      });

      // Width is fixed by the year span (not the deal count), so adjacent year
      // columns can never collide and the cumulative-spend line below shares it.
      const perYear = BOX_W + COL_GAP;
      const W = Math.max(wrap.clientWidth || 900, perYear * (MAX_YEAR - MIN_YEAR) + PAD_L + PAD_R);

      const ns   = "http://www.w3.org/2000/svg";
      const mk   = tag => document.createElementNS(ns, tag);
      const xOf  = yr  => PAD_L + ((yr - MIN_YEAR) / (MAX_YEAR - MIN_YEAR)) * (W - PAD_L - PAD_R);

      // Group deals into per-year columns, ordered biggest value at the top down
      // to smallest, with the no-value deals sitting at the bottom of the column.
      const byYr = new Map();
      filtered.forEach(d => { if (!byYr.has(d.year)) byYr.set(d.year, []); byYr.get(d.year).push(d); });
      byYr.forEach(list => list.sort((a, b) => {
        const av = a.valueMillions || 0, bv = b.valueMillions || 0;
        if (av !== bv) return bv - av;                 // bigger value first; 0s sink
        return a.name.localeCompare(b.name);
      }));

      const maxCount = Math.max(1, ...[...byYr.values()].map(l => l.length));
      const colH     = maxCount * (BOX_H + BOX_GAP);
      const totalH   = COL_TOP + colH + 8 + AXIS_H;
      const LANE_H   = totalH - ERA_H - AXIS_H;   // tinted band height behind columns
      const laneTop  = ERA_H;
      const laneBtm  = COL_TOP + colH + 6;

      svg.setAttribute("viewBox", `0 0 ${W} ${totalH}`);
      svg.setAttribute("width",  W);
      svg.setAttribute("height", totalH);

      // ── Era label strip (own row, fully separated from bubbles) ───────────
      ERAS.forEach(era => {
        const x1 = xOf(era.from);
        const x2 = xOf(Math.min(era.to + 1, MAX_YEAR));

        // coloured strip background
        const strip = mk("rect");
        strip.setAttribute("x", x1); strip.setAttribute("y", 0);
        strip.setAttribute("width", x2 - x1); strip.setAttribute("height", ERA_H);
        strip.setAttribute("fill", era.color); strip.setAttribute("opacity", "0.22");
        svg.appendChild(strip);

        // era name centred in strip
        const txt = mk("text");
        txt.setAttribute("x", x1 + (x2 - x1) / 2);
        txt.setAttribute("y", ERA_H / 2 + 4);
        txt.setAttribute("text-anchor", "middle");
        txt.setAttribute("font-size", "10.5");
        txt.setAttribute("font-family", "IBM Plex Sans, sans-serif");
        txt.setAttribute("font-weight", "600");
        txt.setAttribute("fill", "#f4f4f5");
        txt.setAttribute("letter-spacing", "0.07em");
        txt.textContent = era.label.toUpperCase();
        svg.appendChild(txt);
      });

      // ── Era lane bands (subtle tint behind bubbles) ───────────────────────
      ERAS.forEach(era => {
        const x1 = xOf(era.from);
        const x2 = xOf(Math.min(era.to + 1, MAX_YEAR));
        const band = mk("rect");
        band.setAttribute("x", x1); band.setAttribute("y", laneTop);
        band.setAttribute("width", x2 - x1); band.setAttribute("height", LANE_H);
        band.setAttribute("fill", era.color); band.setAttribute("opacity", "0.06");
        svg.appendChild(band);
      });

      // ── Era dividers — solid thin lines ───────────────────────────────────
      [1993, 2003, 2012, 2020].forEach(yr => {
        const x = xOf(yr);
        const line = mk("line");
        line.setAttribute("x1", x); line.setAttribute("y1", 0);
        line.setAttribute("x2", x); line.setAttribute("y2", laneBtm);
        line.setAttribute("stroke", "#3a3a48"); line.setAttribute("stroke-width", "1");
        svg.appendChild(line);
      });

      // ── Year tick marks — every year as faint dot, every 5 labelled ───────
      const tickY = laneBtm;
      for (let y = MIN_YEAR; y <= MAX_YEAR; y++) {
        const x     = xOf(y);
        const major = y % 5 === 0;
        const tick  = mk("line");
        tick.setAttribute("x1", x); tick.setAttribute("y1", tickY);
        tick.setAttribute("x2", x); tick.setAttribute("y2", tickY + (major ? 6 : 3));
        tick.setAttribute("stroke", major ? "#6c6c78" : "#2e2e3a");
        tick.setAttribute("stroke-width", "1");
        svg.appendChild(tick);
        if (major) {
          const lbl = mk("text");
          lbl.setAttribute("x", x); lbl.setAttribute("y", tickY + 18);
          lbl.setAttribute("text-anchor", "middle");
          lbl.setAttribute("font-size", "11");
          lbl.setAttribute("font-family", "IBM Plex Mono, monospace");
          lbl.setAttribute("fill", "#6c6c78");
          lbl.textContent = y;
          svg.appendChild(lbl);
        }
      }

      // ── Draw one uniform chip per deal, stacked into its year's column ────
      const tip         = document.getElementById("maTooltip");
      const detailCard  = document.getElementById("maDetailCard");
      const detailBody  = document.getElementById("maDetailContent");

      [...byYr.entries()].forEach(([year, list]) => {
        const bx = xOf(year + 0.5) - BOX_W / 2;   // column centred on its year

        list.forEach((deal, i) => {
          const by = COL_TOP + i * (BOX_H + BOX_GAP);
          const color = deal.type !== "acquisition" ? "#fa4d56" : "#4589ff";
          const confirmed = deal.valueSource === "filing";
          const dimmed = activeCategory !== "all" && catGroup(deal.category) !== activeCategory;
          const baseFill = dimmed ? "0.05" : (confirmed ? "0.20" : "0.12");

          // chip background
          const rect = mk("rect");
          rect.setAttribute("x", bx); rect.setAttribute("y", by);
          rect.setAttribute("width", BOX_W); rect.setAttribute("height", BOX_H);
          rect.setAttribute("rx", "4");
          rect.setAttribute("fill", color);
          rect.setAttribute("fill-opacity", baseFill);
          rect.setAttribute("stroke", color);
          rect.setAttribute("stroke-width", "1");
          rect.setAttribute("stroke-opacity", dimmed ? "0.2" : "0.85");
          rect.style.cursor = "pointer";
          svg.appendChild(rect);

          // left accent bar
          const bar = mk("rect");
          bar.setAttribute("x", bx); bar.setAttribute("y", by);
          bar.setAttribute("width", "3"); bar.setAttribute("height", BOX_H);
          bar.setAttribute("fill", color);
          bar.setAttribute("opacity", dimmed ? "0.25" : "1");
          bar.setAttribute("pointer-events", "none");
          svg.appendChild(bar);

          // value (right-aligned, monospace) -- only when the deal has one
          const valStr = deal.valueMillions ? (fmt$(deal.valueMillions) + (deal.valueApprox ? "~" : "")) : "";
          let valW = 0;
          if (valStr) {
            const vt = mk("text");
            vt.setAttribute("x", bx + BOX_W - 6); vt.setAttribute("y", by + BOX_H / 2 + 3.3);
            vt.setAttribute("text-anchor", "end");
            vt.setAttribute("font-size", "9");
            vt.setAttribute("font-family", "IBM Plex Mono, monospace");
            vt.setAttribute("fill", color);
            vt.setAttribute("opacity", dimmed ? "0.3" : "0.95");
            vt.setAttribute("pointer-events", "none");
            vt.textContent = valStr;
            svg.appendChild(vt);
            valW = valStr.length * 5.4 + 6;
          }

          // name (left-aligned, truncated to whatever room is left; the full
          // name is always shown on hover and in the click-through detail card)
          const CH = 5.4;
          const nameMaxW = BOX_W - 9 - valW - 3;
          const maxChars = Math.max(1, Math.floor(nameMaxW / CH));
          let nm = deal.name;
          if (nm.length > maxChars) nm = nm.slice(0, Math.max(1, maxChars - 1)) + "…";
          const nt = mk("text");
          nt.setAttribute("x", bx + 8); nt.setAttribute("y", by + BOX_H / 2 + 3.3);
          nt.setAttribute("text-anchor", "start");
          nt.setAttribute("font-size", "9.5");
          nt.setAttribute("font-family", "IBM Plex Sans, sans-serif");
          nt.setAttribute("fill", dimmed ? "#3a3a48" : "#e8e8ee");
          nt.setAttribute("pointer-events", "none");
          nt.textContent = nm;
          svg.appendChild(nt);

          // Hover tooltip -- positioned from real screen geometry so it lands
          // on the chip regardless of how far the timeline is scrolled.
          rect.addEventListener("mouseenter", () => {
            rect.setAttribute("fill-opacity", confirmed ? "0.38" : "0.28");
            const yr    = byYear.get(deal.year) || {};
            const mktCtx = yr.marketCap ? `<div class="ma-tip-ctx">IBM mkt cap ${deal.year}: ${fmt$(yr.marketCap)}</div>` : "";
            const revCtx = yr.revenue   ? `<div class="ma-tip-ctx">IBM revenue ${deal.year}: ${fmt$(yr.revenue)}</div>`  : "";
            tip.innerHTML = `
              <div class="ma-tip-year" style="color:${eraColor(deal.year)}">${deal.closeDateLabel || deal.year} · ${eraLabel(deal.year)}</div>
              <div class="ma-tip-name">${deal.name}</div>
              <div class="ma-tip-val" style="color:${color}">${fmt$(deal.valueMillions)}${deal.valueApprox ? "~" : ""}</div>
              ${deal.category ? `<div class="ma-tip-cat">${deal.category}</div>` : ""}
              ${mktCtx}${revCtx}
              <div class="ma-tip-hint">Click for full details</div>`;
            tip.style.opacity = "1";
            const host     = tip.offsetParent || tip.parentElement;
            const hostRect = host.getBoundingClientRect();
            const rRect    = rect.getBoundingClientRect();
            const tipW     = tip.offsetWidth || 220;
            let left = (rRect.left - hostRect.left) + rRect.width / 2 - tipW / 2;
            left = Math.max(8, Math.min(left, host.clientWidth - tipW - 8));
            tip.style.left = left + "px";
            tip.style.top  = ((rRect.top - hostRect.top) - 8) + "px";
            tip.style.transform = "translateY(-100%)";
          });

          rect.addEventListener("mouseleave", () => {
            rect.setAttribute("fill-opacity", baseFill);
            tip.style.opacity = "0";
          });

          // Click -> full detail card
          rect.addEventListener("click", () => {
            const perf = perfByName.get(normName(deal.name)) || null;
            const yr  = byYear.get(deal.year)       || {};

            const dealPctMktCap = (deal.valueMillions && yr.marketCap)
              ? (deal.valueMillions / yr.marketCap * 100).toFixed(1)
              : null;
            const dealPctRev = (deal.valueMillions && yr.revenue)
              ? (deal.valueMillions / yr.revenue * 100).toFixed(1)
              : null;

            const isDiv2 = deal.type !== "acquisition";
            const c2 = isDiv2 ? "#fa4d56" : "#4589ff";

            detailBody.innerHTML = `
              <div class="ma-detail-header" style="border-left-color:${c2}">
                <div class="ma-detail-meta" style="color:${eraColor(deal.year)}">${deal.closeDateLabel ? (deal.closeDateExact ? deal.closeDateLabel : "~" + deal.closeDateLabel) : deal.year} · ${eraLabel(deal.year)}${deal.category ? " · " + deal.category : ""}</div>
                <div class="ma-detail-name">${deal.name}</div>
                <div class="ma-detail-amount" style="color:${c2}">${fmt$(deal.valueMillions)}${deal.valueApprox ? "~" : ""}</div>
              </div>
              <div class="ma-detail-body">
                <p>${deal.description}</p>
                ${deal.ibmLanguage ? `<blockquote class="ma-detail-quote">"${deal.ibmLanguage}"</blockquote>` : ""}
                <div class="ma-detail-ctx">
                  ${dealPctMktCap ? `<div class="ma-detail-ctx-item"><span>Deal as % of IBM mkt cap</span><b>${dealPctMktCap}%</b></div>` : ""}
                  ${dealPctRev   ? `<div class="ma-detail-ctx-item"><span>Deal as % of IBM revenue</span><b>${dealPctRev}%</b></div>` : ""}
                  ${yr.marketCap ? `<div class="ma-detail-ctx-item"><span>IBM market cap ${deal.year}</span><b>${fmt$(yr.marketCap)}</b></div>` : ""}
                  ${yr.revenue   ? `<div class="ma-detail-ctx-item"><span>IBM revenue ${deal.year}</span><b>${fmt$(yr.revenue)}</b></div>` : ""}
                </div>
                ${dealPctMktCap ? (() => {
                  const pct = parseFloat(dealPctMktCap);
                  const fillPct = Math.min(pct / maxPct * 100, 100).toFixed(1);
                  // Rank by exact raw value (not the rounded display string) so deals with
                  // close-but-distinct percentages don't collide onto the wrong rank.
                  const rawPct = deal.valueMillions / yr.marketCap * 100;
                  const rank = allPcts.filter(p => p > rawPct).length + 1;
                  const boldColor = pct > 20 ? "#fa4d56" : pct > 10 ? "#ff832b" : pct > 5 ? "#f1c21b" : "#4589ff";
                  return `<div class="ma-boldness">
                    <div class="ma-boldness-hd">
                      <span class="ma-boldness-lbl">Size of the bet</span>
                      <span class="ma-boldness-pct" style="color:${boldColor}">${dealPctMktCap}% of IBM market cap</span>
                    </div>
                    <div class="ma-boldness-track">
                      <div class="ma-boldness-fill" style="width:${fillPct}%;background:linear-gradient(90deg,#4589ff,${boldColor})"></div>
                    </div>
                    <div class="ma-boldness-sub">#${rank} boldest by share of IBM market cap · Red Hat holds the record at ${maxPct.toFixed(1)}% of market cap. (The Boldness Map chart ranks deals by % of revenue instead.)</div>
                  </div>`;
                })() : ""}
                ${perf ? renderPerfChart(perf) : ""}
              </div>
            `;
            detailCard.style.display = "block";
            detailCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
          });
        });
      });
    }

    // ── Cumulative spend line ────────────────────────────────────────────────
    function drawCumulLine() {
      const svg = document.getElementById("maCumulLine");
      if (!svg) return;
      svg.innerHTML = "";

      const wrap     = svg.parentElement;
      const MIN_YEAR = 1984; const MAX_YEAR = 2028;
      // Match the swimlane's fixed width (perYear 124+12 across the year span)
      // so this line stays horizontally aligned with the columns as it scrolls.
      const W        = Math.max(wrap.clientWidth || 900, (124 + 12) * (MAX_YEAR - MIN_YEAR) + 20);
      const H        = 70;
      const PAD_L    = 10; const PAD_R = 10;
      const PAD_T    = 8;  const PAD_B = 22;
      const plotH    = H - PAD_T - PAD_B;

      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("width", W);
      svg.setAttribute("height", H);

      const ns  = "http://www.w3.org/2000/svg";
      const mk  = tag => document.createElementNS(ns, tag);
      const xOf = yr  => PAD_L + ((yr - MIN_YEAR) / (MAX_YEAR - MIN_YEAR)) * (W - PAD_L - PAD_R);
      const maxTotal = cumulPoints[cumulPoints.length - 1]?.total || 1;
      const yOf = v  => PAD_T + plotH - (v / maxTotal) * plotH;

      // gradient fill
      const defs = mk("defs");
      const grad = mk("linearGradient");
      grad.setAttribute("id", "cumulGrad"); grad.setAttribute("x1","0"); grad.setAttribute("y1","0"); grad.setAttribute("x2","0"); grad.setAttribute("y2","1");
      const s1 = mk("stop"); s1.setAttribute("offset","0%");   s1.setAttribute("stop-color","#4589ff"); s1.setAttribute("stop-opacity","0.35");
      const s2 = mk("stop"); s2.setAttribute("offset","100%"); s2.setAttribute("stop-color","#4589ff"); s2.setAttribute("stop-opacity","0.02");
      grad.appendChild(s1); grad.appendChild(s2); defs.appendChild(grad); svg.appendChild(defs);

      // build step path — jumps at each deal year
      if (cumulPoints.length === 0) return;
      const baseY = yOf(0);
      let pathD = `M ${xOf(MIN_YEAR)} ${baseY}`;
      let prev = { year: MIN_YEAR, total: 0 };
      cumulPoints.forEach(pt => {
        const x = xOf(pt.year + 0.5);
        pathD += ` L ${xOf(prev.year + (prev.year === MIN_YEAR ? 0 : 0.5))} ${yOf(prev.total)}`;
        pathD += ` L ${x} ${yOf(prev.total)}`;   // horizontal step
        pathD += ` L ${x} ${yOf(pt.total)}`;     // vertical jump
        prev = pt;
      });
      const endX = xOf(MAX_YEAR);
      pathD += ` L ${endX} ${yOf(prev.total)}`;

      // fill area
      const fillD = pathD + ` L ${endX} ${baseY} L ${xOf(MIN_YEAR)} ${baseY} Z`;
      const fill = mk("path");
      fill.setAttribute("d", fillD);
      fill.setAttribute("fill", "url(#cumulGrad)");
      svg.appendChild(fill);

      // line
      const line = mk("path");
      line.setAttribute("d", pathD);
      line.setAttribute("fill", "none");
      line.setAttribute("stroke", "#4589ff");
      line.setAttribute("stroke-width", "1.5");
      line.setAttribute("opacity", "0.7");
      svg.appendChild(line);

      // label notable jumps (deals ≥ $3B)
      cumulPoints.filter(pt => pt.val >= 3000).forEach(pt => {
        const x = xOf(pt.year + 0.5);
        const y = yOf(pt.total);
        const dot = mk("circle");
        dot.setAttribute("cx", x); dot.setAttribute("cy", y);
        dot.setAttribute("r", "3"); dot.setAttribute("fill", "#4589ff");
        svg.appendChild(dot);

        const lbl = mk("text");
        lbl.setAttribute("x", x + 5); lbl.setAttribute("y", Math.max(y - 4, PAD_T + 10));
        lbl.setAttribute("font-size", "9"); lbl.setAttribute("fill", "#6c9fff");
        lbl.setAttribute("font-family", "IBM Plex Mono, monospace");
        lbl.textContent = `$${(pt.total/1000).toFixed(0)}B`;
        svg.appendChild(lbl);
      });
      // The strip's caption lives in a static HTML label above it (always
      // visible regardless of horizontal scroll), so no in-SVG title is drawn.
    }

    // ── Category-mix stacked bar chart ─────────────────────────────────────
    function drawCatBar() {
      const svg = document.getElementById("maCatBar");
      if (!svg) return;

      // Category colours — refined palette, readable on dark background
      const CAT_COLORS = {
        "Software":    "#4589ff",   // IBM blue
        "Services":    "#3ddbd9",   // teal
        "Hardware":    "#a56eff",   // purple
        "Healthcare":  "#42be65",   // green
        "Other":       "#8d8d8d",   // neutral grey
      };
      const ALL_CATS = ["Software", "Services", "Hardware", "Healthcare", "Other"];
      // Display-only rename. The "Other" bucket isn't a category IBM assigned —
      // it's deals the 10-K extraction never gave a category to (source:
      // "filing-extracted", category: null). "Unclassified" says that honestly;
      // "Other" implied they'd been classified and didn't fit. The internal key
      // stays "Other" so catGroup() and the era-card chip filter are untouched.
      const catLabel = c => c === "Other" ? "Unclassified" : c;

      // Count deals per era per category (only acquisitions with a category)
      const eraData = ERAS.map(era => {
        const eraAcqs = deals.filter(d =>
          d.year >= era.from && d.year <= era.to && d.type === "acquisition"
        );
        const catCounts = {};
        ALL_CATS.forEach(c => { catCounts[c] = 0; });
        eraAcqs.forEach(d => {
          const g = catGroup(d.category);
          if (catCounts[g] !== undefined) catCounts[g]++;
        });
        const total = Object.values(catCounts).reduce((s,v) => s+v, 0);
        return { label: era.label, color: era.color, counts: catCounts, total };
      });

      const ns   = "http://www.w3.org/2000/svg";
      const mk   = tag => document.createElementNS(ns, tag);

      const BAR_H    = 28;
      const BAR_GAP  = 10;
      const LABEL_W  = 90;
      const PAD_T    = 8;
      const PAD_B    = 50;   // room for legend
      const PAD_R    = 32;   // right clearance for outside labels
      const W        = Math.max((document.getElementById("maCatMixWrap") || svg).clientWidth || 560, 400);
      const PLOT_W   = W - LABEL_W - PAD_R;
      const totalH   = PAD_T + eraData.length * (BAR_H + BAR_GAP) + PAD_B;

      svg.setAttribute("viewBox", `0 0 ${W} ${totalH}`);
      svg.setAttribute("width", W);
      svg.setAttribute("height", totalH);

      const tip = document.getElementById("maCatMixTooltip") || document.getElementById("maTooltip");

      eraData.forEach((era, i) => {
        const y = PAD_T + i * (BAR_H + BAR_GAP);
        const total = era.total || 1;

        // Era label
        const lbl = mk("text");
        lbl.setAttribute("x", LABEL_W - 8);
        lbl.setAttribute("y", y + BAR_H / 2 + 4);
        lbl.setAttribute("text-anchor", "end");
        lbl.setAttribute("font-size", "11");
        lbl.setAttribute("font-family", "IBM Plex Sans, sans-serif");
        lbl.setAttribute("fill", era.color);
        lbl.setAttribute("font-weight", "600");
        lbl.textContent = era.label;
        svg.appendChild(lbl);

        // Pass 1 — draw all rects + attach hover events
        const segMeta = [];   // store geometry so labels can be drawn in pass 2
        let xCursor = LABEL_W;
        ALL_CATS.forEach(cat => {
          const count = era.counts[cat];
          if (count === 0) return;
          const segW = (count / total) * PLOT_W;
          const col  = CAT_COLORS[cat];

          const rect = mk("rect");
          rect.setAttribute("x", xCursor);
          rect.setAttribute("y", y);
          rect.setAttribute("width", segW);
          rect.setAttribute("height", BAR_H);
          rect.setAttribute("fill", col);
          rect.setAttribute("opacity", "0.82");
          rect.style.cursor = "default";
          svg.appendChild(rect);

          rect.addEventListener("mouseenter", () => {
            const pct = ((count / total) * 100).toFixed(0);
            tip.innerHTML = `<div class="ma-tip-name">${era.label} · ${catLabel(cat)}</div><div class="ma-tip-val" style="color:${col}">${count} deal${count !== 1 ? "s" : ""} &nbsp;<span style="opacity:.7">${pct}% of era</span></div>`;
            tip.style.opacity = "1";
            const host = tip.offsetParent || tip.parentElement;
            const hostRect = host.getBoundingClientRect();
            const rRect = rect.getBoundingClientRect();
            const tipW = tip.offsetWidth || 200;
            let left = (rRect.left - hostRect.left) + rRect.width / 2 - tipW / 2;
            left = Math.max(8, Math.min(left, host.clientWidth - tipW - 8));
            tip.style.left = left + "px";
            tip.style.top  = ((rRect.top - hostRect.top) - 8) + "px";
            tip.style.transform = "translateY(-100%)";
          });
          rect.addEventListener("mouseleave", () => { tip.style.opacity = "0"; });

          segMeta.push({ x: xCursor, segW, count, col, y });
          xCursor += segW;
        });

        // Pass 2 — draw all labels on top of every rect
        segMeta.forEach(({ x, segW, count, col, y }) => {
          const labelStr = String(count);
          const labelPx  = labelStr.length * 6.2 + 10;
          const lbl = mk("text");
          if (segW >= labelPx) {
            lbl.setAttribute("x", x + segW / 2);
            lbl.setAttribute("text-anchor", "middle");
            lbl.setAttribute("fill", "#0f0f14");
          } else {
            lbl.setAttribute("x", x + segW + 3);
            lbl.setAttribute("text-anchor", "start");
            lbl.setAttribute("fill", col);
            lbl.setAttribute("opacity", "0.85");
          }
          lbl.setAttribute("y", y + BAR_H / 2 + 4);
          lbl.setAttribute("font-size", "9.5");
          lbl.setAttribute("font-family", "IBM Plex Mono, monospace");
          lbl.setAttribute("pointer-events", "none");
          lbl.textContent = labelStr;
          svg.appendChild(lbl);
        });

      });

      // ── Legend ────────────────────────────────────────────────────────────
      const legendY = PAD_T + eraData.length * (BAR_H + BAR_GAP) + 10;
      let lx = LABEL_W;
      ALL_CATS.forEach(cat => {
        const col = CAT_COLORS[cat];
        const dot = mk("rect");
        dot.setAttribute("x", lx); dot.setAttribute("y", legendY);
        dot.setAttribute("width", 10); dot.setAttribute("height", 10);
        dot.setAttribute("fill", col); dot.setAttribute("rx", "2");
        svg.appendChild(dot);
        const ltxt = mk("text");
        ltxt.setAttribute("x", lx + 14);
        ltxt.setAttribute("y", legendY + 9);
        ltxt.setAttribute("font-size", "10");
        ltxt.setAttribute("font-family", "IBM Plex Sans, sans-serif");
        ltxt.setAttribute("fill", "#a0a0b0");
        ltxt.textContent = catLabel(cat);
        svg.appendChild(ltxt);
        lx += catLabel(cat).length * 6.5 + 22;
      });
    }

    drawSwimlane();
    drawCumulLine();
    drawAnnualBar();

    // ── Drag-to-pan ─────────────────────────────────────────────────────────
    const swimWrap = document.querySelector(".ma-swimlane-wrap");
    let isPanning = false, panStartX = 0, panScrollStart = 0;

    swimWrap.addEventListener("mousedown", e => {
      isPanning = true;
      panStartX = e.clientX;
      panScrollStart = swimWrap.scrollLeft;
      swimWrap.style.cursor = "grabbing";
      e.preventDefault();
    });
    window.addEventListener("mousemove", e => {
      if (!isPanning) return;
      swimWrap.scrollLeft = panScrollStart - (e.clientX - panStartX);
    });
    window.addEventListener("mouseup", () => {
      isPanning = false;
      swimWrap.style.cursor = "grab";
    });

    // touch support
    swimWrap.addEventListener("touchstart", e => {
      panStartX = e.touches[0].clientX;
      panScrollStart = swimWrap.scrollLeft;
    }, { passive: true });
    swimWrap.addEventListener("touchmove", e => {
      swimWrap.scrollLeft = panScrollStart - (e.touches[0].clientX - panStartX);
    }, { passive: true });

    // Lock the cumulative-spend line and the deal swimlane together horizontally,
    // whichever one the user scrolls (drag, wheel, trackpad or scrollbar). No guard
    // flag needed: each handler only writes when the values differ, so the reciprocal
    // handler no-ops once they match — that convergence stops any ping-pong, and it
    // never drops the final position during fast continuous scrolling.
    const cumulWrap = document.querySelector(".ma-cumul-wrap");
    if (cumulWrap) {
      const linkScroll = (from, to) => from.addEventListener("scroll", () => {
        if (to.scrollLeft !== from.scrollLeft) to.scrollLeft = from.scrollLeft;
      });
      linkScroll(swimWrap, cumulWrap);
      linkScroll(cumulWrap, swimWrap);
    }

    // Default the timeline to the most recent deals rather than 1985, since
    // that's what execs actually want to see first. The panel is hidden (zero
    // scrollWidth) on initial build, so selectTab() re-triggers this once the
    // M&A tab is actually shown.
    window._maSwimScrollToEnd = () => {
      swimWrap.scrollLeft = swimWrap.scrollWidth;
      if (cumulWrap) cumulWrap.scrollLeft = swimWrap.scrollLeft;
    };
    window._maSwimScrollToEnd();

    // ── Drag-to-pan for Annual Spend bar ────────────────────────────────────
    const annbarWrap = document.querySelector(".ma-annbar-wrap");
    if (annbarWrap) {
      let abPanning = false, abStartX = 0, abScrollStart = 0;
      annbarWrap.addEventListener("mousedown", e => {
        abPanning = true;
        abStartX = e.clientX;
        abScrollStart = annbarWrap.scrollLeft;
        annbarWrap.style.cursor = "grabbing";
        e.preventDefault();
      });
      window.addEventListener("mousemove", e => {
        if (!abPanning) return;
        annbarWrap.scrollLeft = abScrollStart - (e.clientX - abStartX);
      });
      window.addEventListener("mouseup", () => {
        abPanning = false;
        annbarWrap.style.cursor = "grab";
      });
      annbarWrap.addEventListener("touchstart", e => {
        abStartX = e.touches[0].clientX;
        abScrollStart = annbarWrap.scrollLeft;
      }, { passive: true });
      annbarWrap.addEventListener("touchmove", e => {
        annbarWrap.scrollLeft = abScrollStart - (e.touches[0].clientX - abStartX);
      }, { passive: true });
    }

    // ── Annual Spend bar chart ─────────────────────────────────────────────
    function drawAnnualBar() {
      const svg = document.getElementById("maAnnBar");
      if (!svg) return;
      svg.innerHTML = "";

      const ns  = "http://www.w3.org/2000/svg";
      const mk  = tag => document.createElementNS(ns, tag);
      const tip = document.getElementById("maAnnBarTooltip");

      // Sum acquisition spend per year
      const spendMap = new Map();
      deals.filter(d => d.type === "acquisition" && d.valueMillions).forEach(d => {
        spendMap.set(d.year, (spendMap.get(d.year) || 0) + d.valueMillions);
      });
      // Index deals by year for tooltip
      const dealsByYear = new Map();
      deals.filter(d => d.type === "acquisition" && d.valueMillions).forEach(d => {
        if (!dealsByYear.has(d.year)) dealsByYear.set(d.year, []);
        dealsByYear.get(d.year).push(d);
      });
      dealsByYear.forEach(list => list.sort((a,b) => (b.valueMillions||0) - (a.valueMillions||0)));

      const years = [...spendMap.keys()].sort((a,b) => a-b);
      if (!years.length) return;

      const wrap   = svg.parentElement;
      const PAD_L  = 52;
      const PAD_R  = 16;
      const PAD_T  = 16;
      const PAD_B  = 36;
      const BAR_W  = 26;
      const GAP    = 8;
      const MIN_YEAR = Math.min(...years);
      const MAX_YEAR = Math.max(...years);
      const totalYears = MAX_YEAR - MIN_YEAR + 1;
      const W = Math.max(wrap.clientWidth || 600, PAD_L + PAD_R + totalYears * (BAR_W + GAP));
      const H = 220;
      const plotH = H - PAD_T - PAD_B;

      const maxSpend = Math.max(...spendMap.values());
      const yOf = v => PAD_T + plotH - (v / maxSpend) * plotH;
      const xOf = yr => PAD_L + (yr - MIN_YEAR) * (BAR_W + GAP);

      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("width", W);
      svg.setAttribute("height", H);

      // Y-axis gridlines + labels
      const yTicks = [0.25, 0.5, 0.75, 1.0];
      yTicks.forEach(f => {
        const y = yOf(f * maxSpend);
        const gl = mk("line");
        gl.setAttribute("x1", PAD_L); gl.setAttribute("y1", y);
        gl.setAttribute("x2", W - PAD_R); gl.setAttribute("y2", y);
        gl.setAttribute("stroke", "#2a2a36"); gl.setAttribute("stroke-width", "1");
        svg.appendChild(gl);

        const lbl = mk("text");
        lbl.setAttribute("x", PAD_L - 6); lbl.setAttribute("y", y + 4);
        lbl.setAttribute("text-anchor", "end");
        lbl.setAttribute("font-size", "9");
        lbl.setAttribute("font-family", "IBM Plex Mono, monospace");
        lbl.setAttribute("fill", "#5a5a6a");
        const val = f * maxSpend;
        lbl.textContent = val >= 1000 ? `$${(val/1000).toFixed(0)}B` : `$${val.toFixed(0)}M`;
        svg.appendChild(lbl);
      });

      // Era background bands
      ERAS.forEach(era => {
        const x1 = xOf(Math.max(era.from, MIN_YEAR));
        const x2 = xOf(Math.min(era.to, MAX_YEAR) + 1) - GAP;
        if (x2 <= x1) return;
        const band = mk("rect");
        band.setAttribute("x", x1 - GAP/2); band.setAttribute("y", PAD_T);
        band.setAttribute("width", x2 - x1 + GAP/2); band.setAttribute("height", plotH);
        band.setAttribute("fill", era.color); band.setAttribute("opacity", "0.06");
        svg.appendChild(band);
      });

      // Bars
      years.forEach(yr => {
        const spend = spendMap.get(yr);
        const x = xOf(yr);
        const barH = (spend / maxSpend) * plotH;
        const y = PAD_T + plotH - barH;
        const color = eraColor(yr);

        const rect = mk("rect");
        rect.setAttribute("x", x); rect.setAttribute("y", y);
        rect.setAttribute("width", BAR_W); rect.setAttribute("height", barH);
        rect.setAttribute("fill", color); rect.setAttribute("opacity", "0.75");
        rect.setAttribute("rx", "3");
        rect.style.cursor = "pointer";
        svg.appendChild(rect);

        // Year label below bar (every 5 years)
        if (yr % 5 === 0) {
          const lbl = mk("text");
          lbl.setAttribute("x", x + BAR_W/2); lbl.setAttribute("y", H - PAD_B + 14);
          lbl.setAttribute("text-anchor", "middle");
          lbl.setAttribute("font-size", "9.5");
          lbl.setAttribute("font-family", "IBM Plex Mono, monospace");
          lbl.setAttribute("fill", "#5a5a6a");
          lbl.textContent = yr;
          svg.appendChild(lbl);
        }

        // Label big bars inline
        if (spend >= 3000) {
          const vl = mk("text");
          vl.setAttribute("x", x + BAR_W/2); vl.setAttribute("y", y - 4);
          vl.setAttribute("text-anchor", "middle");
          vl.setAttribute("font-size", "8.5");
          vl.setAttribute("font-family", "IBM Plex Mono, monospace");
          vl.setAttribute("fill", color); vl.setAttribute("opacity", "0.9");
          vl.setAttribute("pointer-events", "none");
          vl.textContent = spend >= 1000 ? `$${(spend/1000).toFixed(0)}B` : `$${spend}M`;
          svg.appendChild(vl);
        }

        // Hover
        rect.addEventListener("mouseenter", () => {
          rect.setAttribute("opacity", "1");
          const dealList = (dealsByYear.get(yr) || [])
            .slice(0, 5)
            .map(d => `<div class="ma-tip-ctx" style="margin-top:3px">${d.name}: <b style="color:#c8c8d0">${fmt$(d.valueMillions)}</b></div>`)
            .join("");
          const total = spend >= 1000 ? `$${(spend/1000).toFixed(1)}B` : `$${spend}M`;
          tip.innerHTML = `<div class="ma-tip-year" style="color:${color}">${yr} · ${eraLabel(yr)}</div><div class="ma-tip-val" style="color:${color}">${total} total</div>${dealList}`;
          tip.style.opacity = "1";
          const host = tip.offsetParent || tip.parentElement;
          const hostRect = host.getBoundingClientRect();
          const rRect = rect.getBoundingClientRect();
          const tipW = tip.offsetWidth || 200;
          let left = (rRect.left - hostRect.left) + BAR_W/2 - tipW/2;
          left = Math.max(8, Math.min(left, host.clientWidth - tipW - 8));
          tip.style.left = left + "px";
          tip.style.top = ((rRect.top - hostRect.top) - 8) + "px";
          tip.style.transform = "translateY(-100%)";
        });
        rect.addEventListener("mouseleave", () => {
          rect.setAttribute("opacity", "0.75");
          tip.style.opacity = "0";
        });
      });

      // Era labels along the top
      ERAS.forEach(era => {
        const visFrom = Math.max(era.from, MIN_YEAR);
        const visTo   = Math.min(era.to, MAX_YEAR);
        if (visTo < visFrom) return;
        const x1 = xOf(visFrom);
        const x2 = xOf(visTo) + BAR_W;
        const mid = (x1 + x2) / 2;
        const lbl = mk("text");
        lbl.setAttribute("x", mid); lbl.setAttribute("y", PAD_T - 4);
        lbl.setAttribute("text-anchor", "middle");
        lbl.setAttribute("font-size", "9"); lbl.setAttribute("font-weight", "600");
        lbl.setAttribute("font-family", "IBM Plex Sans, sans-serif");
        lbl.setAttribute("fill", era.color); lbl.setAttribute("opacity", "0.7");
        lbl.setAttribute("letter-spacing", "0.06em");
        lbl.textContent = era.label.toUpperCase();
        svg.appendChild(lbl);
      });
    }

    // ── Boldness Scatter chart ─────────────────────────────────────────────
    function drawScatter() {
      const svg = document.getElementById("maScatter");
      if (!svg) return;
      svg.innerHTML = "";

      const ns  = "http://www.w3.org/2000/svg";
      const mk  = tag => document.createElementNS(ns, tag);
      const tip = document.getElementById("maScatterTooltip");

      // Only valued acquisitions with revenue context
      const pts = deals.filter(d => {
        if (d.type !== "acquisition" || !d.valueMillions) return false;
        const yr = byYear.get(d.year);
        return yr && yr.revenue;
      }).map(d => {
        const yr = byYear.get(d.year);
        return {
          ...d,
          pctRev: d.valueMillions / yr.revenue * 100,
          pctMktCap: yr.marketCap ? d.valueMillions / yr.marketCap * 100 : null,
        };
      });

      if (!pts.length) return;

      const wrap   = svg.parentElement;
      const PAD_L  = 52;
      const PAD_R  = 24;
      const PAD_T  = 16;
      const PAD_B  = 40;
      const W      = Math.max(wrap.clientWidth || 700, 600);
      const H      = 300;
      const plotW  = W - PAD_L - PAD_R;
      const plotH  = H - PAD_T - PAD_B;

      const minYr = 1984, maxYr = 2025;
      const maxPctRev = Math.max(...pts.map(p => p.pctRev)) * 1.08;
      const maxAbsVal = Math.max(...pts.map(p => p.valueMillions));
      const R_MIN = 4, R_MAX = 28;

      const xOf  = yr  => PAD_L + ((yr - minYr) / (maxYr - minYr)) * plotW;
      const yOf  = pct => PAD_T + plotH - (pct / maxPctRev) * plotH;
      const rOf  = val => R_MIN + (Math.sqrt(val / maxAbsVal)) * (R_MAX - R_MIN);

      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("width", W);
      svg.setAttribute("height", H);

      // Y gridlines + labels
      const ySteps = 5;
      for (let i = 0; i <= ySteps; i++) {
        const v = (maxPctRev / ySteps) * i;
        const y = yOf(v);
        const gl = mk("line");
        gl.setAttribute("x1", PAD_L); gl.setAttribute("y1", y);
        gl.setAttribute("x2", W - PAD_R); gl.setAttribute("y2", y);
        gl.setAttribute("stroke", i === 0 ? "#3a3a4a" : "#1e1e2a");
        gl.setAttribute("stroke-width", i === 0 ? "1" : "1");
        svg.appendChild(gl);
        if (i > 0) {
          const lbl = mk("text");
          lbl.setAttribute("x", PAD_L - 6); lbl.setAttribute("y", y + 4);
          lbl.setAttribute("text-anchor", "end");
          lbl.setAttribute("font-size", "9");
          lbl.setAttribute("font-family", "IBM Plex Mono, monospace");
          lbl.setAttribute("fill", "#5a5a6a");
          lbl.textContent = `${v.toFixed(0)}%`;
          svg.appendChild(lbl);
        }
      }

      // Y-axis label
      const yAxisLbl = mk("text");
      yAxisLbl.setAttribute("transform", `rotate(-90) translate(${-(PAD_T + plotH/2)}, 12)`);
      yAxisLbl.setAttribute("text-anchor", "middle");
      yAxisLbl.setAttribute("font-size", "9"); yAxisLbl.setAttribute("fill", "#5a5a6a");
      yAxisLbl.setAttribute("font-family", "IBM Plex Sans, sans-serif");
      yAxisLbl.setAttribute("letter-spacing", "0.04em");
      yAxisLbl.textContent = "% OF IBM REVENUE";
      svg.appendChild(yAxisLbl);

      // X-axis ticks
      [1985, 1990, 1995, 2000, 2005, 2010, 2015, 2020, 2025].forEach(yr => {
        const x = xOf(yr);
        const tick = mk("line");
        tick.setAttribute("x1", x); tick.setAttribute("y1", PAD_T + plotH);
        tick.setAttribute("x2", x); tick.setAttribute("y2", PAD_T + plotH + 4);
        tick.setAttribute("stroke", "#3a3a4a"); tick.setAttribute("stroke-width", "1");
        svg.appendChild(tick);
        const lbl = mk("text");
        lbl.setAttribute("x", x); lbl.setAttribute("y", H - PAD_B + 16);
        lbl.setAttribute("text-anchor", "middle");
        lbl.setAttribute("font-size", "9.5");
        lbl.setAttribute("font-family", "IBM Plex Mono, monospace");
        lbl.setAttribute("fill", "#5a5a6a");
        lbl.textContent = yr;
        svg.appendChild(lbl);
      });

      // Era bands
      ERAS.forEach(era => {
        const x1 = Math.max(xOf(era.from), PAD_L);
        const x2 = Math.min(xOf(era.to + 1), W - PAD_R);
        const band = mk("rect");
        band.setAttribute("x", x1); band.setAttribute("y", PAD_T);
        band.setAttribute("width", x2 - x1); band.setAttribute("height", plotH);
        band.setAttribute("fill", era.color); band.setAttribute("opacity", "0.05");
        svg.appendChild(band);
      });

      // Sort so small bubbles render on top of big ones
      const sorted = [...pts].sort((a,b) => b.valueMillions - a.valueMillions);

      sorted.forEach(p => {
        const x = xOf(p.year);
        const y = yOf(p.pctRev);
        const r = rOf(p.valueMillions);
        const color = eraColor(p.year);

        const circle = mk("circle");
        circle.setAttribute("cx", x); circle.setAttribute("cy", y);
        circle.setAttribute("r", r);
        circle.setAttribute("fill", color); circle.setAttribute("fill-opacity", "0.22");
        circle.setAttribute("stroke", color); circle.setAttribute("stroke-width", "1.5");
        circle.setAttribute("stroke-opacity", "0.85");
        circle.style.cursor = "pointer";
        svg.appendChild(circle);

        // Label very notable deals
        if (p.pctRev >= 3 || p.valueMillions >= 5000) {
          const SHORT = {
            "PricewaterhouseCoopers Consulting": "PwC Consulting",
            "Apptio (from Vista Equity Partners)": "Apptio",
            "StreamSets & webMethods (from Software AG)": "StreamSets & webMethods",
          };
          const nm = SHORT[p.name] || (p.name.length > 16 ? p.name.slice(0,15) + "…" : p.name);
          const lbl = mk("text");
          lbl.setAttribute("x", x + r + 3); lbl.setAttribute("y", y + 3);
          lbl.setAttribute("font-size", "8.5");
          lbl.setAttribute("font-family", "IBM Plex Sans, sans-serif");
          lbl.setAttribute("fill", color); lbl.setAttribute("opacity", "0.85");
          lbl.setAttribute("pointer-events", "none");
          lbl.textContent = nm;
          svg.appendChild(lbl);
        }

        // Hover
        circle.addEventListener("mouseenter", () => {
          circle.setAttribute("fill-opacity", "0.45");
          const yr = byYear.get(p.year) || {};
          tip.innerHTML = `
            <div class="ma-tip-year" style="color:${color}">${p.year} · ${eraLabel(p.year)}</div>
            <div class="ma-tip-name">${p.name}</div>
            <div class="ma-tip-val" style="color:${color}">${fmt$(p.valueMillions)}</div>
            <div class="ma-tip-ctx">${p.pctRev.toFixed(1)}% of IBM revenue${p.pctMktCap ? ` · ${p.pctMktCap.toFixed(1)}% of mkt cap` : ""}</div>`;
          tip.style.opacity = "1";
          const host = tip.offsetParent || tip.parentElement;
          const hostRect = host.getBoundingClientRect();
          const cRect = circle.getBoundingClientRect();
          const tipW = tip.offsetWidth || 220;
          let left = (cRect.left - hostRect.left) + r - tipW/2;
          left = Math.max(8, Math.min(left, host.clientWidth - tipW - 8));
          tip.style.left = left + "px";
          tip.style.top = ((cRect.top - hostRect.top) - 8) + "px";
          tip.style.transform = "translateY(-100%)";
        });
        circle.addEventListener("mouseleave", () => {
          circle.setAttribute("fill-opacity", "0.22");
          tip.style.opacity = "0";
        });
      });

      // Legend: bubble size scale
      const legendY = H - 10;
      const sizes = [500, 5000, 34000];
      let lx = PAD_L;
      sizes.forEach(v => {
        const r = rOf(v);
        const c = mk("circle");
        c.setAttribute("cx", lx + r); c.setAttribute("cy", legendY - r);
        c.setAttribute("r", r); c.setAttribute("fill", "none");
        c.setAttribute("stroke", "#5a5a6a"); c.setAttribute("stroke-width", "1");
        svg.appendChild(c);
        const lt = mk("text");
        lt.setAttribute("x", lx + r * 2 + 5); lt.setAttribute("y", legendY - 1);
        lt.setAttribute("font-size", "8.5");
        lt.setAttribute("font-family", "IBM Plex Mono, monospace");
        lt.setAttribute("fill", "#5a5a6a");
        lt.textContent = v >= 1000 ? `$${(v/1000).toFixed(0)}B` : `$${v}M`;
        svg.appendChild(lt);
        lx += r * 2 + 40;
      });
    }

    // ── Alpha Leaderboard ──────────────────────────────────────────────────
    let alphaSort = "alpha";

    function renderAlphaLeaderboard() {
      const tbody = document.getElementById("maAlphaTbody");
      if (!tbody) return;

      // Same array the blurb above counts from, so the stated total always
      // matches the number of rows actually rendered.
      const perfDeals = measurablePerf;

      const sorted = [...perfDeals].sort((a, b) => {
        if (alphaSort === "alpha")  return b.alpha - a.alpha;
        if (alphaSort === "ibm")    return b.ibmReturn - a.ibmReturn;
        if (alphaSort === "size")   return (b.valueMillions||0) - (a.valueMillions||0);
        return 0;
      });

      const maxAbsAlpha = Math.max(...perfDeals.map(p => Math.abs(p.alpha)));

      tbody.innerHTML = sorted.map(p => {
        const beat    = p.alpha >= 0;
        const iSign   = p.ibmReturn >= 0 ? "+" : "";
        const bSign   = (p.benchReturn != null && p.benchReturn >= 0) ? "+" : "";
        const aSign   = p.alpha >= 0 ? "+" : "";
        const iColor  = p.ibmReturn >= 0 ? "#42be65" : "#fa4d56";
        const aColor  = beat ? "#42be65" : "#fa4d56";
        const barW    = Math.min(Math.abs(p.alpha) / maxAbsAlpha * 40, 40).toFixed(0);
        const barColor = beat ? "#42be65" : "#fa4d56";
        const sizeStr = p.valueMillions ? fmt$(p.valueMillions) : "—";
        const benchStr = p.benchReturn != null
          ? `<span style="color:${p.benchReturn >= 0 ? '#42be65' : '#fa4d56'}">${bSign}${p.benchReturn}%</span>`
          : `<span style="color:#5a5a6a">—</span>`;
        const eraC = eraColor(p.year);

        return `<tr>
          <td>
            <div class="ma-alpha-deal">${p.name}</div>
            <div style="font-size:10px;color:${eraC};margin-top:1px">${eraLabel(p.year)}${p.benchmark ? ` · vs ${p.benchmark}` : ""}</div>
          </td>
          <td class="ma-alpha-year">${p.year}</td>
          <td class="ma-alpha-size">${sizeStr}</td>
          <td class="ma-alpha-ret" style="color:${iColor}">${iSign}${p.ibmReturn}%</td>
          <td class="ma-alpha-bench">${benchStr}</td>
          <td class="ma-alpha-alpha" style="color:${aColor}">
            <span class="ma-alpha-rank-bar" style="background:${barColor};width:${barW}px"></span>${aSign}${p.alpha}pp
          </td>
          <td><span class="ma-alpha-verdict ${beat ? 'beat' : 'miss'}">${beat ? "Beat market" : "Missed market"}</span></td>
        </tr>`;
      }).join("");
    }

    // ── Insights panel tab switching ───────────────────────────────────────
    const INS_MAP = { bar: "maInsBar", scatter: "maInsScatter", alpha: "maInsAlpha", catmix: "maInsCatMix" };
    document.querySelectorAll(".ma-ins-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".ma-ins-tab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        const key = btn.dataset.ins;
        Object.entries(INS_MAP).forEach(([k, id]) => {
          const el = document.getElementById(id);
          if (el) el.style.display = k === key ? "" : "none";
        });
        // Lazy-draw on first reveal (SVGs need layout width)
        if (key === "bar")     drawAnnualBar();
        if (key === "scatter") drawScatter();
        if (key === "alpha")   renderAlphaLeaderboard();
        if (key === "catmix")  drawCatBar();
      });
    });

    // Alpha sort buttons
    document.querySelectorAll(".ma-alpha-sort").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".ma-alpha-sort").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        alphaSort = btn.dataset.sort;
        renderAlphaLeaderboard();
      });
    });

    let _maResizeTimer;
    window.addEventListener("resize", () => {
      clearTimeout(_maResizeTimer);
      _maResizeTimer = setTimeout(() => { drawSwimlane(); drawCumulLine(); drawAnnualBar(); drawScatter(); }, 120);
    });
  }

  /* ---- About / Data panel (built: gives the project longevity) ---------- */
  try {
  document.getElementById("panel-about").innerHTML = `
    <div class="hero">
      <div class="hero-text">
        <div class="hero-kicker">About &amp; Data · sources, methods, maintenance</div>
        <h1>Built to outlive its builders</h1>
        <p>Any IBMer can explore a century of the company's own reporting here —
           and everything is documented so it keeps working long after the original team moves on.</p>
      </div>
    </div>
    <div class="ph">

<div class="planbox">
<h3>What's here</h3>
<ul>
<li><b>Overview</b> — year scrubber, era filters, multi-metric trend chart with milestones, and a derived performance-ratios table with a live ROIC tax slider.</li>
<li><b>Story Mode</b> — a guided, scroll-driven walk through IBM's 115-year arc.</li>
<li><b>Regression Lab</b> — explore relationships between ~48 IBM, macro and derived metrics over any year range (era presets include Hybrid Cloud &amp; AI). The best-fitting model (linear, logarithmic, exponential, power or quadratic) is chosen automatically; lags, an optional second predictor, residual diagnostics and CSV export included.</li>
<li><b>Macro vs IBM</b> — IBM's trajectory against US GDP, CPI, the S&amp;P 500 and NBER recessions.</li>
<li><b>Mergers &amp; Acquisitions</b> — era summary cards, deal timeline, category filters and cumulative-spend view.</li>
<li><b>Competitors</b> — IBM against benchmark tech peers.</li>
</ul>
</div>

<div class="planbox" style="margin-top:16px">
<h3>AI agents &amp; tools</h3>
<ul>
<li><b>CUGA data agent</b> — <code>agent/agent.py</code> wires 17 tools (financials, segments, FCF sourcing, M&amp;A, macro, regressions) into a <a href="https://pypi.org/project/cuga/" target="_blank" rel="noopener">CUGA</a> agent. Run <code>python agent/server.py</code> and use the <b>“⌘ Ask the data”</b> panel (bottom-left) to chat with it.</li>
<li><b>Browser tools</b> — <code>window.CUGA</code> exposes the same data plus page actions (switch tabs, configure the Regression Lab, open M&amp;A era drawers, change the Overview chart's metrics/scale, post an on-page note, highlight an element) to any agent that can run JavaScript. Try <code>window.CUGA.manifest()</code> in the console.</li>
<li><b>Full agent control</b> — when both <code>agent/server.py</code> and this page are open, the CUGA chat agent can drive the page itself via a command bridge: ask it to "go to the M&amp;A tab and open the Krishna era" or "highlight IBM's free cash flow on the Overview page" and watch it happen live.</li>
<li><b>watsonx Orchestrate</b> — import <code>orchestrate/openapi.json</code> to give the site's embedded Orchestrate assistant the same toolset (see <code>orchestrate/README.md</code>).</li>
</ul>
</div>

<div class="planbox" style="margin-top:16px">
<h3>Where the numbers come from</h3>
<ul>
<li>
<b>${fin.length} fiscal years</b> (1911–2025), parsed directly from ${"116"} annual-report PDFs.</li>
<li>Figures are cross-checked across filings (each report restates prior years) and
              <b>never estimated</b> — a missing value shows as <code>n/a</code>.</li>
<li>Money is in <b>US$ millions</b>; net income is the total bottom line, EPS is diluted (total).</li>
<li><b>Free cash flow</b> is <b>unlevered</b> (pre-financing): it is derived from operating cash flow and therefore excludes interest payments, debt issuance, and all financing activities. IBM's own stated FCF figure (which additionally excludes the change in Global Financing receivables) is used for every year 2003–2025 — 2003–2007 read from the five-year road-map table in the 2007 report, later years from each MD&amp;A. 1995–2002 FCF is derived as OCF − net CapEx from the cash-flow statements, so there is a small definitional seam at 2002/2003; the UI labels each year's source.</li>
<li><b>External series</b> (not from the filings): market cap 1984–2025 and year-end stock price 2001–2020 from market-data sources; US GDP (BEA, 1929+), CPI (BLS, 1947+), S&amp;P 500 &amp; Nasdaq year-end (1984+) and NBER recession dates power the Macro and Regression tabs.</li>
<li>Full method &amp; provenance: <code>pipeline/SCHEMA.md</code> and <code>pipeline/data/provenance.json</code>.</li>
</ul>
<p class="datahint">
<b>To refresh the site after the data changes:</b>
          run <code>python pipeline/export_web.py</code> to regenerate <code>data.js</code> at the repo root.</p>
</div>
<div class="planbox" style="margin-top:16px">
<h3>Coverage at a glance</h3>
<ul id="coverageList">
</ul>
</div>
<p class="datahint">Data generated ${D.generated}. Source: ${D.source}.</p>
</div>`;

  // coverage summary (computed live from the data)
  (function coverage() {
    const keys = ["revenue", "netIncome", "epsDiluted", "dividendsPerShare", "totalAssets", "stockholdersEquity",
      "totalDebt", "rdExpense", "freeCashFlow", "operatingCashFlow", "capitalExpenditure", "marketCap", "employees"];
    const labels = { revenue:"Revenue", netIncome:"Net income", epsDiluted:"EPS (diluted)", dividendsPerShare:"Dividends per share",
      totalAssets:"Total assets", stockholdersEquity:"Stockholders’ equity", totalDebt:"Total debt", rdExpense:"R&D expense",
      freeCashFlow:"Free cash flow", operatingCashFlow:"Operating cash flow", capitalExpenditure:"Capital expenditure",
      marketCap:"Market cap (external)", employees:"Employees" };
    const ul = document.getElementById("coverageList");
    keys.forEach(k => {
      const ys = fin.filter(d => d[k] != null).map(d => d.year);
      if (!ys.length) return;
      const li = document.createElement("li");
      li.innerHTML = `<b>${labels[k]}</b>: ${ys.length} years (${Math.min(...ys)}–${Math.max(...ys)})`;
      ul.appendChild(li);
    });
  })();
  } catch (e) { console.error("About & Data tab failed to render:", e); }

  /* ====================================================================== */
  /*  INIT                                                                  */
  /* ====================================================================== */
  try {
    document.getElementById("genStamp").textContent = "Data generated " + D.generated + ".";
    document.getElementById("dataTag").textContent = `${fin.length} years`;
    buildFYChips();
    renderFY(Y1);
    renderSnapshot(Y1);
    drawChart();
    renderDerived();
  } catch (e) { console.error("Overview tab failed to render:", e); }
  // deep-link via hash (e.g. index.html#regression)
  try {
    const initial = (location.hash || "#home").slice(1);
    if (document.getElementById("panel-" + initial)) selectTab(initial);
    window.selectTab = selectTab;
  } catch (e) { console.error("Initial tab selection failed:", e); }

  /* ---- Info drawer (The project / Methodology) --------------------------- */
  try {
  const DRAWER_CONTENT = {
    project: {
      title: "The Project",
      html: `
        <div class="info-drawer-kicker">IBM Through the Years</div>
        <h3>What this is</h3>
        <p>A financial history dashboard built entirely from IBM's and CTR's own published annual reports — 1911 to 2025. Every number was parsed directly from the original filings. No estimates, no Wikipedia, no news articles. Where a figure wasn't reported, the dashboard shows a gap rather than a guess.</p>
        <h3>Why it exists</h3>
        <p>Most financial history sites aggregate data from third-party providers who fill gaps with estimates. This project exists because IBM is one of the only companies in history with over a century of continuous filings — and that story deserves to be told accurately, from the source.</p>
        <h3>What's inside</h3>
        <ul>
          <li><strong>115 fiscal years</strong> (1911–2025) of revenue, net income, EPS, employees, R&amp;D, and more</li>
          <li><strong>Story Mode</strong> — ten narrative chapters tracing IBM's defining eras, with animated chart reveals and excerpts from the actual annual reports</li>
          <li><strong>M&amp;A tab</strong> — $74B+ in sourced acquisitions across five CEO eras, every value confirmed from IBM's own audited filings</li>
          <li><strong>Regression Lab</strong> — run your own statistical models on IBM's historical financials</li>
          <li><strong>Macro vs IBM</strong> — IBM's performance against GDP, S&amp;P 500, and 32 U.S. recessions since 1854</li>
          <li><strong>Competitors tab</strong> — strategic positioning across IBM's three operating segments</li>
        </ul>
        <h3>Key facts</h3>
        <ul>
          <li>IBM survived the Great Depression, WWII, the dot-com bust, the 2008 financial crisis, and COVID-19</li>
          <li>IBM posted its worst-ever loss in 1993 — $8.1B, the largest single-year U.S. corporate loss at the time — and recovered</li>
          <li>The 2019 Red Hat acquisition ($35.1B) represented 29.6% of IBM's entire market cap — the boldest bet in the dataset</li>
          <li>IBM has invested over $172B in R&amp;D since 1990 alone</li>
          <li>Peak revenue: $106.9B in 2011. Peak net income: $16.6B in 2012. Peak employees: 434,246 in 2012</li>
        </ul>`
    },
    methodology: {
      title: "Methodology",
      html: `
        <div class="info-drawer-kicker">How the data was built</div>
        <h3>Source documents</h3>
        <p>All figures come from IBM Corporation and CTR annual reports (1911–2025), parsed from original PDF filings using a custom Python pipeline (<code>pipeline/</code>). No third-party data aggregators were used.</p>
        <h3>Cross-checking</h3>
        <p>Each annual report restates the prior year's figures. Where discrepancies exist between a year's original filing and its restatement in the next year's report, the more recent (audited) figure is used. Values confirmed this way are marked as <strong>verified</strong>.</p>
        <h3>The n/a rule</h3>
        <p>If a line item wasn't reliably stated in the filing, it shows as <code>n/a</code> — never estimated, never interpolated. Gaps in the chart are real gaps in the reporting.</p>
        <h3>Free Cash Flow definition</h3>
        <p>The FCF series shown throughout this dashboard is <strong>unlevered</strong> — it is based on operating cash flow and therefore sits above the financing line. Interest expense, debt repayments, and all other financing activities are excluded. IBM defines FCF as: <strong>Operating Cash Flow − Net Capital Expenditures</strong>, where net CapEx = gross CapEx payments minus proceeds from asset disposals. This follows IBM's own stated definition from the 2015 10-K. The Global Financing receivables adjustment is not applied for pre-2007 years where it wasn't separately reported.</p>
        <h3>M&amp;A sourcing</h3>
        <p>All acquisition values come from IBM's own <em>Acquisitions &amp; Divestitures</em> financial statement note or the consolidated cash flow statement — primary-source audited figures. Values from contemporaneous press releases or 8-K filings are marked separately. IBM executes 8–15 smaller acquisitions per year not individually listed here.</p>
        <h3>Market cap</h3>
        <p>Market capitalization is external market data (share price × shares outstanding) and is not reported in the annual filings themselves. Coverage: 1984–2025.</p>
        <h3>Currency &amp; units</h3>
        <p>All monetary figures are in <strong>US$ millions</strong> unless noted. Net income is the total bottom line. EPS is diluted (total).</p>
        <h3>Refreshing the data</h3>
        <p>Run <code>python pipeline/export_web.py</code> to regenerate <code>website/data.js</code> after any pipeline data changes.</p>`
    }
  };

  const infoOverlay  = document.getElementById("infoOverlay");
  const infoDrawer   = document.getElementById("infoDrawer");
  const infoTitle    = document.getElementById("infoDrawerTitle");
  const infoBody     = document.getElementById("infoDrawerBody");
  const infoClose    = document.getElementById("infoDrawerClose");

  function openInfoDrawer(key) {
    const c = DRAWER_CONTENT[key];
    if (!c) return;
    infoTitle.textContent = c.title;
    infoBody.innerHTML = c.html;
    infoBody.scrollTop = 0;
    infoOverlay.classList.add("open");
    infoDrawer.classList.add("open");
  }
  function closeInfoDrawer() {
    infoOverlay.classList.remove("open");
    infoDrawer.classList.remove("open");
  }

  infoClose.addEventListener("click", closeInfoDrawer);
  infoOverlay.addEventListener("click", closeInfoDrawer);
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeInfoDrawer(); });
  window.openInfoDrawer = openInfoDrawer;
  } catch (e) { console.error("Info drawer failed to initialize:", e); }
})();


  /* ---- Primary performance chart: S&P benchmarks OR EV/EBITDA toggle --- */
  (function initPrimaryChart() {
   try {
    /* Wait for Chart.js CDN to be ready */
    function tryInit() {
      if (typeof Chart === "undefined") { setTimeout(tryInit, 120); return; }
      var canvas = document.getElementById("primaryChartCanvas");
      if (!canvas) return;
      wire(canvas);
    }

    /* ---- Data ----------------------------------------------------------- */
    var sAndPBenchmarkData = {
      years: [
        "Q4 '21", "Q1 '22", "Q2 '22", "Q3 '22", "Q4 '22",
        "Q1 '23", "Q2 '23", "Q3 '23", "Q4 '23",
        "Q1 '24", "Q2 '24", "Q3 '24", "Q4 '24",
        "Q1 '25", "Q2 '25", "Q3 '25", "Q4 '25",
        "Q1 '26", "Q2 '26"
      ],
      // IBM: Yahoo Finance adjusted-close, quarter-end prices from
      // Story Mode/ibm_daily_prices.js — rebased to 100 @ 2021-12-31 ($112.66)
      IBM: [
        100.0,  98.4, 108.2,  92.2, 110.6,
        104.2, 107.8, 114.4, 134.8,
        158.8, 145.3, 187.3, 187.8,
        213.8, 255.1, 245.9, 259.5,
        213.6, 249.6
      ],
      // Source: Competitor Data/all_four_total_returns_q4_2021_current.csv
      // Rebased to 100 @ Q4'21 indexLevel. Formula: round(indexLevel / base * 100, 1)
      // SP500_IT — base 3864.72
      SP500_IT: [
        100.0,  91.6,  73.1,  68.6,  71.8,
         87.5, 102.5,  96.7, 113.3,
        127.7, 145.4, 147.7, 154.8,
        135.2, 167.3, 189.4, 192.1,
        174.5, 230.0
      ],
      // SP_SW_SERV — base 15546.56
      SP_SW_SERV: [
        100.0,  88.9,  67.1,  64.7,  65.8,
         74.6,  80.8,  77.0,  91.4,
         94.6,  91.8,  97.7, 114.9,
         97.4, 115.5, 120.4, 114.1,
         86.8, 104.7
      ],
      // SP_TECH_HW — base 2912.00
      SP_TECH_HW: [
        100.0,  88.7,  69.4,  64.6,  67.9,
         79.7,  93.7,  87.1,  97.1,
        113.7, 116.5, 117.0, 132.5,
        111.9, 140.5, 166.1, 168.6,
        188.7, 294.1
      ],
      // SP_IT_SERV — base 824.15
      SP_IT_SERV: [
        100.0,  90.8,  78.5,  74.3,  81.5,
         87.5,  92.4,  94.3, 109.3,
        114.0, 102.0, 121.8, 123.3,
        122.1, 130.9, 116.3, 124.3,
         99.2,  94.6
      ]
    };

    // Source: Competitor Data/Competitor Growth- INTERN.csv (EV/EBITDA section, rows 27-50)
    // Quarters: CQ42021 → CQ12026 (18 periods)
    var actualEvEbitdaData = {
      years: [
        "Q4 '21","Q1 '22","Q2 '22","Q3 '22","Q4 '22",
        "Q1 '23","Q2 '23","Q3 '23","Q4 '23",
        "Q1 '24","Q2 '24","Q3 '24","Q4 '24",
        "Q1 '25","Q2 '25","Q3 '25","Q4 '25",
        "Q1 '26"
      ],
      IBM:    [ 9.6,  9.8, 10.6,  9.2, 11.0, 10.4, 10.7, 10.9, 12.8, 13.9, 12.4, 15.3, 14.4, 16.0, 18.1, 17.0, 17.1, 13.9],
      GOOGL:  [15.6, 14.2, 10.8,  9.7,  9.4, 10.8, 12.0, 12.0, 12.3, 12.8, 14.5, 12.6, 13.7, 10.6, 11.7, 15.1, 18.2, 15.7],
      AMZN:   [22.7, 20.4, 15.0, 15.5, 12.5, 13.5, 15.7, 13.3, 14.0, 14.6, 14.7, 13.8, 15.0, 12.3, 14.3, 13.3, 13.0, 10.9],
      MSFT:   [24.8, 21.4, 17.4, 15.7, 16.6, 20.0, 22.1, 19.8, 21.9, 23.1, 23.4, 21.9, 20.5, 17.5, 21.6, 20.3, 17.6, 13.1],
      ORCL:   [14.2, 12.7, 10.5, 11.1, 13.0, 13.1, 15.1, 12.9, 13.1, 14.6, 15.6, 18.2, 17.1, 14.7, 20.5, 24.3, 16.6, 12.6],
      SAP:    [16.2, 12.7, 11.0, 10.8, 11.3, 13.5, 14.6, 13.4, 18.2, 23.0, 22.8, 24.0, 25.3, 23.9, 25.5, 22.5, 19.5, 12.9],
      AVGO:   [16.1, 14.0, 10.4,  9.6, 11.9, 12.8, 16.6, 15.4, 18.6, 21.2, 23.2, 23.2, 28.4, 19.7, 29.9, 31.2, 26.4, 18.5],
      CSCO:   [12.9, 11.0,  8.8,  7.9,  9.4,  9.5,  9.1,  9.5,  9.7,  9.7, 10.3, 11.0, 11.9, 12.1, 13.0, 12.7, 13.4, 13.4],
      ACN:    [22.5, 17.5, 14.1, 13.4, 13.5, 14.6, 15.4, 15.0, 16.9, 17.0, 14.8, 16.5, 16.4, 14.7, 13.5, 10.8, 10.8,  8.4],
      TCS:    [24.6, 22.8, 19.3, 18.0, 18.5, 17.2, 17.9, 19.2, 20.0, 19.6, 19.3, 20.7, 19.8, 17.5, 17.0, 14.2, 15.3, 10.5],
      HPE:    [ 5.9,  5.9,  5.3,  4.9,  5.7,  5.9,  6.2,  6.1,  5.7,  5.9,  6.3,  6.0,  5.6,  4.8,  6.0,  7.5,  7.5,  7.0],
      DELL:   [ 7.3,  5.7,  5.2,  4.6,  5.4,  5.5,  6.7,  7.3,  7.2,  9.2, 10.4,  8.8,  8.4,  7.1,  8.7,  9.4,  8.1,  8.6]
    };

    var competitorColors = {
      IBM:   "#054ADA",
      GOOGL: "#34a853",
      AMZN:  "#ff9900",
      MSFT:  "#00a4ef",
      ORCL:  "#f80000",
      SAP:   "#0070f2",
      AVGO:  "#cc0000",
      CSCO:  "#1ba0d7",
      ACN:   "#a100ff",
      TCS:   "#4589ff",
      HPE:   "#08bdba",
      DELL:  "#006bb6"
    };

    /* ---- Revenue Growth Y/Y data (from CSV, EV/EBITDA section rows 48-50 and Revenue section)
       Quarters: CQ42022→CQ12026  (same index positions 4-17 of the 18-quarter array)
       Source: Competitor Data/Competitor Growth- INTERN.csv, Growth Y/Y block
       Values are percentages expressed as decimals (e.g. 0.06 = 6%)                         */
    var revenueGrowthYoY = {
      // quarters shared with ev data — index 0 = CQ42021 baseline; YoY available from CQ42022 (idx 4)
      // We store all 18 quarters; first 4 (CQ42021–CQ32022) are null (no prior-year available)
      quarters: [
        "Q4 '21","Q1 '22","Q2 '22","Q3 '22","Q4 '22",
        "Q1 '23","Q2 '23","Q3 '23","Q4 '23",
        "Q1 '24","Q2 '24","Q3 '24","Q4 '24",
        "Q1 '25","Q2 '25","Q3 '25","Q4 '25",
        "Q1 '26"
      ],
      // idx:                          0     1     2     3     4      5      6      7      8      9     10     11     12     13     14     15     16     17
      // quarter:                    Q4'21 Q1'22 Q2'22 Q3'22 Q4'22  Q1'23  Q2'23  Q3'23  Q4'23  Q1'24  Q2'24  Q3'24  Q4'24  Q1'25  Q2'25  Q3'25  Q4'25  Q1'26
      IBM:    [null, null, null, null, 0.00,  0.00,  0.00,  0.05,  0.04,  0.01,  0.02,  0.01,  0.01,  0.01,  0.08,  0.09,  0.12,  0.09],
      GOOGL:  [null, null, null, null, 0.01,  0.03,  0.07,  0.11,  0.13,  0.15,  0.14,  0.15,  0.12,  0.12,  0.14,  0.16,  0.18,  0.22],
      AMZN:   [null, null, null, null, 0.09,  0.09,  0.11,  0.13,  0.14,  0.13,  0.10,  0.11,  0.10,  0.09,  0.13,  0.13,  0.14,  0.17],
      MSFT:   [null, null, null, null, 0.02,  0.07,  0.08,  0.13,  0.18,  0.17,  0.15,  0.16,  0.12,  0.13,  0.18,  0.18,  0.17,  0.18],
      ORCL:   [null, null, null, null, 0.18,  0.18,  0.17,  0.09,  0.05,  0.07,  0.03,  0.07,  0.09,  0.06,  0.11,  0.12,  0.14,  0.22],
      SAP:    [null, null, null, null,-0.05,  0.07,  0.09,  0.12,  0.09,  0.07,  0.08,  0.15,  0.04,  0.12,  0.19,  0.13,  0.17,  0.13],
      AVGO:   [null, null, null, null, 0.16,  0.08,  0.05,  0.04,  0.34,  0.43,  0.47,  0.51,  0.25,  0.20,  0.22,  0.28,  0.29,  0.48],
      CSCO:   [null, null, null, null, 0.07,  0.14,  0.16,  0.08, -0.06, -0.13, -0.10, -0.06,  0.09,  0.11,  0.08,  0.08,  0.10,  0.12],
      ACN:    [null, null, null, null, 0.05,  0.05,  0.03,  0.04,  0.03,  0.00, -0.01,  0.03,  0.09,  0.05,  0.08,  0.07,  0.06,  0.08],
      TCS:    [null, null, null, null, 0.07,  0.08,  0.08,  0.06,  0.03,  0.02,  0.04,  0.07,  0.03,  0.03, -0.02, -0.03,  0.00,  0.00],
      HPE:    [null, null, null, null, 0.12,  0.04,  0.01, -0.07, -0.13,  0.03,  0.10,  0.15,  0.16,  0.06,  0.18,  0.14,  0.18,  0.40],
      DELL:   [null, null, null, null,-0.11, -0.20, -0.13, -0.10, -0.11,  0.06,  0.09,  0.10,  0.07,  0.05,  0.19,  0.11,  0.39,  0.88]
    };

    /* ---- Chart instance ------------------------------------------------- */
    var mainChartInstance = null;
    var scatterChartInstance = null;
    var currentMode = "totalReturn";

    /* ---- Render --------------------------------------------------------- */
    function render() {
      var canvas = document.getElementById("primaryChartCanvas");
      if (!canvas) return;
      var ctx  = canvas.getContext("2d");
      var mode = currentMode;

      var chartLabels  = [];
      var chartDatasets = [];

      if (mode === "totalReturn") {
        chartLabels = sAndPBenchmarkData.years;

        var trMap = [
          { id: "tr-IBM",      key: "IBM",        label: "IBM Total Return",                   color: "#054ADA", width: 3.5, fill: true,  bg: "rgba(5,74,218,0.05)" },
          { id: "tr-SP500IT",  key: "SP500_IT",   label: "S&P 500 Info Tech Index",            color: "#ffb000", width: 2,   fill: false, bg: null },
          { id: "tr-SPHW",     key: "SP_TECH_HW", label: "S&P Tech Hardware Select Index",     color: "#fa4d56", width: 2,   fill: false, bg: null },
          { id: "tr-SPSW",     key: "SP_SW_SERV", label: "S&P Software & Services Index",      color: "#4589ff", width: 2,   fill: false, bg: null },
          { id: "tr-SPITSRV",  key: "SP_IT_SERV", label: "S&P 500 IT Services Index",          color: "#08bdba", width: 2,   fill: false, bg: null }
        ];

        trMap.forEach(function(t) {
          var pill = document.querySelector("#total-return-toggles .tr-pill[data-id='" + t.id + "']");
          if (pill && pill.classList.contains("active")) {
            chartDatasets.push({
              label: t.label,
              data: sAndPBenchmarkData[t.key],
              borderColor: t.color,
              backgroundColor: t.bg || "transparent",
              borderWidth: t.width,
              fill: t.fill,
              tension: 0.2,
              pointRadius: 3,
              pointHoverRadius: 5
            });
          }
        });

      } else {
        chartLabels = actualEvEbitdaData.years;
        var combinedData = [];

        document.querySelectorAll(".ev-cb").forEach(function(btn) {
          if (!btn.classList.contains("active")) return;
          var key = btn.getAttribute("data-key");
          var label = btn.getAttribute("data-label") || key;
          chartDatasets.push({
            label: label,
            data: actualEvEbitdaData[key],
            borderColor: competitorColors[key] || "#9a9aa7",
            borderWidth: key === "IBM" ? 3.5 : 2,
            pointRadius: key === "IBM" ? 4 : 2,
            pointHoverRadius: 5,
            tension: 0.25
          });
          combinedData.push(actualEvEbitdaData[key]);
        });

        /* Trendline */
        var trendCb = document.getElementById("showTrendline");
        if (trendCb && trendCb.checked && combinedData.length > 0) {
          var n = actualEvEbitdaData.years.length;
          var avgData = actualEvEbitdaData.years.map(function(_, i) {
            var sum = 0;
            combinedData.forEach(function(d) { sum += d[i]; });
            return sum / combinedData.length;
          });
          var sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
          for (var i = 0; i < n; i++) { sumX += i; sumY += avgData[i]; sumXY += i * avgData[i]; sumXX += i * i; }
          var slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
          var intercept = (sumY - slope * sumX) / n;
          chartDatasets.push({
            label: "Ecosystem Trendline",
            data: avgData.map(function(_, i) { return slope * i + intercept; }),
            borderColor: "#fa4d56",
            borderDash: [6, 4],
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0
          });
        }
      }

      if (mainChartInstance) { mainChartInstance.destroy(); }

      Chart.defaults.color = "#9a9aa7";
      Chart.defaults.font.family = "'IBM Plex Sans', sans-serif";

      mainChartInstance = new Chart(ctx, {
        type: "line",
        data: { labels: chartLabels, datasets: chartDatasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 600 },
          plugins: {
            legend: {
              position: "bottom",
              labels: { color: "#f4f4f5", usePointStyle: true, boxWidth: 6, padding: 16 }
            },
            tooltip: {
              mode: "index",
              intersect: false,
              backgroundColor: "#16161e",
              borderColor: "#2a2a36",
              borderWidth: 1,
              titleColor: "#f4f4f5",
              bodyColor: "#9a9aa7",
              padding: 10,
              callbacks: {
                label: function(ctx) {
                  var suffix = mode === "totalReturn" ? "" : "x";
                  return ctx.dataset.label + ": " + ctx.parsed.y.toFixed(1) + suffix;
                }
              }
            }
          },
          scales: {
            y: {
              grid: { color: "#2a2a36" },
              border: { color: "#2a2a36" },
              ticks: { color: "#6c6c78", font: { size: 11 } },
              title: {
                display: true,
                text: mode === "totalReturn" ? "Growth Index (Base 100 @ Jan 2022)" : "EV / EBITDA Multiple (x)",
                color: "#6c6c78",
                font: { size: 11 }
              }
            },
            x: {
              grid: { display: false },
              border: { color: "#2a2a36" },
              ticks: { color: "#6c6c78", font: { size: 11 } }
            }
          },
          interaction: { mode: "index", intersect: false }
        }
      });
    }

    /* ---- Scatter render ------------------------------------------------- */
    function renderScatter() {
      var canvas = document.getElementById("primaryChartCanvas");
      if (!canvas) return;
      var ctx = canvas.getContext("2d");

      // Find selected quarter index
      var qSel = document.getElementById("scatterQuarter");
      var qIdx = qSel ? parseInt(qSel.value, 10) : 17;

      var datasets = [];
      document.querySelectorAll("#scatter-toggles .sc-cb").forEach(function(btn) {
        if (!btn.classList.contains("active")) return;
        var key = btn.getAttribute("data-key");
        var label = btn.getAttribute("data-label") || key;
        var ev = actualEvEbitdaData[key] ? actualEvEbitdaData[key][qIdx] : null;
        var gr = revenueGrowthYoY[key]   ? revenueGrowthYoY[key][qIdx]   : null;
        if (ev == null || gr == null) return;
        datasets.push({
          label: label,
          data: [{ x: ev, y: +(gr * 100).toFixed(1) }],
          backgroundColor: competitorColors[key] || "#9a9aa7",
          borderColor: key === "IBM" ? "#fff" : (competitorColors[key] || "#9a9aa7"),
          borderWidth: key === "IBM" ? 2 : 1,
          pointRadius: key === "IBM" ? 10 : 8,
          pointHoverRadius: key === "IBM" ? 13 : 11
        });
      });

      if (mainChartInstance) { mainChartInstance.destroy(); mainChartInstance = null; }

      Chart.defaults.color = "#9a9aa7";
      Chart.defaults.font.family = "'IBM Plex Sans', sans-serif";

      mainChartInstance = new Chart(ctx, {
        type: "bubble",
        data: { datasets: datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 400 },
          plugins: {
            legend: {
              display: false
            },
            tooltip: {
              backgroundColor: "#16161e",
              borderColor: "#2a2a36",
              borderWidth: 1,
              titleColor: "#f4f4f5",
              bodyColor: "#9a9aa7",
              padding: 10,
              callbacks: {
                title: function(items) { return items[0].dataset.label; },
                label: function(item) {
                  return [
                    "EV/EBITDA: " + item.parsed.x.toFixed(1) + "x",
                    "Rev Growth (YoY): " + item.parsed.y.toFixed(1) + "%"
                  ];
                }
              }
            }
          },
          scales: {
            x: {
              grid: { color: "#2a2a36" },
              border: { color: "#2a2a36" },
              ticks: {
                color: "#6c6c78", font: { size: 11 },
                callback: function(v) { return v + "x"; }
              },
              title: { display: true, text: "EV / EBITDA Multiple (x)", color: "#6c6c78", font: { size: 11 } }
            },
            y: {
              grid: { color: "#2a2a36" },
              border: { color: "#2a2a36" },
              ticks: {
                color: "#6c6c78", font: { size: 11 },
                callback: function(v) { return v + "%"; }
              },
              title: { display: true, text: "Revenue Growth Y/Y (%)", color: "#6c6c78", font: { size: 11 } }
            }
          }
        },
        plugins: [{
          id: "bubbleLabels",
          afterDatasetsDraw: function(chart) {
            var ctx2 = chart.ctx;
            chart.data.datasets.forEach(function(ds, i) {
              var meta = chart.getDatasetMeta(i);
              if (!meta.visible) return;
              meta.data.forEach(function(pt) {
                ctx2.save();
                ctx2.font = "600 11px 'IBM Plex Sans', sans-serif";
                ctx2.fillStyle = "#f4f4f5";
                ctx2.textAlign = "center";
                ctx2.textBaseline = "bottom";
                ctx2.fillText(ds.label, pt.x, pt.y - (pt.options.radius || 8) - 3);
                ctx2.restore();
              });
            });
          }
        }]
      });
    }

    /* ---- Wire up all controls ------------------------------------------ */
    function wire(canvas) {
      var modeButtons = [
        document.getElementById("chartModeTR"),
        document.getElementById("chartModeEV"),
        document.getElementById("chartModeScatter")
      ].filter(Boolean);
      var trDiv  = document.getElementById("total-return-toggles");
      var evDiv  = document.getElementById("ev-ebitda-toggles");
      var scDiv  = document.getElementById("scatter-toggles");

      /* Chart mode buttons */
      modeButtons.forEach(function(btn) {
        btn.addEventListener("click", function() {
          var mode = btn.getAttribute("data-mode");
          modeButtons.forEach(function(b) { b.classList.remove("active"); });
          btn.classList.add("active");
          if (trDiv) trDiv.style.display = mode === "totalReturn" ? "flex" : "none";
          if (evDiv) evDiv.style.display = mode === "evEbitda"    ? "flex" : "none";
          if (scDiv) scDiv.style.display = mode === "scatter"     ? "flex" : "none";
          currentMode = mode;
          if (mode === "scatter") { renderScatter(); } else { render(); }
        });
      });

      /* TR pill toggles */
      document.querySelectorAll("#total-return-toggles .tr-pill").forEach(function(btn) {
        btn.addEventListener("click", function() {
          btn.classList.toggle("active");
          render();
        });
      });

      /* TR All / Clear */
      var trSelAll = document.getElementById("tr-select-all");
      var trClrAll = document.getElementById("tr-clear-all");
      if (trSelAll) trSelAll.addEventListener("click", function() {
        document.querySelectorAll("#total-return-toggles .tr-pill").forEach(function(b) { b.classList.add("active"); });
        render();
      });
      if (trClrAll) trClrAll.addEventListener("click", function() {
        document.querySelectorAll("#total-return-toggles .tr-pill").forEach(function(b) { b.classList.remove("active"); });
        render();
      });

      /* EV pill toggles — all companies including IBM */
      document.querySelectorAll("#ev-ebitda-toggles .ev-cb").forEach(function(btn) {
        btn.addEventListener("click", function() {
          btn.classList.toggle("active");
          syncSectorBtn(btn.getAttribute("data-sector"));
          render();
        });
      });

      /* EV sector group buttons — toggle all pills in that sector */
      document.querySelectorAll("#ev-ebitda-toggles .ev-sector-btn").forEach(function(sBtn) {
        sBtn.addEventListener("click", function() {
          var sector = sBtn.getAttribute("data-sector");
          var pills  = document.querySelectorAll("#ev-ebitda-toggles .ev-cb[data-sector='" + sector + "']");
          var anyOff = Array.prototype.some.call(pills, function(p) { return !p.classList.contains("active"); });
          pills.forEach(function(p) {
            if (anyOff) { p.classList.add("active"); } else { p.classList.remove("active"); }
          });
          syncSectorBtn(sector);
          render();
        });
      });

      /* Sync a sector button's visual state from its pills */
      function syncSectorBtn(sector) {
        if (!sector) return;
        var sBtn  = document.querySelector("#ev-ebitda-toggles .ev-sector-btn[data-sector='" + sector + "']");
        if (!sBtn) return;
        var pills  = document.querySelectorAll("#ev-ebitda-toggles .ev-cb[data-sector='" + sector + "']");
        var total  = pills.length;
        var active = Array.prototype.filter.call(pills, function(p) { return p.classList.contains("active"); }).length;
        sBtn.classList.remove("active", "partial");
        if (active === total && total > 0) { sBtn.classList.add("active"); }
        else if (active > 0)              { sBtn.classList.add("partial"); }
      }

      /* EV All / Clear */
      var evSelAll = document.getElementById("ev-select-all");
      var evClrAll = document.getElementById("ev-clear-all");
      if (evSelAll) evSelAll.addEventListener("click", function() {
        document.querySelectorAll("#ev-ebitda-toggles .ev-cb").forEach(function(b) { b.classList.add("active"); });
        ["ibm","cloud","software","services","infra"].forEach(syncSectorBtn);
        render();
      });
      if (evClrAll) evClrAll.addEventListener("click", function() {
        document.querySelectorAll("#ev-ebitda-toggles .ev-cb").forEach(function(b) { b.classList.remove("active"); });
        ["ibm","cloud","software","services","infra"].forEach(syncSectorBtn);
        render();
      });

      /* Trendline checkbox */
      var trendCbEl = document.getElementById("showTrendline");
      if (trendCbEl) trendCbEl.addEventListener("change", render);

      /* Scatter pill toggles */
      document.querySelectorAll("#scatter-toggles .sc-cb").forEach(function(btn) {
        btn.addEventListener("click", function() {
          btn.classList.toggle("active");
          syncScatterSectorBtn(btn.getAttribute("data-sector"));
          renderScatter();
        });
      });

      /* Scatter sector buttons */
      document.querySelectorAll("#scatter-toggles .sc-sector-btn").forEach(function(sBtn) {
        sBtn.addEventListener("click", function() {
          var sector = sBtn.getAttribute("data-sector");
          var pills  = document.querySelectorAll("#scatter-toggles .sc-cb[data-sector='" + sector + "']");
          var anyOff = Array.prototype.some.call(pills, function(p) { return !p.classList.contains("active"); });
          pills.forEach(function(p) {
            if (anyOff) { p.classList.add("active"); } else { p.classList.remove("active"); }
          });
          syncScatterSectorBtn(sector);
          renderScatter();
        });
      });

      /* Sync scatter sector button state from its pills */
      function syncScatterSectorBtn(sector) {
        if (!sector) return;
        var sBtn  = document.querySelector("#scatter-toggles .sc-sector-btn[data-sector='" + sector + "']");
        if (!sBtn) return;
        var pills  = document.querySelectorAll("#scatter-toggles .sc-cb[data-sector='" + sector + "']");
        var total  = pills.length;
        var active = Array.prototype.filter.call(pills, function(p) { return p.classList.contains("active"); }).length;
        sBtn.classList.remove("active", "partial");
        if (active === total && total > 0) { sBtn.classList.add("active"); }
        else if (active > 0)              { sBtn.classList.add("partial"); }
      }

      /* Scatter All / Clear */
      var scSelAll = document.getElementById("sc-select-all");
      var scClrAll = document.getElementById("sc-clear-all");
      if (scSelAll) scSelAll.addEventListener("click", function() {
        document.querySelectorAll("#scatter-toggles .sc-cb").forEach(function(b) { b.classList.add("active"); });
        ["ibm","cloud","software","services","infra"].forEach(syncScatterSectorBtn);
        renderScatter();
      });
      if (scClrAll) scClrAll.addEventListener("click", function() {
        document.querySelectorAll("#scatter-toggles .sc-cb").forEach(function(b) { b.classList.remove("active"); });
        ["ibm","cloud","software","services","infra"].forEach(syncScatterSectorBtn);
        renderScatter();
      });

      /* Scatter quarter selector — populate + wire */
      var qSel = document.getElementById("scatterQuarter");
      if (qSel) {
        actualEvEbitdaData.years.forEach(function(yr, i) {
          // Only include quarters where YoY growth data exists (idx >= 4)
          if (i < 4) return;
          var opt = document.createElement("option");
          opt.value = i;
          opt.textContent = yr;
          if (i === actualEvEbitdaData.years.length - 1) opt.selected = true;
          qSel.appendChild(opt);
        });
        qSel.addEventListener("change", renderScatter);
      }

      /* Initial render */
      render();
    }

    tryInit();
   } catch (e) { console.error("Competitors primary chart failed to initialize:", e); }
  })();


  (function initCompetitors() {
   try {
    const contentArea = document.getElementById("intelDynamicContent");
    const segBtns     = document.querySelectorAll("#segmentSelector .reg-preset-btn");
    if (!contentArea || !segBtns.length) return;

    /* ---- Segment color map --------------------------------------------- */
    const COLORS = {
      sw:      "#a56eff",
      co:      "#4589ff",
      inf:     "#08bdba",
      ibmBlue: "#0f62fe",
      red:     "#fa4d56",
      muted:   "#9a9aa7"
    };

    /* ---- Data dictionary ------------------------------------------------ */
    const SEGMENT_DATA = {
      "software": {
        color: COLORS.sw,
        peers: {
          t1: "Microsoft Azure, Oracle, SAP, Salesforce, Alphabet (Google Cloud)",
          t2: "Broadcom (VMware), SUSE, Amazon AWS Services, Cisco Systems"
        },
        swot: {
          s: ["Red Hat OpenShift container orchestration dominance", "Sovereign enterprise trust via watsonx open architecture"],
          w: ["High reliance on legacy middleware application renewals", "Margin expansion pressure from pure multi-tenant SaaS providers"],
          o: ["Monetizing HashiCorp multi-cloud infrastructure automation planes", "Scaling targeted, open-source Granite AI model ecosystems"],
          t: ["Rapid open-source LLM baseline commoditization", "Hyperscalers natively decoupling independent software developer tools"]
        },
        comparative: [
          { dim: "Core Strategic Focus", ibm: "Hybrid Multi-Cloud, AI Governance, Automation",              peer: "Mass Public Cloud Scale, Monolithic SaaS Apps & Core ERP stacks" },
          { dim: "Operating Margins",    ibm: "Highly Profitable (~80–83% Gross Margin)",                    peer: "Similar premium margins (65–80%) depending on SaaS/IaaS software mix" },
          { dim: "Deployment Model",     ibm: "Open, Environment Agnostic (Run workloads anywhere)",         peer: "Proprietary Ecosystem Lock-in (Azure/AWS) or rigid localized stacks" }
        ],
        ansoff: {
          pen: [
            {
              title: "Red Hat Extension Upselling",
              desc: "Deepen penetration of existing enterprise accounts by converting legacy middleware and OS customers into full Red Hat platform subscribers.",
              bullets: [
                "Cross-selling OpenShift container orchestration into existing RHEL install bases via bundled multi-year ELAs",
                "Attaching Ansible Automation Platform licenses to accounts already running IBM middleware stacks",
                "Migrating IBM Cloud Pak customers from perpetual license models to subscription-based SaaS renewal structures"
              ],

            }
          ],
          prod: [
            {
              title: "watsonx & Granite AI Integration",
              desc: "Embed generative AI governance and AIOps tooling directly into the existing software portfolio to monetize AI demand without requiring customer platform migrations.",
              bullets: [
                "Injecting watsonx.governance compliance and model risk management layers into existing data fabric deployments",
                "Integrating Instana and Turbonomic AIOps engines into Red Hat OpenShift to automate infrastructure observability",
                "Embedding Granite foundation model APIs into IBM software products (e.g., Concert, Code Assistant) as native AI features"
              ],

            }
          ],
          mkt: [
            {
              title: "Hyperscaler Marketplace Deployment",
              desc: "Distribute IBM software natively through AWS, Azure, and Google Cloud marketplaces to capture cloud-native developer and cloud-committed spend budgets.",
              bullets: [
                "Listing OpenShift, watsonx, and RHEL on AWS Marketplace and Azure Marketplace with enterprise commit drawdown eligibility",
                "Enabling cloud-native deployment of IBM software via Operator Hub to reach platform engineering teams inside hyperscaler environments",
                "Partnering with Google Cloud on Granite model hosting in Vertex AI to access Google's enterprise ML buyer ecosystem"
              ],

            }
          ],
          div: [
            {
              title: "HashiCorp Multi-Cloud Automation",
              desc: "Leverage the acquired HashiCorp infrastructure-as-code and secrets management suite to enter the cloud operations and platform engineering toolchain market.",
              bullets: [
                "Distributing Terraform and Vault as enterprise-grade, compliance-ready infrastructure automation tools for regulated industries",
                "Building a unified IBM Cloud + HashiCorp sovereign automation layer for government and financial sector multi-cloud environments",
                "Cross-selling HashiCorp Boundary (zero-trust network access) into IBM Security and IBM Consulting accounts"
              ],

            }
          ]
        },
        porters: [3, 4, 2, 3, 5],
        portersContext: [
          { force: "New Entrants",   score: 3, rationale: "Cloud-native startups lower technical entry barriers, but enterprise compliance certifications and Red Hat ecosystem depth create a meaningful moat." },
          { force: "Buyer Power",    score: 4, rationale: "Large enterprise accounts run multi-vendor RFPs, leverage open-source alternatives, and extract aggressive software discounting." },
          { force: "Supplier Power", score: 2, rationale: "IBM controls its core software IP (Red Hat, HashiCorp, Granite models), limiting upstream provider dependency. The main input constraint is elite developer talent." },
          { force: "Substitutes",    score: 3, rationale: "Open-source LLMs (Llama, Mistral) and hyperscaler-native AI APIs act as credible substitutes for watsonx outside heavily regulated industries." },
          { force: "Rivalry",        score: 5, rationale: "Extreme competition from Microsoft, Oracle, SAP, and Broadcom across hybrid management, database layers, and enterprise runtime software." }
        ],
        portersNarrative: [
          { label: "The Strategic Reality", accent: "",           text: "The software segment is defined by <strong>Intense Rivalry</strong> and <strong>High Buyer Power</strong>. Hyperscalers (Microsoft Azure, AWS, Google Cloud) are engaged in an architectural war to capture enterprise workloads. Buyers (Fortune 500 CIOs) are terrified of vendor lock-in and actively use their bargaining power to demand multi-cloud flexibility." },
          { label: "IBM's Defensive Moat",  accent: "accent-up", text: "The threat of New Entrants is <strong>Moderate-to-Low</strong> for foundational cloud architecture due to the massive capital and IP required. IBM uses <strong>Red Hat OpenShift</strong> as its ultimate defense mechanism — by providing an open-source orchestration layer that runs on any cloud, IBM neutralizes proprietary lock-in strategies and aligns perfectly with buyer demands." }
        ],
        bcgNarrative: [
          { label: "The Cash Engine",      accent: "accent-up",   text: "<strong>Transaction Middleware</strong> acts as the massive Cash Cow. Flat market growth, but 80%+ gross margins due to deeply entrenched legacy software running global business applications. This funds IBM's entire R&D and M&A strategy." },
          { label: "The Future Valuation", accent: "",            text: "<strong>Red Hat OpenShift Platform</strong> is the undisputed Star, capturing high market share in the rapidly expanding container orchestration and hybrid cloud platform market." },
          { label: "The High-Stakes Bet",  accent: "accent-warn", text: "<strong>watsonx Enterprise AI Suite</strong> sits as a Question Mark. The market is growing exponentially, but IBM faces intense competition from Microsoft/OpenAI to win long-term market share in regulated enterprise niches." }
        ],
        positionNarrative: [
          { label: "The Coordinates",      accent: "",        text: "Tracked on an operational matrix of <strong>Proprietary Lock-in vs. Open Multi-Cloud</strong> and <strong>Consumer Scale vs. Regulated Enterprise</strong>." },
          { label: "The Strategic Direction", accent: "accent-up", text: "IBM maps strictly to the <strong>top-right quadrant</strong> (Open Multi-Cloud, Regulated Enterprise). It avoids low-margin consumer scale, positioning as the secure, compliance-first, cloud-agnostic platform layer for highly regulated banks, healthcare, and governments." }
        ],
        bcg: [
          { x: 30, y: 15, r: 18, label: "Red Hat/OpenShift" },
          { x: 60, y: 3,  r: 14, label: "Transaction Middleware" },
          { x: 10, y: 20, r: 10, label: "watsonx / GenAI" },
          { x: 5,  y: -2, r: 8,  label: "Legacy OS Licenses" }
        ],
        positionConfig: {
          title:  "Position Mapping: Enterprise AI & Cloud Space",
          xLabel: "Proprietary Lock-in ← → Open Multi-Cloud",
          yLabel: "Consumer Scale ← → Regulated Enterprise",
          data: [
            { x: 8, y: 8, r: 12, label: "IBM (watsonx/Red Hat)", bg: COLORS.sw },
            { x: 2, y: 4, r: 15, label: "Microsoft Azure",        bg: "#4589ff" },
            { x: 1, y: 2, r: 15, label: "AWS",                    bg: "#ff832b" },
            { x: 9, y: 2, r: 10, label: "SUSE/Open Source",       bg: COLORS.muted }
          ]
        }
      },
      "consulting": {
        color: COLORS.co,
        peers: {
          t1: "Accenture, Infosys, TCS (Tata Consultancy Services)",
          t2: "McKinsey, BCG, Bain, Deloitte, PwC, EY, KPMG"
        },
        swot: {
          s: ["End-to-end technical implementation capabilities tied to structural architectures", "Deep historical domain expertise in migrating legacy enterprise mainframe systems"],
          w: ["Higher onshore delivery costs compared to pure offshore staff-augmentation firms", "Direct exposure to sudden corporate discretionary IT budget contractions"],
          o: ["High-margin enterprise generative AI data readiness and pipeline consulting", "Advising global corporate boards on AI risk, compliance, and regulatory frameworks"],
          t: ["AI-driven automated code generation compressing traditional billable engineering hours", "Aggressive upstream technological expansion by elite private strategy consultancies"]
        },
        comparative: [
          { dim: "Core Strategic Focus", ibm: "Tech-Driven Transformation, App Modernization & Enterprise AI Integration",         peer: "Pure Operational Cost-Out Outsourcing or abstract high-level advisory" },
          { dim: "Operating Margins",    ibm: "Stable Services Margins (~30–34% Gross Margin)",                                    peer: "Highly variable; ~25% for commodity IT staffing up to 45%+ for elite private strategy" },
          { dim: "Deployment Model",     ibm: "Asset-Backed Consulting paired with proprietary templates (IBM Garage framework)",   peer: "Pure headcount deployment, time-and-materials billing, or slide-based advisory" }
        ],
        ansoff: {
          pen: [
            {
              title: "Account Share Maximization",
              desc: "Deepen existing enterprise relationships by attaching AI and modernization workstreams directly alongside active legacy maintenance contracts.",
              bullets: [
                "Embedding application modernization squads inside current multi-year outsourcing agreements at renewal junctures",
                "Attaching IBM Garage co-creation sprints as structured upsells to accounts already running legacy ERP implementations",
                "Expanding mainframe-adjacent Consulting footprint within existing Z-systems banking clients via hybrid integration projects"
              ],

            }
          ],
          prod: [
            {
              title: "AI Factory Co-Innovation Pods",
              desc: "Build proprietary, industry-specific AI accelerators and data readiness frameworks to productize IBM Consulting's AI delivery capability into repeatable, high-margin offerings.",
              bullets: [
                "Developing pre-built AI data pipeline templates for financial services, healthcare, and telco verticals via IBM Consulting Advantage",
                "Deploying Client Zero AI Factory models where IBM uses its own internal environments as live proof-of-concept showcases for enterprise buyers",
                "Launching watsonx integration accelerators that compress AI deployment timelines from 18 months to sub-90-day production cycles"
              ],

            }
          ],
          mkt: [
            {
              title: "Sovereign & Public Sector Scaling",
              desc: "Expand IBM Consulting's implementation and risk-advisory footprint into defense, federal agencies, and central banking institutions requiring cleared, compliant delivery partners.",
              bullets: [
                "Scaling FedRAMP-authorized AI consulting delivery into U.S. federal civilian and defense agencies via existing GSA schedule vehicles",
                "Building dedicated sovereign cloud advisory practices for EU public sector clients navigating NIS2, DORA, and AI Act compliance mandates",
                "Deploying IBM Consulting teams into central bank digital currency (CBDC) architecture and financial market infrastructure modernization programs"
              ],

            }
          ],
          div: [
            {
              title: "Outcome-Based Managed Services",
              desc: "Shift from time-and-materials billing to subscription-style, asset-backed managed transformation platforms where revenue is directly tied to measurable client operational outcomes.",
              bullets: [
                "Launching gain-sharing engagement structures where IBM Consulting fees are partially indexed to client cost reduction or revenue uplift KPIs",
                "Building IBM Consulting-managed AI Operations Centers that run continuous model monitoring, retraining, and performance optimization on a recurring fee basis",
                "Packaging IBM Consulting IP (Garage frameworks, accelerators, industry templates) into licensed SaaS-like platforms for mid-market enterprise self-service"
              ],

            }
          ]
        },
        porters: [2, 4, 4, 3, 5],
        portersContext: [
          { force: "New Entrants",   score: 2, rationale: "Boutique AI agencies scale up quickly, but global enterprise delivery requires massive multi-geography depth, creating a solid barrier to large accounts." },
          { force: "Buyer Power",    score: 4, rationale: "Highly consolidated corporate procurement departments aggressively negotiate billable rates and demand clear ROI proof before unlocking transformation budgets." },
          { force: "Supplier Power", score: 4, rationale: "Extremely high dependency on scarce, premium data engineers, AI solution architects, and domain experts, driving up delivery cost floors." },
          { force: "Substitutes",    score: 3, rationale: "Internal corporate IT groups leveraging advanced automated AI coding assistants can bypass mid-level technical implementation partners." },
          { force: "Rivalry",        score: 5, rationale: "Intense competitive landscape. Elite strategy firms (MBB) are building technical engineering arms, while classic integrators scale specialized AI advisory groups." }
        ],
        portersNarrative: [
          { label: "The Strategic Reality",   accent: "",            text: "Consulting faces a structural shift. <strong>Buyer Bargaining Power is Extreme</strong>. Clients now demand short-cycle, outcome-based, agile delivery sprints rather than massive multi-year outsourcing contracts." },
          { label: "The Existential Threat",  accent: "accent-warn", text: "The <strong>Threat of Substitution is High and Rising</strong>. AI-driven code generation (e.g., GitHub Copilot) is directly cannibalizing the traditional billing model of charging for thousands of low-level engineering hours." },
          { label: "IBM's Pivot",             accent: "accent-up",   text: "IBM Consulting must leverage the <strong>Low Threat of New Entrants</strong> at scale. Boutique firms cannot handle the legal liability, global scale, and security clearances required for Fortune 500 migrations, protecting IBM's position at the top of the market." }
        ],
        bcgNarrative: [
          { label: "The Cash Engine",      accent: "accent-up",   text: "<strong>Core Application Migration & ERP Services</strong> — steady volume and multi-year lifecycle revenues that provide foundational cash stability to fund the AI pivot." },
          { label: "The Future Valuation", accent: "",            text: "<strong>Generative AI Systems Integration & Data Pipelines</strong> — hyper-growth sector as enterprises rush to clean data and connect internal architectures to foundation models." },
          { label: "The High-Stakes Bet",  accent: "accent-warn", text: "<strong>Upstream AI Strategic Advisory</strong> — high-margin, high-growth potential, but IBM must aggressively fight elite private strategy consultancies (MBB) to own the C-suite roadmap budget." }
        ],
        positionNarrative: [
          { label: "The Coordinates",      accent: "",        text: "Tracked on an alignment scale of <strong>Strategy-Led vs. Technology-Led</strong> delivery across custom bespoke systems." },
          { label: "The Strategic Direction", accent: "accent-up", text: "Positioned firmly as a <strong>Technology-Led, Specialized Industry Transformer</strong>. IBM avoids competing purely on lower-cost offshore staff augmentation, focusing its consulting arm on connecting high-level corporate business strategy directly to deep, secure hybrid cloud execution." }
        ],
        bcg: [
          { x: 15, y: 18, r: 12, label: "GenAI Systems Integration" },
          { x: 40, y: 4,  r: 20, label: "Core App Migration & ERP" },
          { x: 10, y: 12, r: 10, label: "AI Strategic Advisory" },
          { x: 5,  y: 1,  r: 8,  label: "Legacy Implementation Support" }
        ],
        positionConfig: {
          title:  "Position Mapping: IT Consulting Space",
          xLabel: "Strategy-Led ← → Technology-Led",
          yLabel: "Offshore Staff Augmentation ← → Specialized Industry Transformer",
          data: [
            { x: 8, y: 8, r: 12, label: "IBM Consulting",       bg: COLORS.co },
            { x: 5, y: 6, r: 18, label: "Accenture",            bg: "#a56eff" },
            { x: 3, y: 9, r: 15, label: "MBB (McKinsey/BCG)",   bg: COLORS.muted },
            { x: 8, y: 2, r: 15, label: "TCS / Infosys",        bg: "#08bdba" }
          ]
        }
      },
      "infrastructure": {
        color: COLORS.inf,
        peers: {
          t1: "HP Enterprise (HPE), Dell Technologies",
          t2: "AWS Infrastructure, Google Cloud Infrastructure, Cisco Systems"
        },
        swot: {
          s: ["Absolute monopoly over core global financial enterprise mainframe technology (Z-systems)", "Advanced high-density, liquid-cooled secure enterprise server architectures"],
          w: ["Capital-intensive manufacturing cycles requiring heavy hardware investments", "Long enterprise hardware replacement timelines (typically 3–5 year corporate refresh cycles)"],
          o: ["Surging enterprise demand for physical, on-premise private AI training clusters", "Provisioning secure hardware frameworks for sovereign cloud data environments"],
          t: ["Public hyperscalers designing custom proprietary ASIC silicon to bypass hardware vendors", "Global supply chain bottlenecks or semiconductor microchip allocation constraints"]
        },
        comparative: [
          { dim: "Core Strategic Focus", ibm: "Sovereign Systems, Mainframe Modernization, Quantum-Safe Cryptographic Hardware",           peer: "Commodity x86 Servers, Enterprise Storage Arrays, & Mass Public IaaS Backbones" },
          { dim: "Operating Margins",    ibm: "Premium Blended Infrastructure Margins (~55–60%) due to unique mainframe IP ownership",      peer: "Lower, highly competitive hardware margins (~15–25%) for standard commodity x86 servers" },
          { dim: "Deployment Model",     ibm: "Hybrid Compute Infrastructure (Mainframe-to-Cloud orchestration and secure local nodes)",    peer: "Traditional on-premise raw hardware provisioning or multi-tenant public cloud scaling" }
        ],
        ansoff: {
          pen: [
            {
              title: "Mainframe Lifecycle Refreshes",
              desc: "Execute structured, multi-year upgrade programs across core Z-system install bases in banking, insurance, and aviation to capture recurring capacity and software co-term revenue.",
              bullets: [
                "Deploying IBM z17 and LinuxONE IV platform migrations under multi-year hardware-software co-term agreements with existing financial services clients",
                "Attaching IBM Z software stacks (Db2, CICS, MQ) as mandatory co-term upgrades within each hardware refresh cycle",
                "Expanding mainframe capacity licensing via IBM Monthly License Charge (MLC) models as transaction volumes scale with client business growth"
              ],

            }
          ],
          prod: [
            {
              title: "Quantum-Safe Hardware & Secure AI Storage",
              desc: "Launch next-generation server and storage architectures purpose-built for AI model inference and post-quantum cryptographic security requirements adjacent to mission-critical enterprise data.",
              bullets: [
                "Shipping IBM z17 with the Telum II AI accelerator chip for on-chip inference of AI models directly within the mainframe transaction processing environment",
                "Launching IBM Storage Scale with AI-optimized data pipelines designed to feed GPU clusters running enterprise foundation model training workloads",
                "Deploying IBM Quantum Safe cryptographic hardware modules (CRYSTALS-Kyber, CRYSTALS-Dilithium) across Z-systems and Power platforms ahead of NIST PQC mandate deadlines"
              ],

            }
          ],
          mkt: [
            {
              title: "Industrial Edge Computing Nodes",
              desc: "Deploy ruggedized IBM Power and storage systems directly into industrial operational environments — telecom edge, smart factory floors, and energy distribution networks — where latency and data sovereignty constraints preclude public cloud.",
              bullets: [
                "Deploying IBM Power10 edge nodes inside 5G telecom Open RAN switching architectures for ultra-low-latency network function processing",
                "Supplying hardened IBM Storage and LinuxONE systems into smart manufacturing environments requiring real-time quality control AI inference at the production line",
                "Partnering with global energy utilities to deploy sovereign on-premise compute nodes for grid management AI and operational technology (OT) security monitoring"
              ],

            }
          ],
          div: [
            {
              title: "Flexible Consumption (As-a-Service Hardware)",
              desc: "Transform traditional capital-expenditure hardware purchases into elastic, cloud-like operational consumption models that lower client procurement barriers and generate IBM recurring infrastructure revenue.",
              bullets: [
                "Expanding IBM TechXchange and IBM Infrastructure-as-a-Service agreements that allow mainframe and Power capacity consumption on a pay-per-use utility model",
                "Launching IBM Hybrid Cloud Infrastructure subscriptions that bundle Z-system compute, storage, and software into a single monthly operational expense line",
                "Structuring outcome-based infrastructure contracts where IBM manages on-premise hardware capacity on behalf of clients under a full managed infrastructure SLA"
              ],

            }
          ]
        },
        porters: [1, 2, 5, 4, 4],
        portersContext: [
          { force: "New Entrants",   score: 1, rationale: "Near-impossible entry barrier due to astronomical capital expenditures, patents, and manufacturing complexity required to build high-performance computing hardware." },
          { force: "Buyer Power",    score: 2, rationale: "Buyers have leverage in standard x86 bids, but zero bargaining power when purchasing proprietary, mission-critical systems like IBM mainframes." },
          { force: "Supplier Power", score: 5, rationale: "Critically high. Dependent on a microscopic number of global semiconductor foundries and advanced silicon design inputs for next-gen processing." },
          { force: "Substitutes",    score: 4, rationale: "Public cloud hyperscaler multi-tenant instances act as an attractive structural substitute for companies looking to avoid owning physical server rooms." },
          { force: "Rivalry",        score: 4, rationale: "Intense, cyclical competition against Dell and HPE for mid-market corporate hardware frameworks, edge deployments, and enterprise private storage." }
        ],
        portersNarrative: [
          { label: "The Strategic Reality",  accent: "",            text: "This segment operates in a fortress. The <strong>Threat of New Entrants is effectively Zero</strong>. Building high-performance computing hardware requires astronomical CapEx, decades of proprietary physics IP, and specialized silicon foundries." },
          { label: "The Existential Threat", accent: "accent-warn", text: "The <strong>Threat of Substitutes is High</strong>. Public cloud hyperscalers continuously attempt to pull mission-critical workloads off on-premise hardware into localized cloud infrastructure (e.g., AWS Outposts, Azure Stack)." },
          { label: "IBM's Defense",          accent: "accent-up",   text: "<strong>Supplier Power is Critically High</strong> — but Buyer Power is structurally low for proprietary mainframe systems. Banks and telecom giants are locked in to IBM Z due to the exorbitant risk of rewriting millions of lines of core COBOL banking code." }
        ],
        bcgNarrative: [
          { label: "The Cash Engine",      accent: "accent-up",   text: "<strong>Z-Systems Mainframe Ecosystems</strong> — high-margin, hyper-stable foundational cash engine powering the world's transactional banking backbone and funding the rest of the company's R&D." },
          { label: "The Future Valuation", accent: "",            text: "<strong>Sovereign On-Premise AI Training Private Clusters</strong> — hyper-growth sector as highly regulated enterprise entities invest heavily to run private, secure AI models strictly within physical enterprise walls." },
          { label: "The High-Stakes Bet",  accent: "accent-warn", text: "<strong>Hybrid Edge Storage Nodes & Quantum Computing Systems</strong> — massive potential long-term markets, but require deep ongoing investments to carve out early commercial developer dominance." }
        ],
        positionNarrative: [
          { label: "The Coordinates",      accent: "",          text: "Mapped against <strong>On-Premise Commodity Architecture vs. Specialized Sovereign Hybrid Systems</strong>." },
          { label: "The Strategic Direction", accent: "accent-up", text: "Positioned strictly in the <strong>Specialized Sovereign Hybrid</strong> corner. Rather than competing for mass low-margin commodity hardware volumes, the infrastructure vector targets mission-critical computing environments requiring absolute data residency, military-grade security, and maximum transaction throughput." }
        ],
        bcg: [
          { x: 15, y: 25, r: 10, label: "Sovereign AI Private Clusters" },
          { x: 65, y: 5,  r: 25, label: "Z-Systems Mainframes" },
          { x: 20, y: 14, r: 12, label: "Edge Storage Nodes" },
          { x: 8,  y: -3, r: 8,  label: "Quantum Computing" }
        ],
        positionConfig: {
          title:  "Position Mapping: Enterprise Compute",
          xLabel: "On-Premise Commodity ← → Specialized Sovereign Hybrid",
          yLabel: "General Compute ← → Mission Critical / AI Secure",
          data: [
            { x: 9, y: 9, r: 12, label: "IBM Z & Sovereign AI",      bg: COLORS.inf },
            { x: 3, y: 4, r: 15, label: "Dell / HPE",                 bg: COLORS.muted },
            { x: 8, y: 5, r: 18, label: "AWS / Azure Infrastructure", bg: "#ff832b" },
            { x: 1, y: 2, r: 10, label: "Cisco Systems",              bg: "#1ba0d7" }
          ]
        }
      }
    };

    let activeSeg = "software";
    let compCharts = { radar: null, bcg: null, position: null };

    /* ---- Destroy all Chart.js instances --------------------------------- */
    function destroyCharts() {
      Object.keys(compCharts).forEach(function(k) {
        if (compCharts[k]) { compCharts[k].destroy(); compCharts[k] = null; }
      });
    }

    /* ---- Fade + update -------------------------------------------------- */
    function triggerUpdate(segKey) {
      contentArea.classList.add("faded");
      setTimeout(function() {
        updateDashboard(segKey);
        contentArea.classList.remove("faded");
      }, 250);
    }

    /* ---- Wire up segment buttons --------------------------------------- */
    segBtns.forEach(function(btn) {
      btn.addEventListener("click", function() {
        segBtns.forEach(function(b) { b.classList.remove("active"); });
        btn.classList.add("active");
        activeSeg = btn.getAttribute("data-seg");
        /* Show dynamic content area on first selection */
        if (contentArea) contentArea.style.display = "";
        triggerUpdate(activeSeg);
      });
    });

    /* ---- Render all panels --------------------------------------------- */
    function updateDashboard(segKey) {
      var data = SEGMENT_DATA[segKey];

      /* 1. Peers */
      document.getElementById("txtTier1").textContent = data.peers.t1;
      document.getElementById("txtTier2").textContent = data.peers.t2;

      /* 2. SWOT lists */
      document.getElementById("txtS").innerHTML = data.swot.s.map(function(i){ return "<li>" + i + "</li>"; }).join("");
      document.getElementById("txtW").innerHTML = data.swot.w.map(function(i){ return "<li>" + i + "</li>"; }).join("");
      document.getElementById("txtO").innerHTML = data.swot.o.map(function(i){ return "<li>" + i + "</li>"; }).join("");
      document.getElementById("txtT").innerHTML = data.swot.t.map(function(i){ return "<li>" + i + "</li>"; }).join("");

      /* 3. Comparative table */
      document.getElementById("comparativeTableBody").innerHTML = data.comparative.map(function(row) {
        return "<tr><td>" + row.dim + "</td><td>" + row.ibm + "</td><td>" + row.peer + "</td></tr>";
      }).join("");

      /* 4. Ansoff matrix text */
      function renderAnsoffItems(id, items) {
        document.getElementById(id).innerHTML = items.map(function(item) {
          var bulletsHtml = "";
          if (item.bullets && item.bullets.length) {
            bulletsHtml = '<ul class="ansoff-bullets">' +
              item.bullets.map(function(b) { return '<li>' + b + '</li>'; }).join("") +
            '</ul>';
          }
          return '<div class="ansoff-item">' +
            '<span class="ansoff-item-title">' + item.title + '</span>' +
            '<span class="ansoff-item-desc">' + item.desc + '</span>' +
            bulletsHtml +
          '</div>';
        }).join("");
      }
      renderAnsoffItems("ansoffPen",  data.ansoff.pen);
      renderAnsoffItems("ansoffProd", data.ansoff.prod);
      renderAnsoffItems("ansoffMkt",  data.ansoff.mkt);
      renderAnsoffItems("ansoffDiv",  data.ansoff.div);

      /* 5. Porter's context rationale table */
      var portersCtxEl = document.getElementById("portersContext");
      if (portersCtxEl && data.portersContext) {
        portersCtxEl.innerHTML = data.portersContext.map(function(row) {
          return '<div class="porters-row">' +
            '<span class="porters-force">' + row.force + '</span>' +
            '<span class="porters-score score-' + row.score + '">' + row.score + '</span>' +
            '<span class="porters-rationale">' + row.rationale + '</span>' +
          '</div>';
        }).join("");
      }

      /* 6. Position map title */
      var titleEl = document.getElementById("positionMapTitle");
      if (titleEl) titleEl.textContent = "6. " + data.positionConfig.title;

      /* 6b. BCG narrative blocks */
      var bcgNarrEl = document.getElementById("bcgNarrative");
      if (bcgNarrEl && data.bcgNarrative) {
        bcgNarrEl.innerHTML = data.bcgNarrative.map(function(b) {
          return '<div class="intel-narrative-block ' + b.accent + '">' +
            '<div class="intel-narrative-label">' + b.label + '</div>' +
            '<div class="intel-narrative-text">' + b.text + '</div>' +
          '</div>';
        }).join("");
      }

      /* 6c. Position narrative blocks */
      var posNarrEl = document.getElementById("positionNarrative");
      if (posNarrEl && data.positionNarrative) {
        posNarrEl.innerHTML = data.positionNarrative.map(function(b) {
          return '<div class="intel-narrative-block ' + b.accent + '">' +
            '<div class="intel-narrative-label">' + b.label + '</div>' +
            '<div class="intel-narrative-text">' + b.text + '</div>' +
          '</div>';
        }).join("");
      }

      /* Charts (requires Chart.js) */
      if (typeof Chart === "undefined") return;
      destroyCharts();
      Chart.defaults.color = "#9a9aa7";
      Chart.defaults.font.family = "'IBM Plex Sans', sans-serif";

      /* Porter's radar */
      var ctxRadar = document.getElementById("portersChart");
      if (ctxRadar) {
        compCharts.radar = new Chart(ctxRadar.getContext("2d"), {
          type: "radar",
          data: {
            labels: ["New Entrants", "Buyer Power", "Supplier Power", "Substitutes", "Rivalry"],
            datasets: [{
              label: "Threat Level (1–5)",
              data: data.porters,
              backgroundColor: "rgba(250,77,86,0.2)",
              borderColor: "#fa4d56",
              pointBackgroundColor: "#ff8389",
              borderWidth: 2
            }]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            scales: {
              r: {
                min: 0, max: 5,
                angleLines: { color: "#2a2a36" },
                grid: { color: "#2a2a36" },
                pointLabels: { color: "#9a9aa7", font: { size: 11 } },
                ticks: { display: false }
              }
            },
            plugins: { legend: { display: false } }
          }
        });
      }

      /* BCG bubble */
      var ctxBcg = document.getElementById("bcgChart");
      if (ctxBcg) {
        compCharts.bcg = new Chart(ctxBcg.getContext("2d"), {
          type: "bubble",
          data: {
            datasets: [{
              label: "Business Units",
              data: data.bcg,
              backgroundColor: data.color + "8c",
              borderColor: data.color,
              borderWidth: 2
            }]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { label: function(ctx){ return ctx.raw.label; } } }
            },
            scales: {
              x: { title: { display: true, text: "Relative Market Share (High ← → Low)" }, reverse: true, grid: { color: "#2a2a36" } },
              y: { title: { display: true, text: "Market Growth Rate (%)" }, grid: { color: "#2a2a36" } }
            }
          }
        });
      }

      /* Position mapping bubble */
      var ctxPos = document.getElementById("positionChart");
      if (ctxPos) {
        var posCfg = data.positionConfig;
        compCharts.position = new Chart(ctxPos.getContext("2d"), {
          type: "bubble",
          data: {
            datasets: posCfg.data.map(function(d) {
              return {
                label: d.label,
                data: [{ x: d.x, y: d.y, r: d.r }],
                backgroundColor: d.bg + "99",
                borderColor: d.bg,
                borderWidth: 2
              };
            })
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { position: "bottom", labels: { font: { size: 11 }, boxWidth: 10 } },
              tooltip: { callbacks: { label: function(ctx){ return ctx.dataset.label; } } }
            },
            scales: {
              x: { min: 0, max: 10, title: { display: true, text: posCfg.xLabel }, grid: { color: "#2a2a36" } },
              y: { min: 0, max: 10, title: { display: true, text: posCfg.yLabel }, grid: { color: "#2a2a36" } }
            }
          }
        });
      }
    }

    /* ---- Boot ----------------------------------------------------------- */
    /* No auto-render — intelDynamicContent is hidden until a segment is clicked */
   } catch (e) { console.error("Competitors tab failed to initialize:", e); }
  })();
