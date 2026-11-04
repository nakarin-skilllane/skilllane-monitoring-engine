# bench/ingest-go: build from the repo root with
#   docker build -t bench-ingest-go bench/ingest-go
# The build stage runs the mask test (testdata/mask-cases.json) and fails the
# image when a required case fails. The runtime image is distroless static.

FROM golang:1.23-bookworm AS build
WORKDIR /src
ENV CGO_ENABLED=0 GOFLAGS=-trimpath
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go vet ./... \
 && go test -count=1 -run 'TestMaskCases' -v . \
 && go build -ldflags='-s -w' -o /out/ingest .

FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/ingest /ingest
ENV PORT=5100
EXPOSE 5100
USER nonroot:nonroot
ENTRYPOINT ["/ingest"]
