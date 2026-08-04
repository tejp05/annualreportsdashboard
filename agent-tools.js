/* ============================================================================
   agent-tools.js — window.CUGA: an agent tool layer over the whole dashboard.

   Two halves:
   1. TOOLS — data tools (read window.IBM_DATA) and page ACTIONS (switch tabs,
      configure the Regression Lab, open M&A era drawers). Any agent that can
      execute JavaScript — CUGA's browser mode, an Orchestrate custom
      extension, or the devtools console — calls:
          await window.CUGA.invoke("get_cagr", {metric:"revenue", from_year:2020, to_year:2025})
      Discovery: window.CUGA.manifest()  (JSON-schema per tool).
   2. CHAT PANEL — a small "Ask the data" panel (bottom-left) that talks to the
      Python CUGA agent server (agent/server.py, default http://localhost:8787).
      Fully optional: when the server is down the panel says so; the site is
      unaffected. Override the endpoint via window.CUGA_AGENT_URL.
   ========================================================================== */
(function () {
"use strict";

const D = window.IBM_DATA;
if (!D) return;

const FIN = D.financials;
const byYear = new Map(FIN.map(r => [r.year, r]));

const METRIC_UNITS = {
  revenue: "$M", netIncome: "$M", pretaxIncome: "$M", incomeTaxes: "$M",
  freeCashFlow: "$M", operatingCashFlow: "$M", capitalExpenditure: "$M",
  rdExpense: "$M", totalAssets: "$M", stockholdersEquity: "$M", totalDebt: "$M",
  marketCap: "$M", softwareARR: "$M", epsDiluted: "$", epsBasic: "$",
  dividendsPerShare: "$", stockPrice: "$", employees: "count",
};

const series = m => FIN.filter(r => r[m] != null).map(r => [r.year, r[m]]);
const inRange = (pairs, a, b) => pairs.filter(([y]) => y >= a && y <= b);
const badMetric = m => { throw new Error(`unknown metric '${m}' — call list_metrics`); };
const ck = m => { if (!(m in METRIC_UNITS)) badMetric(m); };

function ols(xs, ys) {
  const n = xs.length;
  const xm = xs.reduce((a, b) => a + b, 0) / n, ym = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i]-xm, dy = ys[i]-ym; sxx += dx*dx; sxy += dx*dy; syy += dy*dy; }
  if (sxx === 0 || syy === 0) return null;
  const slope = sxy / sxx, r = sxy / Math.sqrt(sxx * syy);
  return { slope, intercept: ym - slope * xm, r, r2: r * r, n };
}

/* ── Tool registry ─────────────────────────────────────────────────────────
   Each tool: { desc, params: {name: {type, desc, required?}}, fn(args) }   */
const TOOLS = {

  /* ---- data tools ---- */
  list_metrics: {
    desc: "Every metric key with unit and year coverage. Call first.",
    params: {},
    fn: () => Object.entries(METRIC_UNITS).map(([m, unit]) => {
      const s = series(m);
      return { metric: m, unit, from: s[0]?.[0] ?? null, to: s.at(-1)?.[0] ?? null, n: s.length };
    }),
  },

  get_financials_year: {
    desc: "Full financial record for one fiscal year (1911–2025).",
    params: { year: { type: "integer", desc: "fiscal year", required: true } },
    fn: ({ year }) => {
      const r = byYear.get(+year);
      if (!r) throw new Error(`no data for ${year} (coverage 1911–2025)`);
      return r;
    },
  },

  get_metric_series: {
    desc: "Year-by-year values of one metric over a range.",
    params: {
      metric: { type: "string", desc: "key from list_metrics", required: true },
      from_year: { type: "integer", desc: "default 1911" },
      to_year: { type: "integer", desc: "default 2025" },
    },
    fn: ({ metric, from_year = 1911, to_year = 2025 }) => {
      ck(metric);
      return inRange(series(metric), from_year, to_year)
        .map(([year, value]) => ({ year, value }));
    },
  },

  get_metric_stats: {
    desc: "n / min / max / mean / latest / CAGR for a metric over a range.",
    params: {
      metric: { type: "string", desc: "key from list_metrics", required: true },
      from_year: { type: "integer", desc: "default 1911" },
      to_year: { type: "integer", desc: "default 2025" },
    },
    fn: ({ metric, from_year = 1911, to_year = 2025 }) => {
      ck(metric);
      const s = inRange(series(metric), from_year, to_year);
      if (!s.length) throw new Error("no data in range");
      const vs = s.map(p => p[1]);
      const min = s.reduce((a, b) => (b[1] < a[1] ? b : a));
      const max = s.reduce((a, b) => (b[1] > a[1] ? b : a));
      const yrs = s.at(-1)[0] - s[0][0];
      const cagr = (s[0][1] > 0 && s.at(-1)[1] > 0 && yrs > 0)
        ? +(((s.at(-1)[1] / s[0][1]) ** (1 / yrs) - 1) * 100).toFixed(2) : null;
      return {
        metric, unit: METRIC_UNITS[metric], n: s.length,
        first: { year: s[0][0], value: s[0][1] }, latest: { year: s.at(-1)[0], value: s.at(-1)[1] },
        min: { year: min[0], value: min[1] }, max: { year: max[0], value: max[1] },
        mean: +(vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(2),
        cagrPct: cagr,
      };
    },
  },

  get_cagr: {
    desc: "Compound annual growth rate of a metric between two years.",
    params: {
      metric: { type: "string", desc: "key from list_metrics", required: true },
      from_year: { type: "integer", desc: "start year", required: true },
      to_year: { type: "integer", desc: "end year", required: true },
    },
    fn: ({ metric, from_year, to_year }) => {
      ck(metric);
      const a = byYear.get(+from_year)?.[metric], b = byYear.get(+to_year)?.[metric];
      if (a == null || b == null) throw new Error("metric missing for one of those years");
      if (a <= 0) throw new Error("CAGR undefined off a non-positive base");
      return { metric, from_year, to_year,
        cagrPct: +(((b / a) ** (1 / (to_year - from_year)) - 1) * 100).toFixed(2),
        startValue: a, endValue: b };
    },
  },

  compare_years: {
    desc: "Two fiscal years side-by-side across all covered metrics with % change.",
    params: {
      year_a: { type: "integer", desc: "first year", required: true },
      year_b: { type: "integer", desc: "second year", required: true },
    },
    fn: ({ year_a, year_b }) => {
      const ra = byYear.get(+year_a), rb = byYear.get(+year_b);
      if (!ra || !rb) throw new Error("years outside 1911–2025");
      return Object.keys(METRIC_UNITS)
        .filter(m => ra[m] != null || rb[m] != null)
        .map(m => ({ metric: m, [year_a]: ra[m], [year_b]: rb[m],
          changePct: (ra[m] && rb[m] != null) ? +(((rb[m] - ra[m]) / Math.abs(ra[m])) * 100).toFixed(1) : null }));
    },
  },

  get_top_years: {
    desc: "Best or worst n years for a metric.",
    params: {
      metric: { type: "string", desc: "key from list_metrics", required: true },
      n: { type: "integer", desc: "default 5" },
      order: { type: "string", desc: "'best' | 'worst' (default best)" },
    },
    fn: ({ metric, n = 5, order = "best" }) => {
      ck(metric);
      return series(metric)
        .sort((a, b) => order === "worst" ? a[1] - b[1] : b[1] - a[1])
        .slice(0, n).map(([year, value]) => ({ year, value }));
    },
  },

  get_segments: {
    desc: "Segment revenue (2021–2025) for one year, plus FY2025 gross margins.",
    params: { year: { type: "integer", desc: "2021–2025, default 2025" } },
    fn: ({ year = 2025 } = {}) => {
      const row = (D.segments.years || []).find(s => s.year === +year);
      if (!row) throw new Error("segment revenue exists 2021–2025 only");
      return { year: +year, segments: row.segments,
               grossMargin2025: D.segments.segmentGrossMargin2025 || null };
    },
  },

  get_fcf_history: {
    desc: "Free cash flow by year with per-year sourcing notes (stated vs derived).",
    params: {
      from_year: { type: "integer", desc: "default 1995" },
      to_year: { type: "integer", desc: "default 2025" },
    },
    fn: ({ from_year = 1995, to_year = 2025 } = {}) =>
      FIN.filter(r => r.freeCashFlow != null && r.year >= from_year && r.year <= to_year)
        .map(r => ({ year: r.year, freeCashFlow: r.freeCashFlow,
                     source: r.freeCashFlowNote || (r.year >= 2003 ? "IBM-stated" : "derived") })),
  },

  get_ma_deals: {
    desc: "Filter/search the 78 filing-sourced M&A deals.",
    params: {
      deal_type: { type: "string", desc: "'acquisition' | 'divestiture' | 'spinoff' | 'all'" },
      from_year: { type: "integer", desc: "default 1984" },
      to_year: { type: "integer", desc: "default 2025" },
      min_value_millions: { type: "number", desc: "only deals ≥ this value" },
      search: { type: "string", desc: "substring match on name/category" },
    },
    fn: ({ deal_type = "all", from_year = 1984, to_year = 2025, min_value_millions = 0, search = "" } = {}) => {
      const q = search.trim().toLowerCase();
      return (D.ma.deals || []).filter(d =>
        d.year >= from_year && d.year <= to_year &&
        (deal_type === "all" || d.type === deal_type) &&
        (d.valueMillions || 0) >= min_value_millions &&
        (!q || d.name.toLowerCase().includes(q) || (d.category || "").toLowerCase().includes(q)))
        .map(d => ({ year: d.year, name: d.name, type: d.type,
                     valueMillions: d.valueMillions ?? null, category: d.category ?? null }));
    },
  },

  get_ma_era_summary: {
    desc: "Acquisitions, divestitures/spin-offs and disclosed spend per CEO era.",
    params: {},
    fn: () => [["Pre-Gerstner", 1984, 1992], ["Gerstner", 1993, 2002], ["Palmisano", 2003, 2011],
               ["Rometty", 2012, 2019], ["Krishna", 2020, 2025]].map(([era, a, b]) => {
      const deals = (D.ma.deals || []).filter(d => d.year >= a && d.year <= b);
      const acq = deals.filter(d => d.type === "acquisition");
      return { era, from: a, to: b, acquisitions: acq.length,
        divestitures: deals.length - acq.length,
        disclosedSpendMillions: acq.reduce((s, d) => s + (d.valueMillions || 0), 0) };
    }),
  },

  get_milestones: {
    desc: "Company milestones in a year range.",
    params: { from_year: { type: "integer", desc: "default 1911" }, to_year: { type: "integer", desc: "default 2025" } },
    fn: ({ from_year = 1911, to_year = 2025 } = {}) =>
      (D.metadata.milestones || []).filter(m => m.year >= from_year && m.year <= to_year),
  },

  get_leadership: {
    desc: "IBM CEOs — everyone, or who ran IBM in a given year.",
    params: { year: { type: "integer", desc: "optional; omit to list all" } },
    fn: ({ year } = {}) => {
      const L = D.metadata.leadership || [];
      return year ? L.filter(l => l.from <= year && (l.to == null || l.to >= year)) : L;
    },
  },

  get_macro_series: {
    desc: "US macro series by year: gdp, cpi, sp500, nasdaq, ibmBondYield, treasury10yr, recessions.",
    params: {
      series: { type: "string", desc: "series name", required: true },
      from_year: { type: "integer", desc: "default 1929" },
      to_year: { type: "integer", desc: "default 2025" },
    },
    fn: ({ series: name, from_year = 1929, to_year = 2025 }) => {
      if (name === "recessions")
        return (D.macro.recessions || []).filter(r => r.end >= from_year && r.start <= to_year);
      const keymap = { gdp: "gdpBillionsUSD", cpi: "cpiIndex", sp500: "sp500YearEnd",
                       nasdaq: "nasdaqYearEnd", ibmBondYield: "ibmBondYield", treasury10yr: "treasury10yr" };
      const src = D.macro[keymap[name]];
      if (!src) throw new Error(`unknown series '${name}'`);
      return Object.entries(src)
        .filter(([y]) => /^\d+$/.test(y) && +y >= from_year && +y <= to_year)
        .map(([year, value]) => ({ year: +year, value }));
    },
  },

  run_regression: {
    desc: "OLS between two metrics (linear + log-log elasticity), optional X-lead lag.",
    params: {
      x_metric: { type: "string", desc: "predictor key", required: true },
      y_metric: { type: "string", desc: "outcome key", required: true },
      from_year: { type: "integer", desc: "default 1911" },
      to_year: { type: "integer", desc: "default 2025" },
      lag: { type: "integer", desc: "years X leads Y (0–5, default 0)" },
    },
    fn: ({ x_metric, y_metric, from_year = 1911, to_year = 2025, lag = 0 }) => {
      ck(x_metric); ck(y_metric);
      const sy = new Map(series(y_metric));
      const pairs = inRange(series(x_metric), from_year, to_year)
        .filter(([y]) => sy.has(y + lag) && y + lag <= to_year)
        .map(([y, x]) => [x, sy.get(y + lag), y]);
      if (pairs.length < 4) throw new Error(`only ${pairs.length} overlapping observations`);
      const xs = pairs.map(p => p[0]), ys = pairs.map(p => p[1]);
      const out = { x: x_metric, y: y_metric, lag, n: pairs.length,
                    years: [pairs[0][2], pairs.at(-1)[2]], linear: ols(xs, ys) };
      if (xs.every(v => v > 0) && ys.every(v => v > 0)) {
        const ll = ols(xs.map(Math.log), ys.map(Math.log));
        if (ll) out.logLog = { elasticity: +ll.slope.toFixed(3), r2: +ll.r2.toFixed(3) };
      }
      out.caution = "annual data — small n and shared time trends can flatter correlations; the Regression Lab tab has full diagnostics";
      return out;
    },
  },

  get_live_quote: {
    desc: "Live IBM quote (via agent server proxy, then Yahoo direct).",
    params: {},
    fn: async () => {
      const tryJSON = async url => {
        const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      };
      try { return await tryJSON(`${AGENT_URL}/quote?symbol=IBM`); } catch (_) {}
      const j = await tryJSON("https://query1.finance.yahoo.com/v8/finance/chart/IBM?interval=1d&range=5d");
      const res = j.chart.result[0];
      const m = res.meta;
      const closes = (res.indicators?.quote?.[0]?.close || []).filter(c => c != null);
      const prevClose = closes.length >= 2 ? closes[closes.length - 2] : (m.chartPreviousClose || m.previousClose);
      return { symbol: "IBM", price: m.regularMarketPrice, prevClose };
    },
  },

  refresh_live_quote: {
    desc: "Force the Overview tab's live-quote widget (price, change, live market-cap estimate) to re-fetch right now, instead of waiting for its normal 60s auto-refresh.",
    params: {},
    fn: async () => {
      window.selectTab("home");
      if (typeof window.refreshLiveQuote !== "function") throw new Error("live quote widget unavailable");
      await window.refreshLiveQuote();
      return {
        price: document.getElementById("lqPrice")?.textContent,
        change: document.getElementById("lqChange")?.textContent,
        marketCapEstimate: document.getElementById("lqCap")?.textContent,
      };
    },
  },

  /* ---- page actions ---- */
  navigate_to_tab: {
    desc: "Switch the dashboard to a tab: home, story, regression, macro, ma, competitors, about.",
    params: { tab: { type: "string", desc: "tab id", required: true } },
    fn: ({ tab }) => {
      if (!document.getElementById("panel-" + tab)) throw new Error(`no tab '${tab}'`);
      window.selectTab(tab);
      return { navigated: tab };
    },
  },

  set_overview_range: {
    desc: "Set the Overview trend chart's year range.",
    params: {
      from_year: { type: "integer", desc: "start year", required: true },
      to_year: { type: "integer", desc: "end year", required: true },
      label: { type: "string", desc: "optional chip label" },
    },
    fn: ({ from_year, to_year, label }) => {
      window.selectTab("home");
      if (typeof window.setOverviewRange !== "function") throw new Error("overview hook unavailable");
      window.setOverviewRange(+from_year, +to_year, label || `${from_year}–${to_year}`);
      return { range: [+from_year, +to_year] };
    },
  },

  list_regression_metrics: {
    desc: "List the metric keys the Regression Lab accepts for x_metric / y_metric, plus its curated preset scenarios. Call this before configure_regression rather than guessing a key — the Lab's keys are its own and do not all match list_metrics.",
    params: {},
    fn: () => {
      const prev = document.getElementById("panel-regression")?.classList.contains("active");
      if (!prev) window.selectTab("regression");
      const sel = document.getElementById("regX");
      if (!sel) throw new Error("Regression Lab did not initialize");
      const metrics = [...sel.options].map(o => ({ key: o.value, label: o.textContent.trim() }))
        .filter(m => m.key);
      const presets = [...document.querySelectorAll("#panel-regression .reg-preset-btn")]
        .map(b => b.textContent.trim()).filter(Boolean);
      return { metrics, presets,
               note: "Run a preset by passing its exact label to click_control; run an arbitrary pair with configure_regression." };
    },
  },

  configure_regression: {
    desc: "Open the Regression Lab and run a fit (best model auto-picked, always uses every available data point for the chosen metrics — there is no year-range control). Returns the fitted stats panel, so the answer can quote R², the chosen model and the slope. Use list_regression_metrics first for valid keys.",
    params: {
      x_metric: { type: "string", desc: "Regression Lab X key (e.g. rdExpense, gdp, swPct)", required: true },
      y_metric: { type: "string", desc: "Regression Lab Y key", required: true },
      lag: { type: "integer", desc: "0–5, default 0" },
    },
    fn: ({ x_metric, y_metric, lag = 0 }) => {
      window.selectTab("regression");
      const $ = id => document.getElementById(id);
      if (!$("regX")) throw new Error("Regression Lab did not initialize");
      const opt = (sel, v) => [...$(sel).options].some(o => o.value === v);
      if (!opt("regX", x_metric)) throw new Error(`no Regression Lab metric '${x_metric}'`);
      if (!opt("regY", y_metric)) throw new Error(`no Regression Lab metric '${y_metric}'`);
      $("regX").value = x_metric; $("regY").value = y_metric;
      $("regLag").value = String(Math.max(0, Math.min(5, lag)));
      $("regRun").click();
      const stats = $("regStatsCard")?.innerText || "";
      return { configured: { x_metric, y_metric, lag }, statsPanel: stats.slice(0, 600) };
    },
  },

  /* ── situational awareness ──────────────────────────────────────────────
     Without this the agent is blind: it can drive the page but cannot read
     back what is on it, so it cannot confirm an action landed or answer
     "what am I looking at". Reports the active tab plus that tab's headline
     figures, read from the live DOM rather than from the dataset. */
  describe_current_view: {
    desc: "Read back what is currently on screen: the active tab and its headline figures. Use to confirm an action landed, or to answer questions about what the user is looking at right now. Reads the rendered page, so it reflects live values.",
    params: {},
    fn: () => {
      const activeBtn = document.querySelector(".tab.active, [role='tab'][aria-selected='true']");
      const panel = document.querySelector(".panel.active");
      const tab = panel ? panel.id.replace(/^panel-/, "") : null;
      const txt = el => (el?.innerText || "").replace(/\s+/g, " ").trim();

      const view = { tab, tabLabel: txt(activeBtn) || null };

      if (tab === "macro") {
        const kpi = id => txt(document.getElementById(id));
        view.heroKpis = {
          marketCap: kpi("hkpiMarketCap"), totalDebt: kpi("hkpiDebt"),
          revenue: kpi("hkpiRevenue"), stockReturn: kpi("hkpiReturn"),
          creditRating: kpi("hkpiRating"),
        };
        view.sectionAKpis = ["spKpiPrice","spKpiYTD","spKpiDiv","spKpiBeta","spKpiVol","spKpiOutperf"]
          .map(id => txt(document.getElementById(id))).filter(Boolean);
        view.returnChart = {
          window: document.querySelector("#spReturnWindow .sp-tab-btn.active")?.dataset.win || null,
          cumulative: !!document.getElementById("spReturnCumToggle")?.checked,
        };
        view.bondChartTenor = txt(document.querySelector("#bondYieldRoot .sp-tab-btn.active")) || null;
      } else if (tab === "regression") {
        view.regression = {
          x: document.getElementById("regX")?.value || null,
          y: document.getElementById("regY")?.value || null,
          lag: document.getElementById("regLag")?.value || null,
          stats: txt(document.getElementById("regStatsCard")).slice(0, 400),
        };
      } else if (tab === "ma") {
        view.insightView = document.querySelector(".ma-ins-tab.active")?.dataset.ins || null;
      } else if (tab === "competitors") {
        view.segment = document.querySelector("#segmentSelector .reg-preset-btn.active")?.dataset.seg || null;
      }
      // Always include the live ticker if it is up — it is on every tab.
      const lq = window.__liveQuote;
      if (lq && lq.price != null) view.livePrice = lq.price;
      return view;
    },
  },

  /* ── Macro tab: IBM vs Market total-return chart ───────────────────────── */
  configure_return_chart: {
    desc: "Configure the Macro tab's 'IBM vs Market — Total Return & Outperformance' chart: the time window, which series are shown, and annual-bars vs cumulative-growth mode.",
    params: {
      window: { type: "string", desc: "'all' | '20' | '10' | '5' (years)" },
      series: { type: "array", desc: "Which to show, any of: ibm, sp500. Omit to leave unchanged" },
      cumulative: { type: "boolean", desc: "true = cumulative growth of $100; false = annual bars" },
    },
    fn: ({ window: win, series, cumulative }) => {
      window.selectTab("macro");
      const applied = {};
      if (win != null) {
        const b = [...document.querySelectorAll("#spReturnWindow .sp-tab-btn")]
          .find(x => x.dataset.win === String(win));
        if (!b) throw new Error(`window must be one of all, 20, 10, 5 — got '${win}'`);
        b.click(); applied.window = String(win);
      }
      if (Array.isArray(series)) {
        const valid = ["ibm", "sp500"];
        const bad = series.filter(s => !valid.includes(s));
        if (bad.length) throw new Error(`unknown series ${bad.join(", ")}; valid: ${valid.join(", ")}`);
        if (!series.length) throw new Error("series cannot be empty — the chart would be blank");
        valid.forEach(k => {
          const btn = [...document.querySelectorAll("#spReturnLegend .sp-leg-btn")]
            .find(x => x.dataset.key === k);
          if (!btn) return;
          const on = btn.getAttribute("aria-pressed") === "true";
          if (on !== series.includes(k)) btn.click();
        });
        applied.series = series;
      }
      if (cumulative != null) {
        const t = document.getElementById("spReturnCumToggle");
        if (t && t.checked !== !!cumulative) { t.checked = !!cumulative; t.dispatchEvent(new Event("change")); }
        applied.cumulative = !!cumulative;
      }
      return { applied, note: (document.getElementById("spReturnNote")?.innerText || "").slice(0, 300) };
    },
  },

  set_bond_yield_tenor: {
    desc: "Set which US Treasury tenor the Macro tab's 'IBM's Cost of Debt vs the Risk-Free Curve' chart compares IBM against.",
    params: { tenor: { type: "string", desc: "'3m' | '5y' | '10y' | '30y' (or a label like '10-yr note')", required: true } },
    fn: ({ tenor }) => {
      window.selectTab("macro");
      const alias = { "3m": "13-week", "5y": "5-yr", "10y": "10-yr", "30y": "30-yr" };
      const needle = (alias[String(tenor).toLowerCase()] || String(tenor)).toLowerCase();
      const btns = [...document.querySelectorAll("#bondYieldRoot .sp-tab-btn")];
      if (!btns.length) throw new Error("cost-of-debt chart is not on the page");
      const b = btns.find(x => x.textContent.toLowerCase().includes(needle));
      if (!b) throw new Error(`no tenor matching '${tenor}'; available: ${btns.map(x=>x.textContent.trim()).join(", ")}`);
      b.click();
      const root = document.getElementById("bondYieldRoot");
      return { tenor: b.textContent.trim(),
               callouts: [...root.querySelectorAll("div[style*='border-left']")]
                 .map(d => d.innerText.replace(/\s+/g, " ").trim()).slice(0, 3) };
    },
  },

  set_hero_chart_layer: {
    desc: "Switch the Macro tab's big IBM Stock Performance hero chart to a different layer.",
    params: { layer: { type: "string", desc: "price | marketCap | dividends | earnings | acquisitions", required: true } },
    fn: ({ layer }) => {
      window.selectTab("macro");
      const b = [...document.querySelectorAll(".mac-hero-layer-btn")].find(x => x.dataset.layer === layer);
      if (!b) throw new Error(`layer must be one of price, marketCap, dividends, earnings, acquisitions — got '${layer}'`);
      b.click();
      return { layer };
    },
  },

  set_ma_insight_view: {
    desc: "Switch the M&A tab's Deal Intelligence panel between its views.",
    params: { view: { type: "string", desc: "bar (Annual Spend) | scatter (Boldness Map) | alpha (Alpha Leaderboard) | catmix (Category Mix)", required: true } },
    fn: ({ view }) => {
      window.selectTab("ma");
      const b = [...document.querySelectorAll(".ma-ins-tab")].find(x => x.dataset.ins === view);
      if (!b) {
        const avail = [...document.querySelectorAll(".ma-ins-tab")].map(x => x.dataset.ins).join(", ");
        throw new Error(`no M&A view '${view}'; available: ${avail}`);
      }
      b.click();
      return { view, label: b.textContent.trim() };
    },
  },

  set_competitor_segment: {
    desc: "Choose which IBM segment the Competitors tab analyses (peer directory, SWOT, Five Forces, BCG, position map all follow this selection).",
    params: { segment: { type: "string", desc: "software | consulting | infrastructure", required: true } },
    fn: ({ segment }) => {
      window.selectTab("competitors");
      const b = [...document.querySelectorAll("#segmentSelector .reg-preset-btn")]
        .find(x => x.dataset.seg === segment);
      if (!b) throw new Error(`segment must be one of software, consulting, infrastructure — got '${segment}'`);
      b.click();
      return { segment, label: b.textContent.trim() };
    },
  },

  open_ma_era: {
    desc: "Open the M&A tab and pop the deal-list drawer for a CEO era.",
    params: { era: { type: "string", desc: "Pre-Gerstner | Gerstner | Palmisano | Rometty | Krishna", required: true } },
    fn: ({ era }) => {
      window.selectTab("ma");
      const card = [...document.querySelectorAll(".ma-era-card")]
        .find(c => c.querySelector(".ma-era-name")?.textContent.trim().toLowerCase() === era.trim().toLowerCase());
      if (!card) throw new Error(`no era card '${era}'`);
      card.click();
      return { opened: era };
    },
  },

  download_metric_csv: {
    desc: "Download a metric's full series as a CSV file.",
    params: { metric: { type: "string", desc: "key from list_metrics", required: true } },
    fn: ({ metric }) => {
      ck(metric);
      const rows = series(metric);
      const blob = new Blob([["year," + metric, ...rows.map(r => r.join(","))].join("\n")],
                            { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `ibm_${metric}_${rows[0][0]}-${rows.at(-1)[0]}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      return { downloaded: a.download, rows: rows.length };
    },
  },

  set_chart_metrics: {
    desc: "Set which metrics are plotted on the Overview trend chart (same-unit metrics only; picking a different-unit metric replaces the selection).",
    params: { metrics: { type: "array", desc: "1+ keys from: revenue, netIncome, totalAssets, stockholdersEquity, marketCap, freeCashFlow, epsDiluted, stockPrice", required: true } },
    fn: ({ metrics }) => {
      window.selectTab("home");
      if (typeof window.setOverviewMetrics !== "function") throw new Error("overview chart hook unavailable");
      const applied = window.setOverviewMetrics(metrics);
      return { metrics: applied };
    },
  },

  set_chart_scale: {
    desc: "Toggle the Overview trend chart between linear and log y-axis scale.",
    params: { scale: { type: "string", desc: "'linear' or 'log'", required: true } },
    fn: ({ scale }) => {
      window.selectTab("home");
      const box = document.getElementById("logToggle");
      if (!box) throw new Error("scale toggle unavailable");
      const wantLog = scale === "log";
      if (box.checked !== wantLog) { box.checked = wantLog; box.dispatchEvent(new Event("change")); }
      return { scale: wantLog ? "log" : "linear" };
    },
  },

  set_agent_note: {
    desc: "Post a floating note banner on the page (visible on every tab) — use this to leave the user a visible comment, summary, or call-out. Text only, no HTML.",
    params: { text: { type: "string", desc: "note text", required: true } },
    fn: ({ text }) => {
      let el = document.getElementById("cugaAgentNote");
      if (!el) {
        el = document.createElement("div");
        el.id = "cugaAgentNote";
        el.innerHTML = '<span class="cuga-note-tag">Agent note</span><span class="cuga-note-text"></span><button class="cuga-note-x" aria-label="Dismiss">×</button>';
        el.querySelector(".cuga-note-x").addEventListener("click", () => el.remove());
        document.body.appendChild(el);
      }
      el.querySelector(".cuga-note-text").textContent = text;
      return { posted: true };
    },
  },

  clear_agent_note: {
    desc: "Remove the on-page agent note banner, if present.",
    params: {},
    fn: () => {
      const el = document.getElementById("cugaAgentNote");
      if (el) el.remove();
      return { cleared: !!el };
    },
  },

  highlight_element: {
    desc: "Scroll to and briefly pulse-highlight the first element on the current tab whose text contains the given substring (case-insensitive). Good for drawing attention to a stat card, chip, or row after navigating there.",
    params: { text: { type: "string", desc: "substring to search for", required: true } },
    fn: ({ text }) => {
      const q = text.trim().toLowerCase();
      const panel = document.querySelector(".panel.active");
      if (!panel) throw new Error("no active tab panel");
      const candidates = panel.querySelectorAll(".snap, .ma-stat, .ma-era-card, .fy-stat, .reg-stat-row, .chip, .mtoggle, td, .gm-row, .callout");
      const hit = [...candidates].find(el => el.textContent.toLowerCase().includes(q));
      if (!hit) throw new Error(`no element on the current tab contains '${text}'`);
      hit.scrollIntoView({ behavior: "smooth", block: "center" });
      hit.classList.add("cuga-highlight");
      setTimeout(() => hit.classList.remove("cuga-highlight"), 2600);
      return { highlighted: hit.textContent.trim().slice(0, 80) };
    },
  },

  click_control: {
    desc: "Click a visible button, tab-style toggle, chip, or checkbox label on the current tab whose text matches a substring — e.g. a Macro-tab benchmark toggle ('S&P 500'), a Regression Lab preset, an M&A era filter, a 'Log scale' checkbox label, a Story Mode series button. Broader than the dedicated tools below: use this for any on-page control that doesn't have its own named tool.",
    params: { text: { type: "string", desc: "substring of the control's visible text", required: true } },
    fn: ({ text }) => {
      const q = text.trim().toLowerCase();
      const panel = document.querySelector(".panel.active") || document;
      const candidates = panel.querySelectorAll(
        "button, label, [role='button'], .chip, .mtoggle, .sp-tab-btn, .sp-leg-btn, .sm-series-btn, .ma-era-card"
      );
      const hit = [...candidates].find(el => el.textContent.trim().toLowerCase().includes(q));
      if (!hit) throw new Error(`no clickable control on the current tab matches '${text}'`);
      hit.scrollIntoView({ behavior: "smooth", block: "center" });
      hit.click();
      return { clicked: hit.textContent.trim().slice(0, 60) };
    },
  },

  set_theme: {
    desc: "Switch the dashboard between dark (default) and light color themes. Persists across reloads.",
    params: { theme: { type: "string", desc: "'dark' or 'light'", required: true } },
    fn: ({ theme }) => {
      if (typeof window.setTheme !== "function") throw new Error("theme hook unavailable");
      return { theme: window.setTheme(theme) };
    },
  },

  jump_to_story_chapter: {
    desc: "Open Story Mode and scroll to a specific chapter/era, optionally switching which series (netIncome, revenue, marketCap, stockPrice) its chart displays.",
    params: {
      chapter: { type: "string", desc: "chapter title substring, era id, or 0-based index (e.g. 'Gerstner', 'hybrid', 3)", required: true },
      series: { type: "string", desc: "optional: netIncome | revenue | marketCap | stockPrice" },
    },
    fn: ({ chapter, series }) => {
      window.selectTab("story");
      if (typeof window.setStoryChapter !== "function") throw new Error("Story Mode did not initialize");
      const idOrIdx = /^\d+$/.test(String(chapter).trim()) ? +chapter : chapter;
      return window.setStoryChapter(idOrIdx, series);
    },
  },

  configure_macro_chart: {
    desc: "Configure the Macro tab's IBM-vs-market indexed-growth chart: which IBM series to plot, which benchmark indexes to overlay, and whether to inflation-adjust (CPI-real).",
    params: {
      ibm_key: { type: "string", desc: "'revenue' or 'marketCap'" },
      benchmarks: { type: "array", desc: "subset of: sp500, tech, nasdaq, djia" },
      real: { type: "boolean", desc: "true = CPI-adjust every series to real dollars" },
    },
    fn: ({ ibm_key, benchmarks, real }) => {
      window.selectTab("macro");
      if (typeof window.setMacroChart !== "function") throw new Error("Macro chart did not initialize");
      return window.setMacroChart({ ibm_key, benchmarks, real });
    },
  },

  celebrate: {
    desc: "Fire a brief on-page confetti burst — a fun visual flourish for a milestone, a big number, or just to celebrate. Purely decorative, clears itself after ~3 seconds.",
    params: {},
    fn: () => {
      const colors = ["#0f62fe", "#a56eff", "#08bdba", "#42be65", "#ff832b", "#fa4d56", "#ffffff"];
      const n = 70;
      for (let i = 0; i < n; i++) {
        const el = document.createElement("div");
        const color = colors[i % colors.length];
        const round = Math.random() < 0.5;
        el.style.cssText = `position:fixed;top:-12px;left:${Math.random() * 100}vw;` +
          `width:${6 + Math.random() * 6}px;height:${6 + Math.random() * 6}px;background:${color};` +
          `z-index:99999;pointer-events:none;border-radius:${round ? "50%" : "2px"};` +
          `box-shadow:0 0 4px ${color};`;
        document.body.appendChild(el);
        const duration = 1800 + Math.random() * 1400;
        const xDrift = (Math.random() - 0.5) * 240;
        const spin = 360 + Math.random() * 720;
        const anim = el.animate(
          [
            { transform: "translate(0,0) rotate(0deg)", opacity: 1 },
            { transform: `translate(${xDrift}px, 100vh) rotate(${spin}deg)`, opacity: 0.9, offset: 0.85 },
            { transform: `translate(${xDrift}px, 100vh) rotate(${spin}deg)`, opacity: 0 },
          ],
          { duration, easing: "cubic-bezier(.25,.46,.45,.94)" }
        );
        anim.onfinish = () => el.remove();
        setTimeout(() => el.remove(), duration + 200);
      }
      return { celebrated: true, particles: n };
    },
  },

  list_chartable_macro_series: {
    desc: "List the year-keyed macro series create_custom_chart can plot alongside financial metrics — GDP, CPI, Treasury yields, IBM's cost of debt, total-return series, and so on. Call this (or list_metrics for company figures) before charting rather than guessing a key.",
    params: {},
    fn: () => {
      const macro = (window.IBM_DATA || {}).macro || {};
      const out = [];
      for (const key of Object.keys(macro)) {
        const v = macro[key];
        if (!v || typeof v !== "object" || Array.isArray(v)) continue;
        const yrs = Object.keys(v).filter(x => /^\d{4}$/.test(x)).sort();
        if (yrs.length < 3) continue;
        if (!yrs.every(y => typeof v[y] === "number" || v[y] == null)) continue;
        out.push({ key, from: +yrs[0], to: +yrs[yrs.length - 1], n: yrs.length });
      }
      return { series: out.sort((a, b) => a.key.localeCompare(b.key)),
               note: "Pass any of these to create_custom_chart's metrics array, mixed freely with list_metrics keys." };
    },
  },

  create_custom_chart: {
    desc: "Build a brand-new chart from any 1-4 metrics, append it to the bottom of the Overview tab, and take the user there. Accepts BOTH financial-series keys (list_metrics — revenue, rdExpense, netIncome, marketCap...) AND year-keyed macro series (list_chartable_macro_series — gdp, cpi, treasury10yr, ibmCostOfDebt, ibmTotalReturn, sp500TotalReturn...), so you can plot company figures against the economy. Metrics with different units are automatically indexed to 100 so they stay comparable on one axis. Use this for any 'plot X against Y' or 'make me a chart of...' request that isn't just the existing Overview trend chart (see set_chart_metrics for that).",
    params: {
      metrics: { type: "array", desc: "1-4 metric keys, financial or macro, e.g. ['revenue','rdExpense'] or ['ibmCostOfDebt','treasury10yr']", required: true },
      title: { type: "string", desc: "optional chart title" },
      from_year: { type: "integer", desc: "default: earliest year all metrics overlap" },
      to_year: { type: "integer", desc: "default: latest year all metrics overlap" },
      scale: { type: "string", desc: "'linear' (default) or 'log'" },
    },
    fn: ({ metrics, title, from_year, to_year, scale }) => {
      window.selectTab("home");
      if (typeof window.createCustomChart !== "function") throw new Error("custom chart hook unavailable");
      return window.createCustomChart({ metrics, title, fromYear: from_year, toYear: to_year, scale });
    },
  },

  clear_custom_charts: {
    desc: "Remove every agent-built custom chart from the bottom of the Overview tab.",
    params: {},
    fn: () => {
      if (typeof window.clearCustomCharts !== "function") throw new Error("custom chart hook unavailable");
      return window.clearCustomCharts();
    },
  },
};

/* ── Public API ────────────────────────────────────────────────────────────*/
const AGENT_URL = window.CUGA_AGENT_URL || "http://localhost:8787";

window.CUGA = {
  manifest: () => Object.entries(TOOLS).map(([name, t]) => ({
    name, description: t.desc,
    parameters: {
      type: "object",
      properties: Object.fromEntries(Object.entries(t.params)
        .map(([p, s]) => [p, { type: s.type, description: s.desc }])),
      required: Object.entries(t.params).filter(([, s]) => s.required).map(([p]) => p),
    },
  })),
  invoke: async (name, args = {}) => {
    const t = TOOLS[name];
    if (!t) return { ok: false, error: `unknown tool '${name}' — see window.CUGA.manifest()` };
    try { return { ok: true, result: await t.fn(args) }; }
    catch (e) { return { ok: false, error: e.message }; }
  },
  agentURL: AGENT_URL,
};

/* ── "Ask the data" chat panel (talks to agent/server.py) ─────────────────*/
function buildChatPanel() {
  const wrap = document.createElement("div");
  wrap.id = "cugaChat";
  wrap.innerHTML = `
    <button id="cugaFab" title="Ask the CUGA data agent" aria-label="Ask the data"
            aria-expanded="false" aria-controls="cugaPanel">⌘ Ask the data</button>
    <div id="cugaPanel" hidden role="dialog" aria-label="CUGA data agent chat">
      <div class="cuga-head">
        <span>CUGA data agent</span>
        <span class="cuga-status" id="cugaStatus"></span>
        <button id="cugaClose" aria-label="Close">×</button>
      </div>
      <div class="cuga-msgs" id="cugaMsgs">
        <div class="cuga-msg agent">Ask anything about 115 years of IBM data — e.g.
        "revenue CAGR under Krishna", "biggest acquisitions of the 2010s",
        "does R&amp;D predict net income two years later?"</div>
        <div class="cuga-msg disclaimer">⚠ This feature requires a premium API key with a higher token limit. Full AI Q&amp;A will be available once access is provisioned.</div>
      </div>
      <form class="cuga-inrow" id="cugaForm">
        <input id="cugaInput" type="text" placeholder="Ask about IBM's financials, M&A, macro…" autocomplete="off">
        <button type="submit">Send</button>
      </form>
    </div>`;
  document.body.appendChild(wrap);

  const panel = document.getElementById("cugaPanel");
  const msgs = document.getElementById("cugaMsgs");
  const input = document.getElementById("cugaInput");
  const status = document.getElementById("cugaStatus");
  const thread = "web-" + Math.random().toString(36).slice(2, 8);

  const fab = document.getElementById("cugaFab");
  const setOpen = open => {
    panel.hidden = !open;
    fab.setAttribute("aria-expanded", String(open));
    fab.classList.toggle("open", open);
    fab.textContent = open ? "× Close" : "⌘ Ask the data";
    if (open) { input.focus(); ping(); }
  };
  fab.addEventListener("click", () => setOpen(panel.hidden));
  document.getElementById("cugaClose").addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !panel.hidden) setOpen(false);
  });
  setInterval(() => { if (!panel.hidden) ping(); }, 15000);   // keep status current

  async function ping() {
    try {
      const r = await fetch(`${AGENT_URL}/health`, { signal: AbortSignal.timeout(2500) });
      const j = r.ok ? await r.json() : null;
      if (j && j.agentWarm) {
        status.textContent = "● online"; status.className = "cuga-status on";
      } else if (j) {
        status.textContent = "● warming up…"; status.className = "cuga-status warm";
      } else {
        status.textContent = "○ offline"; status.className = "cuga-status off";
      }
    } catch (_) {
      status.textContent = "○ offline — run python agent/server.py";
      status.className = "cuga-status off";
    }
  }

  const add = (cls, text) => {
    const div = document.createElement("div");
    div.className = "cuga-msg " + cls;
    div.textContent = text;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    return div;
  };

  document.getElementById("cugaForm").addEventListener("submit", async e => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    input.value = "";
    add("user", q);
    const pending = add("agent", "thinking…");
    try {
      /* The OpenAI backend (agent/openai_agent.py) runs on Vercel, where
         functions are stateless — so instead of driving this page through the
         /commands long-poll, it hands browser tool calls back to us with an
         opaque `state`. We run them here and post the results to continue the
         same turn. Loop-capped so a model that keeps asking for browser tools
         can't spin the page forever. The CUGA backend never sets
         pendingBrowserCalls, so it just falls through on the first reply. */
      let payload = { question: q, thread_id: thread };
      let j = null;
      for (let round = 0; round < 4; round++) {
        const r = await fetch(`${AGENT_URL}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(120000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        j = await r.json();
        if (!j.pendingBrowserCalls || !j.pendingBrowserCalls.length) break;

        pending.textContent = "Working on the page…";
        const toolResults = [];
        for (const call of j.pendingBrowserCalls) {
          const out = await window.CUGA.invoke(call.tool, call.args || {});
          toolResults.push(out.ok
            ? { id: call.id, ok: true, result: out.result }
            : { id: call.id, ok: false, error: out.error });
        }
        payload = { state: j.state, toolResults };
      }
      pending.textContent = (j && j.answer) || "(no answer)";
    } catch (err) {
      pending.textContent =
        "Agent unreachable. Start it with:  python agent/server.py  " +
        "(see agent/README.md). Direct tools still work: try " +
        "window.CUGA.invoke('get_metric_stats', {metric:'revenue'}) in the console.";
    }
    msgs.scrollTop = msgs.scrollHeight;
  });
}

/* ── Browser command poller ─────────────────────────────────────────────────
   Lets server-side CUGA tools (agent.py's browser_action) drive this page:
   long-poll GET /commands/next, execute via window.CUGA.invoke (or return
   the tool manifest for the special "__manifest__" request), POST the result
   back. Silently backs off on network errors — no server running is a normal
   idle state, not a failure worth logging. */
async function pollBrowserCommands() {
  while (true) {
    let cmd = null;
    try {
      const r = await fetch(`${AGENT_URL}/commands/next`, { signal: AbortSignal.timeout(35000) });
      if (r.status === 204) continue;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      cmd = await r.json();
    } catch (_) {
      await new Promise(res => setTimeout(res, 5000));
      continue;
    }
    if (!cmd) continue;
    let body;
    if (cmd.tool === "__manifest__") {
      body = { ok: true, result: window.CUGA.manifest() };
    } else {
      const out = await window.CUGA.invoke(cmd.tool, cmd.args || {});
      body = out.ok ? { ok: true, result: out.result } : { ok: false, error: out.error };
    }
    try {
      await fetch(`${AGENT_URL}/commands/${cmd.id}/result`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
      });
    } catch (_) { /* command timed out server-side already; nothing to do */ }
  }
}
pollBrowserCommands();

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", buildChatPanel);
else buildChatPanel();

})();
