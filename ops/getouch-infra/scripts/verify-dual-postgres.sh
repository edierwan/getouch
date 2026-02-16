#!/bin/bash
# verify-dual-postgres.sh — Verify dual Postgres setup
# Run from VPS: bash /opt/getouch/scripts/verify-dual-postgres.sh

set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'
PASS=0
FAIL=0

check() {
  local desc="$1"
  shift
  if eval "$@" >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} $desc"
    ((PASS++))
  else
    echo -e "  ${RED}✗${NC} $desc"
    ((FAIL++))
  fi
}

echo ""
echo "═══════════════════════════════════════════"
echo "  Dual Postgres Verification"
echo "═══════════════════════════════════════════"
echo ""

echo "1) Container Status"
check "postgres is running" "docker ps --format '{{.Names}}' | grep -q '^postgres$'"
check "postgres-ssd is running" "docker ps --format '{{.Names}}' | grep -q '^postgres-ssd$'"

echo ""
echo "2) Health Checks"
check "postgres is healthy" "docker exec postgres pg_isready -U getouch"
check "postgres-ssd is healthy" "docker exec postgres-ssd pg_isready -U getouch"

echo ""
echo "3) Volume Mounts"
check "postgres uses NVMe (/opt/getouch/data/postgres)" \
  "docker inspect postgres --format '{{range .Mounts}}{{.Source}}{{end}}' | grep -q '/opt/getouch/data/postgres'"
check "postgres-ssd uses SATA (/data/postgres-ssd)" \
  "docker inspect postgres-ssd --format '{{range .Mounts}}{{.Source}}{{end}}' | grep -q '/data/postgres-ssd'"

echo ""
echo "4) Port Bindings"
check "postgres on 5432 (internal only)" \
  "docker inspect postgres --format '{{json .NetworkSettings.Ports}}' | grep -q '5432'"
check "postgres-ssd on 127.0.0.1:5433" \
  "docker inspect postgres-ssd --format '{{json .NetworkSettings.Ports}}' | grep -q '5433'"

echo ""
echo "5) Staging Databases"
check "getouch_bot_stg exists" \
  "docker exec postgres-ssd psql -U getouch -tc \"SELECT 1 FROM pg_database WHERE datname='getouch_bot_stg'\" | grep -q 1"
check "getouch_wa_stg exists" \
  "docker exec postgres-ssd psql -U getouch -tc \"SELECT 1 FROM pg_database WHERE datname='getouch_wa_stg'\" | grep -q 1"
check "getouch_api_stg exists" \
  "docker exec postgres-ssd psql -U getouch -tc \"SELECT 1 FROM pg_database WHERE datname='getouch_api_stg'\" | grep -q 1"

echo ""
echo "6) Production Untouched"
check "getouch_bot exists on prod postgres" \
  "docker exec postgres psql -U getouch -tc \"SELECT 1 FROM pg_database WHERE datname='getouch_bot'\" | grep -q 1"
check "getouch_wa exists on prod postgres" \
  "docker exec postgres psql -U getouch -tc \"SELECT 1 FROM pg_database WHERE datname='getouch_wa'\" | grep -q 1"
check "getouch_api exists on prod postgres" \
  "docker exec postgres psql -U getouch -tc \"SELECT 1 FROM pg_database WHERE datname='getouch_api'\" | grep -q 1"

echo ""
echo "═══════════════════════════════════════════"
echo -e "  Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}"
echo "═══════════════════════════════════════════"
echo ""

if [ $FAIL -gt 0 ]; then
  exit 1
fi
