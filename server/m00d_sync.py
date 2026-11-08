#!/usr/bin/env python3
"""
m00d sync server: keeps one copy of the app's data on your own server.

Standard library only. Run it behind a reverse proxy that does HTTPS (Caddy, nginx).

    GET  /data   -> {"rev": 7, "data": {...}}         (data is null until the first upload)
    PUT  /data   <- {"baseRev": 7, "data": {...}}
                 -> {"rev": 8}                         on success
                 -> 409 {"rev": 9, "data": {...}}      if someone else saved first;
                                                       the app merges and tries again

Every request needs  Authorization: Bearer <M00D_TOKEN>.

Safety nets:
  - writes are atomic (temp file + rename), so a crash never leaves half a file
  - previous.json always holds the version before the latest save
  - a dated copy is kept per day in snapshots/ (the newest M00D_KEEP_DAYS days)

Environment:
  M00D_TOKEN      required. A long random secret, e.g. `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`
  M00D_DATA_DIR   where to store data (default: ./m00d-data)
  M00D_ORIGIN     allowed browser origin (default: https://martin-martin.github.io)
  M00D_HOST       address to listen on (default: 127.0.0.1; the Docker image uses 0.0.0.0)
  M00D_PORT       port to listen on (default: 8787)
  M00D_KEEP_DAYS  how many daily snapshots to keep (default: 60)
"""
import datetime
import hmac
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TOKEN = os.environ.get("M00D_TOKEN", "")
DATA_DIR = Path(os.environ.get("M00D_DATA_DIR", "m00d-data")).resolve()
ORIGIN = os.environ.get("M00D_ORIGIN", "https://martin-martin.github.io")
HOST = os.environ.get("M00D_HOST", "127.0.0.1")
PORT = int(os.environ.get("M00D_PORT", "8787"))
KEEP_DAYS = int(os.environ.get("M00D_KEEP_DAYS", "60"))
MAX_BODY = 5 * 1024 * 1024

CURRENT = DATA_DIR / "current.json"
SNAPSHOTS = DATA_DIR / "snapshots"
lock = threading.Lock()


def read_current():
    try:
        return json.loads(CURRENT.read_text("utf-8"))
    except FileNotFoundError:
        return {"rev": 0, "data": None}


def write_atomic(path, obj):
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def snapshot(doc):
    SNAPSHOTS.mkdir(parents=True, exist_ok=True)
    write_atomic(SNAPSHOTS / f"{datetime.date.today().isoformat()}.json", doc)
    for old in sorted(SNAPSHOTS.glob("*.json"))[:-KEEP_DAYS]:
        old.unlink()


class Handler(BaseHTTPRequestHandler):
    server_version = "m00d-sync"

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Vary", "Origin")

    def reply(self, code, obj=None):
        body = json.dumps(obj if obj is not None else {}).encode("utf-8")
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def ok_path(self):
        return self.path.split("?")[0].rstrip("/").endswith("/data")

    def authed(self):
        got = self.headers.get("Authorization", "")
        return hmac.compare_digest(got.encode(), f"Bearer {TOKEN}".encode())

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        if not self.ok_path():
            return self.reply(404, {"error": "not found"})
        if not self.authed():
            return self.reply(401, {"error": "wrong key"})
        with lock:
            self.reply(200, read_current())

    def do_PUT(self):
        if not self.ok_path():
            return self.reply(404, {"error": "not found"})
        if not self.authed():
            return self.reply(401, {"error": "wrong key"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self.reply(413, {"error": "body missing or too large"})
        try:
            body = json.loads(self.rfile.read(length))
            base, data = int(body["baseRev"]), body["data"]
            if not isinstance(data, dict) or not isinstance(data.get("entries"), dict):
                raise ValueError("not m00d data")
        except (ValueError, KeyError, TypeError) as e:
            return self.reply(400, {"error": f"bad request: {e}"})
        with lock:
            cur = read_current()
            if base != cur["rev"]:
                return self.reply(409, cur)
            doc = {
                "rev": cur["rev"] + 1,
                "savedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
                "data": data,
            }
            if cur["data"] is not None:
                write_atomic(DATA_DIR / "previous.json", cur)
            write_atomic(CURRENT, doc)
            snapshot(doc)
            self.reply(200, {"rev": doc["rev"]})

    def log_message(self, fmt, *args):
        # Short log line; never logs bodies (they contain health data).
        sys.stderr.write(f"{self.address_string()} {fmt % args}\n")


if __name__ == "__main__":
    if len(TOKEN) < 16:
        sys.exit("Set M00D_TOKEN to a long random secret (16+ characters).")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(DATA_DIR, 0o700)
    print(f"m00d sync on {HOST}:{PORT}, data in {DATA_DIR}, origin {ORIGIN}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
