# Coolify Deployment Guide — Getouch Platform

## Overview

Coolify manages the **application-tier** services (landing, bot, wa, api).
Infrastructure services remain under manual compose control.

## Application Definitions in Coolify

### 1. Landing (`getouch.co`)
| Field | Value |
|-------|-------|
| **Type** | Docker (Dockerfile) |
| **Source** | GitHub → `app/Dockerfile` |
| **Port** | 3000 |
| **Domain** | `getouch.co` |
| **Health Check** | `GET /health` |
| **Network** | `getouch_app`, `getouch_data` |

**Environment Variables:**
```env
PORT=3000
VERSION=2.0.0
NODE_ENV=production
DATABASE_URL_PROD=postgresql://getouch:<pass>@postgres:5432/getouch
DATABASE_URL_DEV=postgresql://getouch:<pass>@postgres-ssd:5432/getouch
SESSION_SECRET=<from .env>
OLLAMA_HOST=ollama
OLLAMA_PORT=11434
COMFYUI_HOST=comfyui
COMFYUI_PORT=8188
ADMIN_TOKEN=<from .env>
IMAGE_DIR=/app/data/images
```

### 2. Bot (`bot.getouch.co`)
| Field | Value |
|-------|-------|
| **Type** | Docker (Dockerfile) |
| **Source** | GitHub → `services/bot/Dockerfile` |
| **Port** | 3000 |
| **Domain** | `bot.getouch.co` |
| **Health Check** | `GET /health` |

### 3. WhatsApp Gateway (`wa.getouch.co`)
| Field | Value |
|-------|-------|
| **Type** | Docker (Dockerfile) |
| **Source** | GitHub → `services/wa/Dockerfile` |
| **Port** | 3000 |
| **Domain** | `wa.getouch.co` |
| **Health Check** | `GET /health` |

### 4. API (`api.getouch.co`)
| Field | Value |
|-------|-------|
| **Type** | Docker (Dockerfile) |
| **Source** | GitHub → `services/api/Dockerfile` |
| **Port** | 3000 |
| **Domain** | `api.getouch.co` |
| **Health Check** | `GET /health` |

## Infra Services (Manual Compose — NOT Coolify)

These stay under `/opt/getouch/compose/` managed by docker compose:

| Service | Compose File | Reason |
|---------|-------------|--------|
| Caddy + Cloudflared | `docker-compose.yml` | Core ingress, Coolify routes through it |
| Postgres (NVMe) | `docker-compose.db.yml` | Production data, stateful |
| Postgres SSD | `docker-compose.db-staging.yml` | Dev data, stateful |
| Ollama + ComfyUI | `docker-compose.ollama.yml` | GPU workload, heavyweight |
| Prometheus + Grafana | `docker-compose.mon.yml` | Observability stack |

## Deployment Workflow

1. Push to `develop` → Coolify auto-deploys to dev environment
2. Push to `main` → Coolify auto-deploys to production
3. Manual deploy via Coolify UI for rollbacks
