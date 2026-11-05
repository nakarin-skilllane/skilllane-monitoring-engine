#!/usr/bin/env python3
"""Row-by-row diff of two JSONL files (the rows this prototype maps vs bench/fixture/expected-*.jsonl).

    python3 tools/compare-fixture.py expected-logs.jsonl mapped-logs.jsonl

Key order is ignored (ClickHouse does not care); every value must be equal. Prints the first
differences and a per-column count, exit 1 when anything differs.
"""
import json
import sys
from collections import Counter


def main(expected_path: str, actual_path: str, show: int = 5) -> int:
    diff_columns: Counter = Counter()
    shown = 0
    rows = 0
    with open(expected_path, encoding="utf-8") as e, open(actual_path, encoding="utf-8") as a:
        for n, (el, al) in enumerate(zip(e, a), 1):
            rows = n
            exp = json.loads(el)
            act = json.loads(al)
            keys = set(exp) | set(act)
            bad = [k for k in keys if exp.get(k, "<missing>") != act.get(k, "<missing>")]
            if not bad:
                continue
            for k in bad:
                diff_columns[k] += 1
            if shown < show:
                shown += 1
                print(f"row {n}:")
                for k in sorted(bad):
                    print(f"  {k}\n    expected {json.dumps(exp.get(k, '<missing>'), ensure_ascii=False)[:400]}\n    actual   {json.dumps(act.get(k, '<missing>'), ensure_ascii=False)[:400]}")
        extra_e = sum(1 for _ in e)
        extra_a = sum(1 for _ in a)
    if extra_e or extra_a:
        print(f"line count differs: expected has {extra_e} more, actual has {extra_a} more (compared {rows})")
    total = sum(diff_columns.values())
    if diff_columns:
        print("differences per column:", dict(diff_columns.most_common()))
    print(f"{rows} rows compared, {total} differing values" + (", identical" if not total and not extra_e and not extra_a else ""))
    return 0 if not total and not extra_e and not extra_a else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
