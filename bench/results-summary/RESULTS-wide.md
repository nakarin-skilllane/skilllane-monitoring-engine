# Ingest benchmark results

Generated 2026-11-05T06:40:24.863Z by bench/load/summarize.mjs. One target at a time, same CPU / memory budget (bench/docker-compose.yml).

## dotnet

image 111 MiB · verify OK

### HTTP

| profile | run | peak rows/s | at conns | req/s | MB/s | p50 | p95 | p99 | CPU avg | CPU max | RSS max |
|---|---|---|---|---|---|---|---|---|---|---|---|
| mixed | 1 | 47,834 | 512 | 1,455.5 | 25.6 | 371.6 | 472.5 | 534.1 | 111% | 226% | 574 MiB |

### Kafka (drain of produced rows)

| run | rows | drain s | rows/s | CPU avg | CPU max | RSS max |
|---|---|---|---|---|---|---|
| 1 | 500,028 | 26.1 | 19,138 | 73% | 163% | 269 MiB |

## go

image 19 MiB · verify OK

### HTTP

| profile | run | peak rows/s | at conns | req/s | MB/s | p50 | p95 | p99 | CPU avg | CPU max | RSS max |
|---|---|---|---|---|---|---|---|---|---|---|---|
| mixed | 1 | 37,416 | 512 | 1,138.6 | 20 | 492.7 | 584.1 | 638.7 | 179% | 300% | 212 MiB |

### Kafka (drain of produced rows)

| run | rows | drain s | rows/s | CPU avg | CPU max | RSS max |
|---|---|---|---|---|---|---|
| 1 | 500,028 | 14.1 | 35,569 | 145% | 259% | 527 MiB |

## node

image 467 MiB · verify OK

### HTTP

| profile | run | peak rows/s | at conns | req/s | MB/s | p50 | p95 | p99 | CPU avg | CPU max | RSS max |
|---|---|---|---|---|---|---|---|---|---|---|---|
| mixed | 1 | 18,538 | 512 | 564.1 | 9.9 | 1,032.9 | 1,087.4 | 1,360.1 | 98% | 132% | 227 MiB |

### Kafka (drain of produced rows)

| run | rows | drain s | rows/s | CPU avg | CPU max | RSS max |
|---|---|---|---|---|---|---|
| 1 | 500,028 | 21.1 | 23,700 | 115% | 147% | 512 MiB |

## rust

image 47 MiB · verify OK

### HTTP

| profile | run | peak rows/s | at conns | req/s | MB/s | p50 | p95 | p99 | CPU avg | CPU max | RSS max |
|---|---|---|---|---|---|---|---|---|---|---|---|
| mixed | 1 | 56,261 | 512 | 1,712 | 30.1 | 323.5 | 378.1 | 426.6 | 102% | 210% | 349 MiB |

### Kafka (drain of produced rows)

| run | rows | drain s | rows/s | CPU avg | CPU max | RSS max |
|---|---|---|---|---|---|---|
| 1 | 500,028 | 26.1 | 19,133 | 40% | 59% | 404 MiB |
