#!/usr/bin/env python3
"""Posts every envelope of a .jsonl fixture to a running ingest, with the resource's
deployment.environment.name rewritten (so the rows can be counted and deleted by env).

    python3 tools/post-fixture.py bench/fixture/envelopes.jsonl http://localhost:5100 bench-dotnet [concurrency] [gzip]

Prints the status-code histogram, the number of items posted per stream and the wall time.
"""
import gzip
import json
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor


def post(base: str, stream: str, body: bytes, use_gzip: bool) -> int:
    headers = {"content-type": "application/json"}
    if use_gzip:
        body = gzip.compress(body, 6)
        headers["content-encoding"] = "gzip"
    req = urllib.request.Request(f"{base}/api/ingest/{stream}", data=body, headers=headers, method="POST")
    for attempt in range(60):
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                return res.status
        except urllib.error.HTTPError as e:
            if e.code == 503:
                time.sleep(float(e.headers.get("Retry-After", "2")))
                continue
            return e.code
    return 503


def main() -> int:
    path, base, env = sys.argv[1], sys.argv[2], sys.argv[3]
    concurrency = int(sys.argv[4]) if len(sys.argv) > 4 else 8
    use_gzip = (sys.argv[5] if len(sys.argv) > 5 else "gzip") == "gzip"
    jobs = []
    items = Counter()
    with open(path, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            envelope = json.loads(line)
            envelope["resource"]["deployment.environment.name"] = env
            items[envelope["stream"]] += len(envelope["items"])
            jobs.append((envelope["stream"], json.dumps(envelope, ensure_ascii=False, separators=(",", ":")).encode("utf-8")))
    started = time.time()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        statuses = Counter(pool.map(lambda j: post(base, j[0], j[1], use_gzip), jobs))
    elapsed = time.time() - started
    print(f"posted {len(jobs)} envelopes ({dict(items)} items) in {elapsed:.1f} s · statuses {dict(statuses)}")
    return 0 if statuses.get(202, 0) == len(jobs) else 1


if __name__ == "__main__":
    sys.exit(main())
