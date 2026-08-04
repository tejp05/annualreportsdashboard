"""openai_agent.py — OpenAI-backed agent loop, for the Vercel deployment.

WHY THIS EXISTS
CUGA cannot run on Vercel: it drags in torch/transformers/docling/easyocr/
opencv/playwright (~5.8GB installed) against a 500MB function limit, so the
deployed /chat has been returning 503. This module is a drop-in replacement
that talks to OpenAI directly, so the live site gets a working agent with the
same tools.

The API key is read from the OPENAI_API_KEY environment variable and is never
committed. On Vercel set it under Project -> Settings -> Environment Variables;
locally it comes from .env via server.py's load_dotenv(). Do NOT hardcode it
into this file or any other file in the repo: this repo is published to a
public GitHub remote and the site itself is public, so a literal key would be
world-readable and scraped within minutes.

STATELESS BROWSER TOOLS — the important design point.
Server-side data tools (get_financials_year, run_regression, ...) execute here
in the function and loop normally. Browser tools (navigate_to_tab,
configure_regression, ...) cannot: agent/browser_bridge.py is an in-memory
queue that assumes one long-lived process, which is exactly what Vercel is
not. So browser calls are handed BACK to the page instead:

    POST /chat {question}
      -> {"pendingBrowserCalls":[{id,tool,args}], "state":"<opaque>"}
    page runs them through window.CUGA.invoke, then
    POST /chat {state, toolResults:[{id,ok,result,error}]}
      -> {"answer": "..."}  (or another round of pendingBrowserCalls)

The conversation lives in `state`, round-tripped through the client, so any
function instance can pick up any turn. State is signed with the API key so a
client cannot forge tool output back into a model context.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import zlib

MODEL = os.environ.get("OPENAI_AGENT_MODEL", "gpt-4o-mini")
MAX_ROUNDS = 6          # server-side tool rounds per request, before giving up
MAX_TOOL_CHARS = 6000   # truncate oversized tool payloads before they hit the model

SYSTEM_PROMPT = """\
You are the data analyst embedded in an IBM annual-reports dashboard \
(1911-2025: IBM/CTR financials, M&A, segments, US macro). Ground every answer \
in tool output, not prior knowledge — IBM-specific numbers must come from the \
tools. When a metric is ambiguous, call list_metrics first instead of guessing \
a key. Always state the fiscal year(s) a figure covers. If the user's request \
implies changing what is on screen ("show me", "go to", "navigate", \
"highlight", "open", "configure the regression lab", "change the chart") — \
call the matching browser tool to actually do it, do not just describe what \
you would do. You can drive the whole dashboard: switch tabs, jump to a Story \
Mode chapter, open an M&A era drawer, build charts, and run the Regression Lab. \
For any control without a dedicated tool, click_control matches on-screen text. \
\
For regression requests ("regress X on Y", "is there a relationship between…", \
"run the R&D preset"): call list_regression_metrics first to get the Lab's own \
metric keys and its preset labels — do not guess a key. Then either \
configure_regression for an arbitrary pair, or click_control with a preset's \
exact label. Both leave the fitted chart on screen for the user; report the R², \
the auto-picked model and the direction of the slope from the stats panel the \
tool returns, and say plainly when a fit is weak or the sample is small rather \
than implying a relationship the numbers do not support. Keep answers to 1-3 \
sentences unless asked for a table or detail.\
"""

# Browser-side tools, executed by window.CUGA in the page (see agent-tools.js).
# Schemas are declared here rather than fetched from the client so the model
# cannot be handed tool definitions by an untrusted caller.
STR = "string"
INT = "integer"
BOOL = "boolean"
STR_ARRAY = {"type": "array", "items": {"type": "string"}}

# Browser-side tools, executed by window.CUGA in the page (see agent-tools.js).
#
# These MUST mirror agent-tools.js's TOOLS registry exactly — same names, same
# argument names. They previously did not: configure_regression was declared
# here as x/y/from_year/to_year while the page's tool takes
# x_metric/y_metric/lag, and get_live_quote was declared with a `symbol` it does
# not accept. The model dutifully sent the declared names and the calls failed,
# which is why driving the Regression Lab from chat never worked.
#
# The page exposes ~34 tools; the data-query ones are omitted here because the
# server already runs equivalents in-process (agent/agent.py ALL_TOOLS) without
# a client round-trip. What is left is everything that has to touch the DOM.
#
# Declared here rather than read from the client's manifest on purpose: /chat is
# a public endpoint, so a caller could otherwise hand the model arbitrary tool
# definitions.
BROWSER_TOOLS = [
    # ── navigation ────────────────────────────────────────────────────────────
    ("navigate_to_tab", "Switch the dashboard to a tab. Use for 'show me' / 'go to' / 'open'.",
     {"tab": (STR, "One of: home, story, regression, macro, ma, competitors, about", True)}),
    ("jump_to_story_chapter",
     "Open Story Mode and scroll to a chapter/era, optionally switching its chart series.",
     {"chapter": (STR, "Chapter title substring, era id, or 0-based index (e.g. 'Gerstner', 'hybrid', 3)", True),
      "series": (STR, "Optional: netIncome | revenue | marketCap | stockPrice", False)}),
    ("open_ma_era", "Open the M&A tab and pop the deal-list drawer for a CEO era.",
     {"era": (STR, "Pre-Gerstner | Gerstner | Palmisano | Rometty | Krishna", True)}),

    # ── regression lab ────────────────────────────────────────────────────────
    ("list_regression_metrics",
     "List the metric keys the Regression Lab accepts, plus its curated preset scenarios. "
     "Call this BEFORE configure_regression instead of guessing a key — the Lab's keys are "
     "its own and do not all match list_metrics.", {}),
    ("configure_regression",
     "Open the Regression Lab and run a fit on the chosen pair. The best model (linear, log, "
     "exponential, power, quadratic) is picked automatically and every overlapping data point "
     "is used — there is no year-range control. Returns the fitted stats panel, so quote the "
     "R², model and slope from it rather than describing the fit in the abstract.",
     {"x_metric": (STR, "Independent variable key, from list_regression_metrics", True),
      "y_metric": (STR, "Dependent variable key, from list_regression_metrics", True),
      "lag": (INT, "Lag y behind x by N years, 0-5. Default 0", False)}),

    # ── charts ────────────────────────────────────────────────────────────────
    ("set_overview_range", "Set the Overview trend chart's year range.",
     {"from_year": (INT, "Start year", True), "to_year": (INT, "End year", True),
      "label": (STR, "Optional chip label", False)}),
    ("set_chart_metrics",
     "Set which metrics the Overview trend chart plots (same-unit metrics only).",
     {"metrics": (STR_ARRAY, "1+ of: revenue, netIncome, totalAssets, stockholdersEquity, "
                             "marketCap, freeCashFlow, epsDiluted, stockPrice", True)}),
    ("set_chart_scale", "Toggle the Overview trend chart between linear and log y-axis.",
     {"scale": (STR, "'linear' or 'log'", True)}),
    ("create_custom_chart",
     "Build a NEW chart from 1-4 metrics, append it to the Overview tab and go there. Use for "
     "any 'plot X against Y' / 'make me a chart of' request. Mixed-unit metrics are indexed to "
     "100 automatically so they stay comparable.",
     {"metrics": (STR_ARRAY, "1-4 metric keys, e.g. ['revenue','rdExpense']", True),
      "title": (STR, "Optional chart title", False),
      "from_year": (INT, "Default: earliest year all metrics overlap", False),
      "to_year": (INT, "Default: latest year all metrics overlap", False),
      "scale": (STR, "'linear' (default) or 'log'", False)}),
    ("clear_custom_charts", "Remove every agent-built custom chart from the Overview tab.", {}),
    ("configure_macro_chart",
     "Configure the Macro tab's IBM-vs-market indexed-growth chart.",
     {"ibm_key": (STR, "'revenue' or 'marketCap'", False),
      "benchmarks": (STR_ARRAY, "Subset of: sp500, tech, nasdaq, djia", False),
      "real": (BOOL, "true = CPI-adjust every series to real dollars", False)}),

    # ── macro tab chart controls ──────────────────────────────────────────────
    ("configure_return_chart",
     "Configure the Macro tab's 'IBM vs Market — Total Return & Outperformance' chart: time "
     "window, which series are shown, and annual-bars vs cumulative-growth mode.",
     {"window": (STR, "'all' | '20' | '10' | '5' (years)", False),
      "series": (STR_ARRAY, "Which to show, any of: ibm, sp500. Omit to leave unchanged", False),
      "cumulative": (BOOL, "true = cumulative growth of $100; false = annual bars", False)}),
    ("set_bond_yield_tenor",
     "Set which Treasury tenor the Macro tab's cost-of-debt chart compares IBM against. Returns "
     "the spread callouts, so quote the actual gap rather than describing it vaguely.",
     {"tenor": (STR, "'3m' | '5y' | '10y' | '30y'", True)}),
    ("set_hero_chart_layer",
     "Switch the Macro tab's big IBM Stock Performance hero chart to a different layer.",
     {"layer": (STR, "price | marketCap | dividends | earnings | acquisitions", True)}),

    # ── other tab views ───────────────────────────────────────────────────────
    ("set_ma_insight_view",
     "Switch the M&A tab's Deal Intelligence panel between its views.",
     {"view": (STR, "bar (Annual Spend) | scatter (Boldness Map) | alpha (Alpha Leaderboard) | "
                    "catmix (Category Mix)", True)}),
    ("set_competitor_segment",
     "Choose which IBM segment the Competitors tab analyses — the peer directory, SWOT, Five "
     "Forces, BCG matrix and position map all follow this selection.",
     {"segment": (STR, "software | consulting | infrastructure", True)}),

    # ── reading the page back ─────────────────────────────────────────────────
    ("describe_current_view",
     "Read back what is currently on screen: the active tab and its headline figures. Use to "
     "confirm an action landed, or to answer 'what am I looking at'. Reads the rendered page, so "
     "it reflects live values rather than the static dataset.", {}),

    # ── page interaction ──────────────────────────────────────────────────────
    ("click_control",
     "Click any visible button, toggle, chip or checkbox label on the CURRENT tab by matching a "
     "substring of its text. The general fallback for controls without a dedicated tool — "
     "including running a Regression Lab preset by its label.",
     {"text": (STR, "Substring of the control's visible text", True)}),
    ("highlight_element",
     "Scroll to and pulse-highlight the first element on the current tab containing this text. "
     "Use after navigating, to point at the specific figure being discussed.",
     {"text": (STR, "Substring to search for", True)}),
    ("set_agent_note",
     "Post a floating note banner visible on every tab — use to leave a written summary or "
     "call-out on the page itself. Plain text, no HTML.",
     {"text": (STR, "Note text", True)}),
    ("clear_agent_note", "Remove the on-page note banner.", {}),
    ("download_metric_csv", "Download a metric's full series as a CSV file.",
     {"metric": (STR, "Key from list_metrics", True)}),
    ("set_theme", "Switch the dashboard between dark (default) and light themes.",
     {"theme": (STR, "'dark' or 'light'", True)}),

    # ── live quote ────────────────────────────────────────────────────────────
    ("get_live_quote", "Read the live IBM quote currently shown on the page.", {}),
    ("refresh_live_quote", "Force the live-quote widget to re-fetch now instead of waiting 60s.", {}),
    ("celebrate", "Fire a brief confetti burst. Purely decorative.", {}),
]
BROWSER_TOOL_NAMES = {name for name, _, _ in BROWSER_TOOLS}


def _secret() -> bytes:
    key = os.environ.get("OPENAI_API_KEY", "")
    if not key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    return hashlib.sha256(key.encode()).digest()


def pack_state(messages: list) -> str:
    """Compress + sign the message list so it can survive a client round-trip."""
    raw = zlib.compress(json.dumps(messages).encode())
    sig = hmac.new(_secret(), raw, hashlib.sha256).digest()[:16]
    return base64.urlsafe_b64encode(sig + raw).decode()


def unpack_state(token: str) -> list:
    blob = base64.urlsafe_b64decode(token.encode())
    sig, raw = blob[:16], blob[16:]
    if not hmac.compare_digest(sig, hmac.new(_secret(), raw, hashlib.sha256).digest()[:16]):
        raise ValueError("state signature mismatch")
    return json.loads(zlib.decompress(raw))


def _schema_from_langchain(tool) -> dict:
    """Turn a LangChain tool into an OpenAI function-calling schema."""
    params = {"type": "object", "properties": {}, "required": []}
    schema = getattr(tool, "args_schema", None)
    if schema is not None:
        try:
            model_schema = schema.model_json_schema()      # pydantic v2
        except AttributeError:
            model_schema = schema.schema()                 # pydantic v1
        params["properties"] = model_schema.get("properties", {})
        params["required"] = model_schema.get("required", [])
        # OpenAI rejects the $defs/allOf shapes pydantic emits for enums
        for prop in params["properties"].values():
            prop.pop("allOf", None)
            prop.pop("$ref", None)
            prop.setdefault("type", "string")
    return {
        "type": "function",
        "function": {
            "name": tool.name,
            "description": (tool.description or "")[:1024],
            "parameters": params,
        },
    }


def build_tool_schemas(server_tools) -> list:
    schemas = [_schema_from_langchain(t) for t in server_tools]
    for name, desc, params in BROWSER_TOOLS:
        props = {}
        for p, (t, d, _req) in params.items():
            # A type is either a bare JSON-schema type name, or a full fragment
            # (arrays need their own "items", which OpenAI rejects without).
            props[p] = {**t, "description": d} if isinstance(t, dict) \
                else {"type": t, "description": d}
        schemas.append({
            "type": "function",
            "function": {
                "name": name,
                "description": desc,
                "parameters": {
                    "type": "object",
                    "properties": props,
                    "required": [p for p, (_, _, req) in params.items() if req],
                },
            },
        })
    return schemas


def _client():
    from openai import OpenAI  # lazy: keeps cold start off the import path
    return OpenAI(api_key=os.environ["OPENAI_API_KEY"])


def _truncate(text: str) -> str:
    return text if len(text) <= MAX_TOOL_CHARS else text[:MAX_TOOL_CHARS] + " …[truncated]"


def run(question: str | None,
        state_token: str | None,
        tool_results: list | None,
        server_tools_by_name: dict) -> dict:
    """One /chat turn.

    Returns either {"answer": str} or
    {"pendingBrowserCalls": [{id, tool, args}], "state": token}.
    """
    if state_token:
        messages = unpack_state(state_token)
        for res in (tool_results or []):
            payload = res.get("result") if res.get("ok") else {"error": res.get("error")}
            messages.append({
                "role": "tool",
                "tool_call_id": res["id"],
                "content": _truncate(json.dumps(payload, default=str)),
            })
    else:
        messages = [{"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": question or ""}]

    client = _client()
    schemas = build_tool_schemas(list(server_tools_by_name.values()))

    for _ in range(MAX_ROUNDS):
        completion = client.chat.completions.create(
            model=MODEL, messages=messages, tools=schemas, tool_choice="auto",
        )
        msg = completion.choices[0].message
        calls = msg.tool_calls or []

        if not calls:
            return {"answer": msg.content or ""}

        messages.append({
            "role": "assistant",
            "content": msg.content,
            "tool_calls": [{"id": c.id, "type": "function",
                            "function": {"name": c.function.name,
                                         "arguments": c.function.arguments}}
                           for c in calls],
        })

        # Browser calls stop the server loop and go back to the page. If the
        # model mixed server and browser calls in one turn, run the server ones
        # first so their output is already in context when the page replies.
        browser_calls, ran_server = [], False
        for call in calls:
            name = call.function.name
            try:
                args = json.loads(call.function.arguments or "{}")
            except json.JSONDecodeError:
                args = {}

            if name in BROWSER_TOOL_NAMES:
                browser_calls.append({"id": call.id, "tool": name, "args": args})
                continue

            tool = server_tools_by_name.get(name)
            if tool is None:
                out = {"error": f"unknown tool '{name}'"}
            else:
                try:
                    out = tool.invoke(args)
                except Exception as exc:                     # surface, don't crash the turn
                    out = {"error": f"{type(exc).__name__}: {exc}"}
            ran_server = True
            messages.append({"role": "tool", "tool_call_id": call.id,
                             "content": _truncate(json.dumps(out, default=str))})

        if browser_calls:
            return {"pendingBrowserCalls": browser_calls, "state": pack_state(messages)}
        if not ran_server:
            break

    return {"answer": "I couldn't finish that request within the tool-call budget. "
                      "Try asking for one thing at a time."}
