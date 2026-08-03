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
lazily inside get_agent(), so every route works without it.

/chat therefore runs the OpenAI backend here (agent/openai_agent.py), which
needs OPENAI_API_KEY set under Vercel Project → Settings → Environment
Variables. The key is read from the environment and must never be committed:
this repo is public and the site it deploys is public, so a literal key in the
source would be world-readable. Without the variable set, /chat returns 503
and every other route still works: /health, /tools (+ all 17 direct
data-query tools), /quote, /quotes, /quote/history, /quote/intraday,
/filings/latest, /filings/xbrl.

The /commands/next + /commands/{id}/result browser-bridge queue
(agent/browser_bridge.py) is in-memory and single-process by design ("one-user
local dev tool, not a multi-tenant service" per its docstring), so it cannot
work across Vercel's stateless, possibly multi-instance functions. The OpenAI
backend does not use it: browser tool calls are returned to the page as
`pendingBrowserCalls` with signed state and executed there, which is stateless
by construction. The queue routes stay reachable but idle (204), since nothing
enqueues into them on this path.
"""
import sys
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent.parent / "agent"
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from server import app  # noqa: E402  (agent/server.py, loaded as top-level "server")

__all__ = ["app"]
