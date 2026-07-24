"""Vercel serverless entrypoint.

Re-exports the FastAPI app from agent/server.py so Vercel's Python runtime
(which auto-detects a module-level ASGI `app`) can serve /chat, /quote,
/filings/*, etc. as a serverless function instead of the always-on uvicorn
process agent/server.py runs locally.

agent/server.py imports its siblings as top-level modules (`from agent import
...`, `import browser_bridge`), which only resolves because `python
agent/server.py` puts agent/ at sys.path[0]. We recreate that here before
importing it.

Known gap: the /commands/next + /commands/{id}/result browser-bridge queue
(agent/browser_bridge.py) is in-memory and single-process by design ("one-user
local dev tool, not a multi-tenant service" per its docstring) — it will not
work correctly across Vercel's stateless, possibly multi-instance functions.
Everything else (chat, quotes, filings, tool endpoints) is stateless per
request and fine.
"""
import sys
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent.parent / "agent"
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from server import app  # noqa: E402  (agent/server.py, loaded as top-level "server")

__all__ = ["app"]
