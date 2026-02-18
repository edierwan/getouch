#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Coolify Admin List — Show all registered users
#
# Usage:  sudo bash coolify-admin-list.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

CONTAINER_DB="coolify-db"
DB_NAME="coolify"
DB_USER="coolify"

CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  Coolify — Registered Users${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo ""

docker info >/dev/null 2>&1 || { echo -e "${RED}Cannot connect to Docker.${NC}"; exit 1; }

docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" \
    -c "SELECT id, email, name, created_at, updated_at FROM users ORDER BY id;" 2>/dev/null \
    || echo -e "${RED}Failed to query users. Is coolify-db running?${NC}"

echo ""
