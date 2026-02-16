# Two-Environment Strategy: Staging + Production

> **Goal**: Run `develop` → staging and `main` → production on the **same VPS** with full isolation.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  VPS (Ubuntu 22.04, 16GB RAM, NVMe + SATA)             │
│                                                          │
│  ┌─── Production (/opt/getouch/) ───────────────────┐   │
│  │  getouch_ingress → Caddy → getouch_app            │   │
│  │  landing, bot, wa, api                            │   │
│  │  Postgres (NVMe: /opt/getouch/data/postgres)      │   │
│  │  Domains: getouch.co, *.getouch.co                │   │
│  │  Branch: main                                     │   │
│  └───────────────────────────────────────────────────┘   │
│                                                          │
│  ┌─── Staging (/opt/getouch-stg/) ──────────────────┐   │
│  │  stg_ingress → Caddy → stg_app                    │   │
│  │  landing, bot, wa, api                            │   │
│  │  Postgres (SATA: /data/postgres-stg)              │   │
│  │  Domains: stg.getouch.co, *.stg.getouch.co       │   │
│  │  Branch: develop                                  │   │
│  └───────────────────────────────────────────────────┘   │
│                                                          │
│  ┌─── Shared Services ──────────────────────────────┐   │
│  │  Ollama (GPU), Monitoring (Grafana, Prometheus)   │   │
│  └───────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## Key Decisions

| Concern | Production | Staging |
|---------|-----------|---------|
| **Branch** | `main` | `develop` |
| **Base path** | `/opt/getouch/` | `/opt/getouch-stg/` |
| **Domain** | `getouch.co` | `stg.getouch.co` |
| **Subdomains** | `bot.getouch.co` | `bot.stg.getouch.co` |
| **DB storage** | NVMe (`/opt/getouch/data/postgres`) | SATA (`/data/postgres-stg`) |
| **Docker project** | `getouch` | `getouch-stg` |
| **Networks** | `getouch_ingress`, `getouch_app`, `getouch_data` | `stg_ingress`, `stg_app`, `stg_data` |
| **CF Tunnel** | Production token | Staging token |
| **Ollama** | Shared (connected to both `getouch_data` + `stg_data`) | Shared |
| **Monitoring** | Shared (scrapes both envs) | — |
| **Caddy port** | `127.0.0.1:80` | `127.0.0.1:8080` |
| **Postgres port** | 5432 (internal) | 5433 (internal) |

## Directory Layout

```
/opt/getouch/                    # ← PRODUCTION (existing)
├── compose/
│   ├── docker-compose.yml       # Caddy + cloudflared
│   ├── docker-compose.apps.yml
│   ├── docker-compose.db.yml
│   ├── docker-compose.mon.yml
│   └── docker-compose.ollama.yml
├── config/
│   ├── Caddyfile
│   └── init-databases.sql
├── data/
│   ├── postgres/                # NVMe
│   ├── grafana/
│   └── prometheus/
├── env/
│   └── .env
└── services/
    ├── landing/
    ├── bot/
    ├── wa/
    └── api/

/opt/getouch-stg/                # ← STAGING (new)
├── compose/
│   ├── docker-compose.yml
│   ├── docker-compose.apps.yml
│   └── docker-compose.db.yml
├── config/
│   ├── Caddyfile
│   └── init-databases.sql
├── env/
│   └── .env
└── services/
    ├── landing/
    ├── bot/
    ├── wa/
    └── api/

/data/postgres-stg/              # ← STAGING DB on SATA disk
```

## Step 1: Create Docker Networks

```bash
# Production networks (already exist)
# docker network create getouch_ingress
# docker network create getouch_app
# docker network create getouch_data

# Staging networks
docker network create stg_ingress
docker network create stg_app
docker network create stg_data
```

## Step 2: Create Staging Directory Tree

```bash
sudo mkdir -p /opt/getouch-stg/{compose,config,env,services/{landing,bot,wa,api}}
sudo mkdir -p /data/postgres-stg
sudo chown -R deploy:deploy /opt/getouch-stg /data/postgres-stg
```

## Step 3: Staging Compose Files

Copy production compose files and modify:

```bash
cp /opt/getouch/compose/docker-compose.yml    /opt/getouch-stg/compose/
cp /opt/getouch/compose/docker-compose.apps.yml /opt/getouch-stg/compose/
cp /opt/getouch/compose/docker-compose.db.yml   /opt/getouch-stg/compose/
cp /opt/getouch/config/init-databases.sql       /opt/getouch-stg/config/
```

### Key changes in staging compose files:

**docker-compose.yml** (ingress):
```yaml
services:
  caddy:
    # ...
    ports:
      - "127.0.0.1:8080:80"       # Different port from prod
    volumes:
      - /opt/getouch-stg/config/Caddyfile:/etc/caddy/Caddyfile:ro
    networks:
      - stg_ingress
      - stg_app

  cloudflared:
    environment:
      TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN_STG}
    networks:
      - stg_ingress

networks:
  stg_ingress:
    external: true
  stg_app:
    external: true
```

**docker-compose.apps.yml**:
- Change all `container_name:` to add `-stg` suffix (e.g., `landing-stg`)
- Change build context paths to `/opt/getouch-stg/services/...`
- Change networks from `getouch_app`/`getouch_data` to `stg_app`/`stg_data`
- Update env vars to use staging database URLs

**docker-compose.db.yml**:
- `container_name: postgres-stg`
- Volume: `/data/postgres-stg:/var/lib/postgresql/data`
- Network: `stg_data`
- Different POSTGRES_PASSWORD

## Step 4: Staging Caddyfile

```
{
    auto_https off
}

stg.getouch.co:80 {
    reverse_proxy landing:3000
}

bot.stg.getouch.co:80 {
    reverse_proxy bot:3000
}

wa.stg.getouch.co:80 {
    reverse_proxy wa:3000
}

api.stg.getouch.co:80 {
    reverse_proxy api:3000
}
```

> Note: Container names inside the staging compose project won't have `-stg` suffix in their **service names** (only `container_name` gets the suffix). Caddy connects via service name within the compose project.

## Step 5: Staging .env

```bash
# /opt/getouch-stg/env/.env
CLOUDFLARE_TUNNEL_TOKEN_STG=eyJ...staging-tunnel-token
POSTGRES_USER=getouch
POSTGRES_PASSWORD=STAGING_SECRET_PASSWORD
POSTGRES_DB=getouch
DATABASE_URL=postgresql://getouch:STAGING_SECRET_PASSWORD@postgres-stg:5432/getouch
NODE_ENV=staging
TZ=Asia/Kuala_Lumpur
OLLAMA_HOST=ollama          # Shared Ollama
OLLAMA_PORT=11434
OLLAMA_MODEL=qwen2.5:7b
```

## Step 6: Cloudflare Dashboard — Staging Tunnel

1. **CF Zero Trust** → **Tunnels** → **Create a tunnel**
2. Name: `getouch-staging`
3. Copy the tunnel token → save as `CLOUDFLARE_TUNNEL_TOKEN_STG` in staging .env
4. Add public hostnames:
   | Hostname | Service |
   |----------|---------|
   | `stg.getouch.co` | `http://caddy:80` |
   | `bot.stg.getouch.co` | `http://caddy:80` |
   | `wa.stg.getouch.co` | `http://caddy:80` |
   | `api.stg.getouch.co` | `http://caddy:80` |

5. Add CF Access policy for staging domains (restrict to dev team emails)

## Step 7: Connect Ollama to Both Networks

Ollama needs to be accessible from both production and staging app networks:

```bash
# Add staging data network to existing Ollama container
docker network connect stg_data ollama
```

Or update `docker-compose.ollama.yml` to include both networks:

```yaml
services:
  ollama:
    networks:
      - getouch_data
      - stg_data

networks:
  getouch_data:
    external: true
  stg_data:
    external: true
```

## Step 8: Deploy Scripts

### Production deploy (`/opt/getouch/scripts/deploy.sh`)
```bash
#!/bin/bash
set -euo pipefail
cd /opt/getouch/compose
echo "=== Deploying PRODUCTION (main branch) ==="
git -C /opt/getouch/services/landing pull origin main
git -C /opt/getouch/services/bot pull origin main
# ... etc
docker compose -f docker-compose.apps.yml build --no-cache
docker compose -f docker-compose.apps.yml up -d
echo "✅ Production deployed"
```

### Staging deploy (`/opt/getouch-stg/scripts/deploy.sh`)
```bash
#!/bin/bash
set -euo pipefail
cd /opt/getouch-stg/compose
echo "=== Deploying STAGING (develop branch) ==="
git -C /opt/getouch-stg/services/landing pull origin develop
git -C /opt/getouch-stg/services/bot pull origin develop
# ... etc
docker compose -f docker-compose.apps.yml build --no-cache
docker compose -f docker-compose.apps.yml up -d
echo "✅ Staging deployed"
```

## Step 9: Monitoring — Scrape Both Envs

Update Prometheus config to scrape both production and staging services:

```yaml
# prometheus.yml additions
scrape_configs:
  # Production (existing)
  - job_name: 'prod-landing'
    static_configs:
      - targets: ['landing:3000']
        labels:
          env: production

  # Staging
  - job_name: 'stg-landing'
    static_configs:
      - targets: ['landing-stg:3000']
        labels:
          env: staging
```

## Step 10: Git Branch Workflow

```
develop  ──────●──────●──────●──── (staging auto-deploy)
                \              \
main      ──────●──────────────●── (production manual deploy)
```

1. All development happens on `develop` (or feature branches merged to `develop`)
2. Push to `develop` → deploy to staging (manual or webhook)
3. When ready for production: merge `develop` → `main`
4. Push to `main` → deploy to production (manual)

## Safety Guardrails

### 1. Environment indicator in admin UI
Add a visible banner in the landing admin dashboard when `NODE_ENV=staging`:
```javascript
if (process.env.NODE_ENV === 'staging') {
  // Show orange "STAGING" badge in header
}
```

### 2. Database isolation
- Production DB: NVMe at `/opt/getouch/data/postgres` (fast, reliable)
- Staging DB: SATA at `/data/postgres-stg` (disposable, can be wiped)
- **Never cross-connect** — each env has its own postgres container on its own network

### 3. No shared Docker networks between envs
Production and staging Docker networks are completely separate. Only Ollama bridges both (it's stateless for inference).

### 4. DNS safety
Staging uses `*.stg.getouch.co` — completely separate DNS records. No risk of routing staging traffic to production.

### 5. Backup schedule
- **Production**: Daily backup at 2 AM via existing `/opt/getouch/scripts/backup.sh`
- **Staging**: No backup needed (disposable). Can restore from production backup for realistic testing:
  ```bash
  pg_dump -h postgres -U getouch getouch | psql -h postgres-stg -U getouch getouch
  ```

## Resource Budget (16GB RAM)

| Service | Production | Staging | Shared |
|---------|-----------|---------|--------|
| Postgres | ~1-2 GB | ~512 MB | — |
| Caddy | ~50 MB | ~50 MB | — |
| Cloudflared | ~50 MB | ~50 MB | — |
| Landing | ~150 MB | ~150 MB | — |
| Bot | ~200 MB | ~200 MB | — |
| WA | ~200 MB | ~200 MB | — |
| API | ~200 MB | ~200 MB | — |
| Ollama | — | — | ~4 GB |
| Grafana | — | — | ~200 MB |
| Prometheus | — | — | ~500 MB |
| **Total** | ~2.5 GB | ~1.5 GB | ~5 GB |

**Remaining headroom**: ~7 GB — comfortable for both envs running simultaneously.

## Quick Start Commands

```bash
# Start staging (first time)
cd /opt/getouch-stg/compose
source ../env/.env
docker compose -p getouch-stg -f docker-compose.db.yml up -d
docker compose -p getouch-stg -f docker-compose.yml up -d
docker compose -p getouch-stg -f docker-compose.apps.yml up -d

# Stop staging without affecting production
docker compose -p getouch-stg -f docker-compose.apps.yml down
docker compose -p getouch-stg -f docker-compose.yml down

# Status of both environments
docker ps --format "table {{.Names}}\t{{.Status}}" | grep -E "getouch|stg"
```

## Coolify Integration (Future)

Coolify can be added later to automate deployments:

1. Install Coolify on the same VPS (or a separate management server)
2. Add two "servers" pointing to the same VPS
3. Configure two "projects":
   - **getouch-prod**: deploy from `main` branch → `/opt/getouch/`
   - **getouch-stg**: deploy from `develop` branch → `/opt/getouch-stg/`
4. Set up webhooks on GitHub to trigger builds on push

This can also be achieved with simple GitHub Actions + SSH deploy without Coolify.
