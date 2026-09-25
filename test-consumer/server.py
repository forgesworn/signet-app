#!/usr/bin/env python3
"""Signet Test Harness server.

Serves the static harness AND accepts result reports from the callback
page, appending them to results/log.jsonl. That file is the point: after
you try a sign-in, the outcome is on disk, so someone reading the repo
(a colleague, or Claude) can see whether My Signet actually signed
without you having to describe what you saw.

Dev-only. Binds 0.0.0.0 so a phone on the same Wi-Fi can reach it.
"""

import json
import os
import ssl
import sys
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("SIGNET_HARNESS_PORT", "5175"))
BIND = os.environ.get("SIGNET_HARNESS_BIND", "0.0.0.0")
ROOT = os.path.dirname(os.path.abspath(__file__))
RESULTS_DIR = os.path.join(ROOT, "results")
LOG_PATH = os.path.join(RESULTS_DIR, "log.jsonl")
MAX_BODY = 64 * 1024

# https, when a certificate is present. A phone can only be a Sign-in-with-
# Signet consumer over https or localhost — a plain http LAN address is
# refused by the parser before Signet even asks you to approve. Mint one for
# this machine's LAN address with:
#
#   mkcert -cert-file cert/harness.pem -key-file cert/harness-key.pem <lan-ip> localhost
#
CERT_PATH = os.environ.get("SIGNET_HARNESS_CERT", os.path.join(ROOT, "cert", "harness.pem"))
KEY_PATH = os.environ.get("SIGNET_HARNESS_KEY", os.path.join(ROOT, "cert", "harness-key.pem"))
HAS_TLS = os.path.exists(CERT_PATH) and os.path.exists(KEY_PATH)
SCHEME = "https" if HAS_TLS else "http"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # Never cache the harness — a stale callback page silently tests
        # yesterday's code.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if self.path.rstrip("/") != "/report":
            self.send_error(404, "unknown endpoint")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(400, "bad Content-Length")
            return
        if length <= 0 or length > MAX_BODY:
            self.send_error(400, "body missing or too large")
            return
        raw = self.rfile.read(length)
        try:
            report = json.loads(raw.decode("utf-8"))
            if not isinstance(report, dict):
                raise ValueError("report must be an object")
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            self.send_error(400, f"bad JSON: {exc}")
            return

        report["receivedAt"] = datetime.now(timezone.utc).isoformat()
        report["userAgent"] = self.headers.get("User-Agent", "")[:300]
        report["clientAddress"] = self.client_address[0]

        os.makedirs(RESULTS_DIR, exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(report, ensure_ascii=False) + "\n")

        verdict = str(report.get("verdict", "?"))
        headline = str(report.get("headline", ""))
        print(f"[report] {verdict}: {headline}", flush=True)

        body = json.dumps({"ok": True, "logged": LOG_PATH}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # Quieter than the default: only note non-GET or errors.
        if args and isinstance(args[0], str) and args[0].startswith("GET"):
            return
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    os.makedirs(RESULTS_DIR, exist_ok=True)
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    if HAS_TLS:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(CERT_PATH, KEY_PATH)
        server.socket = context.wrap_socket(server.socket, server_side=True)
    print(f"Signet Test Harness  → {SCHEME}://localhost:{PORT}/")
    print(f"Results log          → {LOG_PATH}")
    print("Ctrl-C to stop.\n", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
