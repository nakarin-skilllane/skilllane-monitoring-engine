# syntax=docker/dockerfile:1
# Build: docker build -t bench-ingest-rust bench/ingest-rust   (from the repo root, no toolchain needed)
FROM rust:1-bookworm AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake libssl-dev pkg-config \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# Dependencies first (librdkafka is built from source here): cached until Cargo.toml / Cargo.lock change.
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src tests \
 && echo 'pub fn placeholder() {}' > src/lib.rs \
 && echo 'fn main() {}' > src/main.rs \
 && cargo build --release --locked \
 && cargo test --release --locked --no-run \
 && rm -rf src tests
COPY . .
RUN touch src/lib.rs src/main.rs \
 && cargo test --release --locked -- --nocapture --test-threads=1 \
 && cargo build --release --locked \
 && strip target/release/ingest-rust

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /src/target/release/ingest-rust /ingest-rust
ENV PORT=5100 TZ=UTC
EXPOSE 5100
ENTRYPOINT ["/ingest-rust"]
