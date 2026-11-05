#!/bin/bash
# Runs once at ClickHouse initdb (empty data dir). The read-only user of the query API
# and of AI (mcp-clickhouse): same grants as clickhouse/users.sql, password from env.
set -euo pipefail

: "${CLICKHOUSE_READER_USER:=skilllane_monitoring_reader}"
: "${CLICKHOUSE_READER_PASSWORD:?CLICKHOUSE_READER_PASSWORD is required}"
: "${CLICKHOUSE_DB:=skilllane_monitoring}"

clickhouse client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --multiquery <<SQL
CREATE USER IF NOT EXISTS ${CLICKHOUSE_READER_USER} IDENTIFIED WITH sha256_password BY '${CLICKHOUSE_READER_PASSWORD}'
    SETTINGS readonly = 2, max_execution_time = 55, max_memory_usage = 2000000000, max_result_rows = 100000, max_threads = 8, max_concurrent_queries_for_user = 16;
GRANT SELECT ON ${CLICKHOUSE_DB}.* TO ${CLICKHOUSE_READER_USER};
ALTER USER ${CLICKHOUSE_READER_USER} SETTINGS readonly = 2, max_execution_time = 55, max_memory_usage = 2000000000, max_result_rows = 100000, max_threads = 8, max_concurrent_queries_for_user = 16;
SQL
echo "[init] reader user ${CLICKHOUSE_READER_USER} ready"
