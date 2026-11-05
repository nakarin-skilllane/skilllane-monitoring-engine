#!/usr/bin/env python3
"""Post every envelope of a fixture to a running ingest (one request per line, a few in flight).

usage: post-fixture.py <envelopes.jsonl> [--url http://localhost:5100] [--env bench-rust] [--gzip] [--concurrency 8]

`--env` rewrites deployment.environment.name in each resource (so the rows land under that env);
prints the status counts and the wall time. Uses only the standard library.
"""
import argparse
import gzip
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import Counter

ap = argparse.ArgumentParser()
ap.add_argument("fixture")
ap.add_argument("--url", default="http://localhost:5100")
ap.add_argument("--env", default=None)
ap.add_argument("--gzip", action="store_true")
ap.add_argument("--concurrency", type=int, default=8)
args = ap.parse_args()

with open(args.fixture, encoding="utf-8") as f:
    lines = [l for l in f if l.strip()]

def body_of(line):
    if args.env is None:
        return line.encode("utf-8"), json.loads(line)["stream"]
    e = json.loads(line)
    e["resource"]["deployment.environment.name"] = args.env
    return json.dumps(e, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), e["stream"]

statuses = Counter()
lock = threading.Lock()
index = {"i": 0}

def worker():
    while True:
        with lock:
            i = index["i"]
            index["i"] += 1
        if i >= len(lines):
            return
        body, stream = body_of(lines[i])
        headers = {"Content-Type": "application/json"}
        if args.gzip:
            body = gzip.compress(body, 1)
            headers["Content-Encoding"] = "gzip"
        req = urllib.request.Request(f"{args.url}/api/ingest/{stream}", data=body, headers=headers, method="POST")
        for attempt in range(50):
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    status = r.status
                    r.read()
            except urllib.error.HTTPError as e:
                status = e.code
                e.read()
            if status != 503:
                break
            time.sleep(2)
        with lock:
            statuses[status] += 1

t0 = time.time()
threads = [threading.Thread(target=worker) for _ in range(args.concurrency)]
for t in threads:
    t.start()
for t in threads:
    t.join()
dt = time.time() - t0
print(f"posted {len(lines)} envelopes in {dt:.1f} s: " + ", ".join(f"{k}×{v}" for k, v in sorted(statuses.items())))
sys.exit(0 if statuses.get(202) == len(lines) else 1)
