package main

// The HTTP path end to end against a fake ClickHouse: every fixture envelope
// posted (plain and gzip) answers 202 only after its rows reached the insert
// endpoint, and the inserted row counts equal the expected files' line counts.
// Also the 400 / 413 / 503 answers. Skipped without the fixture.

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeClickHouse struct {
	rows   [2]atomic.Int64
	fail   atomic.Bool
	mu     sync.Mutex
	sample []byte
}

func (f *fakeClickHouse) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if f.fail.Load() {
		http.Error(w, "Code: 243. DB::Exception: Cannot reserve", http.StatusInternalServerError)
		return
	}
	if u, p, ok := r.BasicAuth(); !ok || u != "u" || p != "p" {
		http.Error(w, "auth", http.StatusForbidden)
		return
	}
	query := r.URL.Query()
	if query.Get("date_time_input_format") != "best_effort" {
		http.Error(w, "settings", http.StatusBadRequest)
		return
	}
	var table Table
	switch query.Get("query") {
	case "INSERT INTO db.logs FORMAT JSONEachRow":
		table = TableLogs
	case "INSERT INTO db.spans FORMAT JSONEachRow":
		table = TableSpans
	default:
		http.Error(w, "query", http.StatusBadRequest)
		return
	}
	if r.Header.Get("Content-Encoding") != "gzip" {
		http.Error(w, "not gzip", http.StatusBadRequest)
		return
	}
	zr, err := gzip.NewReader(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(zr)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	n := int64(bytes.Count(body, []byte("\n")))
	f.rows[table].Add(n)
	f.mu.Lock()
	if f.sample == nil && n > 0 {
		f.sample = body[:bytes.IndexByte(body, '\n')]
	}
	f.mu.Unlock()
	w.WriteHeader(http.StatusOK)
}

func newTestServer(t *testing.T, ch *fakeClickHouse, flushRows, maxInflight int) (*httptest.Server, *Writer) {
	t.Helper()
	chServer := httptest.NewServer(ch)
	t.Cleanup(chServer.Close)
	cfg := &Config{ClickHouseURL: chServer.URL, ClickHouseUser: "u", ClickHousePassword: "p", ClickHouseDatabase: "db",
		FlushRows: flushRows, FlushMs: 50, MaxInflight: maxInflight}
	stats := NewStats()
	writer := NewWriter(cfg, stats)
	handler := &Handler{writer: writer, stats: stats}
	srv := httptest.NewServer((&IngestServer{handler: handler, writer: writer, maxInflight: int64(maxInflight)}).Routes())
	t.Cleanup(srv.Close)
	return srv, writer
}

func post(t *testing.T, url string, body []byte, gz bool) int {
	t.Helper()
	var reader io.Reader = bytes.NewReader(body)
	req, _ := http.NewRequest(http.MethodPost, url, nil)
	if gz {
		var buf bytes.Buffer
		zw := gzip.NewWriter(&buf)
		_, _ = zw.Write(body)
		_ = zw.Close()
		reader = &buf
		req.Header.Set("Content-Encoding", "gzip")
	}
	req.Body = io.NopCloser(reader)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	_, _ = io.Copy(io.Discard, res.Body)
	res.Body.Close()
	return res.StatusCode
}

func TestHTTPEndToEnd(t *testing.T) {
	f, err := os.Open(fixtureDir + "envelopes.jsonl")
	if err != nil {
		t.Skipf("fixture not available: %v", err)
	}
	defer f.Close()
	ch := &fakeClickHouse{}
	srv, writer := newTestServer(t, ch, 5000, 64)

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	var codes sync.Map
	var wg sync.WaitGroup
	sem := make(chan struct{}, 32)
	n := 0
	for sc.Scan() {
		line := bytes.Clone(sc.Bytes())
		line = bytes.Replace(line, []byte(`"deployment.environment.name":"bench"`), []byte(`"deployment.environment.name":"bench-go"`), 1)
		stream := "logs"
		if bytes.HasPrefix(line, []byte(`{"v":1,"stream":"spans"`)) {
			stream = "spans"
		}
		n++
		gz := n%2 == 0
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			code := post(t, srv.URL+"/api/ingest/"+stream, line, gz)
			v, _ := codes.LoadOrStore(code, new(atomic.Int64))
			v.(*atomic.Int64).Add(1)
		}()
	}
	wg.Wait()
	writer.FlushAll()
	accepted := int64(0)
	codes.Range(func(k, v any) bool {
		c := v.(*atomic.Int64).Load()
		if k.(int) == http.StatusAccepted {
			accepted = c
		} else {
			t.Errorf("%d envelopes answered %d", c, k)
		}
		return true
	})
	logs, spans := ch.rows[TableLogs].Load(), ch.rows[TableSpans].Load()
	t.Logf("posted %d envelopes: %d accepted · inserted logs %d, spans %d", n, accepted, logs, spans)
	if accepted != int64(n) {
		t.Fatalf("expected every envelope to answer 202")
	}
	if logs != 57078 || spans != 8651 {
		t.Fatalf("inserted rows logs %d / spans %d; expected 57078 / 8651", logs, spans)
	}
	if !bytes.Contains(ch.sample, []byte(`"env":"bench-go"`)) {
		t.Errorf("env was not rewritten: %s", ch.sample)
	}
}

func TestHTTPAnswers(t *testing.T) {
	ch := &fakeClickHouse{}
	srv, _ := newTestServer(t, ch, 5000, 1)
	envelope := []byte(`{"v":1,"stream":"logs","resource":{"service.name":"s"},"sentAt":"2026-11-05T02:00:00.000Z","items":[{"message":"hi"}]}`)

	res, _ := http.Get(srv.URL + "/api/health")
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || strings.TrimSpace(string(body)) != `{"ok":true}` {
		t.Errorf("health: %d %s", res.StatusCode, body)
	}
	if code := post(t, srv.URL+"/api/ingest/logs", envelope, false); code != 202 {
		t.Errorf("plain envelope: %d", code)
	}
	if code := post(t, srv.URL+"/api/ingest/logs", envelope, true); code != 202 {
		t.Errorf("gzip envelope: %d", code)
	}
	if code := post(t, srv.URL+"/api/ingest/spans", envelope, false); code != 400 {
		t.Errorf("stream mismatch: %d", code)
	}
	if code := post(t, srv.URL+"/api/ingest/metrics", envelope, false); code != 400 {
		t.Errorf("unknown stream: %d", code)
	}
	if code := post(t, srv.URL+"/api/ingest/logs", []byte(`{"v":2}`), false); code != 400 {
		t.Errorf("not an envelope: %d", code)
	}
	if code := post(t, srv.URL+"/api/ingest/logs", []byte(`{"v":1,`), false); code != 400 {
		t.Errorf("broken JSON: %d", code)
	}
	big := append([]byte(`{"v":1,"stream":"logs","resource":{"service.name":"s"},"items":[],"pad":"`), bytes.Repeat([]byte("x"), maxBodyBytes)...)
	big = append(big, `"}`...)
	if code := post(t, srv.URL+"/api/ingest/logs", big, true); code != 413 {
		t.Errorf("over the limit (gzip): %d", code)
	}
	if ch.rows[TableLogs].Load() != 2 {
		t.Errorf("rows inserted: %d", ch.rows[TableLogs].Load())
	}

	// ClickHouse down → 503 with Retry-After
	ch.fail.Store(true)
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/ingest/logs", bytes.NewReader(envelope))
	res, _ = http.DefaultClient.Do(req)
	_, _ = io.Copy(io.Discard, res.Body)
	res.Body.Close()
	if res.StatusCode != 503 || res.Header.Get("Retry-After") != "2" {
		t.Errorf("ClickHouse failure: %d retry-after %q", res.StatusCode, res.Header.Get("Retry-After"))
	}
	ch.fail.Store(false)

	// max inflight 1: a second concurrent request answers 503
	slow := &fakeClickHouse{}
	gate := make(chan struct{})
	slowServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-gate
		slow.ServeHTTP(w, r)
	}))
	defer slowServer.Close()
	cfg := &Config{ClickHouseURL: slowServer.URL, ClickHouseUser: "u", ClickHousePassword: "p", ClickHouseDatabase: "db", FlushRows: 5000, FlushMs: 10, MaxInflight: 1}
	stats := NewStats()
	writer := NewWriter(cfg, stats)
	ingest := &IngestServer{handler: &Handler{writer: writer, stats: stats}, writer: writer, maxInflight: 1}
	srv2 := httptest.NewServer(ingest.Routes())
	defer srv2.Close()
	first := make(chan int, 1)
	go func() { first <- post(t, srv2.URL+"/api/ingest/logs", envelope, false) }()
	for i := 0; i < 50 && ingest.inflight.Load() == 0; i++ {
		time.Sleep(5 * time.Millisecond)
	}
	if code := post(t, srv2.URL+"/api/ingest/logs", envelope, false); code != 503 {
		t.Errorf("over max inflight: %d", code)
	}
	close(gate)
	if code := <-first; code != 202 {
		t.Errorf("first request: %d", code)
	}
}
