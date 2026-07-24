"""Vercel serverless entrypoint.

Re-exports the FastAPI app from agent/server.py so Vercel's Python runtime
(which auto-detects a module-level ASGI `app`) can serve /chat, /quote,
/filings/*, etc. as a serverless function instead of the always-on uvicorn
process agent/server.py runs locally.

agent/server.py imports its siblings as top-level modules (`from agent import
...`, `import browser_bridge`), which only resolves because `python
agent/server.py` puts agent/ at sys.path[0]. We recreate that here before
importing it.

This deployment's requirements.txt deliberately omits `cuga` (it drags in
torch/transformers/docling/easyocr/opencv/playwright — ~5.8GB installed,
versus Vercel's 500MB function limit). agent/agent.py only imports cuga
lazily inside get_agent(), so every route works without it except /chat,
which returns a 503 instead of crashing (see agent/server.py). That covers
/health, /tools (+ all 17 direct data-query tools), /quote, /quotes,
/quote/history, /quote/intraday, /filings/latest, /filings/xbrl.

Known gap: the /commands/next + /commands/{id}/result browser-bridge queue
(agent/browser_bridge.py) is in-memory and single-process by design ("one-user
local dev tool, not a multi-tenant service" per its docstring) — it will not
work correctly across Vercel's stateless, possibly multi-instance functions.
It's harmless to leave reachable (always returns empty/204 since nothing
enqueues into it without a live /chat agent).
"""
import sys
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent.parent / "agent"
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from server import app  # noqa: E402  (agent/server.py, loaded as top-level "server")

__all__ = ["app"]
