-- skilllane-monitoring telemetry schema (ClickHouse 25.8). Idempotent: the engine runs every
-- statement on boot (ENGINE_APPLY_SCHEMA=true) and docker runs it at initdb.
-- Statements end with ";" at the end of a line; split on that when applying.
-- Retention per env: prod/production 90 d logs · 14 d spans; staging/uat 30 d · 7 d;
-- anything else (dev, local) 7 d · 3 d. RED aggregates keep 90 d for every env.

CREATE DATABASE IF NOT EXISTS skilllane_monitoring;

-- One row per log line: the flat ECS record written by skilllane-monitoring.
CREATE TABLE IF NOT EXISTS skilllane_monitoring.logs
(
    `timestamp`         DateTime64(3, 'UTC') CODEC(Delta(8), ZSTD(1)),
    `env`               LowCardinality(String),
    `service`           LowCardinality(String),
    `role`              LowCardinality(String),
    `version`           LowCardinality(String),
    `host`              LowCardinality(String),
    `level`             LowCardinality(String),
    `logger`            LowCardinality(String),
    `event_code`        LowCardinality(String),
    `event_module`      LowCardinality(String),
    `message`           String CODEC(ZSTD(1)),
    `trace_id`          String CODEC(ZSTD(1)),
    `span_id`           String CODEC(ZSTD(1)),
    `correlation_id`    String CODEC(ZSTD(1)),
    `user_id`           String CODEC(ZSTD(1)),
    `user_roles`        Array(LowCardinality(String)),
    `organization_id`   String CODEC(ZSTD(1)),
    `http_method`       LowCardinality(String),
    `http_route`        LowCardinality(String),
    `url_path`          String CODEC(ZSTD(1)),
    `url_domain`        LowCardinality(String),
    `http_status`       UInt16,
    `duration_ms`       Nullable(Float64),
    `error_type`        LowCardinality(String),
    `error_code`        LowCardinality(String),
    `error_message`     String CODEC(ZSTD(1)),
    `error_hint`        LowCardinality(String),
    `error_hint_detail` String CODEC(ZSTD(1)),
    `error_fix`         String CODEC(ZSTD(1)),
    `error_stack`       String CODEC(ZSTD(3)),
    `error_cause`       String CODEC(ZSTD(3)),
    `error_category`    LowCardinality(String),
    `error_target`      String CODEC(ZSTD(1)),
    `origin_function`   LowCardinality(String),
    `origin_file`       LowCardinality(String),
    `usecase`           LowCardinality(String),
    `failed_step`       LowCardinality(String),
    `db_statement`      String CODEC(ZSTD(3)),
    `dependency_type`   LowCardinality(String),
    `dependency_name`   LowCardinality(String),
    `dependency_host`   LowCardinality(String),
    `dependency_port`   UInt16,
    `job_queue`         LowCardinality(String),
    `job_type`          LowCardinality(String),
    `job_id`            String CODEC(ZSTD(1)),
    `job_attempt`       UInt16,
    `job_max_attempts`  UInt16,
    `job_final`         UInt8,
    `job_inflight`      Array(String),
    `reason`            LowCardinality(String),
    `labels`            Map(LowCardinality(String), String),
    `fields`            Map(LowCardinality(String), String),
    -- Groups the same error across lines (Errors page). 0 = not an error line.
    `error_fingerprint` UInt64 MATERIALIZED if(
        event_code != 'http.request'
          AND (error_type != '' OR error_hint != '' OR level IN ('error', 'fatal')),
        cityHash64(env, service, error_type, error_code, error_hint, origin_function,
                   if(error_type = '' AND error_hint = '', concat(logger, ':', message), '')),
        0),
    `ingested_at`       DateTime64(3, 'UTC') DEFAULT now64(3),
    INDEX idx_trace_id trace_id TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_user_id user_id TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_fingerprint error_fingerprint TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_message lower(message) TYPE ngrambf_v1(3, 65536, 2, 0) GRANULARITY 1,
    INDEX idx_error_message lower(error_message) TYPE ngrambf_v1(3, 65536, 2, 0) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(timestamp)
ORDER BY (env, toStartOfHour(timestamp), service, level, timestamp)
TTL addDays(toDateTime(timestamp), multiIf(env IN ('prod', 'production'), 90, env IN ('staging', 'uat'), 30, 7));

-- One row per finished span.
CREATE TABLE IF NOT EXISTS skilllane_monitoring.spans
(
    `timestamp`         DateTime64(6, 'UTC') CODEC(Delta(8), ZSTD(1)),
    `duration_ns`       UInt64,
    `env`               LowCardinality(String),
    `service`           LowCardinality(String),
    `role`              LowCardinality(String),
    `version`           LowCardinality(String),
    `host`              LowCardinality(String),
    `trace_id`          String CODEC(ZSTD(1)),
    `span_id`           String CODEC(ZSTD(1)),
    `parent_span_id`    String CODEC(ZSTD(1)),
    -- 1 = first span of this service in the trace: no parent, or a remote parent.
    `is_entry`          UInt8,
    `name`              LowCardinality(String),
    `kind`              LowCardinality(String),
    `status_code`       LowCardinality(String),
    `status_message`    String CODEC(ZSTD(1)),
    `scope_name`        LowCardinality(String),
    `http_method`       LowCardinality(String),
    `http_route`        LowCardinality(String),
    `http_status`       UInt16,
    `url_path`          String CODEC(ZSTD(1)),
    `db_system`         LowCardinality(String),
    `db_statement`      String CODEC(ZSTD(3)),
    `peer`              LowCardinality(String),
    `exception_type`    LowCardinality(String),
    `exception_message` String CODEC(ZSTD(1)),
    `attributes`        Map(LowCardinality(String), String),
    `resource`          Map(LowCardinality(String), String),
    `events`            String CODEC(ZSTD(3)),
    -- Captured I/O (the monitor's Network view), masked by the SDK; moved out of `attributes`
    -- by the ingest so queries that read the attributes map stay cheap. '' / 0 when not captured.
    `url_query`          String CODEC(ZSTD(3)),
    `req_headers`        String CODEC(ZSTD(3)),
    `res_headers`        String CODEC(ZSTD(3)),
    `req_body`           String CODEC(ZSTD(3)),
    `res_body`           String CODEC(ZSTD(3)),
    `req_body_size`      UInt64 CODEC(ZSTD(3)),
    `res_body_size`      UInt64 CODEC(ZSTD(3)),
    `req_body_truncated` UInt8 CODEC(ZSTD(3)),
    `res_body_truncated` UInt8 CODEC(ZSTD(3)),
    `db_params`          String CODEC(ZSTD(3)),
    `db_statement_full`  String CODEC(ZSTD(3)),
    `msg_body`           String CODEC(ZSTD(3)),
    `msg_headers`        String CODEC(ZSTD(3)),
    `msg_body_size`      UInt64 CODEC(ZSTD(3)),
    `msg_body_truncated` UInt8 CODEC(ZSTD(3)),
    -- Counted at ingest, so the trace view's sizes never read the JSON above.
    `req_header_count`   UInt16 CODEC(ZSTD(3)),
    `res_header_count`   UInt16 CODEC(ZSTD(3)),
    `db_param_count`     UInt16 CODEC(ZSTD(3)),
    `ingested_at`       DateTime64(3, 'UTC') DEFAULT now64(3),
    INDEX idx_trace_id trace_id TYPE bloom_filter(0.001) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(timestamp)
ORDER BY (env, toStartOfHour(timestamp), service, is_entry, name, timestamp)
TTL addDays(toDateTime(timestamp), multiIf(env IN ('prod', 'production'), 14, env IN ('staging', 'uat'), 7, 3));

-- The captured I/O columns for a spans table created before 18 Oct 2026 (same place as in the
-- CREATE above; metadata only, old rows read '' / 0). A no-op on a table created from it.
ALTER TABLE skilllane_monitoring.spans
    ADD COLUMN IF NOT EXISTS `url_query`          String CODEC(ZSTD(3)) AFTER `events`,
    ADD COLUMN IF NOT EXISTS `req_headers`        String CODEC(ZSTD(3)) AFTER `url_query`,
    ADD COLUMN IF NOT EXISTS `res_headers`        String CODEC(ZSTD(3)) AFTER `req_headers`,
    ADD COLUMN IF NOT EXISTS `req_body`           String CODEC(ZSTD(3)) AFTER `res_headers`,
    ADD COLUMN IF NOT EXISTS `res_body`           String CODEC(ZSTD(3)) AFTER `req_body`,
    ADD COLUMN IF NOT EXISTS `req_body_size`      UInt64 CODEC(ZSTD(3)) AFTER `res_body`,
    ADD COLUMN IF NOT EXISTS `res_body_size`      UInt64 CODEC(ZSTD(3)) AFTER `req_body_size`,
    ADD COLUMN IF NOT EXISTS `req_body_truncated` UInt8 CODEC(ZSTD(3)) AFTER `res_body_size`,
    ADD COLUMN IF NOT EXISTS `res_body_truncated` UInt8 CODEC(ZSTD(3)) AFTER `req_body_truncated`,
    ADD COLUMN IF NOT EXISTS `db_params`          String CODEC(ZSTD(3)) AFTER `res_body_truncated`,
    ADD COLUMN IF NOT EXISTS `db_statement_full`  String CODEC(ZSTD(3)) AFTER `db_params`,
    ADD COLUMN IF NOT EXISTS `msg_body`           String CODEC(ZSTD(3)) AFTER `db_statement_full`,
    ADD COLUMN IF NOT EXISTS `msg_headers`        String CODEC(ZSTD(3)) AFTER `msg_body`,
    ADD COLUMN IF NOT EXISTS `msg_body_size`      UInt64 CODEC(ZSTD(3)) AFTER `msg_headers`,
    ADD COLUMN IF NOT EXISTS `msg_body_truncated` UInt8 CODEC(ZSTD(3)) AFTER `msg_body_size`,
    ADD COLUMN IF NOT EXISTS `req_header_count`   UInt16 CODEC(ZSTD(3)) AFTER `msg_body_truncated`,
    ADD COLUMN IF NOT EXISTS `res_header_count`   UInt16 CODEC(ZSTD(3)) AFTER `req_header_count`,
    ADD COLUMN IF NOT EXISTS `db_param_count`     UInt16 CODEC(ZSTD(3)) AFTER `res_header_count`;

-- trace id → time range, so a trace opens without scanning every partition.
CREATE TABLE IF NOT EXISTS skilllane_monitoring.trace_index
(
    `trace_id`    String,
    `day`         Date,
    `env`         LowCardinality(String),
    `start_ts`    SimpleAggregateFunction(min, DateTime64(6, 'UTC')),
    `end_ts`      SimpleAggregateFunction(max, DateTime64(6, 'UTC')),
    `span_count`  SimpleAggregateFunction(sum, UInt64),
    `error_count` SimpleAggregateFunction(sum, UInt64),
    `services`    SimpleAggregateFunction(groupUniqArrayArray, Array(String))
)
ENGINE = AggregatingMergeTree
PARTITION BY day
ORDER BY (trace_id, day, env)
TTL day + INTERVAL 14 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS skilllane_monitoring.trace_index_mv TO skilllane_monitoring.trace_index AS
SELECT
    trace_id,
    toDate(timestamp) AS day,
    env,
    min(timestamp) AS start_ts,
    max(timestamp + toIntervalMicrosecond(intDiv(duration_ns, 1000))) AS end_ts,
    count() AS span_count,
    countIf(status_code = 'ERROR') AS error_count,
    groupUniqArray(toString(service)) AS services
FROM skilllane_monitoring.spans
GROUP BY trace_id, day, env;

-- RED per route per minute, from entry spans (replaces span-metrics).
CREATE TABLE IF NOT EXISTS skilllane_monitoring.route_stats_1m
(
    `minute`          DateTime('UTC'),
    `env`             LowCardinality(String),
    `service`         LowCardinality(String),
    `role`            LowCardinality(String),
    `kind`            LowCardinality(String),
    `route`           LowCardinality(String),
    `requests`        SimpleAggregateFunction(sum, UInt64),
    `errors`          SimpleAggregateFunction(sum, UInt64),
    `duration_sum_ms` SimpleAggregateFunction(sum, Float64),
    `duration_max_ms` SimpleAggregateFunction(max, Float64),
    `duration_q`      AggregateFunction(quantilesTDigest(0.5, 0.95, 0.99), Float64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(minute)
ORDER BY (env, service, role, kind, route, minute)
TTL minute + INTERVAL 90 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS skilllane_monitoring.route_stats_1m_mv TO skilllane_monitoring.route_stats_1m AS
SELECT
    toStartOfMinute(toDateTime(timestamp)) AS minute,
    env,
    service,
    role,
    kind,
    if(http_route != '', concat(http_method, ' ', http_route), name) AS route,
    count() AS requests,
    countIf(status_code = 'ERROR' OR http_status >= 500) AS errors,
    sum(duration_ns / 1e6) AS duration_sum_ms,
    max(duration_ns / 1e6) AS duration_max_ms,
    quantilesTDigestState(0.5, 0.95, 0.99)(duration_ns / 1e6) AS duration_q
FROM skilllane_monitoring.spans
WHERE is_entry = 1
GROUP BY minute, env, service, role, kind, route;
