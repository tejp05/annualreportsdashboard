"""server.py — HTTP bridge for the IBM-dashboard CUGA agent.

Endpoints:
  POST /chat                 {"question": "...", "thread_id": "..."} -> CUGA agent answer
  GET  /tools                list every tool with its description (discovery)
  POST /tools/{tool_name}    invoke ONE tool directly (no LLM) with JSON args —
                             these are the endpoints watsonx Orchestrate imports
                             as an OpenAPI toolset (see orchestrate/README.md)
  GET  /quote?symbol=IBM     live market quote proxy (Yahoo Finance), used by the
                             website's live-price widget and usable as an
                             Orchestrate tool
  GET  /filings/latest       recent 10-K/10-Q/8-K filings from SEC EDGAR (submissions
                             API) for IBM, so the site can show/refresh when a new
                             annual or quarterly report is filed
  GET  /filings/xbrl         latest filed revenue/net income/EPS (annual + last few
                             quarters) straight from SEC's structured XBRL data —
                             powers the "Latest Filed Results" widget/chart, which
                             updates itself the moment IBM files a new 10-Q/10-K,
                             without waiting on this repo's PDF pipeline re-run

  -- browser command bridge (lets the CUGA agent drive an open dashboard tab) --
  GET  /commands/next            long-poll: the browser calls this; returns the
                                  next queued {id, tool, args} or 204 if none
  POST /commands/{id}/result     the browser posts {ok, result, error} back
  (the agent-side tool functions in agent.py enqueue via _run_browser_command
   and block until the browser responds or the timeout elapses)

Run:  pip install -r agent/requirements.txt
      python agent/server.py            # serves on http://localhost:8787
CORS is open so the static site (any port) can call it.
"""

from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime
import urllib.parse
import urllib.request
import uuid

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()  # reads ../.env (WATSONX_API_KEY etc.) before agent.py touches cuga

from agent import ALL_TOOLS, ask_agent, warm_up
import browser_bridge

app = FastAPI(
    title="IBM Annual Reports Dashboard — Agent Tools",
    description=(
        "CUGA agent chat plus direct tool endpoints over 115 years of IBM "
        "annual-report data (financials, segments, M&A, macro, regressions). "
        "POST /tools/{name} endpoints are importable into watsonx Orchestrate "
        "as an OpenAPI toolset."
    ),
    version="1.0.0",
)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

TOOLS_BY_NAME = {t.name: t for t in ALL_TOOLS}


@app.on_event("startup")
def _prewarm_agent():
    """Cold-starting cuga (heavy imports + LangGraph build + WatsonX client)
    takes ~60-70s; without this, whoever sends the FIRST /chat request eats
    that tax. Warm it in a background thread so uvicorn still binds the port
    immediately - the server is reachable right away, /chat just blocks a bit
    longer than usual until the warm-up thread finishes."""
    threading.Thread(target=warm_up, daemon=True).start()


class ChatBody(BaseModel):
    question: str
    thread_id: str = "web"


@app.get("/health")
def health():
    """Cheap status check: is the CUGA agent warmed up yet? The chat panel's
    online/offline indicator hits this instead of /tools so it can tell 'up
    but still warming' apart from 'ready for a fast reply'."""
    import agent as agent_module
    return {"server": "up", "agentWarm": agent_module._agent is not None}


@app.post("/chat")
def chat(body: ChatBody):
    """Ask the CUGA agent a question in natural language."""
    return {"answer": ask_agent(body.question, body.thread_id)}


@app.get("/tools")
def list_tools():
    """Discovery: every tool name with its full description and arg docs."""
    return [{"name": t.name, "description": t.description} for t in ALL_TOOLS]


@app.post("/tools/{tool_name}")
def invoke_tool(tool_name: str, args: dict | None = None):
    """Invoke one dashboard tool directly (no LLM). Args are the tool's
    keyword arguments as a JSON object; see GET /tools for each tool's docs."""
    t = TOOLS_BY_NAME.get(tool_name)
    if not t:
        raise HTTPException(404, f"Unknown tool '{tool_name}'. See GET /tools.")
    try:
        return {"result": t.invoke(args or {})}
    except Exception as e:
        raise HTTPException(400, f"Tool error: {e}")


class CommandResult(BaseModel):
    ok: bool
    result: object | None = None
    error: str | None = None


@app.get("/commands/next")
def next_command(response: Response):
    """Long-poll target: the browser's agent-tools.js poller calls this in a
    tight loop. Blocks server-side (up to ~30s) waiting for a command so the
    browser isn't hammering an empty queue; returns 204 if the window elapses
    with nothing queued."""
    deadline = time.time() + 30
    while time.time() < deadline:
        cmd = browser_bridge.pop_next_command()
        if cmd is not None:
            return cmd
        time.sleep(0.4)
    response.status_code = 204
    return None


@app.post("/commands/{cmd_id}/result")
def post_command_result(cmd_id: str, body: CommandResult):
    """The browser posts the outcome of executing a command here."""
    found = browser_bridge.resolve_command(cmd_id, body.ok, body.result, body.error)
    return {"accepted": found}


def _daily_price_prev(result: dict) -> tuple[float | None, float | None]:
    """Extract (price, prevClose) from a Yahoo interval=1d chart response.

    meta.chartPreviousClose/previousClose is unreliable on this endpoint (it can
    return a stale value from well before the requested range, not literally
    yesterday's close). The response's own daily closes array is accurate, so
    prefer the second-to-last valid close -- the last entry is today's
    (in-progress or final) bar, matching regularMarketPrice."""
    meta = result["meta"]
    price = meta.get("regularMarketPrice")
    closes = [c for c in result.get("indicators", {}).get("quote", [{}])[0].get("close", []) if c is not None]
    prev = closes[-2] if len(closes) >= 2 else (meta.get("chartPreviousClose") or meta.get("previousClose"))
    return price, prev


@app.get("/quote")
def quote(symbol: str = "IBM"):
    """Live market quote (Yahoo Finance chart API, ~15-min delayed)."""
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/"
           f"{urllib.parse.quote(symbol)}?interval=1d&range=5d")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            j = json.load(r)
        result = j["chart"]["result"][0]
        meta = result["meta"]
        price, prev = _daily_price_prev(result)
        ts = meta.get("regularMarketTime")
        return {
            "symbol": symbol,
            "price": price,
            "prevClose": prev,
            "currency": meta.get("currency"),
            "asOf": datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M") if ts else None,
        }
    except Exception as e:
        raise HTTPException(502, f"Quote unavailable: {e}")


_quotes_cache: dict[str, tuple[float, dict]] = {}


@app.get("/quotes")
def quotes(symbols: str = "IBM,MSFT,ORCL,SAP,AMZN,ACN,GOOGL,NVDA"):
    """Batch quotes for the CNBC-style ticker strip: IBM + competitors.
    One Yahoo chart call per symbol, 60s-cached, fetched in parallel so the
    whole strip loads in one round-trip time."""
    from concurrent.futures import ThreadPoolExecutor

    def one(sym: str):
        sym = sym.strip().upper()
        now = time.time()
        hit = _quotes_cache.get(sym)
        if hit and now - hit[0] < 60:
            return hit[1]
        url = (f"https://query1.finance.yahoo.com/v8/finance/chart/"
               f"{urllib.parse.quote(sym)}?interval=1d&range=5d")
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(req, timeout=8) as r:
                result = json.load(r)["chart"]["result"][0]
            meta = result["meta"]
            price, prev = _daily_price_prev(result)
            out = {"symbol": sym, "price": price, "prevClose": prev,
                   "changePct": round((price - prev) / prev * 100, 2) if price and prev else None,
                   "name": meta.get("shortName") or sym}
        except Exception:
            out = {"symbol": sym, "price": None, "prevClose": None, "changePct": None, "name": sym}
        _quotes_cache[sym] = (now, out)
        return out

    syms = [s for s in symbols.split(",") if s.strip()][:12]
    with ThreadPoolExecutor(max_workers=6) as ex:
        results = list(ex.map(one, syms))
    return {"quotes": [q for q in results if q["price"] is not None]}


@app.get("/quote/history")
def quote_history(symbol: str = "IBM", range: str = "3mo"):
    """Recent daily closes (Yahoo Finance chart API), used to bridge the gap
    between the static Story Mode daily-price file (which only updates when
    the pipeline is re-run) and today, so its stock-price chart stays live."""
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/"
           f"{urllib.parse.quote(symbol)}?interval=1d&range={urllib.parse.quote(range)}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            j = json.load(r)
        result = j["chart"]["result"][0]
        timestamps = result.get("timestamp", [])
        closes = result.get("indicators", {}).get("quote", [{}])[0].get("close", [])
        points = [
            {"date": datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d"), "close": round(c, 4)}
            for ts, c in zip(timestamps, closes) if c is not None
        ]
        return {"symbol": symbol, "points": points}
    except Exception as e:
        raise HTTPException(502, f"History unavailable: {e}")


@app.get("/quote/intraday")
def quote_intraday(symbol: str = "IBM"):
    """5-minute intraday OHLC for today (Yahoo Finance, ~15-min delayed).
    Returns {symbol, prevClose, points:[{t, price}]} where t is Unix seconds
    and price is the close of that 5-min bar. The browser uses this to draw a
    live intraday sparkline that grows with each 60s refresh."""
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/"
           f"{urllib.parse.quote(symbol)}?interval=5m&range=1d")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            j = json.load(r)
        res = j["chart"]["result"][0]
        meta = res["meta"]
        timestamps = res.get("timestamp", [])
        closes = (res.get("indicators", {})
                     .get("quote", [{}])[0]
                     .get("close", []))
        points = [
            {"t": int(ts), "price": round(c, 4)}
            for ts, c in zip(timestamps, closes)
            if c is not None
        ]
        prev = meta.get("chartPreviousClose") or meta.get("previousClose")
        return {"symbol": symbol, "prevClose": prev, "points": points}
    except Exception as e:
        raise HTTPException(502, f"Intraday unavailable: {e}")


# ---- SEC EDGAR: live filings + XBRL (earnings-report auto-refresh) --------
# The historical 1911-2025 charts are built from hand-verified PDF parsing
# (pipeline/) and only change when that pipeline is re-run. This section is
# a *separate*, genuinely live feed straight from SEC EDGAR's public APIs so
# the site can reflect a brand-new 10-K/10-Q the moment it's filed, without
# waiting on a pipeline re-run. Numbers from here are always labeled
# "unaudited by this project" on the frontend, never merged into financials.json.
IBM_CIK = "0000051143"
SEC_HEADERS = {"User-Agent": "IBM-Annual-Reports-Dashboard (research/education; tejpatel@umich.edu)"}
_EARNINGS_FORMS = {"10-K", "10-Q", "8-K"}
_sec_cache: dict[str, tuple[float, object]] = {}
_SEC_CACHE_TTL = 900  # 15 min - SEC asks integrators to keep request rates low; filings are near-static anyway


def _sec_get(url: str):
    """Fetch + JSON-decode a data.sec.gov URL with a short in-memory cache."""
    now = time.time()
    hit = _sec_cache.get(url)
    if hit and now - hit[0] < _SEC_CACHE_TTL:
        return hit[1]
    req = urllib.request.Request(url, headers=SEC_HEADERS)
    with urllib.request.urlopen(req, timeout=10) as r:
        data = json.load(r)
    _sec_cache[url] = (now, data)
    return data


def _accession_url(cik: str, accession: str, doc: str) -> str:
    return f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession.replace('-', '')}/{doc}"


@app.get("/filings/latest")
def filings_latest(symbol: str = "IBM"):
    """Recent 10-K/10-Q/8-K filings from SEC EDGAR, newest first. The 8-Ks
    with item 2.02 ("Results of Operations") are IBM's quarterly earnings
    releases - usually filed a day before the 10-Q/10-K itself, so this is
    typically the first place a new earnings report shows up."""
    try:
        sub = _sec_get(f"https://data.sec.gov/submissions/CIK{IBM_CIK}.json")
    except Exception as e:
        raise HTTPException(502, f"EDGAR unavailable: {e}")
    recent = sub["filings"]["recent"]
    items_col = recent.get("items", [""] * len(recent["form"]))
    out = []
    for i in range(len(recent["form"])):
        form = recent["form"][i]
        if form not in _EARNINGS_FORMS:
            continue
        items = items_col[i]
        if form == "8-K" and "2.02" not in (items or ""):
            continue  # skip non-earnings 8-Ks (governance, dividends, etc.)
        accession = recent["accessionNumber"][i]
        out.append({
            "form": form,
            "filingDate": recent["filingDate"][i],
            "reportDate": recent["reportDate"][i],
            "items": items,
            "accessionNumber": accession,
            "url": _accession_url(IBM_CIK, accession, recent["primaryDocument"][i]),
        })
        if len(out) >= 8:
            break
    return {
        "companyName": sub.get("name"),
        "cik": IBM_CIK,
        "filings": out,
        "latest": out[0] if out else None,
        "nasdaqFilingsUrl": "https://www.nasdaq.com/market-activity/stocks/ibm/sec-filings",
        "secFilingsUrl": f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={IBM_CIK}&type=10-K",
    }


_XBRL_CONCEPTS = {
    "revenue": ("RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues"),
    "netIncome": ("NetIncomeLoss",),
    "epsDiluted": ("EarningsPerShareDiluted",),
}

# Total debt = long-term debt (noncurrent) + short-term borrowings. Verified
# against the pipeline's audited FY2025 figure: LongTermDebtNoncurrent
# ($54,836M) + ShortTermBorrowings ($6,424M) at 2025-12-31 = $61,260M, matching
# financials.json's totalDebt of $61.3B for FY2025. Unlike revenue/EPS these
# are instant (balance-sheet) facts, not duration facts, so they need their
# own extraction path (see _xbrl_instant_series below).
_DEBT_TAGS = ("LongTermDebtNoncurrent", "ShortTermBorrowings")


def _xbrl_concept_points(concept: str, unit_key: str):
    """Fetch one us-gaap concept's full history and split it into clean
    single-quarter and single-year points (SEC's raw feed also has
    overlapping YTD/half-year duplicates we don't want)."""
    try:
        d = _sec_get(f"https://data.sec.gov/api/xbrl/companyconcept/CIK{IBM_CIK}/us-gaap/{concept}.json")
    except Exception:
        return [], []
    points = d.get("units", {}).get(unit_key, [])
    quarters, annuals = [], []
    for p in points:
        try:
            start = datetime.strptime(p["start"], "%Y-%m-%d")
            end = datetime.strptime(p["end"], "%Y-%m-%d")
        except (KeyError, ValueError):
            continue
        days = (end - start).days
        row = {"fy": p.get("fy"), "fp": p.get("fp"), "form": p.get("form"),
               "start": p["start"], "end": p["end"], "filed": p.get("filed"), "val": p["val"]}
        if 80 <= days <= 100 and p.get("form") == "10-Q":
            quarters.append(row)
        elif 355 <= days <= 375 and p.get("form") == "10-K":
            annuals.append(row)
    quarters.sort(key=lambda r: r["end"])
    annuals.sort(key=lambda r: r["end"])
    return quarters, annuals


def _xbrl_instant_series(concept: str) -> dict[str, dict]:
    """Fetch one us-gaap *instant* (balance-sheet) concept and return one
    point per period-end date, deduplicated. A period-end balance is often
    repeated as a prior-period comparative in later filings (e.g. FY2025's
    12/31/25 long-term-debt balance reappears in the Q1 and Q2 2026 10-Qs) —
    keep the value from whichever filing first reported it."""
    try:
        d = _sec_get(f"https://data.sec.gov/api/xbrl/companyconcept/CIK{IBM_CIK}/us-gaap/{concept}.json")
    except Exception:
        return {}
    by_end: dict[str, dict] = {}
    for p in d.get("units", {}).get("USD", []):
        if p.get("form") not in ("10-Q", "10-K") or not p.get("end"):
            continue
        existing = by_end.get(p["end"])
        if existing is None or p["filed"] < existing["filed"]:
            by_end[p["end"]] = {"val": p["val"], "filed": p["filed"], "form": p["form"],
                                 "fy": p.get("fy"), "fp": p.get("fp")}
    return by_end


def _total_debt_series() -> list[dict]:
    """Long-term debt (noncurrent) + short-term borrowings, combined by
    period-end date. Only period-ends present in *both* concepts are used, so
    a partial/missing tag never silently understates total debt."""
    long_term = _xbrl_instant_series(_DEBT_TAGS[0])
    short_term = _xbrl_instant_series(_DEBT_TAGS[1])
    out = []
    for end in sorted(set(long_term) & set(short_term)):
        lt, st = long_term[end], short_term[end]
        out.append({
            "periodEnd": end, "val": lt["val"] + st["val"],
            "filed": max(lt["filed"], st["filed"]), "form": lt["form"],
            "fy": lt["fy"], "fp": lt["fp"],
        })
    return out


@app.get("/filings/xbrl")
def filings_xbrl(symbol: str = "IBM"):
    """Latest reported revenue / net income / diluted EPS straight from SEC's
    structured XBRL data - annual + the last several quarters. This is the
    live feed behind the site's auto-updating "Latest Filed Results" widget:
    the moment IBM's next 10-Q or 10-K hits EDGAR, these numbers change and
    the site's periodic refresh picks them up - no pipeline re-run needed."""
    series = {}
    for metric, tags in _XBRL_CONCEPTS.items():
        unit_key = "USD/shares" if metric == "epsDiluted" else "USD"
        for tag in tags:
            q, a = _xbrl_concept_points(tag, unit_key)
            if q or a:
                series[metric] = (q, a)
                break
        else:
            series[metric] = ([], [])

    def merge(period_key: str):
        by_end: dict[str, dict] = {}
        for metric, (quarters, annuals) in series.items():
            for row in (quarters if period_key == "q" else annuals):
                slot = by_end.setdefault(row["end"], {
                    "fy": row["fy"], "fp": row["fp"], "periodStart": row["start"],
                    "periodEnd": row["end"], "filed": row["filed"], "form": row["form"],
                })
                slot[metric] = row["val"]
                if row["filed"] > slot["filed"]:
                    slot["filed"] = row["filed"]
        return sorted(by_end.values(), key=lambda r: r["periodEnd"])

    quarterly, annual = merge("q"), merge("a")
    debt_series = _total_debt_series()
    return {
        "recentQuarters": quarterly[-8:],
        "recentAnnual": annual[-5:],
        "latestQuarter": quarterly[-1] if quarterly else None,
        "latestAnnual": annual[-1] if annual else None,
        "recentDebt": debt_series[-8:],
        "latestDebt": debt_series[-1] if debt_series else None,
    }


if __name__ == "__main__":
    # AGENT_HOST=0.0.0.0 to expose beyond localhost (remote hosting);
    # AGENT_PORT to move off 8787. Pair with the site's ?agent= URL override.
    uvicorn.run(app,
                host=os.environ.get("AGENT_HOST", "127.0.0.1"),
                port=int(os.environ.get("AGENT_PORT", "8787")))
