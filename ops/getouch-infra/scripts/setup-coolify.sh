#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Getouch — Phase 1: Bring up Coolify via existing compose
# Run on the host (as root or with sudo).
#
# Prerequisites:
#   - Docker + Docker Compose v2 installed
#   - .env file at /opt/getouch/compose/.env
#   - docker-compose.coolify.yml in /opt/getouch/compose/
#
# Usage:
#   sudo bash setup-coolify.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail

COMPOSE_DIR="/opt/getouch/compose"
DATA_DIR="/data/coolify"

echo "──────────────────────────────────────────"
echo "  Getouch · Phase 1 — Coolify Setup"
echo "──────────────────────────────────────────"

# 1. Ensure /data/coolify exists with correct permissions
echo "[1/5] Creating ${DATA_DIR} with correct permissions…"
mkdir -p "${DATA_DIR}"
chmod 700 "${DATA_DIR}"
echo "       ✓ ${DATA_DIR} ready (mode 700)"

# 2. Ensure Docker networks exist
echo "[2/5] Ensuring Docker networks exist…"
docker network create getouch_ingress 2>/dev/null || true
docker network create getouch_app    2>/dev/null || true
docker network create getouch_data   2>/dev/null || true
echo "       ✓ Networks: getouch_ingress, getouch_app, getouch_data"

# 3. Pull latest Coolify image
echo "[3/5] Pulling Coolify image…"
docker pull ghcr.io/coollabsio/coolify:latest
echo "       ✓ Image pulled"

# 4. Start Coolify
echo "[4/5] Starting Coolify…"
cd "${COMPOSE_DIR}"
docker compose -f docker-compose.coolify.yml --env-file .env up -d
echo "       ✓ Coolify container started"

# 5. Verify
echo "[5/5] Verifying Coolify is reachable…"
RETRIES=10
for i in $(seq 1 $RETRIES); do
  if curl -sf http://127.0.0.1:8000/api/health >/dev/null 2>&1; then
    echo "       ✓ Coolify health OK at http://127.0.0.1:8000"
    break
  fi
  if [ "$i" -eq "$RETRIES" ]; then
    echo "       ⚠ Coolify not yet healthy (still starting). Check with:"
    echo "         docker logs coolify --tail 20"
    echo "         curl http://127.0.0.1:8000/api/health"
  fi
  sleep 6
done

echo ""
echo "──────────────────────────────────────────"
echo "  ✓ Phase 1 Complete"
echo ""
echo "  Coolify UI:    https://coolify.getouch.co"
echo "  Local access:  http://127.0.0.1:8000"
echo "  Data dir:      ${DATA_DIR}"
echo ""
echo "  Caddy routes coolify.getouch.co → 127.0.0.1:8000"
echo "  Coolify is NOT exposed on public ports."
echo "──────────────────────────────────────────"
