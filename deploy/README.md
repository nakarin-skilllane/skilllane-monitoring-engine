# Deploy: skilllane-monitoring on one VM

คู่มือภาษาไทยแบบทำมือทีละคำสั่ง (เตรียม VM, clone, .env, docker build, compose, อัปเดต, แก้ปัญหา): [DEPLOY.md](DEPLOY.md)

ClickHouse + engine + monitor behind Caddy (HTTPS) on a single Ubuntu VM. **Everything is
built on the VM from git**: one script clones this repo, builds the two images there and runs
`docker compose up`. The SDK and its wire contract are the npm package `skilllane-monitoring`
(entry point `skilllane-monitoring/contract`), so no other repo is needed.

```
VM:  git clone skilllane-monitoring-engine
     docker compose build          (Dockerfile.engine, Dockerfile.monitor; pnpm install from npm)
     docker compose up -d          caddy :80/:443 → monitor :3300 → engine :5100 → clickhouse
```

The engine does **not** run a queue: it subscribes to the customer's queue (`LOG_*` in `.env`)
or, with none configured, accepts HTTP ingest only (`POST https://engine.<DOMAIN>/api/ingest/<stream>`
with the bearer token `ENGINE_INGEST_TOKEN`).

| File | Role |
|---|---|
| `setup-vm.sh` | the whole deploy: Docker, firewall, clone/pull the repo, `.env`, build, up. Re-run to update. |
| `push-to-vm.sh` | runs `setup-vm.sh` on the VM over ssh |
| `docker-compose.yml`, `Caddyfile`, `clickhouse-init/`, `clickhouse-config/` | what runs; `clickhouse-config/storage-s3.xml` moves log / span parts older than 14 days to S3 when `CLICKHOUSE_S3_*` is set in `.env` (optional) |
| `Dockerfile.engine`, `Dockerfile.monitor` | the images; build context = this repo's root (`.dockerignore` there) |
| `.env.example` | every setting; `setup-vm.sh` turns it into `.env` with random secrets |
| `build-push.sh` | optional: build on your Mac and push to GHCR, for a VM too small to build |

## Before the first deploy

- **Commit and push this repo.** The VM clones `main`; uncommitted work is not deployed. A new
  contract or SDK change must be published to npm first (`skilllane-monitoring`), then referenced here.
- **Optional: an S3 bucket** (or any S3-compatible store) and a key with read / write / delete on it: log / span
  parts older than 14 days move there (`CLICKHOUSE_S3_*` in `.env`). Without it everything stays on the VM disk.
- **Oracle console**
  1. Instance: VM.Standard.A1.Flex 2 OCPU / 12 GB, Canonical Ubuntu 24.04 (aarch64), boot volume 100 GB,
     your SSH public key, public subnet with a public IPv4.
  2. Security list of the subnet (Networking → VCN → Subnets → security list → Ingress rules):
     `0.0.0.0/0 TCP 80`, `0.0.0.0/0 TCP 443` (optional `UDP 443`). Limit 22 to your IP when you can.
- **DNS**: `A monitor.<DOMAIN> → <public ip>`, `A engine.<DOMAIN> → <public ip>`. Caddy can only get
  certificates once these resolve.

## Deploy

```sh
DOMAIN=example.com deploy/push-to-vm.sh ubuntu@<public ip> -i ~/.ssh/<key>
```

or by hand on the VM:

```sh
ssh -i ~/.ssh/<key> ubuntu@<public ip>
curl -fsSLO https://raw.githubusercontent.com/nakarin-skilllane/skilllane-monitoring-engine/main/deploy/setup-vm.sh   # or scp it
DOMAIN=example.com bash setup-vm.sh
```

The script installs Docker, opens 80/443 in the VM's own iptables (Oracle images reject everything but 22
there), clones the repo into `~/skilllane-monitoring-deploy/`, writes `deploy/.env` with random
passwords, builds the two images (first time 5–10 minutes on 2 OCPU) and starts the stack. It ends by
printing the monitor URL, the admin login and the ingest token for apps.

Private repo: `git clone` asks for GitHub credentials (a PAT with repo read as the password), or add a
deploy key to `~/.ssh` on the VM and pass `ENGINE_REPO` as an ssh URL.

Check:

```sh
curl https://engine.<DOMAIN>/api/health          # {"ok":true,"clickhouse":true,...}
open https://monitor.<DOMAIN>                    # sign in with the printed admin login
```

## Update

Push to `main`, then run the same script again (ssh in, `bash setup-vm.sh`, or `push-to-vm.sh`):
it pulls, rebuilds (cached layers make it quick) and restarts only the containers whose image changed.
`.env` is kept; `IMAGE_TAG` moves to the new commit.

```sh
cd ~/skilllane-monitoring-deploy/skilllane-monitoring-engine/deploy
docker compose logs -f engine caddy
docker compose ps
```

## Local rehearsal (what the VM will do, on your Mac)

Same script, same steps, minus the Docker install and firewall. `DOMAIN` defaults to `localhost`,
so Caddy signs `*.localhost` with its own CA.

```sh
bash deploy/setup-vm.sh                                  # clones main from GitHub into ~/skilllane-monitoring-deploy
curl -k --resolve engine.localhost:443:127.0.0.1 https://engine.localhost/api/health
open https://monitor.localhost                           # accept the certificate warning, sign in
```

To rehearse with uncommitted work, copy the working tree instead of cloning (never on a VM):

```sh
SOURCE=local LOCAL_ENGINE=$PWD WORKDIR=/tmp/skilllane-rehearsal bash deploy/setup-vm.sh
```

Stop and wipe the rehearsal: `cd <WORKDIR>/skilllane-monitoring-engine/deploy && docker compose down -v`.

## Sending logs from an app (no queue)

```sh
LOG_HTTP_URL=https://engine.<DOMAIN>
LOG_HTTP_TOKEN=<ENGINE_INGEST_TOKEN from the VM's .env>
OTEL_SERVICE_NAME=my-api APP_ROLE=api OTEL_ENV=staging
NODE_OPTIONS="--require skilllane-monitoring/register" node dist/main.js
```

With a queue instead: fill the matching `LOG_*` block in `.env` (brokers / URL reachable from the VM,
TLS + auth) and `docker compose up -d engine`.

## Security notes

- Only Caddy publishes ports. ClickHouse (8123/9000) is never exposed; query it through the engine, or
  add a `127.0.0.1:8123:8123` port mapping and reach it over an ssh tunnel.
- Secrets live only in `deploy/.env` on the VM (`chmod 600`, git-ignored). Rotate `ENGINE_INGEST_TOKEN` by
  listing old,new comma-separated, redeploying apps, then removing the old one.
- `ENGINE_CORS_ORIGIN` defaults to `https://monitor.<DOMAIN>`; the engine marks its session cookie
  `Secure` behind Caddy (X-Forwarded-Proto).
- A 4 GB VM: set `CLICKHOUSE_MEMORY_LIMIT=2g ENGINE_MEMORY_LIMIT=1g MONITOR_MEMORY_LIMIT=768m` in `.env`,
  and consider building on your Mac with `build-push.sh` instead.

## Optional: build elsewhere and pull

`deploy/build-push.sh` builds `linux/arm64` images from your working tree and pushes them to
`ghcr.io/nakarin-skilllane/skilllane-monitoring-{engine,monitor}:<git sha>`. On the VM set
`ENGINE_IMAGE`, `MONITOR_IMAGE` and `IMAGE_TAG` in `.env`, `docker login ghcr.io` (read:packages PAT),
then `docker compose pull && docker compose up -d` instead of `build`.
