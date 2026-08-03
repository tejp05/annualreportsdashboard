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
you would do. Keep answers to 1-3 sentences unless asked for a table or detail.\
"""

# Browser-side tools, executed by window.CUGA in the page (see agent-tools.js).
# Schemas are declared here rather than fetched from the client so the model
# cannot be handed tool definitions by an untrusted caller.
BROWSER_TOOLS = [
    ("navigate_to_tab", "Switch the dashboard to a tab. Use for 'show me' / 'go to' / 'open'.",
     {"tab": ("string", "One of: home, story, regression, macro, ma, competitors, about", True)}),
    ("set_overview_range", "Set the year range on the overview/home charts.",
     {"from_year": ("integer", "First year, >= 1911", True),
      "to_year": ("integer", "Last year, <= 2025", True)}),
    ("configure_regression", "Configure the Regression Lab: choose x/y metrics and year range.",
     {"x": ("string", "Independent variable metric key", True),
      "y": ("string", "Dependent variable metric key", True),
      "from_year": ("integer", "First year", False),
      "to_year": ("integer", "Last year", False)}),
    ("get_live_quote", "Read the live quote currently shown on the page.",
     {"symbol": ("string", "Ticker, default IBM", False)}),
    ("refresh_live_quote", "Force the page's live quote widget to refetch.", {}),
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
        schemas.append({
            "type": "function",
            "function": {
                "name": name,
                "description": desc,
                "parameters": {
                    "type": "object",
                    "properties": {p: {"type": t, "description": d}
                                   for p, (t, d, _) in params.items()},
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
