//! skilllane-monitoring ingest: HTTP, Kafka, RabbitMQ (and BullMQ through bullmq-bridge) envelopes → ClickHouse,
//! the rows the engine's mappers make (README.md, deploy/DEPLOY.md).

pub mod http;
pub mod ingest;
pub mod js;
pub mod kafka;
pub mod mappers;
pub mod mask;
pub mod spanio;
pub mod stats;
pub mod writer;
pub mod config;
pub mod consumer;
pub mod rabbitmq;
pub mod rowbinary;
