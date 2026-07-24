"""browser_bridge.py — in-memory command queue that lets server-side CUGA
tools (agent.py) drive an open browser tab running agent-tools.js.

Flow:
  1. An agent tool calls run_browser_command("navigate_to_tab", {"tab": "ma"}).
  2. That enqueues a command and blocks (via threading.Event) until either the
     browser posts a result back or `timeout` seconds pass.
  3. The browser's poll loop (agent-tools.js) calls GET /commands/next every
     ~1s, executes the tool through window.CUGA.invoke, and POSTs the result
     to /commands/{id}/result — which sets the Event and wakes step 2.

Single global queue: this is a one-user local dev tool, not a multi-tenant
service, so there is no session/tab routing — whichever dashboard tab has
agent-tools.js open and polling will pick up the next command.
"""

from __future__ import annotations

import threading
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any


@dataclass
class _Command:
    id: str
    tool: str
    args: dict
    event: threading.Event = field(default_factory=threading.Event)
    ok: bool = False
    result: Any = None
    error: str | None = None


_lock = threading.Lock()
_queue: deque[str] = deque()
_commands: dict[str, _Command] = {}


def run_browser_command(tool: str, args: dict | None = None, timeout: float = 25.0) -> Any:
    """Enqueue a browser-side tool call and block for the result.

    Raises RuntimeError (with a message safe to return to the LLM) if no
    browser tab picks up the command in time, or if the browser reports an
    error executing it.
    """
    cmd = _Command(id=uuid.uuid4().hex, tool=tool, args=args or {})
    with _lock:
        _commands[cmd.id] = cmd
        _queue.append(cmd.id)
    got = cmd.event.wait(timeout)
    with _lock:
        _commands.pop(cmd.id, None)
    if not got:
        raise RuntimeError(
            f"No dashboard tab responded within {timeout:.0f}s. "
            "Make sure the site is open in a browser with agent-tools.js loaded."
        )
    if not cmd.ok:
        raise RuntimeError(f"Browser action '{tool}' failed: {cmd.error}")
    return cmd.result


def pop_next_command() -> dict | None:
    """Called by GET /commands/next. Returns {id, tool, args} or None."""
    with _lock:
        while _queue:
            cid = _queue.popleft()
            cmd = _commands.get(cid)
            if cmd is not None:
                return {"id": cmd.id, "tool": cmd.tool, "args": cmd.args}
    return None


def resolve_command(cmd_id: str, ok: bool, result: Any = None, error: str | None = None) -> bool:
    """Called by POST /commands/{id}/result. Returns False if the command
    already timed out / doesn't exist (browser can ignore that)."""
    with _lock:
        cmd = _commands.get(cmd_id)
        if cmd is None:
            return False
        cmd.ok, cmd.result, cmd.error = ok, result, error
    cmd.event.set()
    return True
