"""Serve the built site for preview, without letting the browser cache it.

Usage:
    python3 preview.py [port]          # defaults to 8902

Every asset the site loads carries a ?v=<build> stamp, so a rebuild changes
their URLs and the browser fetches them fresh. index.html is the one file that
cannot stamp itself, and `python3 -m http.server` sends no cache headers at
all, so the browser keeps its copy, keeps asking for the previous build's
engine.js, and a rebuild appears to have done nothing.

A real host needs less than this: index.html with Cache-Control: no-cache, and
everything else cached as long as it likes. A preview server can be blunter.
"""

import functools
import http.server
import os
import socketserver
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "outputs", "03_site")


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # no-cache means "cache it, but revalidate first", so the server still
        # answers 304 when nothing changed.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8902
    if not os.path.isdir(ROOT):
        sys.exit("No built site at %s - run 03_build_dashboard.R first." % ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    handler = functools.partial(Handler, directory=ROOT)
    with socketserver.TCPServer(("127.0.0.1", port), handler) as httpd:
        print("Serving %s at http://127.0.0.1:%d/" % (ROOT, port))
        httpd.serve_forever()
