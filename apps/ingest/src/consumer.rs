//! What every queue consumer implements (apps/engine consumers/consumer.ts): started after ClickHouse answers,
//! stopped in order on SIGTERM (stop consuming → the writer flushes → close), and asked for its backlog by the
//! health endpoint and the stats line. One instance per process; `kafka`, `rabbitmq` and `bullmq` each give one.
//!
//! Semantics shared by all three (the engine's): a message is acked / committed / completed only after
//! `Ingest::write` resolved (the rows are in ClickHouse); an insert failure is retried / requeued, never dropped
//! (at-least-once); a message that is not a v1 envelope is counted (`Stats::bad_envelope`) and skipped, never
//! retried. Back-pressure: `Ingest::write` waits while the writer is at its high-water mark.

use async_trait::async_trait;

#[async_trait]
pub trait Consumer: Send + Sync {
    /// `kafka` / `rabbitmq` / `bullmq` (the stats line and the health `transport`).
    fn name(&self) -> &'static str;

    /// Connects and starts consuming; returns once consuming is running (the loop goes on in the background).
    /// An error means "not started": the caller retries with backoff (IngestService.startWithRetry).
    async fn start(&self) -> Result<(), String>;

    /// Stops taking new messages, lets the deliveries in progress finish (their inserts and acks), closes.
    async fn stop(&self);

    /// Cheap human-readable backlog for the stats line (`lag 0=12 1=0 2=3`, `queue=5 ready`), None when unknown.
    async fn lag(&self) -> Option<String>;

    /// Messages not yet in ClickHouse: Kafka lag, RabbitMQ ready + unacked, BullMQ waiting jobs. None when the
    /// queue cannot be read. Must answer quickly or be cut by the caller (health gives it 700 ms).
    async fn pending(&self) -> Option<u64>;
}
