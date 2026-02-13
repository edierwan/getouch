# Runbook 07 — Service Skeletons

## Overview

Four application services run on the `getouch_app` network, proxied by Caddy:

| Service | Subdomain | Port | Description |
|---------|-----------|------|-------------|
| landing | getouch.co | 3000 | Marketing / landing page |
| bot | bot.getouch.co | 3000 | Chat bot service |
| wa | wa.getouch.co | 3000 | WhatsApp integration (Baileys) |
| api | api.getouch.co | 3000 | REST API backend |

## Compose Service

Defined in `docker-compose.apps.yml`:

```yaml
services:
  landing:
    image: node:20-alpine
    working_dir: /app
    volumes:
      - ./apps/landing:/app
    command: node server.js
    networks:
      - getouch_app

  bot:
    image: node:20-alpine
    working_dir: /app
    volumes:
      - ./apps/bot:/app
    command: node server.js
    networks:
      - getouch_app
      - getouch_data

  wa:
    image: node:20-alpine
    working_dir: /app
    volumes:
      - ./apps/wa:/app
    command: node server.js
    networks:
      - getouch_app
      - getouch_data

  api:
    image: node:20-alpine
    working_dir: /app
    volumes:
      - ./apps/api:/app
    command: node server.js
    networks:
      - getouch_app
      - getouch_data
```

## Notes

- `bot`, `wa`, and `api` are on both `getouch_app` (for Caddy) and `getouch_data` (for Postgres/Ollama).
- `wa` service will use [Baileys](https://github.com/WhiskeySockets/Baileys) for WhatsApp Web API.
- Services will be replaced with real Dockerfiles once application code is ready.
