import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    """Serve files with caching disabled so edits to data.js / app.js / styles.css
    show up on a plain reload instead of being served stale from the browser cache."""

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


port = int(os.environ.get("PORT", 5500))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
print(f"Serving IBM dashboard at http://localhost:{port}  (Ctrl+C to stop)")
ThreadingHTTPServer(("", port), NoCacheHandler).serve_forever()
