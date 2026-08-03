/* ============================================================================
   regression.js — IBM Regression Lab
   OLS + nonlinear model fitting across the full 1911–2025 dataset, with era
   filters, lags, an optional second predictor and residual diagnostics.
   The best-fitting model form is always chosen automatically (lowest AICc).
   Pure SVG/HTML, no external dependencies. Lazy-initialized on first visit.
   ========================================================================== */
(function () {
"use strict";

/* ============================================================
   MATH UTILITIES
   ============================================================ */

function lgamma(z) {
  // Lanczos approximation
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < 9; i++) x += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function betaInc(a, b, x) {
  // Regularized incomplete beta I_x(a,b) via continued fraction (NR §6.4)
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x > (a + 1) / (a + b + 2)) return 1 - betaInc(b, a, 1 - x);
  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta) / a;
  let f = 1, c2 = 1, d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d; f = d;
  for (let m = 1; m <= 200; m++) {
    let num = m * (b - m) * x / ((a + 2*m - 1) * (a + 2*m));
    d = 1 + num * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
    c2 = 1 + num / c2; if (Math.abs(c2) < 1e-30) c2 = 1e-30;
    f *= d * c2;
    num = -(a + m) * (a + b + m) * x / ((a + 2*m) * (a + 2*m + 1));
    d = 1 + num * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
    c2 = 1 + num / c2; if (Math.abs(c2) < 1e-30) c2 = 1e-30;
    const delta = d * c2;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-12) break;
  }
  return front * f;
}

function tPValue(tStat, df) {          // two-tailed
  if (df < 1) return 1;
  const x = df / (df + tStat * tStat);
  return betaInc(df / 2, 0.5, x);
}
function tCrit95(df) {
  // 97.5th percentile of t — bisection on tPValue (df small here, fast enough)
  if (df < 1) return NaN;
  let lo = 1.5, hi = 15;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (tPValue(mid, df) > 0.05) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
function fPValue(F, df1, df2) {
  if (!(F > 0)) return 1;
  return betaInc(df2 / 2, df1 / 2, df2 / (df2 + df1 * F));
}

function matInvSym(A) {
  // Gauss-Jordan inverse for small symmetric matrices (k <= 4)
  const n = A.length;
  const M = A.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let j = 0; j < 2 * n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map(row => row.slice(n));
}

/** Core OLS on a design matrix (rows already include the leading 1). */
function olsCore(X, y) {
  const n = X.length, k = X[0].length;
  if (n < k + 1) return null;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = a; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) XtX[a][b] = XtX[b][a];
  const inv = matInvSym(XtX);
  if (!inv) return null;
  const beta = inv.map(row => row.reduce((s, v, j) => s + v * Xty[j], 0));
  const yhat = X.map(row => row.reduce((s, v, j) => s + v * beta[j], 0));
  const resid = y.map((v, i) => v - yhat[i]);
  const ym = y.reduce((s, v) => s + v, 0) / n;
  const SSres = resid.reduce((s, e) => s + e * e, 0);
  const SStot = y.reduce((s, v) => s + (v - ym) ** 2, 0);
  const dfRes = n - k;
  const sigma2 = SSres / Math.max(dfRes, 1);
  const cov = inv.map(row => row.map(v => v * sigma2));
  const se = beta.map((_, j) => Math.sqrt(Math.max(0, cov[j][j])));
  const tStats = beta.map((b, j) => se[j] > 1e-12 ? b / se[j] : Infinity);
  const pVals = tStats.map(t => isFinite(t) ? tPValue(Math.abs(t), dfRes) : 0);
  const r2t = SStot > 1e-12 ? 1 - SSres / SStot : 1;
  const F = (k > 1 && SSres > 1e-12) ? ((SStot - SSres) / (k - 1)) / (SSres / dfRes) : Infinity;
  const pF = isFinite(F) ? fPValue(F, k - 1, dfRes) : 0;
  return { n, k, beta, cov, se, tStats, pVals, yhat, resid, SSres, SStot, sigma2, dfRes, r2t, F, pF };
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const xm = xs.reduce((a, b) => a + b, 0) / n, ym = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i]-xm, dy = ys[i]-ym; sxy += dx*dy; sxx += dx*dx; syy += dy*dy; }
  return (sxx > 1e-12 && syy > 1e-12) ? sxy / Math.sqrt(sxx * syy) : null;
}
function spearman(xs, ys) {
  const rank = arr => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(arr.length);
    for (let i = 0; i < idx.length; ) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let m = i; m <= j; m++) r[idx[m][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  return pearson(rank(xs), rank(ys));
}
function durbinWatson(resid) {
  if (resid.length < 4) return null;
  let num = 0, den = 0;
  for (let i = 0; i < resid.length; i++) {
    den += resid[i] ** 2;
    if (i > 0) num += (resid[i] - resid[i - 1]) ** 2;
  }
  return den > 1e-12 ? num / den : null;
}

function niceTicks(min, max, count) {
  if (min >= max) { min -= 1; max += 1; }
  const span = max - min;
  const step0 = Math.pow(10, Math.floor(Math.log10(span / count)));
  const err = (span / count) / step0;
  const step = err >= 7.5 ? 10 * step0 : err >= 3 ? 5 * step0 : err >= 1.5 ? 2 * step0 : step0;
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let t = start; t <= max + step * 0.5; t += step) ticks.push(+t.toFixed(10));
  return ticks;
}

/* ============================================================
   FORMATTERS (per unit)
   ============================================================ */
function fmtM(v) {
  if (v == null) return "—";
  const a = Math.abs(v), s = v < 0 ? "-" : "";
  if (a >= 1e6) return `${s}$${(a/1e6).toFixed(1)}T`;
  if (a >= 1000) return `${s}$${(a/1000).toFixed(1)}B`;
  return `${s}$${a.toFixed(0)}M`;
}
function fmtB(v) {   // input in $ billions
  if (v == null) return "—";
  const a = Math.abs(v), s = v < 0 ? "-" : "";
  if (a >= 1000) return `${s}$${(a/1000).toFixed(1)}T`;
  return `${s}$${a.toFixed(0)}B`;
}
const UNITS = {
  "$M":  { fmt: fmtM,  axis: fmtM,  full: v => v == null ? "—" : `$${Math.round(v).toLocaleString()}M` },
  "$B":  { fmt: fmtB,  axis: fmtB,  full: v => v == null ? "—" : `$${Math.round(v).toLocaleString()}B` },
  "%":   { fmt: v => v == null ? "—" : `${v.toFixed(2)}%`, axis: v => `${v.toFixed(1)}%`, full: v => v == null ? "—" : `${v.toFixed(2)}%` },
  "$":   { fmt: v => v == null ? "—" : `$${v.toFixed(2)}`, axis: v => `$${v.toFixed(2)}`, full: v => v == null ? "—" : `$${v.toFixed(2)}` },
  "×":   { fmt: v => v == null ? "—" : `${v.toFixed(2)}×`, axis: v => `${v.toFixed(2)}×`, full: v => v == null ? "—" : `${v.toFixed(3)}×` },
  "idx": { fmt: v => v == null ? "—" : v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1), axis: v => v >= 1000 ? `${(v/1000).toFixed(1)}k` : String(Math.round(v)), full: v => v == null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: 1 }) },
  "ct":  { fmt: v => v == null ? "—" : Math.round(v).toLocaleString(), axis: v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : String(Math.round(v)), full: v => v == null ? "—" : Math.round(v).toLocaleString() },
  "$K":  { fmt: v => v == null ? "—" : `$${Math.round(v).toLocaleString()}K`, axis: v => `$${Math.round(v)}K`, full: v => v == null ? "—" : `$${Math.round(v).toLocaleString()}K` },
};
function fmtOf(unit)  { return (UNITS[unit] || UNITS["idx"]).fmt; }
function axisOf(unit) { return (UNITS[unit] || UNITS["idx"]).axis; }
function fullOf(unit) { return (UNITS[unit] || UNITS["idx"]).full; }

/* ============================================================
   METRICS CATALOG
   ============================================================ */
const REG_METRICS = [
  // Income statement & cash flow
  { key: "revenue",            label: "Total revenue",            short: "Revenue",       unit: "$M", group: "Financials" },
  { key: "netIncome",          label: "Net income",               short: "Net income",    unit: "$M", group: "Financials" },
  { key: "pretaxIncome",       label: "Pre-tax income",           short: "Pre-tax inc.",  unit: "$M", group: "Financials" },
  { key: "incomeTaxes",        label: "Income taxes",             short: "Taxes",         unit: "$M", group: "Financials" },
  { key: "freeCashFlow",       label: "Free cash flow",           short: "FCF",           unit: "$M", group: "Financials" },
  { key: "operatingCashFlow",  label: "Operating cash flow",      short: "OCF",           unit: "$M", group: "Financials" },
  { key: "capitalExpenditure", label: "Capital expenditure",      short: "CapEx",         unit: "$M", group: "Financials" },
  { key: "rdExpense",          label: "R&D expense",              short: "R&D",           unit: "$M", group: "Financials" },
  // Balance sheet
  { key: "totalAssets",        label: "Total assets",             short: "Assets",        unit: "$M", group: "Balance sheet" },
  { key: "stockholdersEquity", label: "Stockholders' equity",     short: "Equity",        unit: "$M", group: "Balance sheet" },
  { key: "totalDebt",          label: "Total debt",               short: "Debt",          unit: "$M", group: "Balance sheet" },
  // Per-share, people & market
  { key: "epsDiluted",         label: "EPS (diluted)",            short: "EPS",           unit: "$",  group: "Per share & market" },
  { key: "dividendsPerShare",  label: "Dividends per share",      short: "DPS",           unit: "$",  group: "Per share & market" },
  { key: "stockPrice",         label: "Stock price (year-end)",   short: "Price",         unit: "$",  group: "Per share & market" },
  { key: "marketCap",          label: "Market cap (year-end)",    short: "Mkt cap",       unit: "$M", group: "Per share & market" },
  { key: "employees",          label: "Employees",                short: "Employees",     unit: "ct", group: "Per share & market" },
  { key: "softwareARR",        label: "Software ARR",             short: "SW ARR",        unit: "$M", group: "Per share & market" },
  // Segments (2021+)
  { key: "swRev",              label: "Software revenue",         short: "SW rev",        unit: "$M", group: "Segments (2021+)" },
  { key: "coRev",              label: "Consulting revenue",       short: "CO rev",        unit: "$M", group: "Segments (2021+)" },
  { key: "infRev",             label: "Infrastructure revenue",   short: "Infra rev",     unit: "$M", group: "Segments (2021+)" },
  // US macro (external series)
  { key: "gdp",                label: "US nominal GDP",           short: "US GDP",        unit: "$B",  group: "US macro" },
  { key: "cpi",                label: "US CPI (index)",           short: "CPI",           unit: "idx", group: "US macro" },
  { key: "sp500",              label: "S&P 500 (year-end)",       short: "S&P 500",       unit: "idx", group: "US macro" },
  { key: "nasdaq",             label: "Nasdaq (year-end)",        short: "Nasdaq",        unit: "idx", group: "US macro" },
  { key: "treasury10yr",       label: "10-yr Treasury yield",     short: "10yr Tsy",      unit: "%",  group: "US macro" },
  // M&A
  { key: "maSpend",            label: "M&A spend (disclosed)",    short: "M&A spend",     unit: "$M", group: "M&A" },
  { key: "maCount",            label: "Acquisitions (count)",     short: "M&A count",     unit: "ct", group: "M&A" },
  // Derived ratios
  { key: "opMargin",           label: "Pre-tax margin",           short: "Pre-tax mgn",   unit: "%",  group: "Derived ratios" },
  { key: "netMargin",          label: "Net margin",               short: "Net margin",    unit: "%",  group: "Derived ratios" },
  { key: "fcfMargin",          label: "FCF margin",               short: "FCF margin",    unit: "%",  group: "Derived ratios" },
  { key: "fcfConversion",      label: "FCF conversion (FCF/NI)",  short: "FCF conv.",     unit: "%",  group: "Derived ratios" },
  { key: "rdPct",              label: "R&D intensity (R&D/rev)",  short: "R&D %",         unit: "%",  group: "Derived ratios" },
  { key: "capexPct",           label: "CapEx intensity",          short: "CapEx %",       unit: "%",  group: "Derived ratios" },
  { key: "effTaxRate",         label: "Effective tax rate",       short: "Tax rate",      unit: "%",  group: "Derived ratios" },
  { key: "roe",                label: "Return on equity",         short: "ROE",           unit: "%",  group: "Derived ratios" },
  { key: "roa",                label: "Return on assets",         short: "ROA",           unit: "%",  group: "Derived ratios" },
  { key: "roic",               label: "ROIC (25% tax est.)",      short: "ROIC",          unit: "%",  group: "Derived ratios" },
  { key: "assetTurnover",      label: "Asset turnover (rev/assets)", short: "Asset turns", unit: "×", group: "Derived ratios" },
  { key: "debtEquity",         label: "Debt / equity",            short: "D/E",           unit: "×",  group: "Derived ratios" },
  { key: "divPayout",          label: "Dividend payout (DPS/EPS)", short: "Payout",       unit: "%",  group: "Derived ratios" },
  { key: "revPerEmployee",     label: "Revenue per employee",     short: "Rev/emp",       unit: "$K", group: "Derived ratios" },
  { key: "swPct",              label: "Software share of revenue", short: "SW share",     unit: "%",  group: "Derived ratios" },
  { key: "coPct",              label: "Consulting share of revenue", short: "CO share",   unit: "%",  group: "Derived ratios" },
  { key: "infPct",             label: "Infrastructure share of revenue", short: "Infra share", unit: "%", group: "Derived ratios" },
  // Valuation
  { key: "pe",                 label: "P/E (mkt cap / net income)", short: "P/E",         unit: "×",  group: "Valuation" },
  { key: "pb",                 label: "P/B (mkt cap / equity)",     short: "P/B",         unit: "×",  group: "Valuation" },
  { key: "ps",                 label: "P/S (mkt cap / revenue)",    short: "P/S",         unit: "×",  group: "Valuation" },
  { key: "fcfYield",           label: "FCF yield (FCF / mkt cap)",  short: "FCF yield",   unit: "%",  group: "Valuation" },
  { key: "divYield",           label: "Dividend yield (DPS / price)", short: "Div yield", unit: "%",  group: "Valuation" },
];
const metaByKey = Object.fromEntries(REG_METRICS.map(m => [m.key, m]));
const GROUP_ORDER = ["Financials", "Balance sheet", "Per share & market", "Segments (2021+)",
                     "US macro", "M&A", "Derived ratios", "Valuation"];

/* ============================================================
   ERA / RANGE FILTER — a compact set; the custom from/to inputs
   cover anything finer (scatter colours still show the full
   narrative chapters)
   ============================================================ */
const ERAS = [
  { id: "all",      label: "All available years",   lo: 1911, hi: 2025 },
  { id: "gerstner", label: "Gerstner turnaround",   lo: 1993, hi: 2002 },
  { id: "palmisano",label: "Palmisano era",         lo: 2003, hi: 2011 },
  { id: "rometty",  label: "Rometty era",           lo: 2012, hi: 2019 },
  { id: "hybrid",   label: "Hybrid Cloud & AI",     lo: 2019, hi: 2025 },
];
// Era colouring of scatter points — one colour per narrative chapter
const POINT_ERAS = [
  { from: 1911, hi: 1935, color: "#8d8d8d",  label: "Tabulating Foundation 1911–35" },
  { from: 1935, hi: 1952, color: "#08bdba",  label: "Social Security Platform 1935–52" },
  { from: 1952, hi: 1964, color: "#33b1ff",  label: "Electronic Computing 1952–64" },
  { from: 1964, hi: 1975, color: "#42be65",  label: "Mainframe Platform 1964–75" },
  { from: 1975, hi: 1985, color: "#a56eff",  label: "PC & Minicomputer Era 1975–85" },
  { from: 1985, hi: 1993, color: "#fa4d56",  label: "Fragmentation & Crisis 1985–93" },
  { from: 1993, hi: 2000, color: "#ff832b",  label: "Gerstner Turnaround 1993–00" },
  { from: 2000, hi: 2012, color: "#ffb000",  label: "Smarter Planet 2000–12" },
  { from: 2012, hi: 2019, color: "#ff7eb6",  label: "Watson Pivot Years 2012–19" },
  { from: 2019, hi: 2025, color: "#4589ff",  label: "Hybrid Cloud & AI 2019–25" },
];
function pointEra(year) {
  return POINT_ERAS.find(e => year >= e.from && year <= e.hi) ||
         (year < POINT_ERAS[0].from ? POINT_ERAS[0] : POINT_ERAS[POINT_ERAS.length - 1]);
}

/* ============================================================
   MODEL FORMS — the lab always fits all of them and shows the
   best by AICc; there is no user-facing model setting.
   ============================================================ */
const FORMS = {
  linear: { label: "Linear",              design: x => [1, x],           fy: y => y,   inv: v => v,   needXpos: false, needYpos: false, k: 2 },
  quad:   { label: "Quadratic",           design: x => [1, x, x * x],    fy: y => y,   inv: v => v,   needXpos: false, needYpos: false, k: 3 },
  logx:   { label: "Logarithmic (log x)", design: x => [1, Math.log(x)], fy: y => y,   inv: v => v,   needXpos: true,  needYpos: false, k: 2 },
  expy:   { label: "Exponential (log y)", design: x => [1, x],           fy: Math.log, inv: Math.exp, needXpos: false, needYpos: true,  k: 2 },
  power:  { label: "Power (log-log)",     design: x => [1, Math.log(x)], fy: Math.log, inv: Math.exp, needXpos: true,  needYpos: true,  k: 2 },
};
const FORM_IDS = ["linear", "quad", "logx", "expy", "power"];

/* ============================================================
   DATA PREPARATION
   ============================================================ */
let _rows = null;
function getRows() {
  if (_rows) return _rows;
  const D = window.IBM_DATA;
  const segMap = new Map((D.segments.years || []).map(sy => [sy.year, sy.segments || {}]));
  const gdp  = (D.macro && D.macro.gdpBillionsUSD) || {};
  const cpi  = (D.macro && D.macro.cpiIndex) || {};
  const sp   = (D.macro && D.macro.sp500YearEnd) || {};
  const nq   = (D.macro && D.macro.nasdaqYearEnd) || {};
  const tsy  = (D.macro && D.macro.treasury10yr)  || {};

  // Aggregate M&A per year from the deal list + annual summary
  const maSpend = {}, maCount = {};
  ((D.ma && D.ma.deals) || []).forEach(d => {
    if (d.year == null) return;
    maCount[d.year] = (maCount[d.year] || 0) + 1;
    if (d.valueMillions != null) maSpend[d.year] = (maSpend[d.year] || 0) + d.valueMillions;
  });
  Object.entries((D.ma && D.ma.annualSummary) || {}).forEach(([y, s]) => {
    const yr = +y;
    if (s.acquisitionsCount != null && (maCount[yr] || 0) < s.acquisitionsCount) maCount[yr] = s.acquisitionsCount;
    if (s.totalSpentMillions != null && (maSpend[yr] || 0) < s.totalSpentMillions) maSpend[yr] = s.totalSpentMillions;
  });

  _rows = D.financials.map(d => {
    const seg = segMap.get(d.year) || {};
    const rev = d.revenue, sw = seg.Software || null, y = d.year;
    const r = {
      year: y,
      revenue: d.revenue, netIncome: d.netIncome, pretaxIncome: d.pretaxIncome,
      incomeTaxes: d.incomeTaxes, freeCashFlow: d.freeCashFlow,
      operatingCashFlow: d.operatingCashFlow, capitalExpenditure: d.capitalExpenditure,
      rdExpense: d.rdExpense, totalAssets: d.totalAssets,
      stockholdersEquity: d.stockholdersEquity, totalDebt: d.totalDebt,
      epsDiluted: d.epsDiluted, dividendsPerShare: d.dividendsPerShare,
      stockPrice: d.stockPrice, marketCap: d.marketCap, employees: d.employees,
      softwareARR: d.softwareARR,
      swRev: sw, coRev: seg.Consulting || null, infRev: seg.Infrastructure || null,
      gdp: gdp[y] != null ? gdp[y] : null,
      cpi: cpi[y] != null ? cpi[y] : null,
      sp500: sp[y] != null ? sp[y] : null,
      nasdaq: nq[y] != null ? nq[y] : null,
      treasury10yr: tsy[y]  != null ? tsy[y]  : null,
      maSpend: maSpend[y] != null ? maSpend[y] : null,
      maCount: maCount[y] != null ? maCount[y] : null,
    };
    const div = (a, b) => (a != null && b != null && b !== 0) ? a / b : null;
    r.opMargin      = div(d.pretaxIncome, rev) != null ? d.pretaxIncome / rev * 100 : null;
    r.netMargin     = div(d.netIncome, rev)    != null ? d.netIncome    / rev * 100 : null;
    r.fcfMargin     = div(d.freeCashFlow, rev) != null ? d.freeCashFlow / rev * 100 : null;
    r.fcfConversion = div(d.freeCashFlow, d.netIncome) != null ? d.freeCashFlow / d.netIncome * 100 : null;
    r.rdPct         = div(d.rdExpense, rev)    != null ? d.rdExpense    / rev * 100 : null;
    r.capexPct      = div(d.capitalExpenditure, rev) != null ? d.capitalExpenditure / rev * 100 : null;
    r.effTaxRate    = div(d.incomeTaxes, d.pretaxIncome) != null ? d.incomeTaxes / d.pretaxIncome * 100 : null;
    r.roe           = div(d.netIncome, d.stockholdersEquity) != null ? d.netIncome / d.stockholdersEquity * 100 : null;
    r.roa           = div(d.netIncome, d.totalAssets) != null ? d.netIncome / d.totalAssets * 100 : null;
    r.assetTurnover = div(rev, d.totalAssets);
    r.debtEquity    = div(d.totalDebt, d.stockholdersEquity);
    r.divPayout     = div(d.dividendsPerShare, d.epsDiluted) != null ? d.dividendsPerShare / d.epsDiluted * 100 : null;
    r.revPerEmployee = (rev != null && d.employees) ? rev * 1000 / d.employees : null;  // $K per head
    r.swPct         = div(sw, rev)  != null ? sw / rev * 100 : null;
    r.coPct         = div(seg.Consulting, rev) != null ? seg.Consulting / rev * 100 : null;
    r.infPct        = div(seg.Infrastructure, rev) != null ? seg.Infrastructure / rev * 100 : null;
    r.roic = (d.pretaxIncome != null && d.totalDebt != null && d.stockholdersEquity != null &&
              (d.totalDebt + d.stockholdersEquity) !== 0)
              ? d.pretaxIncome * 0.75 / (d.totalDebt + d.stockholdersEquity) * 100 : null;
    r.pe        = (d.marketCap != null && d.netIncome != null && d.netIncome > 0) ? d.marketCap / d.netIncome : null;
    r.pb        = div(d.marketCap, d.stockholdersEquity);
    r.ps        = div(d.marketCap, rev);
    r.fcfYield  = div(d.freeCashFlow, d.marketCap) != null ? d.freeCashFlow / d.marketCap * 100 : null;
    r.divYield  = div(d.dividendsPerShare, d.stockPrice) != null ? d.dividendsPerShare / d.stockPrice * 100 : null;
    return r;
  });
  return _rows;
}

let _byYear = null;
function getByYear() {
  if (!_byYear) _byYear = new Map(getRows().map(r => [r.year, r]));
  return _byYear;
}

/** Build (x, y[, x2]) observations for the current spec. */
function extractPairs(spec) {
  const byYear = getByYear();
  const out = [];
  for (let y = spec.lo; y <= spec.hi; y++) {
    const yy = y + spec.lag;
    if (yy > spec.hi) continue;
    const xRow = byYear.get(y), yRow = byYear.get(yy);
    const xv = xRow ? xRow[spec.xKey] : null;
    const yv = yRow ? yRow[spec.yKey] : null;
    if (xv == null || yv == null) continue;
    const p = { year: y, yYear: yy, x: xv, y: yv };
    if (spec.x2Key) {
      const x2 = xRow ? xRow[spec.x2Key] : null;
      if (x2 == null) continue;
      p.x2 = x2;
    }
    out.push(p);
  }
  return out;
}

/* ============================================================
   MODEL FITTING
   ============================================================ */
function fitForm(pairs, formId) {
  const form = FORMS[formId];
  const n = pairs.length;
  if (n < form.k + 2) return null;
  if (form.needXpos && pairs.some(p => p.x <= 0)) return null;
  if (form.needYpos && pairs.some(p => p.y <= 0)) return null;
  const X = pairs.map(p => form.design(p.x));
  const yT = pairs.map(p => form.fy(p.y));
  const core = olsCore(X, yT);
  if (!core) return null;
  // back-transform predictions, compute R² on the ORIGINAL y scale so all
  // model forms are comparable
  const yhatO = core.yhat.map(form.inv);
  const yO = pairs.map(p => p.y);
  const ymO = yO.reduce((a, b) => a + b, 0) / n;
  const SSresO = yO.reduce((s, v, i) => s + (v - yhatO[i]) ** 2, 0);
  const SStotO = yO.reduce((s, v) => s + (v - ymO) ** 2, 0);
  const r2 = SStotO > 1e-12 ? 1 - SSresO / SStotO : 1;
  const adjR2 = 1 - (1 - r2) * (n - 1) / Math.max(n - form.k, 1);
  const k = form.k;
  const aicc = n * Math.log(Math.max(SSresO, 1e-9) / n) + 2 * k +
               (n - k - 1 > 0 ? (2 * k * (k + 1)) / (n - k - 1) : 40);
  const residO = yO.map((v, i) => v - yhatO[i]);
  // r2fit = R² of the regression actually run (in log space for log-y forms) —
  // the headline number; r2/adjR2/aicc stay on the original scale so forms
  // can be compared against each other
  const r2fit = core.r2t;
  const adjR2fit = 1 - (1 - r2fit) * (n - 1) / Math.max(n - form.k, 1);
  return { formId, form, core, n, r2, adjR2, aicc, r2fit, adjR2fit, rmse: Math.sqrt(SSresO / n),
           yhatO, residO,
           // p-value: slope t-test for 2-param forms, overall F for quadratic
           pVal: k === 2 ? core.pVals[1] : core.pF,
           tStat: k === 2 ? core.tStats[1] : core.F };
}

function fitAllForms(pairs) {
  const fits = {};
  FORM_IDS.forEach(id => { const f = fitForm(pairs, id); if (f) fits[id] = f; });
  return fits;
}

/** Multiple linear regression with two predictors (always linear). */
function fitMultiple(pairs) {
  const n = pairs.length;
  if (n < 5) return null;
  const X = pairs.map(p => [1, p.x, p.x2]);
  const core = olsCore(X, pairs.map(p => p.y));
  if (!core) return null;
  const r12 = pearson(pairs.map(p => p.x), pairs.map(p => p.x2));
  const adjR2 = 1 - (1 - core.r2t) * (n - 1) / Math.max(n - 3, 1);
  return { core, n, r2: core.r2t, adjR2, r12, rmse: Math.sqrt(core.SSres / n) };
}

/* ============================================================
   PRESET SCENARIOS (all fitted with the automatic model pick)
   ============================================================ */
/* Curated scenarios, grouped by the KIND of relationship each one showcases,
   so the presets double as a guided tour of what regression can (and can't)
   show: strong positive co-movement, inverse relationships, curved/compounding
   fits where a non-linear model wins, and lagged/cautionary cases. `rel` keys
   into PRESET_GROUPS. */
const PRESET_GROUPS = [
  { id: "positive", label: "Strong positive", icon: "↗", hint: "two series that climb together" },
  { id: "negative", label: "Inverse",         icon: "↘", hint: "one rises while the other falls" },
  { id: "curved",   label: "Curved & compounding", icon: "⤴", hint: "where a log / power / quadratic model beats the straight line" },
  { id: "lagged",   label: "Lagged & cautionary", icon: "⏳", hint: "delayed effects — and traps to respect" },
];
/* Every preset below was checked against the actual dataset before being
   listed: each one has enough overlapping observations to fit, and the sign of
   its correlation matches the group it sits in. Three earlier presets did not
   survive that check and were replaced —
     - "Buyback era: equity ↓ EPS ↑" was filed as inverse but measures r = +0.39
       over 1993–2002 (and −0.14 across all years): book equity and EPS did not
       move opposite each other, so the story it told was not in the data.
     - "Interest rates → IBM's P/E" measured only r = −0.23. The discount-rate
       effect is real but lands far more clearly on market cap (r = −0.58), so
       that is what it now regresses.
     - "SW ARR → Software rev" had n = 3, below the 4-observation minimum, so it
       could only ever render the "need more observations" error.
   If you add a preset, re-run the same check — a button that renders an error
   or contradicts its own label is worse than no button. */
const PRESETS = [
  // ---- strong positive ------------------------------------------------------
  {
    label: "Revenue → net income", rel: "positive",
    spec: { xKey: "revenue", yKey: "netIncome", lag: 0, era: "all" },
    story: "The most basic question a company can be asked, over 86 years: how much of each additional revenue dollar reaches the bottom line? The spread around the fit is the story — the same revenue supported wildly different profits in the mainframe monopoly, the 1993 crisis and the software era."
  },
  {
    label: "ROE → price/book", rel: "positive",
    spec: { xKey: "roe", yKey: "pb", lag: 0, era: "all" },
    story: "The textbook valuation relationship: a company earning more on its equity should trade at a higher multiple of book value. Four decades of IBM against that rule — one of the tightest fits in this dataset."
  },
  {
    label: "Net income → market cap", rel: "positive",
    spec: { xKey: "netIncome", yKey: "marketCap", lag: 0, era: "all" },
    story: "Does the market pay for earnings? Since 1984, IBM's profit against what investors valued the whole company at. Watch where the points sit above the line (paying for growth) versus below it (paying for decline)."
  },
  {
    label: "S&P 500 → IBM market cap", rel: "positive",
    spec: { xKey: "sp500", yKey: "marketCap", lag: 0, era: "all" },
    story: "Since 1984: does IBM's valuation simply track the index, or has it systematically lagged the market it used to define?"
  },
  {
    label: "FCF → market cap", rel: "positive",
    spec: { xKey: "freeCashFlow", yKey: "marketCap", lag: 0, era: "all" },
    story: "Cash is king? Three decades of free cash flow against what the market was willing to pay for the company at each year-end."
  },
  {
    label: "R&D → Software revenue", rel: "positive",
    spec: { xKey: "rdExpense", yKey: "swRev", lag: 0, era: "hybrid" },
    story: "IBM's software-first bet: does growing R&D investment translate into Software segment revenue? Segment reporting only starts in 2021, so this fits just 5 points — a tight-looking line on almost no data. Treat it as illustrative, not evidence."
  },
  // ---- inverse ----------------------------------------------------------------
  {
    label: "Interest rates → market cap", rel: "negative",
    spec: { xKey: "treasury10yr", yKey: "marketCap", lag: 0, era: "all" },
    story: "The discount-rate story: when the 10-year Treasury yield rises, future earnings are worth less today and valuations should compress. Four decades of rates against IBM's market cap — the clearest inverse relationship in this dataset that isn't just an accounting identity."
  },
  {
    label: "Debt → asset turnover", rel: "negative",
    spec: { xKey: "totalDebt", yKey: "assetTurnover", lag: 0, era: "all" },
    story: "IBM's balance sheet carries a financing arm, so debt funds customer receivables as well as operations. As that debt grew, each dollar of assets generated less revenue. Note the denominator link — assets sit under turnover — so read this as balance-sheet composition, not an operating verdict."
  },
  {
    label: "Headcount → rev / employee", rel: "negative",
    spec: { xKey: "employees", yKey: "revPerEmployee", lag: 0, era: "all" },
    story: "Across 1957–2013: as headcount grew, revenue per head fell. An inverse pairing where the ratio's denominator does part of the work — read the slope with that in mind. Headcount disclosure stops in 2013, which is why the series ends there."
  },
  // ---- curved & compounding -----------------------------------------------------
  {
    label: "US GDP → revenue (power law)", rel: "curved",
    spec: { xKey: "gdp", yKey: "revenue", lag: 0, era: "all" },
    story: "Eight decades of IBM's top line against the US economy. The lab picks the best-fitting curve; if the power (log-log) model wins, its slope reads as IBM's revenue elasticity to GDP."
  },
  {
    label: "Assets → net income", rel: "curved",
    spec: { xKey: "totalAssets", yKey: "netIncome", lag: 0, era: "all" },
    story: "Do bigger balance sheets earn proportionally more? The model shoot-out below shows whether a straight line or a curve describes it best — watch for diminishing returns."
  },
  {
    label: "Employees → revenue (scale)", rel: "curved",
    spec: { xKey: "employees", yKey: "revenue", lag: 0, era: "all" },
    story: "Scale economics, 1957–2013: how tightly did revenue follow headcount across the mainframe boom, the near-death '90s and the services build-out? Rarely a straight line."
  },
  {
    label: "CPI → revenue (inflation ride)", rel: "curved",
    spec: { xKey: "cpi", yKey: "revenue", lag: 0, era: "all" },
    story: "Nominal revenue rides the price level as well as real growth. Regressing revenue on CPI shows how much of the century-long climb is inflation — the curve shape hints at the real growth on top of it."
  },
  // ---- lagged & cautionary ---------------------------------------------------------
  {
    label: "R&D → EPS, 2-year lag", rel: "lagged",
    spec: { xKey: "rdExpense", yKey: "epsDiluted", lag: 2, era: "all" },
    story: "Research is supposed to pay off later — but across 1990–2023 this pairing measures essentially zero correlation. A genuine null result, and a useful one: it shows that a plausible mechanism plus a plausible lag does not guarantee a relationship you can measure at annual resolution."
  },
  {
    label: "M&A spend → revenue, 2-yr lag", rel: "lagged",
    spec: { xKey: "maSpend", yKey: "revenue", lag: 2, era: "all" },
    story: "If acquisitions bought growth, spending should lead revenue. Over 1984–2023 the slope comes out negative — IBM's heaviest deal years were followed by lower revenue, because the biggest spends came during the decline the deals were meant to arrest. Direction of causation is the whole question here; the regression cannot settle it."
  },
  {
    label: "Nasdaq → M&A spend (trap)", rel: "lagged",
    spec: { xKey: "nasdaq", yKey: "maSpend", lag: 0, era: "all" },
    story: "A cautionary tale: two series that both trend upward will 'correlate' even without a causal link. Check the Durbin–Watson statistic and the spurious-trend warning below before believing this one."
  },
];

/* ============================================================
   SVG UTILITIES
   ============================================================ */
const NS = "http://www.w3.org/2000/svg";
function mkEl(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
function mkTxt(content, attrs) {
  const t = mkEl("text", attrs);
  t.textContent = content;
  return t;
}
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

/* ============================================================
   SCATTER PLOT (+ fitted curve, CI band, era colours, residuals)
   ============================================================ */
function renderScatter(host, pairs, fit, spec) {
  if (!pairs.length) {
    host.innerHTML = '<p class="reg-empty">No overlapping data for this combination. Try a different preset, drop the lag, or pick different metrics.</p>';
    return;
  }
  const xM = metaByKey[spec.xKey], yM = metaByKey[spec.yKey];
  const isMLR = !!spec.x2Key;

  const W = 680, H = 400, ML = 78, MR = 24, MT = 28, MB = 64;
  const pW = W - ML - MR, pH = H - MT - MB;

  // For MLR the scatter becomes actual-vs-predicted
  let xs, ys, xTitle, yTitle;
  if (isMLR && fit) {
    xs = fit.core.yhat; ys = pairs.map(p => p.y);
    xTitle = `Predicted ${yM.short} (${yM.unit})`;
    yTitle = `Actual ${yM.short} (${yM.unit})`;
  } else {
    xs = pairs.map(p => p.x); ys = pairs.map(p => p.y);
    xTitle = `${xM.label} (${xM.unit})`;
    yTitle = `${yM.label} (${yM.unit})`;
  }

  const xSpan = Math.max(...xs) - Math.min(...xs) || Math.abs(Math.max(...xs)) * 0.2 || 2;
  const ySpan = Math.max(...ys) - Math.min(...ys) || Math.abs(Math.max(...ys)) * 0.2 || 2;
  const xLo = Math.min(...xs) - xSpan * 0.14, xHi = Math.max(...xs) + xSpan * 0.14;
  const yLo = Math.min(...ys) - ySpan * 0.2,  yHi = Math.max(...ys) + ySpan * 0.2;
  const xOf = v => ML + (v - xLo) / (xHi - xLo) * pW;
  const yOf = v => MT + pH - (v - yLo) / (yHi - yLo) * pH;

  const svg = mkEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "reg-scatter" });
  const xFmt = axisOf(isMLR ? yM.unit : xM.unit), yFmt = axisOf(yM.unit);

  // grid
  niceTicks(xLo, xHi, 5).forEach(t => {
    const x = xOf(t);
    if (x < ML - 2 || x > W - MR + 2) return;
    svg.appendChild(mkEl("line", { x1: x, y1: MT, x2: x, y2: MT + pH, stroke: "#22222e", "stroke-width": "1" }));
    svg.appendChild(mkTxt(xFmt(t), { x, y: MT + pH + 17, "text-anchor": "middle", class: "reg-tick" }));
  });
  niceTicks(yLo, yHi, 5).forEach(t => {
    const y = yOf(t);
    if (y < MT - 2 || y > MT + pH + 2) return;
    svg.appendChild(mkEl("line", { x1: ML, y1: y, x2: ML + pW, y2: y, stroke: "#22222e", "stroke-width": "1" }));
    svg.appendChild(mkTxt(yFmt(t), { x: ML - 8, y: y + 4, "text-anchor": "end", class: "reg-tick" }));
  });
  svg.appendChild(mkEl("line", { x1: ML, y1: MT + pH, x2: ML + pW, y2: MT + pH, stroke: "#3a3a4a", "stroke-width": "1.5" }));
  svg.appendChild(mkEl("line", { x1: ML, y1: MT, x2: ML, y2: MT + pH, stroke: "#3a3a4a", "stroke-width": "1.5" }));

  if (isMLR && fit) {
    // 45° reference line for actual-vs-predicted
    const lo = Math.max(xLo, yLo), hi = Math.min(xHi, yHi);
    svg.appendChild(mkEl("line", {
      x1: xOf(lo), y1: yOf(lo), x2: xOf(hi), y2: yOf(hi),
      stroke: "#4589ff", "stroke-width": "2", "stroke-dasharray": "7 3", opacity: "0.85",
    }));
  } else if (fit) {
    // CI band + fitted curve, sampled across the x range in original units
    const form = fit.form, core = fit.core;
    const N = 90;
    const sampleLo = form.needXpos ? Math.max(xLo, Math.min(...xs) * 0.5, 1e-9) : xLo;
    const tC = tCrit95(core.dfRes);
    const upper = [], lower = [], curve = [];
    for (let i = 0; i < N; i++) {
      const x = sampleLo + (xHi - sampleLo) * i / (N - 1);
      if (form.needXpos && x <= 0) continue;
      const row = form.design(x);
      const predT = row.reduce((s, v, j) => s + v * core.beta[j], 0);
      let varMean = 0;
      for (let a = 0; a < row.length; a++)
        for (let b = 0; b < row.length; b++) varMean += row[a] * core.cov[a][b] * row[b];
      const half = tC * Math.sqrt(Math.max(0, varMean));
      const yC = form.inv(predT), yU = form.inv(predT + half), yL = form.inv(predT - half);
      if (![yC, yU, yL].every(isFinite)) continue;
      const cy = Math.max(MT - 40, Math.min(MT + pH + 40, yOf(yC)));
      curve.push(`${xOf(x).toFixed(1)},${cy.toFixed(1)}`);
      upper.push(`${xOf(x).toFixed(1)},${Math.max(MT - 40, Math.min(MT + pH + 40, yOf(yU))).toFixed(1)}`);
      lower.unshift(`${xOf(x).toFixed(1)},${Math.max(MT - 40, Math.min(MT + pH + 40, yOf(yL))).toFixed(1)}`);
    }
    if (upper.length > 1) {
      svg.appendChild(mkEl("polygon", {
        points: [...upper, ...lower].join(" "),
        fill: "rgba(69,137,255,0.10)", stroke: "none",
      }));
    }
    if (curve.length > 1) {
      svg.appendChild(mkEl("polyline", {
        points: curve.join(" "), fill: "none",
        stroke: "#4589ff", "stroke-width": "2", "stroke-dasharray": "7 3", opacity: "0.9",
      }));
    }
  }

  // points, era-coloured, with tooltips (+ labels when sparse)
  const showLabels = pairs.length <= 14;
  const xValFmt = fmtOf(xM.unit), yValFmt = fmtOf(yM.unit);
  pairs.forEach((p, i) => {
    const px = isMLR && fit ? fit.core.yhat[i] : p.x;
    const cx = xOf(px), cy = yOf(p.y);
    const era = pointEra(p.year);
    const c = mkEl("circle", {
      cx: cx.toFixed(1), cy: cy.toFixed(1), r: "5.5",
      fill: era.color, stroke: "#0b0b10", "stroke-width": "1.5",
    });
    const tip = mkEl("title");
    tip.textContent = `${spec.lag > 0 ? `${p.year} → ${p.yYear}` : p.year}\n` +
      (isMLR ? `actual ${yValFmt(p.y)}` : `X ${xValFmt(p.x)}  ·  Y ${yValFmt(p.y)}`) +
      (p.x2 != null ? `\nX₂ ${fmtOf(metaByKey[spec.x2Key].unit)(p.x2)}` : "");
    c.appendChild(tip);
    svg.appendChild(c);
    if (showLabels) {
      const lbl = spec.lag > 0 ? `${p.year}→${p.yYear}` : String(p.year);
      const anchor = cx > W * 0.75 ? "end" : "start";
      svg.appendChild(mkTxt(lbl, {
        x: (cx + (cx > W * 0.75 ? -10 : 9)).toFixed(1), y: (cy - 7).toFixed(1),
        class: "reg-dot-label", "text-anchor": anchor,
      }));
    }
  });

  svg.appendChild(mkTxt(xTitle, { x: (ML + pW / 2).toFixed(0), y: H - 4, "text-anchor": "middle", class: "reg-axis-title" }));
  svg.appendChild(mkTxt(yTitle, {
    transform: `translate(14,${(MT + pH / 2).toFixed(0)}) rotate(-90)`,
    "text-anchor": "middle", class: "reg-axis-title",
  }));

  host.innerHTML = "";
  host.appendChild(svg);

  // era legend, only if the points span more than one era bucket
  const erasUsed = [...new Set(pairs.map(p => pointEra(p.year).label))];
  if (erasUsed.length > 1) {
    const leg = document.createElement("div");
    leg.className = "reg-era-legend";
    leg.innerHTML = POINT_ERAS
      .filter(e => erasUsed.includes(e.label))
      .map(e => `<span class="reg-era-key"><i style="background:${e.color}"></i>${esc(e.label)}</span>`)
      .join("");
    host.appendChild(leg);
  }

  // residual sub-plot (single-predictor fits with enough points)
  if (fit && !isMLR && pairs.length >= 5) {
    host.appendChild(renderResiduals(pairs, fit, spec, yM.unit));
  }
}

function renderResiduals(pairs, fit, spec, yUnit) {
  const W = 680, H = 130, ML = 78, MR = 24, MT = 16, MB = 26;
  const pW = W - ML - MR, pH = H - MT - MB;
  const res = fit.residO;
  const years = pairs.map(p => p.yYear);
  const yLo0 = Math.min(...res, 0), yHi0 = Math.max(...res, 0);
  const pad = (yHi0 - yLo0) * 0.15 || 1;
  const yLo = yLo0 - pad, yHi = yHi0 + pad;
  const xLo = Math.min(...years) - 0.5, xHi = Math.max(...years) + 0.5;
  const xOf = v => ML + (v - xLo) / (xHi - xLo) * pW;
  const yOf = v => MT + pH - (v - yLo) / (yHi - yLo) * pH;
  const svg = mkEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "reg-scatter reg-resid" });
  svg.appendChild(mkTxt("Residuals (actual − fitted) by year", { x: ML, y: 11, class: "reg-axis-title" }));
  svg.appendChild(mkEl("line", { x1: ML, y1: yOf(0), x2: ML + pW, y2: yOf(0), stroke: "#3a3a4a", "stroke-width": "1" }));
  const fmt = fmtOf(yUnit);
  res.forEach((e, i) => {
    const x = xOf(years[i]);
    svg.appendChild(mkEl("line", { x1: x, y1: yOf(0), x2: x, y2: yOf(e), stroke: e >= 0 ? "#42be65" : "#ff832b", "stroke-width": "2", opacity: 0.8 }));
    const c = mkEl("circle", { cx: x, cy: yOf(e), r: 3, fill: e >= 0 ? "#42be65" : "#ff832b" });
    const t = mkEl("title"); t.textContent = `${years[i]}: ${fmt(e)}`; c.appendChild(t);
    svg.appendChild(c);
  });
  const maxYear = Math.max(...years);
  niceTicks(xLo, xHi, 6).forEach(t => {
    if (t % 1 !== 0) return;
    if (t > maxYear) return;   // niceTicks can round up to one step past the last real year
    svg.appendChild(mkTxt(String(t), { x: xOf(t), y: H - 8, "text-anchor": "middle", class: "reg-tick" }));
  });
  return svg;
}

/* ============================================================
   STATS PANEL
   ============================================================ */
function slopeStory(fit, spec) {
  const xM = metaByKey[spec.xKey], yM = metaByKey[spec.yKey];
  const xUnit = xM.unit, yUnit = yM.unit;
  const b = fit.core.beta[1];
  const yF = fmtOf(yUnit);
  if (fit.formId === "power")
    return `elasticity: a 1% rise in ${xM.short} associates with a ${b >= 0 ? "+" : ""}${b.toFixed(2)}% change in ${yM.short}`;
  if (fit.formId === "expy") {
    const incr = { "$M": 1000, "$B": 1000, "%": 1, "$": 1, "×": 0.1, "idx": 100, "ct": 1000, "$K": 100 }[xUnit] || 1;
    const pct = (Math.exp(b * incr) - 1) * 100;
    return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% in ${yM.short} per ${fmtOf(xUnit)(incr)} of ${xM.short}`;
  }
  if (fit.formId === "logx")
    return `doubling ${xM.short} associates with ${b >= 0 ? "+" : ""}${yF(b * Math.LN2)} in ${yM.short}`;
  if (fit.formId === "quad") {
    const c = fit.core.beta[2];
    return `curvature ${c >= 0 ? "opens upward (accelerating)" : "opens downward (diminishing returns)"}; see equation below`;
  }
  // linear
  const incr = { "$M": 1000, "$B": 1000, "%": 1, "$": 1, "×": 0.1, "idx": 100, "ct": 1000, "$K": 100 }[xUnit] || 1;
  const dy = b * incr;
  const incrTxt = xUnit === "%" ? "1 pp" : xUnit === "ct" ? "1,000" : fmtOf(xUnit)(incr);
  const dyClean = yUnit === "%" ? `${dy >= 0 ? "+" : ""}${dy.toFixed(2)} pp` : `${dy >= 0 ? "+" : "−"}${yF(Math.abs(dy))}`;
  return `${dyClean} in ${yM.short} per ${incrTxt} in ${xM.short}`;
}

function equationText(fit) {
  const b = fit.core.beta.map(v => Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : v.toPrecision(3));
  const sgn = j => fit.core.beta[j] >= 0 ? "+ " : "− ";
  const mag = j => Math.abs(fit.core.beta[j]) >= 1000 ? Math.round(Math.abs(fit.core.beta[j])).toLocaleString() : Math.abs(fit.core.beta[j]).toPrecision(3);
  switch (fit.formId) {
    case "linear": return `ŷ = ${b[0]} ${sgn(1)}${mag(1)}·x`;
    case "quad":   return `ŷ = ${b[0]} ${sgn(1)}${mag(1)}·x ${sgn(2)}${mag(2)}·x²`;
    case "logx":   return `ŷ = ${b[0]} ${sgn(1)}${mag(1)}·ln x`;
    case "expy":   return `ln ŷ = ${b[0]} ${sgn(1)}${mag(1)}·x`;
    case "power":  return `ln ŷ = ${b[0]} ${sgn(1)}${mag(1)}·ln x`;
  }
  return "";
}

function buildWarnings(pairs, fit, spec) {
  const w = [];
  const n = pairs.length;
  if (n > 0 && n <= 6) w.push(`n = ${n}: statistical power is very low — p-values and R² can flatter noise. Treat as exploratory.`);
  else if (n > 6 && n < 10) w.push(`n = ${n}: modest sample — coefficients are sensitive to single years.`);
  if (fit && n >= 8) {
    const yrs = pairs.map(p => p.year);
    const cx = pearson(yrs, pairs.map(p => p.x)), cy = pearson(yrs, pairs.map(p => p.y));
    if (cx != null && cy != null && Math.abs(cx) > 0.85 && Math.abs(cy) > 0.85)
      w.push("Both series trend strongly with time — much of this correlation may simply be shared growth over the decades rather than a causal link.");
  }
  if (fit) {
    const dw = durbinWatson(fit.residO || fit.core.resid);
    if (dw != null && dw < 1.2) w.push(`Durbin–Watson = ${dw.toFixed(2)} (<1.2): residuals are positively autocorrelated; standard errors are optimistic.`);
  }
  if ((spec.xKey === "freeCashFlow" || spec.yKey === "freeCashFlow" || spec.x2Key === "freeCashFlow") && spec.lo < 2003)
    w.push("FCF before 2003 is derived (OCF − net CapEx) rather than IBM-stated, so there is a small definitional break at 2002/2003.");
  if (spec.lo < 2022 && spec.hi >= 2021 && (spec.xKey === "revenue" || spec.yKey === "revenue" ||
      ["swRev","coRev","infRev","swPct","coPct","infPct"].includes(spec.xKey) || ["swRev","coRev","infRev","swPct","coPct","infPct"].includes(spec.yKey)))
    w.push("The Kyndryl spinoff (Nov 2021) removed ~$19B of managed-infrastructure revenue — a structural break that fits spanning 2021 will absorb into the slope.");
  return w;
}

function renderStats(host, pairs, fit, mlrFit, spec) {
  const isMLR = !!spec.x2Key;
  const theFit = isMLR ? mlrFit : fit;
  if (!theFit) {
    host.innerHTML = `<div class="reg-nofit">Need at least ${isMLR ? 5 : 4} overlapping observations — found ${pairs.length}.<br>Try a different preset, shorten the lag, or change metrics.</div>`;
    return;
  }

  const xM = metaByKey[spec.xKey], yM = metaByKey[spec.yKey];
  const isLogY = !isMLR && (fit.formId === "expy" || fit.formId === "power");
  const headR2 = isMLR ? mlrFit.r2 : (isLogY ? fit.r2fit : fit.r2);
  const headAdj = isMLR ? mlrFit.adjR2 : (isLogY ? fit.adjR2fit : fit.adjR2);
  const r2Pct = (headR2 * 100).toFixed(1);
  const adjPct = (headAdj * 100).toFixed(1);
  const r2Desc = headR2 >= 0.85 ? "very strong" : headR2 >= 0.65 ? "strong" : headR2 >= 0.4 ? "moderate" : headR2 >= 0.15 ? "weak" : "negligible";

  const xs = pairs.map(p => p.x), ys = pairs.map(p => p.y);
  const rP = pearson(xs, ys), rS = spearman(xs, ys);
  const years = pairs.map(p => p.year);
  const yearNote = spec.lag > 0
    ? `${Math.min(...years)}–${Math.max(...years)} (X), Y lagged +${spec.lag}yr`
    : `${Math.min(...years)}–${Math.max(...years)}`;
  const dw = durbinWatson(theFit.residO || theFit.core.resid);

  let rowsHTML = "";
  if (isMLR) {
    const c = mlrFit.core;
    const names = ["Intercept", xM.short, metaByKey[spec.x2Key].short];
    const coefRows = names.map((nm, j) => `
      <tr><td>${esc(nm)}</td>
          <td>${Math.abs(c.beta[j]) >= 1000 ? Math.round(c.beta[j]).toLocaleString() : c.beta[j].toPrecision(4)}</td>
          <td>${c.tStats[j].toFixed(2)}</td>
          <td class="${c.pVals[j] < 0.05 ? "reg-sig-yes" : "reg-sig-no"}">${c.pVals[j] < 0.001 ? "<0.001" : c.pVals[j].toFixed(3)}</td></tr>`).join("");
    rowsHTML = `
      <div class="reg-coef-wrap"><table class="reg-coef-table">
        <thead><tr><th>Coefficient</th><th>β</th><th>t</th><th>p</th></tr></thead>
        <tbody>${coefRows}</tbody></table></div>
      <div class="reg-stat-rows">
        <div class="reg-stat-row"><span class="reg-stat-lbl">Overall F-test p</span>
          <span class="reg-stat-val ${c.pF < 0.05 ? "reg-sig-yes" : "reg-sig-no"}">${c.pF < 0.001 ? "<0.001" : c.pF.toFixed(3)}</span></div>
        <div class="reg-stat-row"><span class="reg-stat-lbl">Predictor correlation r(X₁,X₂)</span>
          <span class="reg-stat-val">${mlrFit.r12 == null ? "—" : mlrFit.r12.toFixed(3)}</span></div>
        <div class="reg-stat-row"><span class="reg-stat-lbl">RMSE</span><span class="reg-stat-val">${fmtOf(yM.unit)(mlrFit.rmse)}</span></div>
        <div class="reg-stat-row"><span class="reg-stat-lbl">Durbin–Watson</span><span class="reg-stat-val">${dw == null ? "—" : dw.toFixed(2)}</span></div>
        <div class="reg-stat-row"><span class="reg-stat-lbl">n</span><span class="reg-stat-val">${mlrFit.n} obs (${yearNote})</span></div>
      </div>`;
    if (mlrFit.r12 != null && Math.abs(mlrFit.r12) > 0.8)
      rowsHTML += `<div class="reg-warning">Predictors are highly correlated (|r| = ${Math.abs(mlrFit.r12).toFixed(2)}) — individual coefficients are unstable (multicollinearity).</div>`;
  } else {
    const pStr = fit.pVal < 0.001 ? "<0.001" : fit.pVal.toFixed(3);
    const sigCls = fit.pVal < 0.05 ? "reg-sig-yes" : "reg-sig-no";
    const sigTxt = fit.pVal < 0.01 ? "significant ✓ p<0.01"
                 : fit.pVal < 0.05 ? "significant ✓ p<0.05"
                 : fit.pVal < 0.10 ? "marginal · p<0.10" : "not significant";
    rowsHTML = `
      <div class="reg-stat-rows">
        <div class="reg-stat-row"><span class="reg-stat-lbl">Best model (auto)</span><span class="reg-stat-val">${FORMS[fit.formId].label}</span></div>
        <div class="reg-stat-row"><span class="reg-stat-lbl">Equation</span><span class="reg-stat-val reg-eq">${equationText(fit)}</span></div>
        <div class="reg-stat-row reg-stat-slope"><span class="reg-stat-lbl">Reading</span><span class="reg-stat-val">${slopeStory(fit, spec)}</span></div>
        <div class="reg-stat-row"><span class="reg-stat-lbl">${fit.form.k === 2 ? "t-statistic (slope)" : "F-statistic"}</span><span class="reg-stat-val">${fit.tStat.toFixed(2)}</span></div>
        ${fit.form.k === 2 ? (() => {
          const b = fit.core.beta[1], half = tCrit95(fit.core.dfRes) * fit.core.se[1];
          const f = v => Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : v.toPrecision(3);
          return `<div class="reg-stat-row"><span class="reg-stat-lbl">Slope 95% CI</span><span class="reg-stat-val">${f(b - half)} to ${f(b + half)}</span></div>`;
        })() : ""}
        <div class="reg-stat-row"><span class="reg-stat-lbl">p-value</span><span class="reg-stat-val ${sigCls}">${pStr}</span></div>
        <div class="reg-stat-row"><span class="reg-stat-lbl">Significance</span><span class="reg-stat-val ${sigCls}">${sigTxt}</span></div>
        <div class="reg-stat-row"><span class="reg-stat-lbl">Pearson r / Spearman ρ</span>
          <span class="reg-stat-val">${rP == null ? "—" : rP.toFixed(3)} / ${rS == null ? "—" : rS.toFixed(3)}</span></div>
        <div class="reg-stat-row"><span class="reg-stat-lbl">RMSE</span><span class="reg-stat-val">${fmtOf(yM.unit)(fit.rmse)}</span></div>
        <div class="reg-stat-row"><span class="reg-stat-lbl">Durbin–Watson</span><span class="reg-stat-val">${dw == null ? "—" : dw.toFixed(2)}</span></div>
        <div class="reg-stat-row"><span class="reg-stat-lbl">n</span><span class="reg-stat-val">${fit.n} obs (${yearNote})</span></div>
      </div>`;
  }

  const warnings = buildWarnings(pairs, theFit, spec);
  host.innerHTML = `
    <div class="reg-stats-inner">
      <div class="reg-stat-primary">
        <div class="reg-r2-big">${r2Pct}<span class="reg-r2-sup">%</span></div>
        <div class="reg-r2-label">R² — ${r2Desc} fit${isMLR ? " (2 predictors)" : ""}</div>
        <div class="reg-r2-adj">Adjusted R² = ${adjPct}%${isLogY ? ` · fitted in log space; back-transformed to the ${esc(yM.unit)} scale, R² = ${(fit.r2 * 100).toFixed(0)}% (model table)` : ""}</div>
      </div>
      ${rowsHTML}
      <div class="reg-ci-note">Shaded band = 95% confidence interval for the fitted mean. ${isMLR ? "Dashed line = perfect prediction (45°)." : ""}</div>
      ${["freeCashFlow","fcfMargin","fcfConversion","fcfYield"].some(k => k === spec.xKey || k === spec.yKey || k === spec.x2Key)
        ? '<div class="reg-ci-note">FCF here is a levered measure: operating cash flow (already net of interest paid under US GAAP) minus net CapEx. IBM’s own stated figure additionally excludes the change in Global Financing receivables.</div>' : ""}
      ${warnings.map(w => `<div class="reg-warning">⚠ ${esc(w)}</div>`).join("")}
    </div>`;
}

/* ============================================================
   MODEL COMPARISON TABLE (read-only — the best form is always used)
   ============================================================ */
function renderModelCompare(host, pairs, fits, activeId, spec) {
  if (spec.x2Key || !Object.keys(fits).length) { host.innerHTML = ""; host.style.display = "none"; return; }
  host.style.display = "";
  const fittedValues = Object.values(fits);
  const bestAicc = fittedValues.length ? Math.min(...fittedValues.map(f => f.aicc)) : 0;
  const rows = FORM_IDS.map(id => {
    const f = fits[id];
    if (!f) {
      const why = FORMS[id].needXpos && pairs.some(p => p.x <= 0) ? "needs x > 0"
               : FORMS[id].needYpos && pairs.some(p => p.y <= 0) ? "needs y > 0"
               : "too few points";
      return `<tr class="reg-model-na"><td>${FORMS[id].label}</td><td colspan="5">not fittable — ${why}</td></tr>`;
    }
    const delta = f.aicc - bestAicc;
    const deltaCls = delta < 2 ? "reg-aic-best" : delta < 4 ? "reg-aic-close" : "reg-aic-poor";
    const deltaStr = id === activeId ? "0 (best)" : `+${delta.toFixed(1)}`;
    return `<tr class="reg-model-row${id === activeId ? " active best" : ""}">
      <td>${FORMS[id].label}${id === activeId ? ' <span class="reg-best-tag">chosen</span>' : ""}</td>
      <td>${(f.r2 * 100).toFixed(1)}%</td>
      <td>${(f.adjR2 * 100).toFixed(1)}%</td>
      <td>${f.aicc.toFixed(1)}</td>
      <td class="${deltaCls}">${deltaStr}</td>
      <td class="${f.pVal < 0.05 ? "reg-sig-yes" : "reg-sig-no"}">${f.pVal < 0.001 ? "<0.001" : f.pVal.toFixed(3)}</td>
    </tr>`;
  }).join("");
  host.innerHTML = `
    <p class="section-title" style="margin:0 0 4px">How the model was chosen</p>
    <p class="reg-mc-hint">All five functional forms are fitted to the same data and the one with the lowest AICc (best fit after penalizing extra parameters) is used automatically. R² here is computed on the original y-scale so the forms are directly comparable. <b>ΔAIC &lt; 2</b> = essentially equivalent; <b>ΔAIC 2–4</b> = some support for the winner; <b>ΔAIC &gt; 4</b> = winner clearly preferred.</p>
    <div class="reg-table-wrap"><table class="reg-data-table reg-model-table">
      <thead><tr><th>Model</th><th>R²</th><th>Adj. R²</th><th>AICc</th><th>ΔAIC</th><th>p</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

/* ============================================================
   DATA TABLE + CSV EXPORT
   ============================================================ */
function renderTable(host, pairs, fit, mlrFit, spec) {
  if (!pairs.length) { host.innerHTML = ""; return; }
  const xM = metaByKey[spec.xKey], yM = metaByKey[spec.yKey];
  const theFit = spec.x2Key ? mlrFit : fit;
  const hasFit = !!theFit;
  const resid = hasFit ? (theFit.residO || theFit.core.resid) : null;

  const xHdr = `${xM.short}${spec.lag > 0 ? " (t)" : ""}`;
  const yHdr = `${yM.short}${spec.lag > 0 ? ` (t+${spec.lag})` : ""}`;
  const x2Hdr = spec.x2Key ? metaByKey[spec.x2Key].short : null;

  const rows = pairs.map((p, i) => `
    <tr>
      <td>${spec.lag > 0 ? `${p.year} → ${p.yYear}` : p.year}</td>
      <td>${fullOf(xM.unit)(p.x)}</td>
      ${x2Hdr ? `<td>${fullOf(metaByKey[spec.x2Key].unit)(p.x2)}</td>` : ""}
      <td>${fullOf(yM.unit)(p.y)}</td>
      ${hasFit ? `<td class="${resid[i] >= 0 ? "reg-res-pos" : "reg-res-neg"}">${fmtOf(yM.unit)(resid[i])}</td>` : ""}
    </tr>`).join("");

  host.innerHTML = `
    <div class="reg-table-head">
      <p class="section-title" style="margin:0">Observations in this fit</p>
      <button class="reg-csv-btn" id="regCsvBtn">Download CSV</button>
    </div>
    <div class="reg-table-wrap">
      <table class="reg-data-table">
        <thead><tr><th>Year</th><th>${esc(xHdr)}</th>${x2Hdr ? `<th>${esc(x2Hdr)}</th>` : ""}<th>${esc(yHdr)}</th>${hasFit ? "<th>Residual</th>" : ""}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  document.getElementById("regCsvBtn").addEventListener("click", () => {
    const head = ["year", xHdr, ...(x2Hdr ? [x2Hdr] : []), yHdr, ...(hasFit ? ["residual"] : [])];
    const lines = [head.join(",")];
    pairs.forEach((p, i) => {
      lines.push([spec.lag > 0 ? `${p.year}->${p.yYear}` : p.year, p.x,
        ...(x2Hdr ? [p.x2] : []), p.y, ...(hasFit ? [resid[i]] : [])].join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ibm_regression_${spec.xKey}_vs_${spec.yKey}_${spec.lo}-${spec.hi}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

/* ============================================================
   PANEL HTML
   ============================================================ */
function metricOptions(sel, allowNone) {
  let html = allowNone ? `<option value=""${!sel ? " selected" : ""}>— none —</option>` : "";
  html += GROUP_ORDER.map(g => {
    const opts = REG_METRICS.filter(m => m.group === g)
      .map(m => `<option value="${m.key}"${m.key === sel ? " selected" : ""}>${esc(m.label)}</option>`).join("");
    return opts ? `<optgroup label="${esc(g)}">${opts}</optgroup>` : "";
  }).join("");
  return html;
}

function buildPanelHTML() {
  const presetGroups = PRESET_GROUPS.map(g => {
    const btns = PRESETS.map((p, i) => ({ p, i })).filter(x => x.p.rel === g.id)
      .map(x => `<button class="reg-preset-btn rel-${g.id}${x.i === 0 ? " active" : ""}" data-preset="${x.i}"><span class="rel-dot"></span>${esc(x.p.label)}</button>`)
      .join("");
    return `<div class="reg-preset-group rel-${g.id}">
      <div class="reg-preset-group-head"><span class="rel-icon">${g.icon}</span>${esc(g.label)}<span class="rel-hint">${esc(g.hint)}</span></div>
      <div class="reg-preset-grid">${btns}</div>
    </div>`;
  }).join("");

  return `
    <div class="hero" style="padding-bottom:0">
      <div class="hero-text">
        <div class="hero-kicker">Regression Lab · ${REG_METRICS.length} metrics · 1911&ndash;2025 · best-fit model chosen automatically</div>
        <h1>Pick two metrics<br>The lab finds the curve</h1>
        <p>Explore relationships across the company's 115-year record. Choose any pairing (plus an optional lag or second predictor); the lab fits linear, logarithmic, exponential, power and quadratic models and shows you the best one — computed live from the parsed annual-report data.</p>
      </div>
    </div>

    <div class="card reg-presets-card">
      <p class="section-title" style="margin:0 0 10px">Curated scenarios — grouped by the kind of relationship they showcase</p>
      ${presetGroups}
    </div>

    <div class="reg-story-bar" id="regStoryBar"></div>

    <div class="card reg-controls-card">
      <div class="reg-control-row">
        <div class="reg-field">
          <label class="reg-label" for="regX">X — predictor</label>
          <select class="reg-select" id="regX">${metricOptions("rdExpense")}</select>
        </div>
        <div class="reg-field">
          <label class="reg-label" for="regY">Y — outcome</label>
          <select class="reg-select" id="regY">${metricOptions("swRev")}</select>
        </div>
        <div class="reg-field">
          <label class="reg-label" for="regX2">X&#8322; — second predictor (optional)</label>
          <select class="reg-select" id="regX2">${metricOptions("", true)}</select>
        </div>
        <div class="reg-field reg-field-sm">
          <label class="reg-label" for="regLag">X lag (years)</label>
          <select class="reg-select" id="regLag">
            <option value="0">0 — same year</option>
            <option value="1">1 — X predicts Y+1</option>
            <option value="2">2 — X predicts Y+2</option>
            <option value="3">3 — X predicts Y+3</option>
            <option value="4">4 — X predicts Y+4</option>
            <option value="5">5 — X predicts Y+5</option>
          </select>
        </div>
        <button class="reg-run-btn" id="regRun">Run</button>
      </div>
    </div>

    <div class="reg-workspace">
      <div class="card reg-scatter-card" id="regScatterCard"></div>
      <div class="card reg-stats-card" id="regStatsCard"></div>
    </div>

    <div class="card reg-table-card" id="regModelCard"></div>
    <div class="card reg-table-card" id="regTableCard"></div>`;
}

/* ============================================================
   WIRING
   ============================================================ */
let _inited = false;

function initRegressionLab() {
  if (_inited) return;
  _inited = true;

  const panel = document.getElementById("panel-regression");
  if (!panel) return;
  panel.innerHTML = buildPanelHTML();

  const state = { xKey: "rdExpense", yKey: "swRev", x2Key: "", lag: 0, lo: 1911, hi: 2025 };

  const $ = id => document.getElementById(id);

  // #8 — annotate each <option> with a coverage range badge drawn from the data
  (function annotateCoverage() {
    const rows = getRows();
    REG_METRICS.forEach(m => {
      const years = rows.filter(r => r[m.key] != null).map(r => r.year);
      if (!years.length) return;
      const lo = Math.min(...years), hi = Math.max(...years), n = years.length;
      const badge = ` [${lo}–${hi}, n=${n}]`;
      ["regX", "regY", "regX2"].forEach(selId => {
        const sel = $(selId);
        if (!sel) return;
        const opt = sel.querySelector(`option[value="${m.key}"]`);
        if (opt && !opt.dataset.annotated) { opt.textContent += badge; opt.dataset.annotated = "1"; }
      });
    });
  })();

  const readControls = () => {
    state.xKey = $("regX").value;
    state.yKey = $("regY").value;
    state.x2Key = $("regX2").value || "";
    state.lag = +$("regLag").value;
    // No year-range control anymore — a manual run always uses every
    // available data point for the chosen metrics (extractPairs already
    // drops years where either series is null).
    state.lo = 1911;
    state.hi = 2025;
  };
  const writeControls = () => {
    $("regX").value = state.xKey; $("regY").value = state.yKey;
    $("regX2").value = state.x2Key; $("regLag").value = String(state.lag);
  };

  function runAll() {
    const spec = { ...state };
    const pairs = extractPairs(spec);
    let fits = {}, fit = null, mlrFit = null;
    if (spec.x2Key) {
      mlrFit = fitMultiple(pairs);
    } else {
      fits = fitAllForms(pairs);
      const avail = Object.values(fits);
      fit = avail.length ? avail.reduce((a, b) => (b.aicc < a.aicc ? b : a)) : null;
    }
    const displayFit = spec.x2Key ? mlrFit : fit;
    renderScatter($("regScatterCard"), pairs, displayFit, spec);
    renderStats($("regStatsCard"), pairs, fit, mlrFit, spec);
    renderModelCompare($("regModelCard"), pairs, fits, fit ? fit.formId : null, spec);
    renderTable($("regTableCard"), pairs, fit, mlrFit, spec);
  }

  const clearPresetHighlight = () =>
    panel.querySelectorAll(".reg-preset-btn").forEach(b => b.classList.remove("active"));

  // presets
  panel.querySelectorAll(".reg-preset-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      clearPresetHighlight();
      btn.classList.add("active");
      const p = PRESETS[+btn.dataset.preset];
      const era = ERAS.find(e => e.id === (p.spec.era || "all")) || ERAS[0];
      Object.assign(state, {
        xKey: p.spec.xKey, yKey: p.spec.yKey, x2Key: p.spec.x2Key || "",
        lag: p.spec.lag || 0, lo: era.lo, hi: era.hi,
      });
      writeControls();
      $("regStoryBar").innerHTML = `<div class="reg-story">${esc(p.story)}</div>`;
      runAll();
    });
  });

  // manual run
  $("regRun").addEventListener("click", () => {
    clearPresetHighlight();
    $("regStoryBar").innerHTML = "";
    readControls(); runAll();
  });

  // boot with first preset
  const first = PRESETS[0];
  const era0 = ERAS.find(e => e.id === (first.spec.era || "all")) || ERAS[0];
  Object.assign(state, {
    xKey: first.spec.xKey, yKey: first.spec.yKey, x2Key: "",
    lag: first.spec.lag || 0, lo: era0.lo, hi: era0.hi,
  });
  writeControls();
  $("regStoryBar").innerHTML = `<div class="reg-story">${esc(first.story)}</div>`;
  runAll();
}

window.initRegressionLab = initRegressionLab;

})();
