package main

// Kafka consumer (apps/engine/src/ingest/consumers/kafka.consumer.ts): group
// BENCH_CONSUMER_GROUP on both topics, one goroutine per assigned partition.
// Offsets are committed only after ClickHouse accepted the batch's rows; an
// insert failure is retried inside the batch until it succeeds or the
// partition is revoked. A message that is not an envelope is skipped (counted).
// Backpressure: a partition goroutine blocks in Writer.Enqueue while a table is
// full, which stalls the poll loop (the consumer pauses).

import (
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

type topicPartition struct {
	topic     string
	partition int32
}

type partitionConsumer struct {
	cl        *kgo.Client
	tp        topicPartition
	handler   *Handler
	quit      chan struct{}
	done      chan struct{}
	batches   chan kgo.FetchTopicPartition
	quitOnce  sync.Once
	partition string
}

type KafkaConsumer struct {
	cl        *kgo.Client
	handler   *Handler
	topics    [2]string
	group     string
	consumers map[topicPartition]*partitionConsumer

	lagMu sync.Mutex
	lag   map[topicPartition]int64

	cancel context.CancelFunc
	done   chan struct{}
}

func NewKafkaConsumer(cfg *Config, handler *Handler) (*KafkaConsumer, error) {
	c := &KafkaConsumer{
		handler:   handler,
		topics:    [2]string{cfg.TopicLogs, cfg.TopicSpans},
		group:     cfg.ConsumerGroup,
		consumers: map[topicPartition]*partitionConsumer{},
		lag:       map[topicPartition]int64{},
		done:      make(chan struct{}),
	}
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(cfg.KafkaBrokers...),
		kgo.ClientID("bench-ingest-go"),
		kgo.ConsumerGroup(cfg.ConsumerGroup),
		kgo.ConsumeTopics(c.topics[0], c.topics[1]),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
		kgo.DisableAutoCommit(),
		kgo.BlockRebalanceOnPoll(),
		kgo.OnPartitionsAssigned(c.assigned),
		kgo.OnPartitionsRevoked(c.revoked),
		kgo.OnPartitionsLost(c.revoked),
		kgo.FetchMaxBytes(20<<20),
		kgo.FetchMaxPartitionBytes(2<<20),
		kgo.FetchMaxWait(time.Second),
		kgo.SessionTimeout(30*time.Second),
		kgo.HeartbeatInterval(3*time.Second),
		kgo.AllowAutoTopicCreation(),
		kgo.WithLogger(kgo.BasicLogger(os.Stdout, kgo.LogLevelWarn, nil)),
	)
	if err != nil {
		return nil, err
	}
	c.cl = cl
	return c, nil
}

func (c *KafkaConsumer) Start() {
	ctx, cancel := context.WithCancel(context.Background())
	c.cancel = cancel
	go c.poll(ctx)
	log.Printf("Consuming %s as group %s", strings.Join(c.topics[:], ", "), c.group)
}

func (c *KafkaConsumer) Stop() {
	c.cancel()
	<-c.done
	c.cl.Close() // revokes the partitions: every running batch finishes and commits
}

func (c *KafkaConsumer) poll(ctx context.Context) {
	defer close(c.done)
	for {
		fetches := c.cl.PollRecords(ctx, 10_000)
		if fetches.IsClientClosed() || ctx.Err() != nil {
			return
		}
		fetches.EachError(func(topic string, partition int32, err error) {
			log.Printf("[warn] fetch %s[%d]: %v", topic, partition, err)
		})
		fetches.EachPartition(func(p kgo.FetchTopicPartition) {
			if len(p.Records) == 0 {
				return
			}
			tp := topicPartition{p.Topic, p.Partition}
			pc := c.consumers[tp]
			if pc == nil {
				return
			}
			last := p.Records[len(p.Records)-1].Offset
			c.lagMu.Lock()
			c.lag[tp] = max(p.HighWatermark-(last+1), 0)
			c.lagMu.Unlock()
			select {
			case pc.batches <- p:
			case <-ctx.Done():
			}
		})
		c.cl.AllowRebalance()
	}
}

// Lag: sum of (high watermark - next offset) per topic, from the last fetch of every partition.
func (c *KafkaConsumer) Lag() string {
	c.lagMu.Lock()
	defer c.lagMu.Unlock()
	var sums [2]int64
	for tp, lag := range c.lag {
		for i, topic := range c.topics {
			if tp.topic == topic {
				sums[i] += lag
			}
		}
	}
	return fmt.Sprintf("%s=%d %s=%d", c.topics[0], sums[0], c.topics[1], sums[1])
}

func (c *KafkaConsumer) assigned(_ context.Context, cl *kgo.Client, assigned map[string][]int32) {
	for topic, partitions := range assigned {
		for _, partition := range partitions {
			tp := topicPartition{topic, partition}
			pc := &partitionConsumer{
				cl:        cl,
				tp:        tp,
				handler:   c.handler,
				quit:      make(chan struct{}),
				done:      make(chan struct{}),
				batches:   make(chan kgo.FetchTopicPartition),
				partition: topic + "[" + strconv.Itoa(int(partition)) + "]",
			}
			c.consumers[tp] = pc
			go pc.consume()
		}
	}
}

func (c *KafkaConsumer) revoked(_ context.Context, _ *kgo.Client, revoked map[string][]int32) {
	var wait []*partitionConsumer
	for topic, partitions := range revoked {
		for _, partition := range partitions {
			tp := topicPartition{topic, partition}
			if pc := c.consumers[tp]; pc != nil {
				pc.stop()
				wait = append(wait, pc)
				delete(c.consumers, tp)
			}
			c.lagMu.Lock()
			delete(c.lag, tp)
			c.lagMu.Unlock()
		}
	}
	for _, pc := range wait {
		<-pc.done
	}
}

func (pc *partitionConsumer) stop() {
	pc.quitOnce.Do(func() { close(pc.quit) })
}

func (pc *partitionConsumer) consume() {
	defer close(pc.done)
	for {
		select {
		case <-pc.quit:
			return
		case batch := <-pc.batches:
			if !pc.handle(batch) {
				return
			}
		}
	}
}

var gzipMagic = []byte{0x1f, 0x8b}

// messageBytes undoes a gzip-compressed value (Kafka's own batch compression is undone by the client).
func messageBytes(value []byte) ([]byte, error) {
	if !bytes.HasPrefix(value, gzipMagic) {
		return value, nil
	}
	zr, err := gzip.NewReader(bytes.NewReader(value))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	return io.ReadAll(zr)
}

// handle writes one batch and commits it; false when the partition was revoked meanwhile.
func (pc *partitionConsumer) handle(batch kgo.FetchTopicPartition) bool {
	envelopes := make([]*Envelope, 0, len(batch.Records))
	for _, record := range batch.Records {
		source := "kafka " + pc.partition + "@" + strconv.FormatInt(record.Offset, 10)
		raw, err := messageBytes(record.Value)
		if err != nil {
			pc.handler.stats.messages.Add(1)
			pc.handler.stats.BadEnvelope(source, err)
			continue
		}
		envelope, err := pc.handler.Parse(raw, source)
		if err != nil {
			continue
		}
		envelopes = append(envelopes, envelope)
	}
	if len(envelopes) > 0 {
		for attempt := 1; ; attempt++ {
			select {
			case <-pc.quit:
				return false
			default:
			}
			err := pc.handler.Write(envelopes)
			if err == nil {
				break
			}
			delay := time.Duration(500*(1<<attempt)) * time.Millisecond
			if delay > 15*time.Second {
				delay = 15 * time.Second
			}
			log.Printf("[warn] %s insert failed (attempt %d), retrying in %s: %v", pc.partition, attempt, delay, err)
			select {
			case <-pc.quit:
				return false
			case <-time.After(delay):
			}
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := pc.cl.CommitRecords(ctx, batch.Records...); err != nil {
		log.Printf("[warn] %s commit failed: %v", pc.partition, err)
	}
	return true
}
