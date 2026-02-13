# Runbook 04 — Postgres

## Overview

Postgres runs as a Docker container on the `getouch_data` network, accessible by app containers only.

## Compose Service

Defined in `docker-compose.db.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - /opt/getouch/data/postgres:/var/lib/postgresql/data
    networks:
      - getouch_data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]
      interval: 10s
      timeout: 5s
      retries: 5
```

## Deploy

```bash
cd /opt/getouch/compose
docker compose -f docker-compose.db.yml up -d
```

## Verification

```bash
docker compose -f docker-compose.db.yml ps
docker exec -it postgres psql -U getouch -c "SELECT version();"
```

## Backup

```bash
docker exec postgres pg_dump -U getouch getouch > /opt/getouch/backups/pg_$(date +%Y%m%d_%H%M%S).sql
```

See runbook 08 for automated backup cron.
