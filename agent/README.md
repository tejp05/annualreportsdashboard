# CUGA agent for the IBM annual-reports dashboard

A [CUGA](https://pypi.org/project/cuga/) agent whose tools cover everything on
the site: 115 years of financials, segments, free cash flow (with sourcing),
the 78 filing-sourced M&A deals, CEO eras, milestones, US macro series, and an
OLS regression tool. Modeled on the `dashboardcreator` sample
(`@tool` functions → `CugaAgent(tools=...)` → `ask_agent()`).

## Run

`cuga` requires Python `>=3.10,<3.14`. The repo's main `.venv` is 3.14 (needed
for the pipeline), so the agent gets its own env via `uv`:

```bash
uv venv agent/.venv --python 3.12
uv pip install --python agent/.venv/Scripts/python.exe -r agent/requirements.txt
```

Set an LLM provider in a `.env` at the **repo root** (`agent/server.py` loads
it automatically) — see `docs/cuga-env-api-keys.md` for every provider's
variable names. WatsonX example:

```env
WATSONX_API_KEY=...
WATSONX_PROJECT_ID=...
WATSONX_URL=https://us-south.ml.cloud.ibm.com
MODEL_NAME=openai/gpt-oss-120b
AGENT_SETTING_CONFIG=settings.watsonx.toml
```

Then start the server:

```bash
agent/.venv/Scripts/python.exe agent/server.py     # http://localhost:8787
```

Then open the website — the **Ask the data** panel (bottom-left) talks to
`POST /chat`. When the server isn't running the panel says so and the rest of
the site is unaffected.

## Pieces

| File | What it is |
|---|---|
| `agent.py` | 17 `@tool` functions over `pipeline/data/*.json` + `get_agent()` / `ask_agent()` |
| `server.py` | FastAPI bridge: `/chat` (CUGA), `/tools/{name}` (direct, no LLM), `/quote` (live price proxy) |
| `../orchestrate/` | OpenAPI spec + instructions to import `/tools/*` into watsonx Orchestrate |

`python agent/agent.py` smoke-tests three tools without needing an LLM key.

The browser has a parallel layer: `window.CUGA` (agent-tools.js) exposes the
same data plus **page actions** (switch tabs, configure the Regression Lab,
open M&A era drawers, change the Overview chart, post/clear an on-page note,
highlight an element, download a CSV) for any embedded agent that can execute
JavaScript.

## Full agent control (chat → live browser)

When both the agent server and the site are open, the CUGA chat agent can
drive the page itself — not just read data from it. Two Python tools
(`list_browser_tools`, `browser_action`) bridge to `window.CUGA` in whichever
tab has `agent-tools.js` open, via an in-memory command queue
(`browser_bridge.py`): the browser long-polls `GET /commands/next`, executes
the requested tool, and posts the result back. Ask the chat panel something
like *"go to the M&A tab and open the Krishna era"* or *"configure the
Regression Lab for R&D vs net income, then leave a note"* — it will chain the
right tool calls and you'll see it happen live in the page.

**Note on cuga's Evolve feature**: cuga ships with an optional trajectory-
memory service ("Evolve") enabled by default, expecting a local MCP server on
`:8201`. Without one running, a single `get_guidelines` call was observed to
hang **~25 minutes** before giving up (well past its own 30s configured
timeout) — disable it via `.env`: `DYNACONF_EVOLVE__ENABLED=false` (already
set in this project's `.env`).

## Performance

Benchmarked and tuned 2026-07-08. Two effects dominate latency:

1. **Cold start (~70-90s)**: the first time any process imports `cuga`, it
   pulls in torch/transformers/langgraph and builds the agent's state graph.
   `server.py` now fires this off via a background thread on FastAPI startup
   (`@app.on_event("startup")` → `warm_up()`), so it happens while the server
   is already accepting connections instead of blocking the first real
   `/chat` call. Check `GET /health` for `{"agentWarm": true/false}` — the
   chat panel's status dot shows "● warming up…" until then. `get_agent()` is
   lock-protected so a request landing mid-warm-up reuses the in-flight
   build instead of racing it into a redundant second one.
2. **Mode**: cuga's `balanced` mode (default) runs a task-decomposition stage
   and a dedicated final-answer-distillation stage per turn. `fast` mode
   skips both. Benchmarked on the warm path: a simple lookup went from 12.9s
   (balanced) to 6.8s (fast); a 3-tool navigate→configure→note chain ran in
   ~16s. No loss of correctness observed in testing (tool selection, DOM
   mutations, and final answers all checked out) — this project's `.env` sets
   `DYNACONF_FEATURES__CUGA_MODE=fast`. Switch to `balanced` if you want more
   deliberate multi-step planning at roughly 2x the latency.

Do **not** touch `max_input_tokens` (shows as 8192 in logs, looks like a
cuga misconfiguration but isn't) — that's the WatsonX-hosted `gpt-oss-120b`
deployment's real context limit; the context-summarization log lines you'll
see are cuga correctly protecting against it, not a bug.
