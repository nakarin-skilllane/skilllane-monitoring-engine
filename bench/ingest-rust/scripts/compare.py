#!/usr/bin/env python3
"""Compare `ingest-rust map` output with bench/fixture/expected-*.jsonl, row by row, column by column.

usage: compare.py <got.jsonl> <expected.jsonl> [--ignore col,col]

Keys only one side has are reported once (not per row); values are compared as parsed JSON, so
key order inside maps does not matter, and text columns must be equal bit for bit.
"""
import json
import sys

got_path, exp_path = sys.argv[1], sys.argv[2]
ignore = set()
if len(sys.argv) > 4 and sys.argv[3] == "--ignore":
    ignore = set(sys.argv[4].split(","))

def rows(path):
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)

got = list(rows(got_path))
exp = list(rows(exp_path))
print(f"rows: got {len(got)} expected {len(exp)}")
only_got, only_exp = set(), set()
diffs = {}
examples = {}
n = min(len(got), len(exp))
for i in range(n):
    g, e = got[i], exp[i]
    only_got |= set(g) - set(e)
    only_exp |= set(e) - set(g)
    for k in set(g) & set(e):
        if k in ignore:
            continue
        if g[k] != e[k]:
            diffs[k] = diffs.get(k, 0) + 1
            if k not in examples:
                examples[k] = (i, g[k], e[k])
if only_got:
    print("columns only in got:", sorted(only_got))
if only_exp:
    print("columns only in expected:", sorted(only_exp))
if diffs:
    for k, c in sorted(diffs.items(), key=lambda kv: -kv[1]):
        i, gv, ev = examples[k]
        print(f"DIFF {k}: {c} rows, e.g. row {i}:\n  got      {json.dumps(gv, ensure_ascii=False)[:400]}\n  expected {json.dumps(ev, ensure_ascii=False)[:400]}")
    sys.exit(1)
print("all compared columns identical" if len(got) == len(exp) else "row count differs")
sys.exit(0 if len(got) == len(exp) else 1)
