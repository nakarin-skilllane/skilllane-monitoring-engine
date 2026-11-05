# syntax=docker/dockerfile:1
# skilllane-monitoring ingest (Rust). Build from the crate: docker build -t skilllane-monitoring-ingest apps/ingest
# The build stage runs every test (the SDK mask cases included) and fails the build when one fails.
# deploy/Dockerfile.ingest is the production copy of this file (deploy/DEPLOY.md).
FROM rust:1-bookworm AS build
# cmake: librdkafka is built from source and linked statically (zlib and OpenSSL too: ssl-vendored)
RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake libssl-dev pkg-config \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# Dependencies first: cached until Cargo.toml / Cargo.lock change.
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src tests \
 && echo 'pub fn placeholder() {}' > src/lib.rs \
 && echo 'fn main() {}' > src/main.rs \
 && cargo build --release \
 && cargo test --release --no-run \
 && rm -rf src tests
COPY . .
RUN touch src/lib.rs src/main.rs \
 && cargo test --release -- --nocapture --test-threads=1 \
 && cargo build --release \
 && strip target/release/ingest

# No shell in the runtime image: the compose file does the HEALTHCHECK (GET /api/health from another container
# or `curl` on the host), not this Dockerfile.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /src/target/release/ingest /ingest
USER nonroot
ENV ENGINE_PORT=5100 TZ=UTC
EXPOSE 5100
ENTRYPOINT ["/ingest"]
