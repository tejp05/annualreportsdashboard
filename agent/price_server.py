"""price_server.py — lightweight server for live price and SEC filings endpoints only.

No cuga/LLM/agent dependencies required.

Endpoints:
  GET  /quote?symbol=IBM          live market quote (Yahoo Finance, ~15-min delayed)
  GET  /quotes?symbols=IBM,MSFT   batch quotes for ticker strip
  GET  /quote/intraday?symbol=IBM 5-minute intraday OHLC for today
  GET  /filings/latest            recent 10-K/10-Q/8-K from SEC EDGAR
  GET  /filings/xbrl              latest revenue/net income/EPS from SEC XBRL
  GET  /health                    status check

Run:
  pip install fastapi uvicorn[standard] python-dotenv
  python agent/price_server.py      # serves on http://localhost:8787
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from datetime import datetime

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="IBM Dashboard — Price & Filings", version="1.0.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"server": "up", "agentWarm": False}


# ── Yahoo Finance quotes ──────────────────────────────────────────────────────

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
    """Batch quotes for the ticker strip. 60-second cached, parallel fetch."""
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


@app.get("/quote/intraday")
def quote_intraday(symbol: str = "IBM"):
    """5-minute intraday OHLC for today (Yahoo Finance, ~15-min delayed)."""
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


# ── SEC EDGAR filings + XBRL ─────────────────────────────────────────────────

IBM_CIK = "0000051143"
SEC_HEADERS = {"User-Agent": "IBM-Annual-Reports-Dashboard (research/education; tejpatel@umich.edu)"}
_EARNINGS_FORMS = {"10-K", "10-Q", "8-K"}
_sec_cache: dict[str, tuple[float, object]] = {}
_SEC_CACHE_TTL = 900


def _sec_get(url: str):
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
    """Recent 10-K/10-Q/8-K filings from SEC EDGAR, newest first."""
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
            continue
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


def _xbrl_concept_points(concept: str, unit_key: str):
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


@app.get("/filings/xbrl")
def filings_xbrl(symbol: str = "IBM"):
    """Latest revenue/net income/diluted EPS from SEC XBRL data."""
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
    return {
        "recentQuarters": quarterly[-8:],
        "recentAnnual": annual[-5:],
        "latestQuarter": quarterly[-1] if quarterly else None,
        "latestAnnual": annual[-1] if annual else None,
    }


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8787)
