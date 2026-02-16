#!/usr/bin/env bash
# deploy.sh — Pull latest images, rebuild app services, restart the stack
set -euo pipefail

COMPOSE_DIR="/opt/getouch/compose"

echo "=== Getouch Deploy ==="
cd "$COMPOSE_DIR"

echo "[1/5] Pulling latest images..."
docker compose pull 2>&1
docker compose -f docker-compose.db.yml pull 2>&1
docker compose -f docker-compose.ollama.yml pull 2>&1
docker compose -f docker-compose.mon.yml pull 2>&1
[ -f docker-compose.db-staging.yml ] && docker compose -f docker-compose.db-staging.yml pull 2>&1
[ -f docker-compose.coolify.yml ] && docker compose -f docker-compose.coolify.yml pull 2>&1

echo "[2/5] Rebuilding app services..."
docker compose -f docker-compose.apps.yml build --no-cache 2>&1

echo "[3/5] Restarting all stacks..."
docker compose up -d 2>&1
docker compose -f docker-compose.db.yml up -d 2>&1
docker compose -f docker-compose.ollama.yml up -d 2>&1
docker compose -f docker-compose.apps.yml up -d 2>&1
docker compose -f docker-compose.mon.yml up -d 2>&1
[ -f docker-compose.db-staging.yml ] && docker compose -f docker-compose.db-staging.yml up -d 2>&1
[ -f docker-compose.coolify.yml ] && docker compose -f docker-compose.coolify.yml up -d 2>&1

echo "[4/5] Reloading Caddy..."
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile 2>&1 || echo "  Caddy reload skipped (may not need it)"

echo "[5/5] Status:"
docker ps --format "table {{.Names}}\t{{.Status}}" | sort

echo ""
echo "Deploy complete at $(date)"
