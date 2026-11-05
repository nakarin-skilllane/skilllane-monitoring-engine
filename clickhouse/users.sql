-- Read-only user for the query API and for AI (mcp-clickhouse). Runs at docker
-- initdb as the admin user `skilllane_monitoring` (CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1).
-- readonly = 2: no writes or DDL, but clients may still send query settings. max_execution_time 55 s ends a query
-- just before the engine's 60 s client timeout; max_threads 8 keeps one page from taking every core of a shared
-- box; 16 concurrent queries per user bounds a burst of auto-refreshing tabs. An existing user: the ALTER below.
CREATE USER IF NOT EXISTS skilllane_monitoring_reader IDENTIFIED WITH sha256_password BY 'skilllane_monitoring_reader'
    SETTINGS readonly = 2, max_execution_time = 55, max_memory_usage = 2000000000, max_result_rows = 100000, max_threads = 8, max_concurrent_queries_for_user = 16;
GRANT SELECT ON skilllane_monitoring.* TO skilllane_monitoring_reader;
ALTER USER skilllane_monitoring_reader SETTINGS readonly = 2, max_execution_time = 55, max_memory_usage = 2000000000, max_result_rows = 100000, max_threads = 8, max_concurrent_queries_for_user = 16;
