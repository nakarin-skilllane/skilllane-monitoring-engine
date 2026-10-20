-- Read-only user for the query API and for AI (mcp-clickhouse). Runs at docker
-- initdb as the admin user `skilllane_monitoring` (CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1).
-- readonly = 2: no writes or DDL, but clients may still send query settings.
CREATE USER IF NOT EXISTS skilllane_monitoring_reader IDENTIFIED WITH sha256_password BY 'skilllane_monitoring_reader'
    SETTINGS readonly = 2, max_execution_time = 30, max_memory_usage = 2000000000, max_result_rows = 100000;
GRANT SELECT ON skilllane_monitoring.* TO skilllane_monitoring_reader;
