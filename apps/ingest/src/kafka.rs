//! Kafka consumer (apps/engine consumers/kafka.consumer.ts): group ENGINE_CONSUMER_GROUP on both topics,
//! client id / SSL / SASL from LOG_KAFKA_*, the topics created when missing (ENGINE_KAFKA_PARTITIONS),
//! offsets stored and committed only after the insert resolved; an insert failure is retried with backoff
//! until it succeeds or the consumer stops (no commit: the messages come again); a message that is not an
//! envelope is counted and skipped, never retried. `lag` / `pending` read committed offsets against the
//! high watermarks (a few broker round trips; the health endpoint cuts them at 700 ms).

use crate::config::Config;
use crate::consumer::Consumer;
use crate::ingest::{gunzip_if_needed, Ingest};
use crate::mappers::Envelope;
use crate::stats;
use async_trait::async_trait;
use futures::FutureExt;
use rdkafka::admin::{AdminClient, AdminOptions, NewTopic, TopicReplication};
use rdkafka::client::DefaultClientContext;
use rdkafka::config::ClientConfig;
use rdkafka::consumer::{CommitMode, Consumer as _, StreamConsumer};
use rdkafka::message::{BorrowedMessage, Message};
use rdkafka::metadata::Metadata;
use rdkafka::{Offset, TopicPartitionList};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/// The most messages taken from the queue before one write (what has been fetched already).
const BATCH_MAX: usize = 256;
const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const BROKER_TIMEOUT: Duration = Duration::from_secs(10);
/// Per broker call while reading the lag (health gives the whole read 700 ms, the stats line 2 s).
const LAG_TIMEOUT: Duration = Duration::from_millis(1000);
const STOP_TIMEOUT: Duration = Duration::from_secs(30);
const CONTEXT: &str = "KafkaConsumer";

pub fn new(config: &Config, ingest: Ingest) -> Result<Box<dyn Consumer>, String> {
    if config.kafka_brokers.is_empty() {
        return Err("LOG_KAFKA_BROKERS is empty".into());
    }
    let brokers = config.kafka_brokers.join(",");
    let mut client = ClientConfig::new();
    client
        .set("bootstrap.servers", &brokers)
        .set("group.id", &config.consumer_group)
        .set("client.id", &config.kafka_client_id)
        .set("enable.auto.commit", "false")
        .set("enable.auto.offset.store", "false")
        .set("auto.offset.reset", "earliest")
        .set("session.timeout.ms", "30000")
        .set("heartbeat.interval.ms", "3000")
        // kafkajs maxBytesPerPartition 2 MiB / maxBytes 20 MiB / maxWaitTimeInMs 1 s
        .set("fetch.message.max.bytes", "2097152")
        .set("fetch.max.bytes", "20971520")
        .set("queued.max.messages.kbytes", "65536")
        .set("fetch.wait.max.ms", "1000")
        .set("allow.auto.create.topics", "false");
    let protocol = match (config.kafka_ssl, config.kafka_sasl.is_some()) {
        (true, true) => "sasl_ssl",
        (true, false) => "ssl",
        (false, true) => "sasl_plaintext",
        (false, false) => "plaintext",
    };
    client.set("security.protocol", protocol);
    if let Some(sasl) = &config.kafka_sasl {
        client
            .set("sasl.mechanism", sasl.mechanism.to_uppercase())
            .set("sasl.username", &sasl.username)
            .set("sasl.password", &sasl.password);
    }
    Ok(Box::new(KafkaConsumer {
        client,
        brokers,
        group: config.consumer_group.clone(),
        topics: config.topics(),
        partitions: config.kafka_partitions,
        ingest,
        running: Mutex::new(None),
        partition_list: Mutex::new(Vec::new()),
    }))
}

struct Running {
    consumer: Arc<StreamConsumer>,
    task: JoinHandle<()>,
    cancel: CancellationToken,
}

pub struct KafkaConsumer {
    client: ClientConfig,
    brokers: String,
    group: String,
    topics: Vec<String>,
    partitions: i32,
    ingest: Ingest,
    running: Mutex<Option<Running>>,
    /// (topic, partition) of both topics, from the metadata read at start (refreshed when empty): the lag read
    /// then needs no metadata round trip.
    partition_list: Mutex<Vec<(String, i32)>>,
}

#[async_trait]
impl Consumer for KafkaConsumer {
    fn name(&self) -> &'static str {
        "kafka"
    }

    async fn start(&self) -> Result<(), String> {
        if self.running.lock().unwrap().is_some() {
            return Ok(());
        }
        let consumer: StreamConsumer = self.client.create().map_err(|e| format!("kafka consumer: {e}"))?;
        let consumer = Arc::new(consumer);
        // Reachability first (an error here means "not started": the caller retries), then the topics.
        let mut metadata = fetch_metadata(&consumer, BROKER_TIMEOUT).await?;
        let existing: HashSet<String> = metadata.topics().iter().map(|t| t.name().to_string()).collect();
        let missing: Vec<&str> = self.topics.iter().map(String::as_str).filter(|t| !existing.contains(*t)).collect();
        if !missing.is_empty() {
            self.create_topics(&missing).await;
            metadata = fetch_metadata(&consumer, BROKER_TIMEOUT).await?;
        }
        *self.partition_list.lock().unwrap() = partitions_of(&metadata, &self.topics);
        let topics: Vec<&str> = self.topics.iter().map(String::as_str).collect();
        consumer.subscribe(&topics).map_err(|e| format!("kafka subscribe: {e}"))?;
        let cancel = CancellationToken::new();
        let task = tokio::spawn(run(consumer.clone(), self.ingest.clone(), cancel.clone()));
        *self.running.lock().unwrap() = Some(Running { consumer, task, cancel });
        stats::info(CONTEXT, &format!("Consuming {} as group {} from {}", self.topics.join(", "), self.group, self.brokers));
        Ok(())
    }

    async fn stop(&self) {
        let Some(running) = self.running.lock().unwrap().take() else { return };
        running.cancel.cancel();
        // The loop finishes the write and commit in progress (or gives up a retry without committing).
        if tokio::time::timeout(STOP_TIMEOUT, running.task).await.is_err() {
            stats::warn(CONTEXT, "stop: the batch in progress did not finish in 30 s; leaving it uncommitted");
        }
        // Closing leaves the group and may wait for the broker: not on the async runtime.
        let consumer = running.consumer;
        let _ = tokio::task::spawn_blocking(move || drop(consumer)).await;
    }

    async fn lag(&self) -> Option<String> {
        let lags = self.partition_lags().await?;
        if lags.is_empty() {
            return None;
        }
        Some(lags.iter().map(|(topic, partition, lag)| format!("{topic}[{partition}]={lag}")).collect::<Vec<_>>().join(" "))
    }

    async fn pending(&self) -> Option<u64> {
        let lags = self.partition_lags().await?;
        Some(lags.iter().map(|(_, _, lag)| *lag as u64).sum())
    }
}

impl KafkaConsumer {
    /// Another consumer (or the engine) may create them at the same time: a failure is only logged.
    async fn create_topics(&self, missing: &[&str]) {
        let admin: Result<AdminClient<DefaultClientContext>, _> = self.client.create();
        let admin = match admin {
            Ok(admin) => admin,
            Err(err) => {
                stats::warn(CONTEXT, &format!("createTopics {}: {err}", missing.join(", ")));
                return;
            }
        };
        // Replication -1 = the broker's default, like kafkajs without replicationFactor.
        let topics: Vec<NewTopic> = missing.iter().map(|t| NewTopic::new(t, self.partitions, TopicReplication::Fixed(-1))).collect();
        let options = AdminOptions::new().operation_timeout(Some(BROKER_TIMEOUT));
        match admin.create_topics(&topics, &options).await {
            Ok(results) => {
                let failed: Vec<String> = results.iter().filter_map(|r| r.as_ref().err().map(|(t, e)| format!("{t}: {e}"))).collect();
                if failed.is_empty() {
                    stats::info(CONTEXT, &format!("Created topics {} ({} partitions)", missing.join(", "), self.partitions));
                } else {
                    stats::warn(CONTEXT, &format!("createTopics: {}", failed.join("; ")));
                }
            }
            Err(err) => stats::warn(CONTEXT, &format!("createTopics {}: {err}", missing.join(", "))),
        }
    }

    /// (topic, partition, high watermark − committed offset) for every partition of both topics; None while not
    /// started or when the broker does not answer. One committed-offsets round trip; the high watermark comes from
    /// librdkafka's cache (updated by every fetch of an assigned partition, what its own `consumer_lag` uses), with
    /// a broker query only for a partition this consumer is not fetching, run concurrently.
    async fn partition_lags(&self) -> Option<Vec<(String, i32, i64)>> {
        let consumer = self.running.lock().unwrap().as_ref()?.consumer.clone();
        let mut partitions = self.partition_list.lock().unwrap().clone();
        if partitions.is_empty() {
            let (consumer, topics) = (consumer.clone(), self.topics.clone());
            let metadata = tokio::task::spawn_blocking(move || consumer.fetch_metadata(None, LAG_TIMEOUT)).await.ok()?.ok()?;
            partitions = partitions_of(&metadata, &topics);
            if partitions.is_empty() {
                return None;
            }
            *self.partition_list.lock().unwrap() = partitions.clone();
        }
        let committed: Vec<Option<i64>> = {
            let (consumer, partitions) = (consumer.clone(), partitions.clone());
            tokio::task::spawn_blocking(move || {
                let mut wanted = TopicPartitionList::new();
                for (topic, partition) in &partitions {
                    wanted.add_partition(topic, *partition);
                }
                let committed = consumer.committed_offsets(wanted, LAG_TIMEOUT).ok()?;
                Some(
                    partitions
                        .iter()
                        .map(|(topic, partition)| match committed.find_partition(topic, *partition).map(|e| e.offset()) {
                            Some(Offset::Offset(n)) if n >= 0 => Some(n),
                            _ => None,
                        })
                        .collect(),
                )
            })
            .await
            .ok()??
        };
        let reads = partitions.into_iter().zip(committed).map(|((topic, partition), committed)| {
            let consumer = consumer.clone();
            tokio::task::spawn_blocking(move || {
                let (low, high) = match cached_watermarks(&consumer, &topic, partition) {
                    // The low watermark matters only without a commit (the group would start at the beginning).
                    Some((low, high)) if committed.is_some() || low >= 0 => (low, high),
                    _ => consumer.fetch_watermarks(&topic, partition, LAG_TIMEOUT).ok()?,
                };
                Some((topic, partition, (high - committed.unwrap_or(low)).max(0)))
            })
        });
        futures::future::join_all(reads).await.into_iter().map(|read| read.ok()?).collect()
    }
}

/// librdkafka's cached (low, high) watermarks of a partition: set by every fetch response of a partition this
/// consumer fetches, no broker round trip. None before the first fetch or for a partition assigned elsewhere.
fn cached_watermarks(consumer: &StreamConsumer, topic: &str, partition: i32) -> Option<(i64, i64)> {
    let topic = std::ffi::CString::new(topic).ok()?;
    let (mut low, mut high) = (-1001i64, -1001i64);
    // SAFETY: the client handle lives as long as `consumer`; the pointers are to locals of this frame.
    let err = unsafe {
        rdkafka::bindings::rd_kafka_get_watermark_offsets(consumer.client().native_ptr(), topic.as_ptr(), partition, &mut low, &mut high)
    };
    (err == rdkafka::types::RDKafkaRespErr::RD_KAFKA_RESP_ERR_NO_ERROR && high >= 0).then_some((low, high))
}

async fn fetch_metadata(consumer: &Arc<StreamConsumer>, timeout: Duration) -> Result<Metadata, String> {
    let consumer = consumer.clone();
    tokio::task::spawn_blocking(move || consumer.fetch_metadata(None, timeout))
        .await
        .map_err(|e| format!("kafka metadata: {e}"))?
        .map_err(|e| format!("kafka metadata: {e}"))
}

/// (topic, partition) of `topics` in `metadata`.
fn partitions_of(metadata: &Metadata, topics: &[String]) -> Vec<(String, i32)> {
    let mut out = Vec::new();
    for topic in topics {
        if let Some(t) = metadata.topics().iter().find(|t| t.name() == topic) {
            out.extend(t.partitions().iter().map(|p| (topic.clone(), p.id())));
        }
    }
    out
}

async fn run(consumer: Arc<StreamConsumer>, ingest: Ingest, cancel: CancellationToken) {
    loop {
        let first = tokio::select! {
            _ = cancel.cancelled() => return,
            received = consumer.recv() => match received {
                Ok(message) => message,
                Err(err) => {
                    stats::error(CONTEXT, &format!("{err}"));
                    tokio::select! {
                        _ = cancel.cancelled() => return,
                        _ = tokio::time::sleep(Duration::from_millis(500)) => continue,
                    }
                }
            },
        };
        let mut messages: Vec<BorrowedMessage> = vec![first];
        // Whatever else was fetched already goes into the same write.
        while messages.len() < BATCH_MAX {
            match consumer.recv().now_or_never() {
                Some(Ok(message)) => messages.push(message),
                _ => break,
            }
        }
        let mut envelopes: Vec<Envelope> = Vec::with_capacity(messages.len());
        for message in &messages {
            let source = format!("kafka {}[{}]@{}", message.topic(), message.partition(), message.offset());
            let Some(payload) = message.payload() else {
                ingest.stats.messages.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                ingest.stats.bad_envelope(&source, "empty message");
                continue;
            };
            let raw = match gunzip_if_needed(payload, MAX_MESSAGE_BYTES) {
                Ok(raw) => raw,
                Err(err) => {
                    ingest.stats.messages.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    ingest.stats.bad_envelope(&source, &err);
                    continue;
                }
            };
            if let Ok(envelope) = ingest.parse(&raw, &source) {
                envelopes.push(envelope);
            }
        }
        let mut attempt = 0u32;
        loop {
            match ingest.write(&envelopes).await {
                Ok(()) => break,
                Err(err) => {
                    attempt += 1;
                    let delay = (500u64 * 2u64.pow(attempt.min(5))).min(15_000);
                    stats::warn(CONTEXT, &format!("insert failed (attempt {attempt}), retrying in {delay} ms: {err}"));
                    tokio::select! {
                        // Stopping: nothing committed, the batch comes again after the restart.
                        _ = cancel.cancelled() => return,
                        _ = tokio::time::sleep(Duration::from_millis(delay)) => {}
                    }
                }
            }
        }
        for message in &messages {
            if let Err(err) = consumer.store_offset_from_message(message) {
                stats::warn(CONTEXT, &format!("store offset: {err}"));
            }
        }
        if let Err(err) = consumer.commit_consumer_state(CommitMode::Async) {
            stats::warn(CONTEXT, &format!("commit: {err}"));
        }
    }
}
