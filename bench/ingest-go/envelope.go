package main

// Message → envelope → rows → Writer (apps/engine/src/ingest/envelope-handler.ts).
// Shared by HTTP and Kafka; Write returns once the rows are inserted (the
// request answers / the offsets commit on it).

import (
	"errors"
	"time"
)

var errNotEnvelope = errors.New("Not an skilllane-monitoring-contract v1 envelope")

type Envelope struct {
	Stream   Table
	Resource *Object
	SentAt   string
	Items    []any
}

// ParseEnvelope: a v1 envelope `{ v: 1, stream, resource, sentAt, items }` or an error.
func ParseEnvelope(raw []byte) (*Envelope, error) {
	if len(raw) == 0 {
		return nil, errors.New("empty message")
	}
	value, err := ParseJSON(raw)
	if err != nil {
		return nil, err
	}
	o, ok := value.(*Object)
	if !ok || o == nil {
		return nil, errNotEnvelope
	}
	if v, _ := o.Get("v"); v != float64(1) {
		return nil, errNotEnvelope
	}
	streamValue, _ := o.Get("stream")
	var stream Table
	switch streamValue {
	case "logs":
		stream = TableLogs
	case "spans":
		stream = TableSpans
	default:
		return nil, errNotEnvelope
	}
	itemsValue, _ := o.Get("items")
	items, ok := itemsValue.([]any)
	if !ok {
		return nil, errNotEnvelope
	}
	resourceValue, _ := o.Get("resource")
	resource, ok := resourceValue.(*Object)
	if !ok || resource == nil {
		return nil, errNotEnvelope
	}
	if name, _ := resource.Get("service.name"); name == nil {
		return nil, errNotEnvelope
	} else if _, isStr := name.(string); !isStr {
		return nil, errNotEnvelope
	}
	sentAt, _ := o.Get("sentAt")
	sentAtText, _ := sentAt.(string)
	return &Envelope{Stream: stream, Resource: resource, SentAt: sentAtText, Items: items}, nil
}

type Handler struct {
	writer *Writer
	stats  *Stats
}

// Parse counts the message and the bad envelope, like the engine's EnvelopeHandler.parse.
func (h *Handler) Parse(raw []byte, source string) (*Envelope, error) {
	h.stats.messages.Add(1)
	envelope, err := ParseEnvelope(raw)
	if err != nil {
		h.stats.BadEnvelope(source, err)
		return nil, err
	}
	return envelope, nil
}

// Write maps the rows of several envelopes and returns once all of them are inserted.
func (h *Handler) Write(envelopes []*Envelope) error {
	var chunks [2][]byte
	var counts [2]int
	for _, e := range envelopes {
		if e.Stream == TableLogs {
			fallbackMs, ok := parseDateJS(e.SentAt)
			if !ok {
				fallbackMs = time.Now().UnixMilli()
			}
			for _, item := range e.Items {
				row, err := mapLog(item, e.Resource, fallbackMs)
				if err != nil {
					h.stats.BadItem("logs", err)
					continue
				}
				chunks[TableLogs] = append(chunks[TableLogs], row...)
				counts[TableLogs]++
			}
		} else {
			for _, item := range e.Items {
				row, err := mapSpan(item, e.Resource)
				if err != nil {
					h.stats.BadItem("spans", err)
					continue
				}
				chunks[TableSpans] = append(chunks[TableSpans], row...)
				counts[TableSpans]++
			}
		}
	}
	if counts[TableSpans] == 0 {
		return h.writer.Enqueue(TableLogs, chunks[TableLogs], counts[TableLogs])
	}
	if counts[TableLogs] == 0 {
		return h.writer.Enqueue(TableSpans, chunks[TableSpans], counts[TableSpans])
	}
	spansDone := make(chan error, 1)
	go func() { spansDone <- h.writer.Enqueue(TableSpans, chunks[TableSpans], counts[TableSpans]) }()
	logsErr := h.writer.Enqueue(TableLogs, chunks[TableLogs], counts[TableLogs])
	spansErr := <-spansDone
	if logsErr != nil {
		return logsErr
	}
	return spansErr
}
