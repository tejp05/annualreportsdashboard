"""run.py — start the whole IBM dashboard with one command.

    python run.py

launches BOTH processes and shuts them down together on Ctrl+C:
  1. the static site        (serve.py, default port 5500 — override with PORT)
  2. the agent/live server  (agent/server.py on its own Python 3.12 venv,
                             default port 8787 — override with AGENT_PORT;
                             set AGENT_HOST=0.0.0.0 to expose it remotely)

Remote structuring later: run this on the host with AGENT_HOST=0.0.0.0, then
open the site once with ?agent=https://your-host:8787 — the browser remembers
it (localStorage) and every live feature (ticker, quotes, SEC filings, chat)
talks to that server instead of localhost.

The agent server needs agent/.venv (see agent/README.md). If it's missing,
the site still runs — live widgets just hide themselves gracefully.
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).parent

AGENT_PY = ROOT / "agent" / ".venv" / "Scripts" / "python.exe"   # Windows venv layout
if not AGENT_PY.exists():
    AGENT_PY = ROOT / "agent" / ".venv" / "bin" / "python"        # POSIX layout


def main() -> None:
    procs: list[tuple[str, subprocess.Popen]] = []
    procs.append(("site", subprocess.Popen([sys.executable, str(ROOT / "serve.py")], cwd=ROOT)))

    if AGENT_PY.exists():
        procs.append(("agent", subprocess.Popen([str(AGENT_PY), str(ROOT / "agent" / "server.py")], cwd=ROOT)))
    else:
        print("[run.py] agent/.venv not found - starting site only "
              "(live ticker/quotes/SEC widgets will hide themselves). "
              "See agent/README.md to set up the agent venv.")

    site_port = os.environ.get("PORT", "5500")
    agent_port = os.environ.get("AGENT_PORT", "8787")
    print(f"[run.py] site  -> http://localhost:{site_port}")
    if len(procs) > 1:
        print(f"[run.py] agent -> http://localhost:{agent_port}  (health: /health)")
    print("[run.py] Ctrl+C stops everything.")

    try:
        while True:
            for name, p in procs:
                code = p.poll()
                if code is not None:
                    print(f"[run.py] {name} exited with code {code} - shutting down the rest.")
                    raise KeyboardInterrupt
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        for _, p in procs:
            if p.poll() is None:
                p.terminate()
        for _, p in procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()


if __name__ == "__main__":
    main()
