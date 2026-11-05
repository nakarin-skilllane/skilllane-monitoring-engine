//! Kafka consumer (apps/engine consumers/kafka.consumer.ts): both topics, manual commit after
//! the insert resolved; an insert failure is retried with backoff until it succeeds; a message
//! that is not an envelope is skipped (counted), never retried.

use crate::ingest::{gunzip_if_needed, Ingest};
use crate::mappers::Envelope;
use futures::FutureExt;
use rdkafka::config::ClientConfig;
use rdkafka::consumer::{CommitMode, Consumer, StreamConsumer};
use rdkafka::message::{BorrowedMessage, Message};
use std::time::Duration;

/// The most messages taken from the queue before one write (what has been fetched already).
const BATCH_MAX: usize = 256;
const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

pub struct KafkaConfig {
    pub brokers: String,
    pub group: String,
    pub topics: Vec<String>,
}

pub async fn run(config: KafkaConfig, ingest: Ingest) -> Result<(), String> {
    let consumer: StreamConsumer = ClientConfig::new()
        .set("bootstrap.servers", &config.brokers)
        .set("group.id", &config.group)
        .set("enable.auto.commit", "false")
        .set("enable.auto.offset.store", "false")
        .set("auto.offset.reset", "earliest")
        .set("session.timeout.ms", "30000")
        .set("heartbeat.interval.ms", "3000")
        .set("fetch.message.max.bytes", "2097152")
        .set("queued.max.messages.kbytes", "65536")
        .set("fetch.wait.max.ms", "1000")
        .create()
        .map_err(|e| format!("kafka consumer: {e}"))?;
    let topics: Vec<&str> = config.topics.iter().map(String::as_str).collect();
    consumer.subscribe(&topics).map_err(|e| format!("kafka subscribe: {e}"))?;
    println!("Consuming {} as group {} from {}", config.topics.join(", "), config.group, config.brokers);

    loop {
        let first = match consumer.recv().await {
            Ok(message) => message,
            Err(err) => {
                eprintln!("kafka: {err}");
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
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
                    eprintln!("kafka insert failed (attempt {attempt}), retrying in {delay} ms: {err}");
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                }
            }
        }
        for message in &messages {
            if let Err(err) = consumer.store_offset_from_message(message) {
                eprintln!("kafka store offset: {err}");
            }
        }
        if let Err(err) = consumer.commit_consumer_state(CommitMode::Async) {
            eprintln!("kafka commit: {err}");
        }
    }
}
