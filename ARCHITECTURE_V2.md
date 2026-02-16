# Getouch Platform — Architecture v2.0 (Dual Environment)

## Final Architecture Summary

```
                    Internet
                       │
                 Cloudflare Tunnel
                       │
              ┌────────▼────────┐
              │     Caddy       │  (reverse proxy, port 80, no TLS)
              │     :80         │
              └──┬──┬──┬──┬──┬──┘
                 │  │  │  │  │
    ┌────────────┤  │  │  │  └──────────────┐
    │            │  │  │  │                 │
    ▼            ▼  ▼  ▼  ▼                 ▼
getouch.co   bot wa api db               coolify
(landing)    .getouch.co                  .getouch.co
    │            │  │  │  │                 │
    │     ┌──────┘  │  │  └──────┐         │
    │     │         │  │         │         │
    ▼     ▼         ▼  ▼         ▼         ▼
┌─────────────────────────┐  ┌────────┐ ┌────────┐
│  Application Tier       │  │pgAdmin │ │Coolify │
│  (Coolify-managed)      │  │ :5050  │ │ :8000  │
│                         │  └────────┘ └────────┘
│  landing  bot  wa  api  │
│  :3000    :3000:3000:3000
└────────┬───┬────────────┘
         │   │
    ┌────┘   └────┐
    │             │
    ▼             ▼
┌─────────┐  ┌─────────┐   ┌──────────┐   ┌──────────┐
│Postgres │  │Postgres │   │  Ollama  │   │ ComfyUI  │
│ (NVMe)  │  │  (SSD)  │   │  GPU     │   │  GPU     │
│ PROD    │  │  DEV    │   │          │   │  SDXL    │
│ :5432   │  │ :5432   │   │  :11434  │   │  :8188   │
└─────────┘  └─────────┘   └──────────┘   └──────────┘
```

## Request Flow — Environment Resolution

```
Client → Caddy → App Service
                    │
                    ▼
            ┌──────────────┐
            │ Extract       │
            │ Authorization │
            │ Bearer token  │
            └──────┬───────┘
                   │
            ┌──────▼───────┐
            │ Key prefix?   │
            │               │
            │ prod_xxx → PROD
            │ dev_xxx  → DEV
            │ gt_xxx   → PROD (legacy)
            └──────┬───────┘
                   │
            ┌──────▼───────┐
            │ Validate key  │
            │ in PROD pool  │
            │ (api_keys     │
            │  .environment)│
            └──────┬───────┘
                   │
            ┌──────▼───────┐
            │ Route request │
            │ to correct    │
            │ DB pool       │
            │               │
            │ PROD → NVMe   │
            │ DEV  → SSD    │
            └──────┬───────┘
                   │
            ┌──────▼───────┐
            │ Tag response  │
            │ with env      │
            │ Rate limit    │
            │ per env       │
            └──────────────┘
```

## Database Schema Changes (Migration 002)

### New columns (`environment VARCHAR(4) NOT NULL DEFAULT 'prod'`):
| Table | Constraint |
|-------|-----------|
| `api_keys` | `CHECK (environment IN ('prod','dev'))` |
| `chat_messages` | `CHECK (environment IN ('prod','dev'))` |
| `images` | `CHECK (environment IN ('prod','dev'))` |
| `image_usage` | `CHECK (environment IN ('prod','dev'))` + new composite PK |
| `api_key_usage_log` | Index on environment |

### New settings:
| Key | Default | Description |
|-----|---------|-------------|
| `ai.image.max_per_day_free.prod` | 10 | Daily image quota (prod) |
| `ai.image.max_per_day_free.dev` | 50 | Daily image quota (dev) |
| `rate_limit.chat.prod` | 15 | Chat RPM (prod) |
| `rate_limit.chat.dev` | 60 | Chat RPM (dev) |
| `rate_limit.image.prod` | 5 | Image RPM (prod) |
| `rate_limit.image.dev` | 20 | Image RPM (dev) |

## API Key Format

| Environment | Prefix | Example |
|-------------|--------|---------|
| Production | `prod_` | `prod_a1b2c3d4e5f6...` |
| Development | `dev_` | `dev_a1b2c3d4e5f6...` |
| Legacy | `gt_` | `gt_a1b2c3d4e5f6...` (treated as prod) |

## Security Rules

1. **Isolation**: `prod_` keys CANNOT access dev DB; `dev_` keys CANNOT access prod DB
2. **Validation**: Key environment column must match prefix — enforced in middleware
3. **Logging**: Every API request tagged with `environment` in usage logs
4. **Rate limiting**: Separate rate limit buckets per environment (prod vs dev)
5. **Quota**: Image generation quotas tracked per environment

## Compose Structure

| Stack | Compose File | Manager | Purpose |
|-------|-------------|---------|---------|
| Ingress | `docker-compose.yml` | Manual | Caddy + Cloudflared |
| Coolify | `docker-compose.coolify.yml` | Manual | CI/CD platform |
| Apps | N/A | Coolify | landing, bot, wa, api |
| DB Prod | `docker-compose.db.yml` | Manual | Postgres NVMe |
| DB Dev | `docker-compose.db-staging.yml` | Manual | Postgres SSD |
| AI | `docker-compose.ollama.yml` | Manual | Ollama + ComfyUI |
| Mon | `docker-compose.mon.yml` | Manual | Prometheus + Grafana |

## AI Models

| Model | Size | Use | Label |
|-------|------|-----|-------|
| llama3.1:8b | ~4.7 GB | Fast responses | Fast |
| qwen2.5:14b-instruct | ~8.5 GB | Complex reasoning | Smart |

## Endpoints

| Endpoint | Auth | Environment-Aware |
|----------|------|------------------|
| `POST /v1/chat` | Bearer (optional) | ✅ Per-env rate limit, logging |
| `GET /v1/chat/models` | None | ❌ |
| `POST /v1/image/generate` | Bearer (optional) | ✅ Per-env quota, logging |
| `GET /v1/image/quota` | Bearer (optional) | ✅ Per-env quota |
| `GET /v1/image/:id` | Bearer (optional) | ✅ Queries env-specific DB |
| `POST /v1/messages/send` | Bearer (required) | ✅ Validated with env |
| `GET /v1/status` | Bearer (required) | ✅ |
| `POST /api/keys` | Session (required) | ✅ Creates with env prefix |
| `PUT /v1/admin/settings/:key` | Admin | ❌ Global settings |
