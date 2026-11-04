package main

// bench/ingest-go: a stand-alone port of the engine's ingest hot path
// (HTTP + Kafka → mask → map → ClickHouse JSONEachRow). See README.md.

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type Config struct {
	Port               string
	ClickHouseURL      string
	ClickHouseUser     string
	ClickHousePassword string
	ClickHouseDatabase string
	KafkaBrokers       []string
	ConsumerGroup      string
	TopicLogs          string
	TopicSpans         string
	FlushMs            int
	FlushRows          int
	MaxInflight        int
}

func envOr(name, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return fallback
}

func envInt(name string, fallback int) int {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
		log.Printf("[warn] %s=%q is not a positive integer; using %d", name, v, fallback)
	}
	return fallback
}

func loadConfig() *Config {
	cfg := &Config{
		Port:               envOr("PORT", "5100"),
		ClickHouseURL:      strings.TrimRight(envOr("CLICKHOUSE_URL", "http://localhost:8123"), "/"),
		ClickHouseUser:     os.Getenv("CLICKHOUSE_USER"),
		ClickHousePassword: os.Getenv("CLICKHOUSE_PASSWORD"),
		ClickHouseDatabase: envOr("CLICKHOUSE_DATABASE", "skilllane_monitoring"),
		ConsumerGroup:      envOr("BENCH_CONSUMER_GROUP", "bench-go"),
		TopicLogs:          envOr("LOG_KAFKA_TOPIC_LOGS", "skilllane-monitoring.logs"),
		TopicSpans:         envOr("LOG_KAFKA_TOPIC_SPANS", "skilllane-monitoring.spans"),
		FlushMs:            envInt("ENGINE_FLUSH_MS", 1000),
		FlushRows:          envInt("ENGINE_FLUSH_ROWS", 5000),
		MaxInflight:        envInt("ENGINE_INGEST_MAX_INFLIGHT", 64),
	}
	for _, b := range strings.Split(os.Getenv("LOG_KAFKA_BROKERS"), ",") {
		if b = strings.TrimSpace(b); b != "" {
			cfg.KafkaBrokers = append(cfg.KafkaBrokers, b)
		}
	}
	return cfg
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	cfg := loadConfig()
	stats := NewStats()
	writer := NewWriter(cfg, stats)
	handler := &Handler{writer: writer, stats: stats}

	server := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           (&IngestServer{handler: handler, writer: writer, maxInflight: int64(cfg.MaxInflight)}).Routes(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      90 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	go func() {
		log.Printf("HTTP ingest on :%s (flush %d rows / %d ms, max inflight %d, ClickHouse %s/%s)",
			cfg.Port, cfg.FlushRows, cfg.FlushMs, cfg.MaxInflight, cfg.ClickHouseURL, cfg.ClickHouseDatabase)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("HTTP server: %v", err)
		}
	}()

	var kafka *KafkaConsumer
	if len(cfg.KafkaBrokers) > 0 {
		var err error
		kafka, err = NewKafkaConsumer(cfg, handler)
		if err != nil {
			log.Fatalf("Kafka client: %v", err)
		}
		kafka.Start()
	} else {
		log.Printf("LOG_KAFKA_BROKERS is empty: no Kafka consumer")
	}

	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				lag := ""
				if kafka != nil {
					lag = kafka.Lag()
				}
				log.Print(stats.Line(writer.Buffered(), lag))
			case <-stop:
				return
			}
		}
	}()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	sig := <-signals
	log.Printf("%s: shutting down", sig)
	close(stop)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
	if kafka != nil {
		kafka.Stop()
	}
	writer.Close()
	log.Print(stats.Line(writer.Buffered(), ""))
}
