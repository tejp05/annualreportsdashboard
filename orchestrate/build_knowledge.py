"""Build watsonx Orchestrate knowledge-base files from pipeline/data.

Condenses the hand-verified pipeline outputs (financials, segments, M&A,
cash flow, market cap, metadata) into small .txt/.csv files that fit the
wxO knowledge-base upload limits (max 20 files & 30 MB per batch;
5 MB per .txt/.csv). Everything lands in orchestrate/knowledge/.

Re-run after any pipeline data change:
    .venv/Scripts/python.exe orchestrate/build_knowledge.py
"""
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "pipeline" / "data"
OUT = ROOT / "orchestrate" / "knowledge"
OUT.mkdir(exist_ok=True)


def load(name):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def money(m, decimals=0):
    """US$ millions -> human string."""
    if m is None:
        return "not stated"
    if abs(m) >= 1000:
        return f"${m:,.{decimals}f} million (${m / 1000:,.1f} billion)"
    if abs(m) >= 10:
        return f"${m:,.{decimals}f} million"
    return f"${m:,.3f} million"


fin = load("financials.json")
years = {y["year"]: y for y in fin["years"]}
meta = load("metadata.json")
seg = load("segments.json")
ma = load("ma_clean.json")
cf = load("cashflow.json")
mc = load("marketcap.json")
sp = load("stockprice.json")

milestones = {m["year"]: m["event"] for m in meta["milestones"]}


def ceo_for(year):
    names = [
        f"{p['name']} ({p['role']})"
        for p in meta["leadership"]
        if p["from"] <= year <= (p["to"] or 9999)
    ]
    return "; ".join(names)


def era_for(year):
    for e in meta["eras"]:
        if e["from"] <= year <= e["to"]:
            return e["label"]
    return ""


# ---------------------------------------------------------------- 1. full CSV
FIELDS = [
    "year", "revenue", "netIncome", "grossProfit", "rdExpense",
    "operatingIncome", "pretaxIncome", "incomeTaxes", "operatingCashFlow",
    "freeCashFlow", "totalAssets", "totalLiabilities", "stockholdersEquity",
    "longTermDebt", "totalDebt", "cashAndEquivalents", "capitalExpenditure",
    "epsBasic", "epsDiluted", "dividendsPerShare", "sharesOutstandingM",
    "employees", "softwareARR", "basis", "flags",
]
with (OUT / "ibm_financials_1911_2025.csv").open("w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(FIELDS)
    for y in sorted(years):
        row = years[y]
        w.writerow([
            row.get(k) if k != "flags" else "; ".join(row.get("flags") or [])
            for k in FIELDS
        ])

# ------------------------------------------------------- 2-4. yearly prose txt
def year_paragraph(y):
    r = years[y]
    company = "Computing-Tabulating-Recording Company (CTR, IBM's predecessor)" if y < 1924 else "IBM"
    parts = [f"{company} fiscal year {y} (FY{y}), from the {y} annual report. All dollar figures are US$ millions as originally reported."]
    rev = r.get("revenue")
    if rev is not None:
        s = f"Revenue: {money(rev)}"
        prev = years.get(y - 1, {}).get("revenue")
        if prev:
            s += f", {'up' if rev >= prev else 'down'} {abs(rev / prev - 1) * 100:.1f}% versus FY{y - 1}"
        parts.append(s + ".")
    else:
        parts.append(
            "Revenue: not reliably stated in the original filing (before 1940 "
            "CTR/IBM reported net earnings rather than a revenue figure)."
            if y < 1940 else "Revenue: not reliably stated."
        )
    ni = r.get("netIncome")
    if ni is not None:
        s = f"Net income: {money(ni)}"
        if rev:
            s += f" (net margin {ni / rev * 100:.1f}%)"
        parts.append(s + ".")
    simple = [
        ("grossProfit", "Gross profit"), ("rdExpense", "R&D expense"),
        ("pretaxIncome", "Pre-tax income"), ("incomeTaxes", "Income taxes"),
        ("operatingCashFlow", "Operating cash flow"), ("freeCashFlow", "Free cash flow"),
        ("capitalExpenditure", "Capital expenditure"), ("totalAssets", "Total assets"),
        ("stockholdersEquity", "Stockholders' equity"), ("totalDebt", "Total debt"),
        ("longTermDebt", "Long-term debt"), ("softwareARR", "Software annual recurring revenue (ARR)"),
    ]
    money_bits = [f"{label}: {money(r[k])}" for k, label in simple if r.get(k) is not None]
    if money_bits:
        parts.append(". ".join(money_bits) + ".")
    per_share = []
    if r.get("epsDiluted") is not None:
        per_share.append(f"Diluted EPS: ${r['epsDiluted']:,.2f}")
    if r.get("epsBasic") is not None:
        per_share.append(f"Basic EPS: ${r['epsBasic']:,.2f}")
    if r.get("dividendsPerShare") is not None:
        per_share.append(f"Dividends per share: ${r['dividendsPerShare']:,.2f}")
    if r.get("sharesOutstandingM") is not None:
        per_share.append(f"Weighted-average diluted shares: {r['sharesOutstandingM']:,.1f} million")
    if per_share:
        parts.append(". ".join(per_share) + ".")
    if r.get("employees") is not None:
        parts.append(f"Employees: {r['employees']:,.0f}.")
    parts.append(f"Leadership: {ceo_for(y)}. Era: {era_for(y)}.")
    if y in milestones:
        parts.append(f"Milestone that year: {milestones[y]}.")
    if r.get("basis"):
        parts.append(f"Reporting-basis note: {r['basis']}.")
    return " ".join(parts)


SPLITS = [(1911, 1955), (1956, 1992), (1993, 2025)]
for lo, hi in SPLITS:
    body = (
        f"IBM (and predecessor CTR) year-by-year financial summaries, FY{lo}-FY{hi}, "
        "extracted and hand-verified from the original annual reports. "
        "All dollar amounts are US$ millions unless written as billions.\n\n"
        + "\n\n".join(year_paragraph(y) for y in sorted(years) if lo <= y <= hi)
        + "\n"
    )
    (OUT / f"ibm_yearly_summaries_{lo}_{hi}.txt").write_text(body, encoding="utf-8")

# --------------------------------------------- 5. definitions & caveats (static)
CAVEATS = """IBM ANNUAL REPORTS DATASET - DEFINITIONS, COVERAGE, AND ACCURACY CAVEATS
This file explains how to correctly read every other file in this knowledge base.
The dataset was built by parsing all 116 IBM/CTR annual reports (1912-2025 report
years, fiscal years 1911-2025) with a validated extraction pipeline, then
hand-verifying key figures against page images of the original filings.

UNITS AND CONVENTIONS
- All dollar amounts are US$ MILLIONS as originally reported (never inflation-adjusted,
  never restated to later presentations unless explicitly noted).
- A blank/null value means the original filings did not reliably state that figure.
  Values are NEVER estimated, interpolated, or backfilled. If a value is missing,
  the correct answer is that IBM did not reliably state it.
- "sharesOutstandingM" is weighted-average DILUTED shares in millions.

COVERAGE
- Net income: complete every fiscal year 1911-2025 (115 years, no gaps).
  FY1914 net income was $0.490 million - the balance was carried to surplus and no
  dividend was paid that year.
- Revenue: null before 1940. Pre-1923 CTR reported net profit, not revenue; a
  consistent revenue line only exists from 1940 onward.
- EPS (basic and diluted): continuous 1970-2025.
- Employees, dividends, assets, equity: available for most but not all years.

REPORTING-BASIS CHANGES (important when comparing across eras)
- 1940-1945: reported net income was held to roughly $8-11 million per year by
  WWII excess-profits taxes. The headline "net profit" lines in those wartime
  reports are PRE-TAX and are not used; the dataset uses after-tax net income.
- 1950-1959: figures are US-DOMESTIC gross income only.
- 1960 onward: worldwide consolidated. There is a basis step-up at 1960 - do not
  present a 1959->1960 change as pure organic growth.
- 2019 onward: IBM's 10-Ks dropped the Selected Financial Data table, so EPS and
  share counts come directly from the audited income statements.

NET INCOME vs INCOME FROM CONTINUING OPERATIONS (common error source)
IBM's income statement lists "income from continuing operations" ABOVE total
"net income"; they differ materially in divestiture years.
- FY2002: income from continuing operations $5,334M vs TOTAL net income $3,579M
  (hard-disk-drive business divested).
- FY2014: $15,751M continuing vs $12,022M total (x86 server and microelectronics exits).
This dataset's netIncome and EPS series always use the TOTAL ("Net income" /
"Total" EPS) line. If a user cites a different number for those years, they are
likely quoting continuing operations.

FREE CASH FLOW (FCF) DEFINITION
- IBM's official FCF definition excludes the year-over-year change in Global
  Financing receivables, so naive OCF minus capex is WRONG by billions in some
  years (e.g., FY2009: $15,100M IBM-stated vs $17,026M naive; FY2003: $8,700M vs $11,215M).
- FY2003-FY2025 freeCashFlow values are IBM's own stated figures.
- FY1995-FY2002 are derived as operating cash flow minus net capital expenditure
  (gross capex minus disposal proceeds) and labeled as derived - there is a
  definitional seam at 2002/2003. Do not chart the two eras as one homogeneous series
  without noting it.

SEGMENTS (see ibm_segments_2021_2025.txt)
- Current four-segment taxonomy (Software / Consulting / Infrastructure /
  Financing, plus Other) exists only from FY2021 (post-Kyndryl spinoff).
- FY2021-2023 are on the then-historical basis; in Q1 2025 IBM reclassified some
  revenue between Software and Consulting, so FY2024-2025 are on the 2025 basis.
  Comparing Software or Consulting across 2023 vs 2024 mixes two bases - flag it.
- Earlier eras used different taxonomies (e.g., 2015-2020 Cognitive Solutions /
  GBS / GTS / Systems / Global Financing) and are not in this knowledge base.

SOFTWARE ARR
- IBM-disclosed software annual recurring revenue, FY2022-2025 only. IBM broadened
  the definition in 2025 and restated FY2024 up to $21.3 billion.

MARKET CAPITALIZATION AND STOCK PRICE (see ibm_marketcap_stockprice.csv)
- Market cap 2001-2016 is IBM's own disclosed "Market capitalization" line from the
  reports' Financial Highlights table. 1984-2000 and 2017-2025 are EXTERNAL market
  data (Yahoo Finance / stockanalysis.com / companiesmarketcap.com /
  wallstreetnumbers.com year-end values), NOT from the filings. No reliable
  standardized series exists before 1984.
- Year-end stock price per share is IBM's own disclosed figure, 2001-2020 only
  (IBM stopped publishing the table after 2020).

M&A (see ibm_acquisitions files)
- 78 deals (76 acquisitions, 2 divestitures) curated from report language plus
  well-established records; disclosed dollar values exist for only 24 deals -
  IBM historically did not disclose most deal values.

LEADERSHIP, ERAS, MILESTONES (see ibm_leadership_eras_milestones.txt)
- Cross-checked against the chairman's-letter signatures in the filings.

SOURCE CORPUS
- 116 annual report PDFs (report years 1912-2025) parsed with pymupdf4llm and
  pdfplumber; figures cross-validated across each report's five-year tables and
  income statements, with human visual verification of anchor values against
  rendered page images. Highest-trust values are human-verified visual reads.
"""
(OUT / "ibm_data_definitions_and_caveats.txt").write_text(CAVEATS, encoding="utf-8")

# ------------------------------------------- 6. leadership / eras / milestones
lines = [
    "IBM (AND CTR) LEADERSHIP, COMPANY ERAS, AND MILESTONES, 1911-2025",
    "Cross-checked against chairman's-letter signatures in the annual reports.",
    "",
    "COMPANY NAME",
]
for span, name in meta["company"].items():
    lines.append(f"- {span}: {name}")
lines += ["", "LEADERSHIP (CEO / CHAIRMAN SUCCESSION)"]
for p in meta["leadership"]:
    to = p["to"] or "present"
    lines.append(f"- {p['name']}, {p['role']}, {p['from']} to {to}.")
lines += ["", "ERAS"]
for e in meta["eras"]:
    lines.append(f"- {e['from']}-{e['to']}: {e['label']}")
lines += ["", "MILESTONES"]
for m in meta["milestones"]:
    lines.append(f"- {m['year']}: {m['event']}")
(OUT / "ibm_leadership_eras_milestones.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

# ----------------------------------------------------------------- 7. segments
sl = [
    "IBM REVENUE BY SEGMENT, FY2021-FY2025 (US$ millions, external revenue)",
    "Current four-segment taxonomy (Software / Consulting / Infrastructure / Financing,",
    "plus Other), which exists only from FY2021 after the Kyndryl spinoff (Nov 2021).",
    "BASIS: FY2021-2023 on the then-historical basis; FY2024-2025 on the 2025 basis",
    "(Q1 2025 reclassified some revenue between Software and Consulting, totals unchanged).",
    "",
]
for yr in seg["years"]:
    segs = ", ".join(f"{k} {money(v)}" for k, v in yr["segments"].items())
    sl.append(
        f"FY{yr['year']} (basis: {yr['basis']}; source report page {yr['source']}): "
        f"{segs}. Total revenue {money(yr['total'])}."
    )
sl += [
    "",
    "FY2025 GROSS MARGIN BY SEGMENT (external gross margin %, from the 2025 report):",
]
for k, v in seg["segmentGrossMargin2025"].items():
    sl.append(f"- {k}: {v}%")
sl += [
    "",
    "Earlier segment taxonomies (e.g., 2015-2020: Cognitive Solutions, Global Business",
    "Services, Technology Services & Cloud Platforms, Systems, Global Financing;",
    "1990s-2000s: Hardware, Software, Global Services, Global Financing) are NOT in",
    "this knowledge base.",
]
(OUT / "ibm_segments_2021_2025.txt").write_text("\n".join(sl) + "\n", encoding="utf-8")

# ------------------------------------------------------------------- 8-9. M&A
deal_fields = ["year", "name", "type", "tier", "category", "segment",
               "closeDate", "valueMillions", "description"]
with (OUT / "ibm_acquisitions_divestitures.csv").open("w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(deal_fields)
    for d in sorted(ma["deals"], key=lambda d: (d["year"], d["name"])):
        w.writerow([d.get(k, "") for k in deal_fields])

nl = [
    "IBM ACQUISITIONS AND DIVESTITURES ({} deals: {} acquisitions, {} divestitures; "
    "disclosed values exist for only {} deals - IBM historically did not disclose "
    "most deal values). All values US$ millions.".format(
        ma["summary"]["total"], ma["summary"]["acquisitions"],
        ma["summary"]["divestitures"], ma["summary"]["withValue"]),
    "",
]
for d in sorted(ma["deals"], key=lambda d: (d["year"], d["name"])):
    bits = [f"{d['year']} - {d['name']} ({d['type']}"]
    if d.get("tier"):
        bits[0] += f", {d['tier']}"
    if d.get("category"):
        bits[0] += f", category: {d['category']}"
    bits[0] += ")."
    if d.get("valueMillions") is not None:
        bits.append(f"Deal value: {money(d['valueMillions'])}.")
    else:
        bits.append("Deal value: not disclosed.")
    if d.get("closeDate"):
        bits.append(f"Closed: {d['closeDate']}.")
    if d.get("description"):
        bits.append(d["description"])
    if d.get("ibmLanguage"):
        bits.append(f"IBM's own report language: {d['ibmLanguage']}")
    nl.append(" ".join(bits))
    nl.append("")
(OUT / "ibm_acquisitions_narrative.txt").write_text("\n".join(nl), encoding="utf-8")

# ------------------------------------------------------------- 10. cash flow
cf_years = cf["years"] if isinstance(cf["years"], dict) else {}
cf_keys = ["operatingCashFlow", "capitalExpenditure", "proceedsFromDisposals",
           "freeCashFlow", "ocfSource", "capexSource", "fcfSource", "note"]
with (OUT / "ibm_cashflow_fcf_1995_2025.csv").open("w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["year"] + cf_keys)
    for y in sorted(cf_years, key=int):
        row = cf_years[y]
        w.writerow([y] + [row.get(k, "") for k in cf_keys])

# ------------------------------------------------- 11. market cap + stock price
mc_years = mc.get("years", {})
sp_years = sp.get("years", {})
with (OUT / "ibm_marketcap_stockprice.csv").open("w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["year", "marketCapUSDMillions", "marketCapSource",
                "yearEndStockPriceUSD", "stockPriceSource"])
    for y in sorted(set(list(mc_years) + list(sp_years)), key=int):
        yi = int(y)
        mc_src = ("IBM Financial Highlights table" if 2001 <= yi <= 2016
                  else "external market data (not from filings)") if str(y) in mc_years else ""
        sp_src = "IBM Financial Highlights table" if str(y) in sp_years else ""
        w.writerow([y, mc_years.get(str(y), ""), mc_src,
                    sp_years.get(str(y), ""), sp_src])

# ------------------------------------------ 12. records, peaks, and firsts
def series(key):
    return [(y, years[y][key]) for y in sorted(years) if years[y].get(key) is not None]


def peak_line(key, label, unit="money"):
    s = series(key)
    if not s:
        return None
    y, v = max(s, key=lambda t: t[1])
    vs = money(v) if unit == "money" else (f"${v:,.2f}" if unit == "ps" else f"{v:,.0f}")
    return f"- All-time highest {label}: FY{y}, {vs}. (Coverage: {s[0][0]}-{s[-1][0]}.)"


def first_over(key, threshold, label):
    for y, v in series(key):
        if v >= threshold:
            return f"- First fiscal year {label}: FY{y} ({money(v)})."
    return None


rl = [
    "IBM ALL-TIME RECORDS, PEAKS, AND FIRSTS (fiscal years 1911-2025)",
    "Use this file to answer any 'peak', 'highest', 'record', 'best/worst year',",
    "or 'first year over X' question. These superlatives are computed across the",
    "ENTIRE verified series - do not infer peaks from individual year summaries.",
    "",
    "REVENUE",
]
rev = series("revenue")
top5 = sorted(rev, key=lambda t: t[1], reverse=True)[:5]
rl.append(
    f"- IBM's revenue PEAKED in FY{top5[0][0]} at {money(top5[0][1])}. "
    "It has never been higher before or since."
)
rl.append("- Top five revenue years: " + "; ".join(f"FY{y} {money(v)}" for y, v in top5) + ".")
rl.append(
    "- Revenue declined from the 2011 peak through 2020 (divestitures and portfolio "
    "shifts) and stepped down again with the Kyndryl managed-infrastructure spinoff "
    "(Nov 2021). Post-spinoff totals (FY2021 $57.4B -> FY2025 $67.5B) are a smaller "
    "revenue base by construction - FY2022's ~$60.5 billion is NOT an all-time peak, "
    "only a point on the post-Kyndryl series."
)
for line in [first_over("revenue", 100, "revenue exceeded $100 million"),
             first_over("revenue", 1000, "revenue exceeded $1 billion"),
             first_over("revenue", 10000, "revenue exceeded $10 billion"),
             first_over("revenue", 50000, "revenue exceeded $50 billion"),
             first_over("revenue", 100000, "revenue exceeded $100 billion")]:
    if line:
        rl.append(line)
rl += ["", "NET INCOME AND LOSSES"]
ni = series("netIncome")
niy, niv = max(ni, key=lambda t: t[1])
loy, lov = min(ni, key=lambda t: t[1])
rl.append(f"- All-time highest net income: FY{niy}, {money(niv)}.")
rl.append(
    f"- Worst year / largest loss: FY{loy}, {money(lov)} - at the time the largest "
    "annual loss in American corporate history (early-1990s crisis; losses ran "
    "1991-1993, and Louis Gerstner arrived in 1993)."
)
for line in [first_over("netIncome", 100, "net income exceeded $100 million"),
             first_over("netIncome", 1000, "net income exceeded $1 billion"),
             first_over("netIncome", 10000, "net income exceeded $10 billion")]:
    if line:
        rl.append(line)
rl += ["", "OTHER ALL-TIME PEAKS"]
for args in [("grossProfit", "gross profit"), ("freeCashFlow", "free cash flow"),
             ("operatingCashFlow", "operating cash flow"), ("rdExpense", "R&D expense"),
             ("totalAssets", "total assets"), ("stockholdersEquity", "stockholders' equity"),
             ("epsDiluted", "diluted EPS", "ps"), ("dividendsPerShare", "dividends per share", "ps"),
             ("employees", "employee count", "count")]:
    line = peak_line(*args)
    if line:
        rl.append(line)
rl.append(
    "- NOTE: per-share figures (EPS, dividends per share) are as ORIGINALLY REPORTED "
    "and not adjusted for stock splits, so cross-era per-share comparisons are not "
    "meaningful (FY1978's $21.29 diluted EPS predates later splits)."
)
rl += [
    "",
    "MARKET CAPITALIZATION (external data 1984-2025, see caveats file)",
]
mc_pairs = [(int(y), v) for y, v in mc_years.items() if v is not None]
if mc_pairs:
    my, mv = max(mc_pairs, key=lambda t: t[1])
    rl.append(f"- Highest year-end market capitalization on record: FY{my}, {money(mv)}. "
              "(No reliable series exists before 1984.)")
(OUT / "ibm_records_and_extremes.txt").write_text("\n".join(rl) + "\n", encoding="utf-8")

sizes = sorted(OUT.glob("*"))
total = sum(p.stat().st_size for p in sizes)
print(f"Wrote {len(sizes)} files, {total / 1024:.0f} KB total, to {OUT}")
for p in sizes:
    print(f"  {p.name:45s} {p.stat().st_size / 1024:7.1f} KB")
