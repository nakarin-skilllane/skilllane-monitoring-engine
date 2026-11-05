//! Every setting the engine's ingest reads (apps/engine/src/config.ts), same names and defaults, so one `.env`
//! serves both processes. Read once at start (`Config::from_env`).

use std::env;

/// Where the values come from: the process environment, or a map in tests.
pub struct Env<'a>(pub &'a dyn Fn(&str) -> Option<String>);

impl Env<'_> {
    fn str(&self, name: &str) -> Option<String> {
        (self.0)(name).map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
    }
    fn str_or(&self, name: &str, default: &str) -> String {
        self.str(name).unwrap_or_else(|| default.to_string())
    }
    /// The engine's `int()`: a positive number, else the default.
    fn num_or(&self, name: &str, default: u64) -> u64 {
        self.str(name).and_then(|v| v.parse::<u64>().ok()).filter(|v| *v > 0).unwrap_or(default)
    }
    /// The engine's `bool()`: set = anything but `false` / `0` / `no` / `off` (case-insensitive); unset = default.
    fn bool_or(&self, name: &str, default: bool) -> bool {
        match self.str(name).map(|v| v.to_lowercase()) {
            Some(v) => !matches!(v.as_str(), "false" | "0" | "no" | "off"),
            None => default,
        }
    }
    fn list(&self, name: &str) -> Vec<String> {
        self.str_or(name, "").split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect()
    }
}

/// LOG_EXPORT resolved like the SDK's `resolveExportMode` (contract): an explicit mode, else the first of
/// Kafka / RabbitMQ / BullMQ / HTTP / OTLP whose env is set, else `stdout`. Only the first three have a consumer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    Kafka,
    Rabbitmq,
    Bullmq,
    Http,
    Otlp,
    Stdout,
}

impl Transport {
    /// The mode string (health `transport`, the start line).
    pub fn name(self) -> &'static str {
        match self {
            Transport::Kafka => "kafka",
            Transport::Rabbitmq => "rabbitmq",
            Transport::Bullmq => "bullmq",
            Transport::Http => "http",
            Transport::Otlp => "otlp",
            Transport::Stdout => "stdout",
        }
    }

    pub fn parse(text: &str) -> Option<Transport> {
        match text {
            "kafka" => Some(Transport::Kafka),
            "rabbitmq" => Some(Transport::Rabbitmq),
            "bullmq" => Some(Transport::Bullmq),
            "http" => Some(Transport::Http),
            "otlp" => Some(Transport::Otlp),
            "stdout" => Some(Transport::Stdout),
            _ => None,
        }
    }

    /// A queue this process consumes.
    pub fn has_consumer(self) -> bool {
        matches!(self, Transport::Kafka | Transport::Rabbitmq | Transport::Bullmq)
    }
}

/// The wire format of the ClickHouse inserts (CLICKHOUSE_INSERT_FORMAT).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum InsertFormat {
    /// One JSON object per line, `date_time_input_format=best_effort`: what the engine sends.
    #[default]
    JsonEachRow,
    /// RowBinary with the column list (rowbinary.rs): no JSON parsing on the server.
    RowBinary,
}

impl InsertFormat {
    pub fn name(self) -> &'static str {
        match self {
            InsertFormat::JsonEachRow => "jsoneachrow",
            InsertFormat::RowBinary => "rowbinary",
        }
    }
}

/// LOG_KAFKA_SASL_MECHANISM as the engine accepts it (`plain`, `scram-sha-256`, `scram-sha-512`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KafkaSasl {
    pub mechanism: String,
    pub username: String,
    pub password: String,
}

#[derive(Clone, Debug)]
pub struct Config {
    /// ENGINE_PORT, else PORT (5100).
    pub port: u16,
    pub clickhouse_url: String,
    pub clickhouse_user: String,
    pub clickhouse_password: String,
    pub clickhouse_database: String,
    /// LOG_EXPORT; `transport_invalid` = the raw value when it was not a mode (logged once, like the engine).
    pub transport: Transport,
    pub transport_invalid: Option<String>,
    pub topic_logs: String,
    pub topic_spans: String,
    // ---- HTTP ingest ----
    pub ingest_http: bool,
    /// ENGINE_INGEST_TOKEN split on `,`, trimmed, empty dropped.
    pub ingest_tokens: Vec<String>,
    pub ingest_max_bytes: usize,
    pub ingest_max_inflight: usize,
    // ---- writer ----
    pub flush_ms: u64,
    pub flush_rows: usize,
    /// ENGINE_INSERT_INFLIGHT (1 = one insert in flight per table, the engine's behaviour).
    pub insert_inflight: usize,
    /// ENGINE_ASYNC_INSERT: ClickHouse async inserts (`async_insert=1&wait_for_async_insert=1`, the server
    /// batches the inserts of every ingest; the answer still waits for the rows to be on disk). Default off.
    pub async_insert: bool,
    /// CLICKHOUSE_INSERT_FORMAT: `jsoneachrow` (default, the engine's) or `rowbinary` (rowbinary.rs).
    pub insert_format: InsertFormat,
    // ---- consumers ----
    pub concurrency: usize,
    pub consumer_group: String,
    pub kafka_brokers: Vec<String>,
    pub kafka_client_id: String,
    pub kafka_ssl: bool,
    pub kafka_sasl: Option<KafkaSasl>,
    /// ENGINE_KAFKA_PARTITIONS: partitions given to a topic this process has to create (default 3).
    pub kafka_partitions: i32,
    pub rabbitmq_url: Option<String>,
    pub rabbitmq_exchange: String,
    pub bullmq_redis_url: Option<String>,
    pub bullmq_prefix: String,
}

impl Config {
    pub fn from_env() -> Config {
        Config::from_lookup(&|name| env::var(name).ok())
    }

    /// The config from any source of values (tests pass a map).
    pub fn from_lookup(get: &dyn Fn(&str) -> Option<String>) -> Config {
        let env = Env(get);
        let explicit = env.str("LOG_EXPORT").map(|v| v.to_lowercase());
        let (transport, transport_invalid) = match explicit.as_deref().and_then(Transport::parse) {
            Some(mode) => (mode, None),
            None => {
                let auto = if env.str("LOG_KAFKA_BROKERS").is_some() {
                    Transport::Kafka
                } else if env.str("LOG_RABBITMQ_URL").is_some() {
                    Transport::Rabbitmq
                } else if env.str("LOG_BULLMQ_REDIS_URL").is_some() {
                    Transport::Bullmq
                } else if env.str("LOG_HTTP_URL").is_some() {
                    Transport::Http
                } else if env.str("OTEL_EXPORTER_ENDPOINT").is_some() {
                    Transport::Otlp
                } else {
                    Transport::Stdout
                };
                (auto, explicit)
            }
        };
        let kafka_sasl = env.str("LOG_KAFKA_SASL_MECHANISM")
            .map(|m| m.to_lowercase())
            .filter(|m| matches!(m.as_str(), "plain" | "scram-sha-256" | "scram-sha-512"))
            .map(|mechanism| KafkaSasl {
                mechanism,
                username: env.str_or("LOG_KAFKA_SASL_USERNAME", ""),
                password: env.str_or("LOG_KAFKA_SASL_PASSWORD", ""),
            });
        Config {
            port: env.str("ENGINE_PORT").or_else(|| env.str("PORT")).and_then(|v| v.parse().ok()).filter(|p| *p > 0).unwrap_or(5100),
            clickhouse_url: env.str_or("CLICKHOUSE_URL", "http://localhost:8123"),
            clickhouse_user: env.str_or("CLICKHOUSE_USER", "skilllane_monitoring"),
            clickhouse_password: env.str_or("CLICKHOUSE_PASSWORD", "skilllane_monitoring"),
            clickhouse_database: env.str_or("CLICKHOUSE_DATABASE", "skilllane_monitoring"),
            transport,
            transport_invalid,
            topic_logs: env.str_or("LOG_TOPIC_LOGS", "skilllane-monitoring.logs"),
            topic_spans: env.str_or("LOG_TOPIC_SPANS", "skilllane-monitoring.spans"),
            ingest_http: env.bool_or("ENGINE_INGEST_HTTP", true),
            ingest_tokens: env.list("ENGINE_INGEST_TOKEN"),
            ingest_max_bytes: env.num_or("ENGINE_INGEST_MAX_BYTES", 2_000_000) as usize,
            ingest_max_inflight: env.num_or("ENGINE_INGEST_MAX_INFLIGHT", 64) as usize,
            flush_ms: env.num_or("ENGINE_FLUSH_MS", 1000),
            flush_rows: env.num_or("ENGINE_FLUSH_ROWS", 5000) as usize,
            insert_inflight: env.num_or("ENGINE_INSERT_INFLIGHT", 1) as usize,
            async_insert: env.bool_or("ENGINE_ASYNC_INSERT", false),
            insert_format: match env.str("CLICKHOUSE_INSERT_FORMAT").map(|v| v.to_lowercase()).as_deref() {
                Some("rowbinary") => InsertFormat::RowBinary,
                _ => InsertFormat::JsonEachRow,
            },
            concurrency: env.num_or("ENGINE_CONCURRENCY", 50) as usize,
            consumer_group: env.str_or("ENGINE_CONSUMER_GROUP", "skilllane-monitoring-engine"),
            kafka_brokers: env.list("LOG_KAFKA_BROKERS"),
            kafka_client_id: env.str_or("LOG_KAFKA_CLIENT_ID", "skilllane-monitoring-engine"),
            kafka_ssl: env.bool_or("LOG_KAFKA_SSL", false),
            kafka_sasl,
            kafka_partitions: env.num_or("ENGINE_KAFKA_PARTITIONS", 3).min(i32::MAX as u64) as i32,
            rabbitmq_url: env.str("LOG_RABBITMQ_URL"),
            rabbitmq_exchange: env.str_or("LOG_RABBITMQ_EXCHANGE", "skilllane-monitoring.telemetry"),
            bullmq_redis_url: env.str("LOG_BULLMQ_REDIS_URL"),
            bullmq_prefix: env.str_or("LOG_BULLMQ_PREFIX", "bull"),
        }
    }

    pub fn topics(&self) -> Vec<String> {
        vec![self.topic_logs.clone(), self.topic_spans.clone()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn config(pairs: &[(&str, &str)]) -> Config {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Config::from_lookup(&|name| map.get(name).cloned())
    }

    #[test]
    fn defaults_are_the_engines() {
        let c = config(&[]);
        assert_eq!(c.port, 5100);
        assert_eq!(c.transport, Transport::Stdout);
        assert_eq!(c.transport_invalid, None);
        assert!(c.ingest_http && c.ingest_tokens.is_empty());
        assert_eq!((c.ingest_max_bytes, c.ingest_max_inflight), (2_000_000, 64));
        assert_eq!((c.flush_ms, c.flush_rows, c.insert_inflight, c.concurrency), (1000, 5000, 1, 50));
        assert!(!c.async_insert);
        assert!(config(&[("ENGINE_ASYNC_INSERT", "1")]).async_insert);
        assert_eq!(c.insert_format, InsertFormat::JsonEachRow);
        assert_eq!(config(&[("CLICKHOUSE_INSERT_FORMAT", "RowBinary")]).insert_format, InsertFormat::RowBinary);
        assert_eq!(config(&[("CLICKHOUSE_INSERT_FORMAT", "csv")]).insert_format, InsertFormat::JsonEachRow);
        assert_eq!(c.clickhouse_password, "skilllane_monitoring");
        assert_eq!(c.consumer_group, "skilllane-monitoring-engine");
        assert_eq!(c.kafka_partitions, 3);
    }

    #[test]
    fn export_mode_resolves_like_the_sdk() {
        assert_eq!(config(&[("LOG_EXPORT", " Kafka ")]).transport, Transport::Kafka);
        let auto = config(&[("LOG_RABBITMQ_URL", "amqp://x")]);
        assert_eq!((auto.transport, auto.transport_invalid), (Transport::Rabbitmq, None));
        let invalid = config(&[("LOG_EXPORT", "nats"), ("LOG_KAFKA_BROKERS", "k:9092")]);
        assert_eq!((invalid.transport, invalid.transport_invalid.as_deref()), (Transport::Kafka, Some("nats")));
        assert_eq!(config(&[("LOG_HTTP_URL", "http://x")]).transport, Transport::Http);
        assert!(!Transport::Http.has_consumer() && Transport::Bullmq.has_consumer());
    }

    #[test]
    fn bool_int_and_lists_follow_the_engine() {
        assert!(!config(&[("ENGINE_INGEST_HTTP", "OFF")]).ingest_http);
        assert!(config(&[("ENGINE_INGEST_HTTP", "yes")]).ingest_http);
        assert!(config(&[("ENGINE_INGEST_HTTP", "maybe")]).ingest_http, "anything but false/0/no/off is true");
        assert_eq!(config(&[("ENGINE_FLUSH_ROWS", "0")]).flush_rows, 5000, "0 is not positive: default");
        assert_eq!(config(&[("ENGINE_FLUSH_ROWS", "x")]).flush_rows, 5000);
        assert_eq!(config(&[("ENGINE_INGEST_TOKEN", " a , ,b")]).ingest_tokens, vec!["a", "b"]);
        assert_eq!(config(&[("LOG_KAFKA_BROKERS", "k1:9092, k2:9092")]).kafka_brokers, vec!["k1:9092", "k2:9092"]);
        let sasl = config(&[("LOG_KAFKA_SASL_MECHANISM", "SCRAM-SHA-512"), ("LOG_KAFKA_SASL_USERNAME", "u")]).kafka_sasl.unwrap();
        assert_eq!((sasl.mechanism.as_str(), sasl.username.as_str(), sasl.password.as_str()), ("scram-sha-512", "u", ""));
        assert!(config(&[("LOG_KAFKA_SASL_MECHANISM", "gssapi")]).kafka_sasl.is_none());
    }
}
