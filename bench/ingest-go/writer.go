package main

// ClickHouse writer (apps/engine/src/ingest/clickhouse-writer.ts): rows are
// buffered per table and inserted with JSONEachRow when ENGINE_FLUSH_ROWS are
// waiting or ENGINE_FLUSH_MS after the first buffered row; one insert in flight
// per table. Every Enqueue returns once its rows are in ClickHouse, or the
// insert's error. Backpressure: Enqueue waits while a table holds 4x
// ENGINE_FLUSH_ROWS rows (HTTP ingest answers 503 instead: Saturated).

import (
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"time"
)

var errWriterClosed = errors.New("ClickhouseWriter is closed")

type tableBuffer struct {
	table    Table
	mu       sync.Mutex
	cond     *sync.Cond
	chunks   [][]byte
	count    int
	waiters  []chan error
	timer    *time.Timer
	inflight bool
	again    bool
}

type Writer struct {
	tables       [2]*tableBuffer
	flushRows    int
	highWater    int
	flushAfter   time.Duration
	insertURL    [2]string
	user, pass   string
	client       *http.Client
	stats        *Stats
	closed       atomic.Bool
	lastErrorLog atomic.Int64
	gzipPool     sync.Pool
}

func NewWriter(cfg *Config, stats *Stats) *Writer {
	w := &Writer{
		flushRows:  cfg.FlushRows,
		highWater:  cfg.FlushRows * 4,
		flushAfter: time.Duration(cfg.FlushMs) * time.Millisecond,
		user:       cfg.ClickHouseUser,
		pass:       cfg.ClickHousePassword,
		stats:      stats,
		client: &http.Client{
			Timeout: 60 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        8,
				MaxIdleConnsPerHost: 8,
				IdleConnTimeout:     90 * time.Second,
			},
		},
	}
	for t := range w.tables {
		b := &tableBuffer{table: Table(t)}
		b.cond = sync.NewCond(&b.mu)
		w.tables[t] = b
		query := url.Values{}
		query.Set("query", fmt.Sprintf("INSERT INTO %s.%s FORMAT JSONEachRow", cfg.ClickHouseDatabase, Table(t)))
		query.Set("date_time_input_format", "best_effort")
		w.insertURL[t] = cfg.ClickHouseURL + "/?" + query.Encode()
	}
	w.gzipPool.New = func() any {
		zw, _ := gzip.NewWriterLevel(io.Discard, gzip.DefaultCompression)
		return zw
	}
	return w
}

// Buffered: rows waiting per table (not counting a running insert).
func (w *Writer) Buffered() [2]int {
	var out [2]int
	for t, b := range w.tables {
		b.mu.Lock()
		out[t] = b.count
		b.mu.Unlock()
	}
	return out
}

// Saturated: at the backpressure mark: an Enqueue now would wait.
func (w *Writer) Saturated(t Table) bool {
	if w.closed.Load() {
		return true
	}
	b := w.tables[t]
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.count >= w.highWater
}

// Enqueue adds `rows` JSONEachRow lines (one chunk) and waits until they are inserted.
func (w *Writer) Enqueue(t Table, chunk []byte, rows int) error {
	if rows == 0 {
		return nil
	}
	if w.closed.Load() {
		return errWriterClosed
	}
	b := w.tables[t]
	b.mu.Lock()
	for b.count >= w.highWater {
		b.cond.Wait()
		if w.closed.Load() {
			b.mu.Unlock()
			return errWriterClosed
		}
	}
	done := make(chan error, 1)
	b.waiters = append(b.waiters, done)
	b.chunks = append(b.chunks, chunk)
	b.count += rows
	if b.count >= w.flushRows {
		w.flushLocked(b)
	} else if b.timer == nil {
		w.armTimer(b)
	}
	b.mu.Unlock()
	return <-done
}

func (w *Writer) armTimer(b *tableBuffer) {
	var t *time.Timer
	t = time.AfterFunc(w.flushAfter, func() {
		b.mu.Lock()
		if b.timer == t {
			b.timer = nil
		}
		w.flushLocked(b)
		b.mu.Unlock()
	})
	b.timer = t
}

// flushLocked starts an insert of everything buffered (or marks one to follow). b.mu held.
func (w *Writer) flushLocked(b *tableBuffer) {
	if b.timer != nil {
		b.timer.Stop()
		b.timer = nil
	}
	if b.count == 0 {
		return
	}
	if b.inflight {
		b.again = true
		return
	}
	chunks, waiters, rows := b.chunks, b.waiters, b.count
	b.chunks, b.waiters, b.count = nil, nil, 0
	b.again = false
	b.inflight = true
	go w.insert(b, chunks, rows, waiters)
}

func (w *Writer) insert(b *tableBuffer, chunks [][]byte, rows int, waiters []chan error) {
	started := time.Now()
	err := w.post(b.table, chunks)
	if err == nil {
		w.stats.Inserted(b.table, rows, time.Since(started))
	} else {
		w.stats.InsertFailed(b.table)
		err = fmt.Errorf("ClickHouse insert into %s failed: %w", b.table, err)
		now := time.Now().UnixMilli()
		if now-w.lastErrorLog.Load() > 5000 {
			w.lastErrorLog.Store(now)
			log.Printf("[error] Insert of %d rows into %s failed: %v", rows, b.table, err)
		}
	}
	for _, done := range waiters {
		done <- err
	}
	b.mu.Lock()
	b.inflight = false
	b.cond.Broadcast()
	if b.count > 0 {
		if b.again || b.count >= w.flushRows || w.closed.Load() {
			w.flushLocked(b)
		} else if b.timer == nil {
			w.armTimer(b)
		}
	}
	b.mu.Unlock()
}

func (w *Writer) post(t Table, chunks [][]byte) error {
	size := 0
	for _, c := range chunks {
		size += len(c)
	}
	body := bytes.NewBuffer(make([]byte, 0, size/4+512))
	zw := w.gzipPool.Get().(*gzip.Writer)
	zw.Reset(body)
	for _, c := range chunks {
		if _, err := zw.Write(c); err != nil {
			w.gzipPool.Put(zw)
			return err
		}
	}
	if err := zw.Close(); err != nil {
		w.gzipPool.Put(zw)
		return err
	}
	w.gzipPool.Put(zw)
	req, err := http.NewRequest(http.MethodPost, w.insertURL[t], body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("Content-Type", "application/x-ndjson")
	if w.user != "" {
		req.SetBasicAuth(w.user, w.pass)
	}
	res, err := w.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		return fmt.Errorf("HTTP %d: %s", res.StatusCode, bytes.TrimSpace(msg))
	}
	_, _ = io.Copy(io.Discard, res.Body)
	return nil
}

// FlushAll inserts every buffered row of every table and returns when nothing is left.
func (w *Writer) FlushAll() {
	for _, b := range w.tables {
		b.mu.Lock()
		for b.count > 0 || b.inflight {
			if !b.inflight {
				w.flushLocked(b)
			}
			if b.inflight {
				b.cond.Wait()
			}
		}
		b.mu.Unlock()
	}
}

// Close: final flush on shutdown; later enqueues fail.
func (w *Writer) Close() {
	w.FlushAll()
	w.closed.Store(true)
	for _, b := range w.tables {
		b.mu.Lock()
		b.cond.Broadcast()
		b.mu.Unlock()
	}
}
