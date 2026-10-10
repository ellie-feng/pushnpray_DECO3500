import http.server
import os
import sys

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
serve_dir = sys.argv[2] if len(sys.argv) > 2 else "."
os.chdir(serve_dir)
http.server.test(HandlerClass=NoCacheHandler, port=port)
