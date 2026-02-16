# Dual Postgres Instance Setup

> Production on NVMe (`postgres`) + Staging on SATA SSD (`postgres-ssd`)

## Why Two Instances

| Concern | Solution |
|---------|----------|
| Staging data shouldn't pollute production | Separate Postgres instances |
| SATA SSD has 938 GB — ideal for staging | `postgres-ssd` stores data on `/data/postgres-ssd` |
| NVMe is faster — keep production performant | Existing `postgres` stays on NVMe |
| Isolation | Different containers, same Docker network for service access |

## Architecture

```
┌─────────────────────────────────────────────────┐
│  VPS (NVMe + SATA SSD)                         │
│                                                  │
│  ┌── postgres (Production) ──────────────────┐  │
│  │  Container: postgres                       │  │
│  │  Data: /opt/getouch/data/postgres (NVMe)  │  │
│  │  Port: 5432 (internal only)               │  │
│  │  DBs: getouch, getouch_bot,               │  │
│  │       getouch_wa, getouch_api             │  │
│  │  Network: getouch_data                    │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  ┌── postgres-ssd (Staging) ─────────────────┐  │
│  │  Container: postgres-ssd                   │  │
│  │  Data: /data/postgres-ssd (SATA SSD)      │  │
│  │  Port: 127.0.0.1:5433 → 5432             │  │
│  │  DBs: getouch, getouch_bot_stg,          │  │
│  │       getouch_wa_stg, getouch_api_stg    │  │
│  │  Network: getouch_data                    │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  Production services → postgres:5432            │
│  Staging services   → postgres-ssd:5432         │
└─────────────────────────────────────────────────┘
```

## Volume Mounts

| Instance | Host Path | Disk | Purpose |
|----------|-----------|------|---------|
| `postgres` | `/opt/getouch/data/postgres` | NVMe (466 GB) | Production data |
| `postgres-ssd` | `/data/postgres-ssd` | SATA SSD (938 GB) | Staging data |

## Port Mapping

| Instance | Host Port | Container Port | Binding |
|----------|-----------|---------------|---------|
| `postgres` | none (internal) | 5432 | Docker network only |
| `postgres-ssd` | `127.0.0.1:5433` | 5432 | Localhost only (for debugging/pgAdmin) |

> **No public port exposure** for either instance.

## Deployment (Phase 1: Non-Destructive)

### Prerequisites

```bash
# 1. Create the SATA data directory
sudo mkdir -p /data/postgres-ssd
sudo chown 999:999 /data/postgres-ssd    # postgres user UID in Alpine image

# 2. Copy init SQL
sudo cp /opt/getouch/config/init-databases-staging.sql /opt/getouch/config/
```

### Start postgres-ssd

```bash
cd /opt/getouch/compose

# Start staging Postgres (production is untouched)
docker compose -f docker-compose.db-staging.yml --env-file .env up -d

# Verify
docker ps | grep postgres-ssd
docker exec postgres-ssd pg_isready -U getouch
```

### Verify

```bash
bash /opt/getouch/scripts/verify-dual-postgres.sh
```

## Staging Service Configuration

Set these env vars for staging services:

```env
DATABASE_URL=postgresql://getouch:$POSTGRES_STG_PASSWORD@postgres-ssd:5432/getouch
DATABASE_URL_BOT=postgresql://getouch:$POSTGRES_STG_PASSWORD@postgres-ssd:5432/getouch_bot_stg
DATABASE_URL_WA=postgresql://getouch:$POSTGRES_STG_PASSWORD@postgres-ssd:5432/getouch_wa_stg
DATABASE_URL_API=postgresql://getouch:$POSTGRES_STG_PASSWORD@postgres-ssd:5432/getouch_api_stg
```

## pgAdmin

Add a second server connection:

1. Open https://db.getouch.co
2. Add Server:
   - **Name**: `Staging (SATA) - postgres-ssd`
   - **Host**: `postgres-ssd`
   - **Port**: `5432`
   - **Username**: `getouch`
   - **Password**: (value of `POSTGRES_STG_PASSWORD`)
3. Rename existing connection to: `Production (NVMe) - postgres`

## Rollback Plan

```bash
# Stop staging Postgres (zero impact on production)
cd /opt/getouch/compose
docker compose -f docker-compose.db-staging.yml down

# Data remains in /data/postgres-ssd for re-use later
# Production postgres is completely unaffected
```

## Phase 2: Rename to postgres-nvme (Optional, Future)

If you later want to rename the production instance:

1. Create `postgres-nvme` with fresh NVMe data dir
2. `pg_dumpall` from current `postgres` → `postgres-nvme`
3. Switch production `DATABASE_URL` to `postgres-nvme`
4. Keep old `postgres` stopped (rollback safety)
5. After 7 days confirmed stable, remove old `postgres`

> **Do not proceed with Phase 2 until Phase 1 is fully validated.**
