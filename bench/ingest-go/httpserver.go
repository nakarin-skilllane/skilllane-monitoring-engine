package main

// POST /api/ingest/<stream> (apps/engine/src/ingest/http-ingest.controller.ts):
// 202 once the rows are in ClickHouse; 503 + Retry-After while ClickHouse fails,
// the writer is full or ENGINE_INGEST_MAX_INFLIGHT requests are running; 400 for
// what can never be written; 413 over ENGINE_INGEST_MAX_BYTES (after gzip).

import (
	"compress/gzip"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
)

const (
	retryAfterSeconds = "2"
	ingestPath        = "/api/ingest/"
	maxBodyBytes      = 2_000_000
)

type IngestServer struct {
	handler     *Handler
	writer      *Writer
	maxInflight int64
	inflight    atomic.Int64
}

func (s *IngestServer) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc(ingestPath, s.ingest)
	return mux
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body := []byte(`{"statusCode":` + strconv.Itoa(status) + `,"message":`)
	body = AppendJSONString(body, message)
	body = append(body, `,"error":`...)
	body = AppendJSONString(body, http.StatusText(status))
	body = append(body, '}')
	_, _ = w.Write(body)
}

func busy(w http.ResponseWriter, message string) {
	w.Header().Set("Retry-After", retryAfterSeconds)
	writeError(w, http.StatusServiceUnavailable, message)
}

// readBody undoes gzip and enforces the byte limit on the decoded body (413 over it).
func readBody(r *http.Request) ([]byte, int, error) {
	if r.ContentLength > maxBodyBytes {
		return nil, http.StatusRequestEntityTooLarge, io.ErrShortBuffer
	}
	var reader io.Reader = r.Body
	if enc := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Encoding"))); enc == "gzip" || enc == "x-gzip" {
		zr, err := gzip.NewReader(r.Body)
		if err != nil {
			return nil, http.StatusBadRequest, err
		}
		defer zr.Close()
		reader = zr
	} else if enc != "" && enc != "identity" {
		return nil, http.StatusUnsupportedMediaType, io.ErrNoProgress
	}
	body, err := io.ReadAll(io.LimitReader(reader, maxBodyBytes+1))
	if err != nil {
		return nil, http.StatusBadRequest, err
	}
	if len(body) > maxBodyBytes {
		return nil, http.StatusRequestEntityTooLarge, io.ErrShortBuffer
	}
	return body, 0, nil
}

func (s *IngestServer) ingest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusNotFound, "Cannot "+r.Method+" "+r.URL.Path)
		return
	}
	streamName := strings.TrimPrefix(r.URL.Path, ingestPath)
	body, status, err := readBody(r)
	if err != nil {
		switch status {
		case http.StatusRequestEntityTooLarge:
			writeError(w, status, "request entity too large")
		case http.StatusUnsupportedMediaType:
			writeError(w, status, "unsupported content encoding")
		default:
			writeError(w, http.StatusBadRequest, "body is not readable: "+err.Error())
		}
		return
	}
	var stream Table
	switch streamName {
	case "logs":
		stream = TableLogs
	case "spans":
		stream = TableSpans
	default:
		writeError(w, http.StatusBadRequest, "unknown stream "+streamName)
		return
	}
	if s.inflight.Load() >= s.maxInflight || s.writer.Saturated(stream) {
		busy(w, "ingest is busy, retry later")
		return
	}
	envelope, err := s.handler.Parse(body, "http")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if envelope.Stream != stream {
		writeError(w, http.StatusBadRequest, "envelope stream "+envelope.Stream.String()+" posted to /"+streamName)
		return
	}
	s.inflight.Add(1)
	err = s.handler.Write([]*Envelope{envelope})
	s.inflight.Add(-1)
	if err != nil {
		busy(w, "not written: "+err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_, _ = w.Write([]byte(`{"items":` + strconv.Itoa(len(envelope.Items)) + `}`))
}
