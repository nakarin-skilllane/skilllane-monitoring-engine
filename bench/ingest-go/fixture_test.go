package main

// End-to-end mapping against the fixture: every envelope of
// bench/fixture/envelopes.jsonl mapped here must equal the engine's rows in
// expected-logs.jsonl / expected-spans.jsonl byte for byte. Skipped when the
// fixture is not next to this module (it is not in the Docker build context).

import (
	"bufio"
	"bytes"
	"os"
	"testing"
)

const fixtureDir = "../fixture/"

func openFixture(t *testing.T, name string) *bufio.Scanner {
	t.Helper()
	f, err := os.Open(fixtureDir + name)
	if err != nil {
		t.Skipf("fixture %s not available: %v", name, err)
	}
	t.Cleanup(func() { f.Close() })
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	return sc
}

func TestFixtureRows(t *testing.T) {
	envelopes := openFixture(t, "envelopes.jsonl")
	expected := [2]*bufio.Scanner{openFixture(t, "expected-logs.jsonl"), openFixture(t, "expected-spans.jsonl")}
	var rows, mismatches [2]int
	var items, bad int
	for envelopes.Scan() {
		e, err := ParseEnvelope(bytes.Clone(envelopes.Bytes()))
		if err != nil {
			t.Fatalf("envelope: %v", err)
		}
		fallbackMs, _ := parseDateJS(e.SentAt)
		for _, item := range e.Items {
			items++
			var row []byte
			if e.Stream == TableLogs {
				row, err = mapLog(item, e.Resource, fallbackMs)
			} else {
				row, err = mapSpan(item, e.Resource)
			}
			if err != nil {
				bad++
				t.Errorf("%s item: %v", e.Stream, err)
				continue
			}
			if !expected[e.Stream].Scan() {
				t.Fatalf("expected-%s.jsonl ended before the envelopes did", e.Stream)
			}
			rows[e.Stream]++
			want := expected[e.Stream].Bytes()
			got := bytes.TrimSuffix(row, []byte("\n"))
			if !bytes.Equal(got, want) {
				mismatches[e.Stream]++
				if mismatches[e.Stream] <= 3 {
					t.Errorf("%s row %d differs\n want %s\n got  %s", e.Stream, rows[e.Stream], want, got)
				}
			}
		}
	}
	for s, sc := range expected {
		if sc.Scan() {
			t.Errorf("expected-%s.jsonl has more rows than were mapped", Table(s))
		}
	}
	t.Logf("fixture: %d items → logs %d rows (%d differ) · spans %d rows (%d differ) · bad items %d",
		items, rows[TableLogs], mismatches[TableLogs], rows[TableSpans], mismatches[TableSpans], bad)
	if mismatches[0]+mismatches[1] > 0 {
		t.Fatalf("%d rows differ from the engine's", mismatches[0]+mismatches[1])
	}
}
