#!/usr/bin/env bash
# deploy.sh — Git pull + rebuild + restart the full stack
# Usage: bash /opt/getouch/scripts/deploy.sh
set -euo pipefail

COMPOSE_DIR="/opt/getouch/compose"
REPO_DIR=""

# Detect if /opt/getouch is a symlink to a git repo
if [ -L /opt/getouch ]; then
  REAL_PATH=$(readlink -f /opt/getouch)
  REPO_DIR=$(cd "$REAL_PATH" && git rev-parse --show-toplevel 2>/dev/null || echo "")
fi

echo "=== Getouch Deploy ==="

# Step 0: Git pull (if git-managed)
if [ -n "$REPO_DIR" ]; then
  echo "[0/6] Pulling latest code from git..."
  cd "$REPO_DIR"
  git pull origin develop 2>&1
  echo "  Commit: $(git log --oneline -1)"
else
  echo "[0/6] Not a git repo — skipping git pull"
fi

cd "$COMPOSE_DIR"

echo "[1/6] Pulling latest Docker images..."
docker compose pull 2>&1
docker compose -f docker-compose.db.yml pull 2>&1
docker compose -f docker-compose.ollama.yml pull 2>&1
docker compose -f docker-compose.mon.yml pull 2>&1
[ -f docker-compose.db-staging.yml ] && docker compose -f docker-compose.db-staging.yml pull 2>&1
[ -f docker-compose.coolify.yml ] && docker compose -f docker-compose.coolify.yml pull 2>&1

echo "[2/6] Rebuilding app services..."
docker compose -f docker-compose.apps.yml build --no-cache 2>&1

echo "[3/6] Restarting all stacks..."
docker compose up -d 2>&1
docker compose -f docker-compose.db.yml up -d 2>&1
docker compose -f docker-compose.ollama.yml up -d 2>&1
docker compose -f docker-compose.apps.yml up -d 2>&1
docker compose -f docker-compose.mon.yml up -d 2>&1
[ -f docker-compose.db-staging.yml ] && docker compose -f docker-compose.db-staging.yml up -d 2>&1
[ -f docker-compose.coolify.yml ] && docker compose -f docker-compose.coolify.yml up -d 2>&1

echo "[4/6] Reloading Caddy..."
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile 2>&1 || echo "  Caddy reload skipped"

echo "[5/6] Grafana provisioning check..."
sleep 3
docker logs --tail 10 grafana 2>&1 | grep -i "provisioning\|datasource\|dashboard" || echo "  (no provisioning log lines yet)"

echo "[6/6] Status:"
docker ps --format "table {{.Names}}\t{{.Status}}" | sort

echo ""
echo "Deploy complete at $(date)"
