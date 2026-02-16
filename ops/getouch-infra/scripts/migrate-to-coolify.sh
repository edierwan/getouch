#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Getouch — Phase 2: Migrate app services from manual compose to Coolify
#
# After Coolify is running and GitHub repo connected:
#   1. Create applications in Coolify UI (landing, bot, wa, api)
#   2. Deploy from Coolify and verify health
#   3. Run this script to stop the manual compose services
#
# Usage:
#   sudo bash migrate-to-coolify.sh [--dry-run]
# ─────────────────────────────────────────────────────────────
set -euo pipefail

COMPOSE_DIR="/opt/getouch/compose"
DRY_RUN=false
[ "${1:-}" = "--dry-run" ] && DRY_RUN=true

echo "──────────────────────────────────────────"
echo "  Getouch · Phase 2 — Migrate to Coolify"
$DRY_RUN && echo "  ** DRY RUN — no changes will be made **"
echo "──────────────────────────────────────────"

# 1. Verify Coolify-managed containers are running
echo "[1/4] Checking Coolify-managed containers…"
SERVICES=("landing" "bot" "wa" "api")
ALL_HEALTHY=true

for svc in "${SERVICES[@]}"; do
  # Coolify names containers with a prefix — find them
  CONTAINER=$(docker ps --filter "label=coolify.name=${svc}" --format '{{.Names}}' 2>/dev/null || echo "")
  if [ -z "$CONTAINER" ]; then
    echo "       ✗ ${svc}: NOT found as Coolify container"
    ALL_HEALTHY=false
  else
    echo "       ✓ ${svc}: running as ${CONTAINER}"
  fi
done

if [ "$ALL_HEALTHY" = false ]; then
  echo ""
  echo "  ⚠ Not all services found under Coolify management."
  echo "    Deploy them in Coolify first, then re-run this script."
  echo ""
  echo "  Coolify UI: https://coolify.getouch.co"
  exit 1
fi

# 2. Health-check each Coolify service
echo "[2/4] Health-checking Coolify services…"
ENDPOINTS=(
  "https://getouch.co/health"
  "https://bot.getouch.co/health"
  "https://wa.getouch.co/health"
  "https://api.getouch.co/health"
)

for url in "${ENDPOINTS[@]}"; do
  STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")
  if [ "$STATUS" = "200" ]; then
    echo "       ✓ ${url} → ${STATUS}"
  else
    echo "       ✗ ${url} → ${STATUS}"
    ALL_HEALTHY=false
  fi
done

if [ "$ALL_HEALTHY" = false ]; then
  echo ""
  echo "  ⚠ Some endpoints not healthy. Fix before stopping manual compose."
  exit 1
fi

# 3. Stop manual compose app services
echo "[3/4] Stopping manual compose app services…"
cd "${COMPOSE_DIR}"

if $DRY_RUN; then
  echo "       [dry-run] Would run: docker compose -f docker-compose.apps.yml down"
else
  docker compose -f docker-compose.apps.yml down
  echo "       ✓ Manual app services stopped"
fi

# 4. Verify infra services still running
echo "[4/4] Verifying infra services (postgres, ollama, monitoring)…"
INFRA_SERVICES=("postgres" "postgres-ssd" "ollama" "comfyui" "prometheus" "grafana" "caddy" "cloudflared")

for svc in "${INFRA_SERVICES[@]}"; do
  STATE=$(docker inspect -f '{{.State.Status}}' "$svc" 2>/dev/null || echo "not found")
  if [ "$STATE" = "running" ]; then
    echo "       ✓ ${svc}: running"
  else
    echo "       ○ ${svc}: ${STATE}"
  fi
done

echo ""
echo "──────────────────────────────────────────"
echo "  ✓ Phase 2 Complete"
echo ""
echo "  Coolify now manages: landing, bot, wa, api"
echo "  Infra-level compose still manages:"
echo "    - Caddy + Cloudflared"
echo "    - Postgres (prod NVMe) + Postgres-SSD (dev SATA)"
echo "    - Ollama + ComfyUI"
echo "    - Prometheus + Grafana + Node-Exporter + cAdvisor"
echo "──────────────────────────────────────────"
