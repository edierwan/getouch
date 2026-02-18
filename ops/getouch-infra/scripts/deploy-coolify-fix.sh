#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# deploy-coolify-fix.sh — Deploy the full Coolify stack fix
#
# Fixes:
#   1. "Cannot connect to real-time service" — adds soketi + redis
#   2. 500 on server page — runs migrations + fixes NULL settings/proxy
#
# Usage:  sudo bash deploy-coolify-fix.sh
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

COMPOSE_DIR="/opt/getouch/compose"
CONFIG_DIR="/opt/getouch/config"
SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_COMPOSE="$(cd "${SCRIPTS_DIR}/../compose" && pwd)"
REPO_CONFIG="$(cd "${SCRIPTS_DIR}/../config" && pwd)"

echo "══════════════════════════════════════════════════════"
echo "  Getouch · Deploy Coolify Stack Fix"
echo "══════════════════════════════════════════════════════"
echo ""

# 1. Create data directories for new services
echo "[1/7] Creating data directories…"
mkdir -p /data/coolify/db /data/coolify/redis /data/coolify/ssh
chmod 700 /data/coolify/db /data/coolify/redis
echo "       ✓ /data/coolify/{db,redis} ready"

# 2. Copy updated compose file
echo "[2/7] Deploying updated docker-compose.coolify.yml…"
cp "${REPO_COMPOSE}/docker-compose.coolify.yml" "${COMPOSE_DIR}/docker-compose.coolify.yml"
echo "       ✓ Compose file updated"

# 3. Copy updated Caddyfile
echo "[3/7] Deploying updated Caddyfile (WebSocket proxy)…"
cp "${REPO_CONFIG}/Caddyfile" "${CONFIG_DIR}/Caddyfile"
echo "       ✓ Caddyfile updated"

# 4. Pull new images
echo "[4/7] Pulling images…"
docker pull ghcr.io/coollabsio/coolify:latest
docker pull ghcr.io/coollabsio/coolify-realtime:1.0.5
docker pull postgres:15-alpine
docker pull redis:7-alpine
echo "       ✓ Images pulled"

# 5. Restart Coolify stack
echo "[5/7] Restarting Coolify stack (with new services)…"
cd "${COMPOSE_DIR}"
docker compose -f docker-compose.coolify.yml down --remove-orphans 2>/dev/null || true
docker compose -f docker-compose.coolify.yml --env-file .env up -d
echo "       ✓ Stack started"

# 6. Reload Caddy for WebSocket routes
echo "[6/7] Reloading Caddy…"
docker exec caddy caddy reload --config /etc/caddy/Caddyfile 2>&1 || {
  echo "       ⚠ Could not reload Caddy live — restarting container"
  docker restart caddy
}
echo "       ✓ Caddy reloaded"

# 7. Wait for Coolify to be healthy, then fix server records
echo "[7/7] Waiting for Coolify to become healthy…"
RETRIES=20
for i in $(seq 1 $RETRIES); do
  if curl -sf http://127.0.0.1:8000/api/health >/dev/null 2>&1; then
    echo "       ✓ Coolify healthy"
    break
  fi
  if [ "$i" -eq "$RETRIES" ]; then
    echo "       ⚠ Coolify still starting — run fix-coolify-server500.sh manually later"
    exit 0
  fi
  printf "       … attempt %d/%d\n" "$i" "$RETRIES"
  sleep 10
done

# Run the server fix
echo ""
echo "── Running server 500 fix ──"
bash "${SCRIPTS_DIR}/fix-coolify-server500.sh"

echo ""
echo "══════════════════════════════════════════════════════"
echo "  ✓ All done!"
echo ""
echo "  What changed:"
echo "    + coolify-db     (PostgreSQL 15 for Coolify)"
echo "    + coolify-redis  (Redis 7 for queues/cache)"
echo "    + coolify-realtime (Soketi WebSocket server)"
echo "    + Caddyfile updated (WebSocket /app/* proxy)"
echo "    + Server settings/proxy NULL records fixed"
echo ""
echo "  Verify at: https://coolify.getouch.co/servers"
echo "══════════════════════════════════════════════════════"
