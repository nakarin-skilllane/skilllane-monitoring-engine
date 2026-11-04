# The load generator / verifier as a container, so a host with Docker alone can run the benchmark.
# Build context = bench/ (needs load/ and fixture/).
FROM node:20-bookworm-slim
WORKDIR /app
RUN npm install --no-audit --no-fund kafkajs@2.2.4 @clickhouse/client@1.12.0 && npm cache clean --force
COPY load/ /app/load/
COPY fixture/envelopes.jsonl.gz fixture/expected-logs.jsonl.gz fixture/expected-spans.jsonl.gz /app/fixture/
ENV NODE_OPTIONS=--max-old-space-size=3072
ENTRYPOINT ["node"]
