//! RabbitMQ consumer (apps/engine consumers/rabbitmq.consumer.ts): asserts the durable direct exchange and one
//! durable queue per stream (bound with routing key = queue name), prefetch ENGINE_CONCURRENCY per consumer.
//! ack after the insert · nack + requeue (after a 1 s pause) when the insert failed · nack without requeue for a
//! message that is not an envelope (counted, never retried). Reconnects with backoff when the connection or the
//! channel closes.

use crate::config::Config;
use crate::consumer::Consumer;
use crate::ingest::{gunzip_if_needed, Ingest};
use async_trait::async_trait;
use futures::StreamExt;
use lapin::message::Delivery;
use lapin::options::{
    BasicAckOptions, BasicCancelOptions, BasicConsumeOptions, BasicNackOptions, BasicQosOptions, ExchangeDeclareOptions,
    QueueBindOptions, QueueDeclareOptions,
};
use lapin::types::FieldTable;
use lapin::uri::AMQPUri;
use lapin::{Channel, Connection, ConnectionProperties, ExchangeKind};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::task::JoinHandle;
use tokio_util::task::TaskTracker;

/// Pause before a failed insert's message goes back to the queue (the engine's NACK_DELAY_MS).
const NACK_DELAY: Duration = Duration::from_secs(1);
/// Reconnect backoff: 1 s doubling up to this.
/// The engine's cap (rabbitmq.consumer.ts): 1 s, 2 s, 4 s … 15 s between attempts.
const RECONNECT_MAX: Duration = Duration::from_secs(15);
/// Longest a cancelled consumer may take to drain before the channel is closed anyway.
const CANCEL_WAIT: Duration = Duration::from_secs(5);
const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const CONNECTION_NAME: &str = "skilllane-monitoring-ingest";

pub fn new(config: &Config, ingest: Ingest) -> Result<Box<dyn Consumer>, String> {
    let url = config.rabbitmq_url.clone().ok_or_else(|| "LOG_RABBITMQ_URL is empty".to_string())?;
    Ok(Box::new(RabbitmqConsumer(Arc::new(Inner {
        url,
        exchange: config.rabbitmq_exchange.clone(),
        queues: config.topics(),
        prefetch: config.concurrency.min(u16::MAX as usize) as u16,
        ingest,
        live: Mutex::new(None),
        generation: AtomicU64::new(0),
        deliveries: TaskTracker::new(),
        stopping: AtomicBool::new(false),
        reconnecting: AtomicBool::new(false),
        reconnect_task: Mutex::new(None),
    }))))
}

pub struct RabbitmqConsumer(Arc<Inner>);

/// One connection + channel with its consumers; replaced on every (re)connect.
struct Live {
    generation: u64,
    connection: Connection,
    channel: Channel,
    tags: Vec<String>,
    loops: Vec<JoinHandle<()>>,
}

struct Inner {
    url: String,
    exchange: String,
    queues: Vec<String>,
    prefetch: u16,
    ingest: Ingest,
    live: Mutex<Option<Live>>,
    /// Bumped by every connect, so a consumer loop of an older connection cannot trigger a reconnect.
    generation: AtomicU64,
    /// Deliveries being handled (parse → insert → ack/nack): the engine's `inflight` set.
    deliveries: TaskTracker,
    stopping: AtomicBool,
    reconnecting: AtomicBool,
    reconnect_task: Mutex<Option<JoinHandle<()>>>,
}

fn err_text(err: &lapin::Error) -> String {
    err.to_string()
}

impl Inner {
    fn stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    fn channel(&self) -> Option<Channel> {
        let live = self.live.lock().unwrap();
        live.as_ref().filter(|l| l.channel.status().connected()).map(|l| l.channel.clone())
    }

    async fn connect(self: &Arc<Self>) -> Result<(), String> {
        // amqplib (the engine) reads `amqp://host/` as the vhost `/`; lapin reads it as the vhost ``.
        let mut uri: AMQPUri = self.url.parse().map_err(|e| format!("LOG_RABBITMQ_URL: {e}"))?;
        if uri.vhost.is_empty() {
            uri.vhost = "/".to_string();
        }
        let properties = ConnectionProperties::default().with_connection_name(CONNECTION_NAME.into());
        let connection = Connection::connect_uri(uri, properties).await.map_err(|e| format!("connect: {}", err_text(&e)))?;
        connection.on_error(|err| eprintln!("rabbitmq connection error: {err}"));
        let (channel, tags, loops, generation) = match self.setup(&connection).await {
            Ok(parts) => parts,
            Err(err) => {
                let _ = connection.close(200, "setup failed").await;
                return Err(err);
            }
        };
        let previous = self.live.lock().unwrap().replace(Live { generation, connection, channel, tags, loops });
        if let Some(previous) = previous {
            previous.discard().await;
        }
        println!("Consuming {} (exchange {}, prefetch {})", self.queues.join(", "), self.exchange, self.prefetch);
        Ok(())
    }

    /// Channel, exchange, queues, bindings, prefetch and the consumers on a fresh connection.
    async fn setup(self: &Arc<Self>, connection: &Connection) -> Result<(Channel, Vec<String>, Vec<JoinHandle<()>>, u64), String> {
        let channel = connection.create_channel().await.map_err(|e| format!("channel: {}", err_text(&e)))?;
        channel
            .exchange_declare(
                &self.exchange,
                ExchangeKind::Direct,
                ExchangeDeclareOptions { durable: true, ..Default::default() },
                FieldTable::default(),
            )
            .await
            .map_err(|e| format!("assert exchange {}: {}", self.exchange, err_text(&e)))?;
        for queue in &self.queues {
            channel
                .queue_declare(queue, QueueDeclareOptions { durable: true, ..Default::default() }, FieldTable::default())
                .await
                .map_err(|e| format!("assert queue {queue}: {}", err_text(&e)))?;
            channel
                .queue_bind(queue, &self.exchange, queue, QueueBindOptions::default(), FieldTable::default())
                .await
                .map_err(|e| format!("bind queue {queue}: {}", err_text(&e)))?;
        }
        // Per consumer (global = false): each queue may hold this many unacked messages.
        channel
            .basic_qos(self.prefetch, BasicQosOptions { global: false })
            .await
            .map_err(|e| format!("prefetch: {}", err_text(&e)))?;

        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let mut tags = Vec::with_capacity(self.queues.len());
        let mut loops = Vec::with_capacity(self.queues.len());
        for queue in &self.queues {
            let consumer = channel
                .basic_consume(queue, "", BasicConsumeOptions::default(), FieldTable::default())
                .await
                .map_err(|e| format!("consume {queue}: {}", err_text(&e)))?;
            tags.push(consumer.tag().to_string());
            loops.push(tokio::spawn(self.clone().consume_loop(queue.clone(), consumer, generation)));
        }
        Ok((channel, tags, loops, generation))
    }

    /// Pulls the deliveries of one queue; each one is handled on its own task so `prefetch` of them overlap.
    /// The stream ends when the consumer is cancelled (stop) or the channel / connection is gone (reconnect).
    async fn consume_loop(self: Arc<Self>, queue: String, mut consumer: lapin::Consumer, generation: u64) {
        while let Some(next) = consumer.next().await {
            match next {
                Ok(delivery) => {
                    let me = self.clone();
                    self.deliveries.spawn(async move { me.on_delivery(delivery).await });
                }
                Err(err) => {
                    // A connection-level error was logged by `on_error` already (the channel is gone with it).
                    if !self.stopping() && self.channel().is_some() {
                        eprintln!("rabbitmq consumer of {queue}: {err}");
                    }
                    break;
                }
            }
        }
        if self.stopping() {
            return;
        }
        let current = self.live.lock().unwrap().as_ref().map(|l| l.generation);
        if current == Some(generation) {
            self.reconnect();
        }
    }

    /// One reconnect loop at a time (the other queue's loop ends on the same close): 1 s, 2 s, 4 s … up to
    /// RECONNECT_MAX between attempts, until connected or stopping.
    fn reconnect(self: &Arc<Self>) {
        if self.reconnecting.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return;
        }
        eprintln!("rabbitmq connection or channel closed; reconnecting");
        let me = self.clone();
        let task = tokio::spawn(async move {
            let stale = me.live.lock().unwrap().take();
            if let Some(stale) = stale {
                stale.discard().await;
            }
            let mut attempt: u32 = 0;
            while !me.stopping() {
                attempt += 1;
                let delay = Duration::from_secs(1 << (attempt - 1).min(5)).min(RECONNECT_MAX);
                tokio::time::sleep(delay).await;
                if me.stopping() {
                    break;
                }
                match me.connect().await {
                    Ok(()) => {
                        println!("rabbitmq reconnected after {attempt} attempt(s)");
                        break;
                    }
                    Err(err) => eprintln!("rabbitmq reconnect attempt {attempt} failed: {err}"),
                }
            }
            me.reconnecting.store(false, Ordering::SeqCst);
        });
        *self.reconnect_task.lock().unwrap() = Some(task);
    }

    /// Parse → insert → ack; the routing key is the queue name (the engine's `rabbitmq <routingKey>` source).
    async fn on_delivery(&self, delivery: Delivery) {
        let source = format!("rabbitmq {}", delivery.routing_key.as_str());
        let raw = match gunzip_if_needed(&delivery.data, MAX_MESSAGE_BYTES) {
            Ok(raw) => raw,
            Err(err) => {
                self.ingest.stats.messages.fetch_add(1, Ordering::Relaxed);
                self.ingest.stats.bad_envelope(&source, &err);
                settle(delivery.acker.nack(BasicNackOptions { multiple: false, requeue: false }).await);
                return;
            }
        };
        let envelope = match self.ingest.parse(&raw, &source) {
            Ok(envelope) => envelope,
            // Counted by parse; never retried.
            Err(_) => return settle(delivery.acker.nack(BasicNackOptions { multiple: false, requeue: false }).await),
        };
        match self.ingest.write(&[envelope]).await {
            Ok(()) => settle(delivery.acker.ack(BasicAckOptions::default()).await),
            Err(_) => {
                // The writer logged the failure; redeliver after a short pause.
                tokio::time::sleep(NACK_DELAY).await;
                settle(delivery.acker.nack(BasicNackOptions { multiple: false, requeue: true }).await);
            }
        }
    }
}

/// ack/nack on a channel that died fails; the broker redelivers those messages anyway.
fn settle(result: lapin::Result<()>) {
    let _ = result;
}

impl Live {
    /// Cancels the consumers and waits for their loops to end (every error ignored: the connection may
    /// already be gone).
    async fn cancel(&mut self) {
        for tag in &self.tags {
            let _ = self.channel.basic_cancel(tag, BasicCancelOptions::default()).await;
        }
        let drained = futures::future::join_all(std::mem::take(&mut self.loops));
        let _ = tokio::time::timeout(CANCEL_WAIT, drained).await;
    }

    async fn close(self) {
        let _ = self.channel.close(200, "closing").await;
        let _ = self.connection.close(200, "closing").await;
    }

    async fn discard(mut self) {
        self.cancel().await;
        self.close().await;
    }
}

#[async_trait]
impl Consumer for RabbitmqConsumer {
    fn name(&self) -> &'static str {
        "rabbitmq"
    }

    async fn start(&self) -> Result<(), String> {
        self.0.connect().await
    }

    async fn stop(&self) {
        let inner = &self.0;
        inner.stopping.store(true, Ordering::SeqCst);
        let reconnect = inner.reconnect_task.lock().unwrap().take();
        if let Some(task) = reconnect {
            task.abort();
            let _ = task.await;
        }
        let mut live = inner.live.lock().unwrap().take();
        if let Some(live) = live.as_mut() {
            live.cancel().await;
        }
        // Deliveries in progress finish (ack / nack) before the channel closes.
        inner.deliveries.close();
        inner.deliveries.wait().await;
        if let Some(live) = live {
            live.close().await;
        }
    }

    async fn lag(&self) -> Option<String> {
        let channel = self.0.channel()?;
        let mut parts = Vec::with_capacity(self.0.queues.len());
        for queue in &self.0.queues {
            let ready = ready_count(&channel, queue).await?;
            parts.push(format!("{queue}={ready} ready"));
        }
        Some(parts.join(" "))
    }

    /// Ready messages in the queues plus deliveries not yet acked.
    async fn pending(&self) -> Option<u64> {
        let channel = self.0.channel()?;
        let mut total = self.0.deliveries.len() as u64;
        for queue in &self.0.queues {
            total += ready_count(&channel, queue).await? as u64;
        }
        Some(total)
    }
}

/// Messages ready in `queue` (passive declare, the engine's `checkQueue`).
async fn ready_count(channel: &Channel, queue: &str) -> Option<u32> {
    channel
        .queue_declare(queue, QueueDeclareOptions { passive: true, ..Default::default() }, FieldTable::default())
        .await
        .ok()
        .map(|q| q.message_count())
}
