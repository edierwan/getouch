# Getouch v2.0 — Deployment Verification Checklist

## Phase 1 — Infra Standardization

- [ ] `/data/coolify` directory exists with mode 700
- [ ] Docker networks exist: `getouch_ingress`, `getouch_app`, `getouch_data`
- [ ] Coolify container running: `docker ps | grep coolify`
- [ ] Coolify health OK: `curl -sf http://127.0.0.1:8000/api/health`
- [ ] Caddy routes `coolify.getouch.co` → `127.0.0.1:8000`
- [ ] Coolify NOT exposed on public ports (only 127.0.0.1:8000)
- [ ] Coolify UI accessible at `https://coolify.getouch.co` (via Cloudflare Access)

## Phase 2 — Deployment Standardization

- [ ] GitHub repo connected in Coolify
- [ ] Application created: landing → getouch.co
- [ ] Application created: bot → bot.getouch.co
- [ ] Application created: wa → wa.getouch.co
- [ ] Application created: api → api.getouch.co
- [ ] All applications healthy in Coolify UI
- [ ] Health checks pass: `curl https://{getouch,bot.getouch,wa.getouch,api.getouch}.co/health`
- [ ] Manual compose apps stopped: `docker compose -f docker-compose.apps.yml ps` (empty)
- [ ] Infra compose still running: postgres, postgres-ssd, ollama, comfyui, prometheus, grafana

## Phase 3 — Dual Environment Routing

### Database

- [ ] Migration 002 applied on prod: `psql $DATABASE_URL_PROD -f migrations/002_dual_environment.sql`
- [ ] Migration 002 applied on dev: `psql $DATABASE_URL_DEV -f migrations/002_dual_environment.sql`
- [ ] `api_keys` table has `environment` column with CHECK constraint
- [ ] `chat_messages` table has `environment` column
- [ ] `images` table has `environment` column
- [ ] `image_usage` table has `environment` column + updated PK
- [ ] `api_key_usage_log` table has `environment` column
- [ ] New settings seeded: `SELECT * FROM settings WHERE key LIKE 'rate_limit%' OR key LIKE '%.prod' OR key LIKE '%.dev'`

### Environment Variables

- [ ] `DATABASE_URL_PROD` set in .env (pointing to postgres NVMe)
- [ ] `DATABASE_URL_DEV` set in .env (pointing to postgres-ssd SATA)
- [ ] App logs show `[db] Dual-pool mode: prod + dev` on startup

### API Key Creation

- [ ] Create prod key via dashboard → prefix starts with `prod_`
- [ ] Create dev key via dashboard → prefix starts with `dev_`
- [ ] Key list shows PROD/DEV badge per key

### Security

- [ ] `prod_` key: `curl -H "Authorization: Bearer prod_xxx" https://api.getouch.co/v1/chat/models` → works
- [ ] `dev_` key: `curl -H "Authorization: Bearer dev_xxx" https://api.getouch.co/v1/chat/models` → works
- [ ] `prod_` key cannot access dev resources (enforced by middleware)
- [ ] `dev_` key cannot access prod resources (enforced by middleware)
- [ ] Legacy `gt_` keys still work (routed to prod)

### Rate Limiting

- [ ] Prod chat rate limit: 15 RPM default
- [ ] Dev chat rate limit: 60 RPM default
- [ ] Rate limits are independent between environments

## Phase 4 — AI Upgrade

### Text Models

- [ ] llama3.1:8b available: `curl http://localhost:11434/api/tags | jq '.models[].name'`
- [ ] qwen2.5:14b-instruct pulled and available
- [ ] Model selection works in admin panel
- [ ] SSE streaming works: `POST /v1/chat` with `event: token` + `event: done`

### Image Generation

- [ ] ComfyUI healthy: `curl http://comfyui:8188/system_stats`
- [ ] SDXL workflow at `app/workflows/sdxl_basic.json`
- [ ] `POST /v1/image/generate` returns image with environment tag
- [ ] Per-environment quota enforced
- [ ] Image metadata saved with correct environment

## Phase 5 — Admin Panel

- [ ] Default text model selector (llama3.1:8b / qwen2.5:14b-instruct)
- [ ] Image generation toggle (enable/disable)
- [ ] Per-environment quota inputs (PROD images/day, DEV images/day)
- [ ] Per-environment rate limit inputs (PROD chat RPM, DEV chat RPM, image RPM)
- [ ] Save settings works — reflected in API responses
- [ ] Dashboard shows environment badge (PROD/DEV) on API keys
- [ ] Dashboard environment selector in key creation modal

## Smoke Tests

```bash
# 1. Create a prod key via UI, copy it
PROD_KEY="prod_xxxxxx"

# 2. Test chat streaming
curl -N -X POST https://getouch.co/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello"}'

# 3. Test WA status (requires prod key)
curl https://wa.getouch.co/v1/status \
  -H "Authorization: Bearer $PROD_KEY"

# 4. Test image quota
curl https://getouch.co/v1/image/quota

# 5. Test image generation
curl -X POST https://getouch.co/v1/image/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt":"a futuristic city at sunset"}'

# 6. Test admin settings
curl https://getouch.co/v1/admin/settings \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 7. Verify environment isolation
curl https://getouch.co/v1/chat \
  -H "Authorization: Bearer dev_xxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"message":"test"}' # Should use dev DB + dev rate limits
```
