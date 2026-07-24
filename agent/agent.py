"""agent.py — CugaAgent wired to the IBM annual-reports dashboard data.

Modeled on the dashboardcreator sample: LangChain @tool functions +
CugaAgent(tools=[...]) + a synchronous ask_agent() wrapper with one
persistent event loop.

Tools (everything on the site is reachable):
  get_dataset_info      — what this dataset is, coverage, tabs, generated date
  list_metrics          — every metric key with unit and year coverage
  get_financials_year   — the full financial record for one fiscal year
  get_metric_series     — a metric's year-by-year values over a range
  get_metric_stats      — min / max / mean / latest / CAGR for a metric
  get_cagr              — compound annual growth rate between two years
  compare_years         — side-by-side of two fiscal years across key metrics
  get_top_years         — best / worst years for a metric
  get_segments          — segment revenue (Software / Consulting / Infra) 2021+
  get_segment_margins   — FY2025 segment gross margins
  get_fcf_history       — free cash flow with per-year sourcing notes
  get_ma_deals          — filter/search the 78 filing-sourced M&A deals
  get_ma_era_summary    — acquisitions, divestitures and spend per CEO era
  get_milestones        — company milestones in a year range
  get_leadership        — CEO list, or who ran IBM in a given year
  get_macro_series      — US GDP / CPI / S&P 500 / Nasdaq / rates by year
  run_regression        — OLS fit (linear + log-log) between any two metrics

  -- browser control (needs the dashboard open in a tab; see browser_bridge.py) --
  list_browser_tools    — every window.CUGA tool available in the live page
  browser_action        — call ANY window.CUGA tool by name: navigate tabs,
                          configure the Regression Lab, open an M&A era drawer,
                          set the Overview chart's metrics/scale/range,
                          highlight an element, post/clear an on-page note,
                          download a metric as CSV, ...

Run the interactive server:  python agent/server.py   (see agent/README.md)
"""

from __future__ import annotations

import asyncio
import threading
import json
import math
import os
from functools import lru_cache

from langchain_core.tools import tool

import browser_bridge

# ── Data loading ──────────────────────────────────────────────────────────────
# Reads the same canonical pipeline JSONs the website is generated from.

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "pipeline", "data")


@lru_cache(maxsize=None)
def _load(name):
    with open(os.path.join(DATA, name), encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def _financials():
    """Per-year records merged the same way export_web.py does (cashflow fills gaps)."""
    fin = {r["year"]: dict(r) for r in _load("financials.json")["years"]}
    for y_str, cf in _load("cashflow.json")["years"].items():
        r = fin.get(int(y_str))
        if not r:
            continue
        for k in ("operatingCashFlow", "capitalExpenditure", "freeCashFlow"):
            if r.get(k) is None and cf.get(k) is not None:
                r[k] = cf[k]
    mcap = _load("marketcap.json")["years"]
    for y, r in fin.items():
        r["marketCap"] = mcap.get(str(y))
    return fin


METRICS = {
    "revenue": "$M", "netIncome": "$M", "pretaxIncome": "$M", "incomeTaxes": "$M",
    "freeCashFlow": "$M", "operatingCashFlow": "$M", "capitalExpenditure": "$M",
    "rdExpense": "$M", "totalAssets": "$M", "stockholdersEquity": "$M",
    "totalDebt": "$M", "marketCap": "$M", "softwareARR": "$M",
    "epsDiluted": "$", "epsBasic": "$", "dividendsPerShare": "$",
    "employees": "count",
}


def _series(metric):
    fin = _financials()
    return {y: r.get(metric) for y, r in sorted(fin.items()) if r.get(metric) is not None}


def _bad_metric(name):
    return f"Unknown metric '{name}'. Available: {', '.join(METRICS)}"


def _fmt(v, unit="$M"):
    if v is None:
        return "n/a"
    if unit == "$M":
        return f"${v/1000:,.1f}B" if abs(v) >= 1000 else f"${v:,.0f}M"
    if unit == "$":
        return f"${v:,.2f}"
    return f"{v:,.0f}"


# ── Tools ─────────────────────────────────────────────────────────────────────

@tool
def get_dataset_info() -> str:
    """Describe this dataset: what it is, where the numbers come from, year
    coverage per metric, and what the dashboard tabs show.

    Call this FIRST to learn what is available before using other tools.
    """
    fin = _financials()
    cov = []
    for m in METRICS:
        ys = [y for y, r in fin.items() if r.get(m) is not None]
        if ys:
            cov.append(f"  {m}: {min(ys)}-{max(ys)} ({len(ys)} yrs)")
    return (
        "IBM / CTR financials parsed directly from 116 annual-report PDFs, "
        "fiscal years 1911-2025, US$ millions, never estimated (missing = null).\n"
        "FCF 2003-2025 is IBM's own stated figure (ex-Global-Financing receivables); "
        "1995-2002 is derived OCF - net CapEx.\n"
        "External series: market cap 1984-2025, US GDP 1929+, CPI 1947+, "
        "S&P 500 / Nasdaq 1984+, IBM Baa bond yield & 10-yr Treasury 1962+.\n"
        "Dashboard tabs: Overview, Story Mode, Regression Lab, Macro vs IBM, "
        "M&A (78 filing-sourced deals), Competitors, About & Data.\n\n"
        "Metric coverage:\n" + "\n".join(cov)
    )


@tool
def list_metrics() -> str:
    """List every financial metric key with its unit and first/last covered year.
    Use the exact keys with get_metric_series, get_cagr, run_regression, etc."""
    fin = _financials()
    lines = []
    for m, unit in METRICS.items():
        ys = [y for y, r in fin.items() if r.get(m) is not None]
        rng = f"{min(ys)}-{max(ys)} ({len(ys)} yrs)" if ys else "no data"
        lines.append(f"{m} [{unit}]: {rng}")
    return "\n".join(lines)


@tool
def get_financials_year(year: int) -> str:
    """Full financial record for one fiscal year (all metrics that were reported).

    Args:
        year: fiscal year between 1911 and 2025.
    """
    r = _financials().get(int(year))
    if not r:
        return f"No data for {year}. Coverage is 1911-2025."
    lines = [f"IBM FY{year} (US$ millions unless noted):"]
    for m, unit in METRICS.items():
        if r.get(m) is not None:
            lines.append(f"  {m}: {_fmt(r[m], unit)}")
    if r.get("basis"):
        lines.append(f"  basis: {r['basis']}")
    return "\n".join(lines)


@tool
def get_metric_series(metric: str, from_year: int = 1911, to_year: int = 2025) -> str:
    """Year-by-year values of one metric over a range.

    Args:
        metric:    a key from list_metrics (e.g. 'revenue', 'freeCashFlow').
        from_year: first year (default 1911).
        to_year:   last year (default 2025).
    """
    if metric not in METRICS:
        return _bad_metric(metric)
    s = {y: v for y, v in _series(metric).items() if from_year <= y <= to_year}
    if not s:
        return f"No {metric} data in {from_year}-{to_year}."
    unit = METRICS[metric]
    return f"{metric} ({unit}):\n" + "\n".join(f"  {y}: {_fmt(v, unit)}" for y, v in s.items())


@tool
def get_metric_stats(metric: str, from_year: int = 1911, to_year: int = 2025) -> str:
    """Summary statistics for a metric over a range: n, min, max, mean, latest,
    and CAGR from the first to the last covered year.

    Args:
        metric:    a key from list_metrics.
        from_year: first year (default 1911).
        to_year:   last year (default 2025).
    """
    if metric not in METRICS:
        return _bad_metric(metric)
    s = {y: v for y, v in _series(metric).items() if from_year <= y <= to_year}
    if not s:
        return f"No {metric} data in {from_year}-{to_year}."
    ys, vs = list(s), list(s.values())
    unit = METRICS[metric]
    lo_y = min(s, key=s.get)
    hi_y = max(s, key=s.get)
    cagr = ""
    if vs[0] and vs[0] > 0 and vs[-1] and vs[-1] > 0 and ys[-1] > ys[0]:
        g = (vs[-1] / vs[0]) ** (1 / (ys[-1] - ys[0])) - 1
        cagr = f"\n  CAGR {ys[0]}-{ys[-1]}: {g*100:.2f}%/yr"
    return (
        f"{metric} over {ys[0]}-{ys[-1]} (n={len(s)}):\n"
        f"  min: {_fmt(s[lo_y], unit)} ({lo_y})\n"
        f"  max: {_fmt(s[hi_y], unit)} ({hi_y})\n"
        f"  mean: {_fmt(sum(vs)/len(vs), unit)}\n"
        f"  latest: {_fmt(vs[-1], unit)} ({ys[-1]})" + cagr
    )


@tool
def get_cagr(metric: str, from_year: int, to_year: int) -> str:
    """Compound annual growth rate of a metric between two years.

    Args:
        metric:    a key from list_metrics.
        from_year: start year.
        to_year:   end year.
    """
    if metric not in METRICS:
        return _bad_metric(metric)
    s = _series(metric)
    a, b = s.get(int(from_year)), s.get(int(to_year))
    if a is None or b is None:
        return f"{metric} missing for {from_year} or {to_year}. Try get_metric_series first."
    if a <= 0:
        return f"CAGR undefined: {metric} in {from_year} is {a} (must be > 0)."
    g = (b / a) ** (1 / (to_year - from_year)) - 1
    return (f"{metric} {from_year} -> {to_year}: {_fmt(a, METRICS[metric])} -> "
            f"{_fmt(b, METRICS[metric])} = {g*100:.2f}%/yr CAGR over {to_year-from_year} years")


@tool
def compare_years(year_a: int, year_b: int) -> str:
    """Side-by-side comparison of two fiscal years across all covered metrics,
    with the change between them.

    Args:
        year_a: first fiscal year.
        year_b: second fiscal year.
    """
    fin = _financials()
    ra, rb = fin.get(int(year_a)), fin.get(int(year_b))
    if not ra or not rb:
        return "One of those years is outside 1911-2025."
    lines = [f"{'metric':22} {year_a:>12} {year_b:>12} {'change':>10}"]
    for m, unit in METRICS.items():
        va, vb = ra.get(m), rb.get(m)
        if va is None and vb is None:
            continue
        chg = f"{(vb-va)/abs(va)*100:+.1f}%" if (va not in (None, 0) and vb is not None) else "—"
        lines.append(f"{m:22} {_fmt(va, unit):>12} {_fmt(vb, unit):>12} {chg:>10}")
    return "\n".join(lines)


@tool
def get_top_years(metric: str, n: int = 5, order: str = "best") -> str:
    """The n best or worst years for a metric.

    Args:
        metric: a key from list_metrics.
        n:      how many years to return (default 5).
        order:  'best' (highest values) or 'worst' (lowest).
    """
    if metric not in METRICS:
        return _bad_metric(metric)
    s = _series(metric)
    if not s:
        return f"No data for {metric}."
    ranked = sorted(s.items(), key=lambda kv: kv[1], reverse=(order != "worst"))
    unit = METRICS[metric]
    return (f"{order} {min(n, len(ranked))} years for {metric}:\n" +
            "\n".join(f"  {y}: {_fmt(v, unit)}" for y, v in ranked[:n]))


@tool
def get_segments(year: int = 2025) -> str:
    """Segment revenue (Software / Consulting / Infrastructure / Financing)
    for one year. Segment data exists 2021-2025 (post-Kyndryl basis).

    Args:
        year: fiscal year 2021-2025 (default 2025).
    """
    seg = _load("segments.json")
    row = next((s for s in seg["years"] if s["year"] == int(year)), None)
    if not row:
        return "Segment revenue is only available 2021-2025."
    total = sum(v for v in row["segments"].values())
    lines = [f"IBM FY{year} segment revenue (external, US$M):"]
    for k, v in sorted(row["segments"].items(), key=lambda kv: -kv[1]):
        lines.append(f"  {k}: {_fmt(v)} ({v/total*100:.0f}%)")
    return "\n".join(lines)


@tool
def get_segment_margins() -> str:
    """FY2025 gross margin by segment, as reported in the segment note."""
    gm = _load("segments.json").get("segmentGrossMargin2025", {})
    if not gm:
        return "Segment gross margins not available."
    return "FY2025 segment gross margins:\n" + "\n".join(
        f"  {k}: {v}%" for k, v in sorted(gm.items(), key=lambda kv: -kv[1]))


@tool
def get_fcf_history(from_year: int = 1995, to_year: int = 2025) -> str:
    """Free cash flow by year with sourcing: 2003-2025 are IBM's own stated
    figures (excluding the change in Global Financing receivables); 1995-2002
    are derived as OCF - net CapEx from the cash-flow statements.

    Args:
        from_year: first year (default 1995 — earliest FCF coverage).
        to_year:   last year (default 2025).
    """
    s = {y: v for y, v in _series("freeCashFlow").items() if from_year <= y <= to_year}
    if not s:
        return "No FCF data in that range."
    lines = ["IBM free cash flow (US$M):"]
    for y, v in s.items():
        src = "IBM-stated" if y >= 2003 else "derived (OCF - net CapEx)"
        lines.append(f"  {y}: {_fmt(v)}  [{src}]")
    return "\n".join(lines)


@tool
def get_ma_deals(deal_type: str = "all", from_year: int = 1984, to_year: int = 2025,
                 min_value_millions: float = 0, search: str = "") -> str:
    """Filter and search IBM's 78 filing-sourced M&A deals.

    Args:
        deal_type:          'acquisition', 'divestiture', 'spinoff', or 'all'.
        from_year:          first deal year (default 1984).
        to_year:            last deal year (default 2025).
        min_value_millions: only deals at or above this disclosed value (default 0 = all).
        search:             case-insensitive substring match on deal name or category.
    """
    deals = _load("ma.json")["deals"]
    q = search.strip().lower()
    hits = [d for d in deals
            if from_year <= d["year"] <= to_year
            and (deal_type == "all" or d["type"] == deal_type)
            and (d.get("valueMillions") or 0) >= min_value_millions
            and (not q or q in d["name"].lower() or q in (d.get("category") or "").lower())]
    if not hits:
        return "No deals match those filters."
    hits.sort(key=lambda d: (d["year"], -(d.get("valueMillions") or 0)))
    lines = [f"{len(hits)} deals:"]
    for d in hits[:40]:
        v = _fmt(d["valueMillions"]) if d.get("valueMillions") else "undisclosed"
        lines.append(f"  {d['year']} {d['type']}: {d['name']} — {v} ({d.get('category', '—')})")
    if len(hits) > 40:
        lines.append(f"  … +{len(hits)-40} more (narrow the filters)")
    return "\n".join(lines)


@tool
def get_ma_era_summary() -> str:
    """Acquisitions, divestitures/spin-offs, and disclosed spend per CEO era
    (Pre-Gerstner, Gerstner, Palmisano, Rometty, Krishna)."""
    eras = [("Pre-Gerstner", 1984, 1992), ("Gerstner", 1993, 2002),
            ("Palmisano", 2003, 2011), ("Rometty", 2012, 2019), ("Krishna", 2020, 2025)]
    deals = _load("ma.json")["deals"]
    lines = []
    for label, a, b in eras:
        in_era = [d for d in deals if a <= d["year"] <= b]
        acq = [d for d in in_era if d["type"] == "acquisition"]
        div = [d for d in in_era if d["type"] in ("divestiture", "spinoff")]
        spend = sum(d.get("valueMillions") or 0 for d in acq)
        big = max(acq, key=lambda d: d.get("valueMillions") or 0, default=None)
        lines.append(f"{label} ({a}-{b}): {len(acq)} acquisitions, {len(div)} divestitures/spin-offs, "
                     f"{_fmt(spend)} disclosed spend"
                     + (f", largest {big['name']} ({_fmt(big['valueMillions'])})" if big and big.get("valueMillions") else ""))
    return "\n".join(lines)


@tool
def get_milestones(from_year: int = 1911, to_year: int = 2025) -> str:
    """Company milestones (founding, System/360, PC, Deep Blue, Red Hat, …)
    within a year range.

    Args:
        from_year: first year (default 1911).
        to_year:   last year (default 2025).
    """
    ms = [m for m in _load("metadata.json")["milestones"] if from_year <= m["year"] <= to_year]
    if not ms:
        return "No milestones in that range."
    return "\n".join(f"  {m['year']}: {m['event']}" for m in ms)


@tool
def get_leadership(year: int = 0) -> str:
    """IBM's CEOs. With a year argument, returns who ran IBM that year;
    with no/zero year, lists all CEOs and their tenures.

    Args:
        year: optional fiscal year (0 = list everyone).
    """
    leaders = _load("metadata.json")["leadership"]
    if year:
        hit = [l for l in leaders if l["from"] <= year <= (l["to"] or 2025)]
        return (f"{year}: " + ", ".join(f"{l['name']} ({l['from']}-{l['to'] or 'present'})" for l in hit)
                if hit else f"No CEO record for {year}.")
    return "\n".join(f"  {l['name']}: {l['from']}-{l['to'] or 'present'}" for l in leaders)


@tool
def get_macro_series(series: str, from_year: int = 1929, to_year: int = 2025) -> str:
    """US macro data used by the dashboard, by year.

    Args:
        series:    one of 'gdp' ($B, 1929+), 'cpi' (index, 1947+),
                   'sp500' (year-end, 1984+), 'nasdaq' (year-end, 1984+),
                   'ibmBondYield' (%, 1962+), 'treasury10yr' (%, 1962+),
                   'recessions' (NBER date ranges).
        from_year: first year.
        to_year:   last year.
    """
    macro = _load("macro.json")
    keymap = {"gdp": "gdpBillionsUSD", "cpi": "cpiIndex", "sp500": "sp500YearEnd",
              "nasdaq": "nasdaqYearEnd", "ibmBondYield": "ibmBondYield",
              "treasury10yr": "treasury10yr"}
    if series == "recessions":
        rec = [r for r in macro["recessions"] if r["end"] >= from_year and r["start"] <= to_year]
        return "\n".join(f"  {r['start']}-{r['end']}: {r.get('name', 'Recession')}" for r in rec)
    key = keymap.get(series)
    if not key or key not in macro:
        return f"Unknown series '{series}'. Available: {', '.join(keymap)}, recessions"
    vals = {int(y): v for y, v in macro[key].items()
            if str(y).isdigit() and from_year <= int(y) <= to_year}
    return f"{series}:\n" + "\n".join(f"  {y}: {v:,}" for y, v in sorted(vals.items()))


@tool
def run_regression(x_metric: str, y_metric: str, from_year: int = 1911,
                   to_year: int = 2025, lag: int = 0) -> str:
    """OLS regression between two metrics (linear fit, plus a log-log fit whose
    slope is an elasticity when both series are positive). X may lead Y by a lag.

    Args:
        x_metric:  predictor — a key from list_metrics.
        y_metric:  outcome — a key from list_metrics.
        from_year: first year of the window (default 1911).
        to_year:   last year (default 2025).
        lag:       years X leads Y (0-5; e.g. lag=2 tests X predicting Y two years later).
    """
    if x_metric not in METRICS:
        return _bad_metric(x_metric)
    if y_metric not in METRICS:
        return _bad_metric(y_metric)
    sx, sy = _series(x_metric), _series(y_metric)
    pairs = [(sx[y], sy[y + lag], y) for y in sx
             if from_year <= y <= to_year and (y + lag) in sy and (y + lag) <= to_year]
    n = len(pairs)
    if n < 4:
        return f"Only {n} overlapping observations — need at least 4. Widen the range."

    def ols(xs, ys):
        xm, ym = sum(xs) / len(xs), sum(ys) / len(ys)
        sxx = sum((x - xm) ** 2 for x in xs)
        sxy = sum((x - xm) * (y - ym) for x, y in zip(xs, ys))
        syy = sum((y - ym) ** 2 for y in ys)
        if sxx == 0 or syy == 0:
            return None
        b = sxy / sxx
        a = ym - b * xm
        r = sxy / math.sqrt(sxx * syy)
        return a, b, r, r * r

    xs = [p[0] for p in pairs]
    ys = [p[1] for p in pairs]
    lin = ols(xs, ys)
    out = [f"{y_metric} ~ {x_metric}" + (f" (X leads by {lag}yr)" if lag else "") +
           f", {pairs[0][2]}-{pairs[-1][2]}, n={n}:"]
    if lin:
        a, b, r, r2 = lin
        out.append(f"  linear: y = {a:,.2f} + {b:.4f}x | r={r:.3f}, R²={r2*100:.1f}%")
    if all(x > 0 for x in xs) and all(y > 0 for y in ys):
        ll = ols([math.log(x) for x in xs], [math.log(y) for y in ys])
        if ll:
            a, b, r, r2 = ll
            out.append(f"  log-log: elasticity = {b:.3f} (a 1% rise in {x_metric} ~ "
                       f"{b:+.2f}% change in {y_metric}) | R²={r2*100:.1f}%")
    out.append("  caution: annual data; small n and shared time trends can flatter correlations. "
               "The website's Regression Lab has full diagnostics.")
    return "\n".join(out)


# ── Browser control ───────────────────────────────────────────────────────────
# These bridge to window.CUGA in an open dashboard tab (agent-tools.js), via
# browser_bridge's command queue. They require the site to be open somewhere
# with agent-tools.js loaded and polling; otherwise they time out with a
# message explaining that, rather than raising.

@tool
def list_browser_tools() -> str:
    """List every tool the live dashboard page exposes to agents (window.CUGA),
    with descriptions and parameters. Call this before browser_action if you
    don't already know the exact tool name and arguments — it reflects
    whatever agent-tools.js currently defines, so it stays accurate even if
    the page's tools change.

    Requires the dashboard to be open in a browser tab; times out after ~10s
    with an explanatory message if no tab is polling.
    """
    try:
        manifest = browser_bridge.run_browser_command("__manifest__", {}, timeout=10)
    except RuntimeError as e:
        return str(e)
    lines = ["Live dashboard tools (call via browser_action):"]
    for t in manifest:
        params = ", ".join(t["parameters"].get("properties", {}))
        lines.append(f"  {t['name']}({params}): {t['description']}")
    return "\n".join(lines)


@tool
def browser_action(tool_name: str, tool_args: dict | None = None) -> str:
    """Execute a tool in the live dashboard page — navigate tabs, configure
    the Regression Lab, open an M&A era drawer, change the Overview chart's
    metrics/scale/year-range, highlight an element, post or clear an on-page
    note banner, download a metric as CSV, get a live stock quote, and more.

    Call list_browser_tools first if you're unsure of the exact tool_name or
    its argument names. Requires the dashboard open in a browser tab; if none
    is polling, this times out after ~25s with an explanatory message instead
    of raising.

    Args:
        tool_name: exact name from list_browser_tools (e.g. 'navigate_to_tab',
                   'configure_regression', 'set_agent_note', 'highlight_element').
        tool_args: keyword arguments for that tool, e.g. {"tab": "ma"} for
                   navigate_to_tab, or {} for tools that take none.
    """
    try:
        result = browser_bridge.run_browser_command(tool_name, tool_args or {}, timeout=25)
    except RuntimeError as e:
        return str(e)
    return json.dumps(result, default=str) if not isinstance(result, str) else result


ALL_TOOLS = [
    get_dataset_info, list_metrics, get_financials_year, get_metric_series,
    get_metric_stats, get_cagr, compare_years, get_top_years, get_segments,
    get_segment_margins, get_fcf_history, get_ma_deals, get_ma_era_summary,
    get_milestones, get_leadership, get_macro_series, run_regression,
    list_browser_tools, browser_action,
]

# ── Agent factory ─────────────────────────────────────────────────────────────

_agent = None
_agent_lock = threading.Lock()


SPECIAL_INSTRUCTIONS = """\
You are the data analyst embedded in an IBM annual-reports dashboard \
(1911-2025, IBM/CTR financials, M&A, segments, US macro). Ground every \
answer in tool output, not prior knowledge - IBM-specific numbers must come \
from these tools. When a metric is ambiguous, call list_metrics first \
instead of guessing a key. Always state the fiscal year(s) a figure covers. \
If the user's request implies changing what's on screen ("show me", "go to", \
"navigate", "highlight", "open", "configure the regression lab", "leave a \
note", "change the chart") - call list_browser_tools once if unsure of exact \
tool names, then use browser_action to actually do it, don't just describe \
what you would do. Keep final answers to 1-3 sentences unless the user asks \
for a table or detail."""


def get_agent():
    """Return the singleton CugaAgent, creating it on first call. Locked so a
    real request landing during the background warm_up() (~90s of cuga/torch
    import + graph build) blocks and reuses that in-flight construction
    instead of racing it and building a redundant second instance."""
    global _agent
    if _agent is not None:
        return _agent
    with _agent_lock:
        if _agent is None:
            from cuga import CugaAgent  # noqa: PLC0415 — lazy import keeps startup fast
            _agent = CugaAgent(tools=ALL_TOOLS, enable_knowledge=False,
                               special_instructions=SPECIAL_INSTRUCTIONS)
    return _agent


def warm_up():
    """Force-construct the agent and its LangGraph now, off the request path.
    Cold start (first-ever cuga import + graph build + WatsonX client) takes
    ~60-70s; call this once at server boot (see server.py's startup hook) so
    the first real user request doesn't pay that tax."""
    get_agent()


# ── Synchronous wrapper ───────────────────────────────────────────────────────
# One persistent loop for the process: the CugaAgent holds async resources
# bound to the loop it first ran on, so closing the loop between questions
# breaks every call after the first.

_loop: asyncio.AbstractEventLoop | None = None


def _get_loop() -> asyncio.AbstractEventLoop:
    global _loop
    if _loop is None or _loop.is_closed():
        _loop = asyncio.new_event_loop()
    return _loop


def ask_agent(question: str, thread_id: str = "default") -> str:
    """Run agent.invoke synchronously (for non-async hosts like the API server)."""
    try:
        agent = get_agent()
        result = _get_loop().run_until_complete(
            agent.invoke(question, thread_id=thread_id)
        )
        return result.answer or "No response from agent."
    except Exception as e:  # surface the reason to the caller, don't crash the server
        return f"Agent error: {e}"


if __name__ == "__main__":
    # Smoke test without the LLM: exercise a few tools directly.
    print(get_dataset_info.invoke({}))
    print(get_cagr.invoke({"metric": "revenue", "from_year": 2020, "to_year": 2025}))
    print(run_regression.invoke({"x_metric": "rdExpense", "y_metric": "netIncome",
                                 "from_year": 1990, "to_year": 2025, "lag": 2}))
