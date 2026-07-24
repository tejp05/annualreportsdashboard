# IBM Through the Years — website

A **zero-build static site** (plain HTML/CSS/JS, no framework, no npm install) that
visualizes a century of IBM's annual-report data. It is intentionally dependency-free
so it keeps running long after the original team has moved on.

## Run it

**One command runs everything** (static site + the live agent server):

```bash
python run.py            # site on :5500, agent/live server on :8787, Ctrl+C stops both
```

Env knobs: `PORT` (site), `AGENT_PORT` (agent), `AGENT_HOST=0.0.0.0` (expose the
agent beyond localhost for remote hosting). When the site is hosted somewhere
else than the agent, open it once with `?agent=https://your-host:8787` — the
browser remembers it and every live feature (ticker, quotes, SEC filings, chat)
uses that server. `?agent=clear` resets.

Lighter options — there is nothing to build:

- **Open directly:** double-click `index.html`. The historical data is baked into
  `data.js`, so it works straight from disk; live widgets (ticker, SEC feed,
  quotes) hide themselves when the agent server isn't reachable.
- **Site only:** `python serve.py` (port 5500).
- **Agent/live server only:** `agent/.venv/Scripts/python.exe agent/server.py`
  (needs the agent venv — see `agent/README.md`). Provides `/quotes`, `/quote`,
  `/filings/latest`, `/filings/xbrl`, `/chat` etc. for all live features.

## Files

| File | Role |
|------|------|
| `index.html` | App shell: top bar, tab nav, the Home panel, and one empty `<section>` per future tab. |
| `styles.css` | All styling. Design tokens (colors, fonts) are the `:root` variables at the top. IBM Carbon-inspired. |
| `charts.js`  | A tiny dependency-free SVG line chart (`window.TrendChart`). Linear/log scale, multi-series, hover, milestone markers. |
| `app.js`     | Wires everything: tabs, the Home page (scrubber, era filters, trend chart), and the placeholder panels. |
| `data.js`    | **Auto-generated** — `window.IBM_DATA`. Do not edit by hand. |

## The data

`window.IBM_DATA` (from `data.js`) has:

- `financials` — array of `{ year, revenue, netIncome, epsDiluted, epsBasic,
  dividendsPerShare, totalAssets, stockholdersEquity, rdExpense, employees }`.
  Money is **US$ millions**; `null` means the value was not reliably stated in the
  filing (**never estimated**).
- `segments` — external revenue by reportable segment, 2021–2025.
- `metadata` — `company`, `leadership` (CEOs), `eras`, `milestones`.

**Source of truth is the pipeline, not this folder.** When the parsed data changes,
regenerate `data.js`:

```bash
python pipeline/export_web.py
```

See `../pipeline/SCHEMA.md` for the full data dictionary and provenance.

## What's built vs. planned

- **Home** — done: timeline scrubber + per-year snapshot, era/leadership filters,
  and the interactive multi-metric trend chart with milestone markers.
- **About & Data** — done: provenance + live coverage summary.
- **Story Mode, AI Assistant, Regression Lab, Macro vs IBM, Competitors** —
  styled placeholders describing what each will do. Each is an empty
  `<section id="panel-NAME">` in `index.html`.

## How to build a placeholder tab (for the owning team)

1. Find your panel: `<section id="panel-NAME">` in `index.html`.
2. The placeholder content for it is generated from `PLACEHOLDERS` in `app.js` —
   delete that entry (or stop rendering it) and put your real UI in the section.
3. Read from `window.IBM_DATA`. Reuse `window.TrendChart` for charts if useful.
4. If you need new data (e.g. macro or competitor series), add it under
   `pipeline/data/` and extend `pipeline/export_web.py` so it lands in `data.js`.
5. Keep the no-build, no-fetch approach so the site stays openable from disk.