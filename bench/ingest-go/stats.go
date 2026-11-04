package main

// Ingest counters and the stats line (apps/engine/src/ingest/ingest.stats.ts).

import (
	"fmt"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Table int

const (
	TableLogs Table = iota
	TableSpans
)

var tableNames = [2]string{"logs", "spans"}

func (t Table) String() string { return tableNames[t] }

type tableCounters struct {
	rows, inserts, failures, lastInsertMs atomic.Int64
}

type Stats struct {
	tables       [2]tableCounters
	messages     atomic.Int64
	badEnvelopes atomic.Int64
	badItems     atomic.Int64

	mu            sync.Mutex
	firstBadError string
	loggedBad     int
	lastTick      struct {
		at                         time.Time
		logs, spans, failures, bad int64
	}
}

func NewStats() *Stats {
	s := &Stats{}
	s.lastTick.at = time.Now()
	return s
}

func (s *Stats) Inserted(t Table, rows int, d time.Duration) {
	c := &s.tables[t]
	c.rows.Add(int64(rows))
	c.inserts.Add(1)
	c.lastInsertMs.Store(d.Milliseconds())
}

func (s *Stats) InsertFailed(t Table) {
	s.tables[t].failures.Add(1)
}

// BadEnvelope: a message that is not a v1 envelope. Logged in full for the first few only.
func (s *Stats) BadEnvelope(source string, err error) {
	s.badEnvelopes.Add(1)
	s.noteBad("bad envelope from "+source, err)
}

// BadItem: an item inside a valid envelope that could not become a row.
func (s *Stats) BadItem(stream string, err error) {
	s.badItems.Add(1)
	s.noteBad("bad "+stream+" item", err)
}

func (s *Stats) noteBad(what string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.firstBadError == "" {
		s.firstBadError = what + ": " + err.Error()
	}
	if s.loggedBad < 5 {
		s.loggedBad++
		more := ""
		if s.loggedBad == 5 {
			more = " (further ones only counted)"
		}
		log.Printf("[warn] %s skipped: %s%s", what, err.Error(), more)
	}
}

// Line: one line for stdout; `lag` comes from the Kafka consumer when it has one.
func (s *Stats) Line(buffered [2]int, lag string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	seconds := now.Sub(s.lastTick.at).Seconds()
	if seconds < 0.001 {
		seconds = 0.001
	}
	logs := s.tables[TableLogs].rows.Load()
	spans := s.tables[TableSpans].rows.Load()
	failures := s.tables[TableLogs].failures.Load() + s.tables[TableSpans].failures.Load()
	bad := s.badEnvelopes.Load() + s.badItems.Load()
	parts := []string{
		fmt.Sprintf("logs %.1f rows/s (last insert %d ms, buffered %d)", float64(logs-s.lastTick.logs)/seconds, s.tables[TableLogs].lastInsertMs.Load(), buffered[TableLogs]),
		fmt.Sprintf("spans %.1f rows/s (last insert %d ms, buffered %d)", float64(spans-s.lastTick.spans)/seconds, s.tables[TableSpans].lastInsertMs.Load(), buffered[TableSpans]),
		fmt.Sprintf("insert failures %d (+%d)", failures, failures-s.lastTick.failures),
		fmt.Sprintf("bad envelopes %d, bad items %d (+%d)", s.badEnvelopes.Load(), s.badItems.Load(), bad-s.lastTick.bad),
		fmt.Sprintf("messages %d", s.messages.Load()),
	}
	if lag != "" {
		parts = append(parts, "lag "+lag)
	}
	if s.firstBadError != "" && bad > s.lastTick.bad {
		parts = append(parts, "first bad: "+s.firstBadError)
	}
	s.lastTick.at = now
	s.lastTick.logs = logs
	s.lastTick.spans = spans
	s.lastTick.failures = failures
	s.lastTick.bad = bad
	return strings.Join(parts, " · ")
}
