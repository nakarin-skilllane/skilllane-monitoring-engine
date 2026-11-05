# syntax=docker/dockerfile:1
# bench-ingest-dotnet: build + mask test in the SDK image; runtime = runtime-deps chiseled with a
# self-contained, trimmed build (default, PUBLISH_MODE=trimmed) or a Native AOT binary (PUBLISH_MODE=aot).
#   docker build -t bench-ingest-dotnet bench/ingest-dotnet
#   docker build --build-arg PUBLISH_MODE=aot -t bench-ingest-dotnet bench/ingest-dotnet
ARG DOTNET_VERSION=10.0

FROM mcr.microsoft.com/dotnet/sdk:${DOTNET_VERSION} AS build
ARG TARGETARCH
ARG PUBLISH_MODE=trimmed
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
# Native AOT needs a C toolchain for the final link
RUN if [ "$PUBLISH_MODE" = "aot" ]; then apt-get update && apt-get install -y --no-install-recommends clang zlib1g-dev && rm -rf /var/lib/apt/lists/*; fi
WORKDIR /src
COPY src/Ingest/Ingest.csproj src/Ingest/
COPY tests/Ingest.Tests/Ingest.Tests.csproj tests/Ingest.Tests/
RUN case "$TARGETARCH" in amd64) RID=linux-x64 ;; arm64) RID=linux-arm64 ;; *) RID=linux-$TARGETARCH ;; esac && echo "$RID" > /rid \
 && dotnet restore tests/Ingest.Tests/Ingest.Tests.csproj \
 && if [ "$PUBLISH_MODE" = "aot" ]; then dotnet restore src/Ingest/Ingest.csproj -r "$RID" -p:PublishAot=true; \
    else dotnet restore src/Ingest/Ingest.csproj -r "$RID" -p:PublishTrimmed=true; fi
COPY . .
# The mask test: every required case of mask-cases.json must match the SDK bit for bit, or the build fails here.
RUN dotnet test tests/Ingest.Tests -c Release --no-restore --logger "console;verbosity=normal" \
 && cat tests/Ingest.Tests/bin/Release/net10.0/mask-coverage.txt
RUN RID=$(cat /rid) && if [ "$PUBLISH_MODE" = "aot" ]; then \
      dotnet publish src/Ingest -c Release -r "$RID" --no-restore -p:PublishAot=true -p:TrimMode=full -p:OptimizationPreference=Speed -p:StripSymbols=true -o /app; \
    else \
      dotnet publish src/Ingest -c Release -r "$RID" --no-restore --self-contained -p:PublishTrimmed=true -p:TrimMode=partial -o /app; \
    fi \
 && rm -f /app/*.dbg /app/*.pdb && ls -la /app

FROM mcr.microsoft.com/dotnet/runtime-deps:${DOTNET_VERSION}-noble-chiseled
WORKDIR /app
COPY --from=build /app /app
ENV PORT=5100 \
    CLICKHOUSE_URL=http://localhost:8123 \
    CLICKHOUSE_DATABASE=skilllane_monitoring \
    ENGINE_FLUSH_MS=1000 \
    ENGINE_FLUSH_ROWS=5000 \
    ENGINE_INGEST_MAX_INFLIGHT=64 \
    DOTNET_gcServer=1 \
    DOTNET_TieredPGO=1
EXPOSE 5100
USER app
ENTRYPOINT ["/app/Ingest"]
