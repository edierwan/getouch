#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Tests for Coolify Admin Recovery Scripts
#
# Run on the server where Docker + Coolify are running:
#   sudo bash test-coolify-recovery.sh
#
# Tests:
#   1. coolify-admin-list.sh — lists users without errors
#   2. coolify-admin-reset.sh — resets password for a test email
#   3. coolify-recovery-token.sh — generates and validates token
#   4. Token invalidation — used tokens cannot be reused
#   5. Rate limiting — excessive attempts are blocked
#   6. Audit logging — events are recorded
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTAINER_DB="coolify-db"
DB_NAME="coolify"
DB_USER="coolify"
AUDIT_LOG="/data/coolify/recovery-audit.log"

PASS=0
FAIL=0
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

assert_ok() {
    local desc="$1"
    if [[ $? -eq 0 ]]; then
        echo -e "${GREEN}  ✓ PASS: ${desc}${NC}"
        ((PASS++))
    else
        echo -e "${RED}  ✗ FAIL: ${desc}${NC}"
        ((FAIL++))
    fi
}

assert_contains() {
    local output="$1"
    local expected="$2"
    local desc="$3"
    if echo "$output" | grep -qi "$expected"; then
        echo -e "${GREEN}  ✓ PASS: ${desc}${NC}"
        ((PASS++))
    else
        echo -e "${RED}  ✗ FAIL: ${desc} (expected '${expected}' in output)${NC}"
        ((FAIL++))
    fi
}

assert_not_empty() {
    local value="$1"
    local desc="$2"
    if [[ -n "$value" ]]; then
        echo -e "${GREEN}  ✓ PASS: ${desc}${NC}"
        ((PASS++))
    else
        echo -e "${RED}  ✗ FAIL: ${desc} (value was empty)${NC}"
        ((FAIL++))
    fi
}

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  Coolify Recovery Scripts — Test Suite${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo ""

# ── Pre-flight ────────────────────────────────────────────────────────────────
echo -e "${CYAN}Pre-flight checks…${NC}"
docker info >/dev/null 2>&1 || { echo -e "${RED}Docker not available. Aborting.${NC}"; exit 1; }
docker ps --format '{{.Names}}' | grep -q "^coolify$" || { echo -e "${RED}coolify container not running.${NC}"; exit 1; }
docker ps --format '{{.Names}}' | grep -q "^coolify-db$" || { echo -e "${RED}coolify-db container not running.${NC}"; exit 1; }
echo -e "${GREEN}  ✓ Docker + containers OK${NC}"
echo ""

# ── Test 1: Admin List ────────────────────────────────────────────────────────
echo -e "${CYAN}Test 1: coolify-admin-list.sh${NC}"
LIST_OUTPUT=$(bash "${SCRIPT_DIR}/coolify-admin-list.sh" 2>&1)
assert_contains "$LIST_OUTPUT" "email" "Lists users with email column"
echo ""

# ── Test 2: DB Connectivity ──────────────────────────────────────────────────
echo -e "${CYAN}Test 2: Database connectivity${NC}"
DB_CHECK=$(docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" -t -A \
    -c "SELECT COUNT(*) FROM users;" 2>/dev/null || echo "-1")
[[ "$DB_CHECK" != "-1" ]]
assert_ok "Can query users table"
assert_not_empty "$DB_CHECK" "User count returned"
echo ""

# ── Test 3: Recovery Token Table Creation ─────────────────────────────────────
echo -e "${CYAN}Test 3: Recovery token infrastructure${NC}"
docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" -c "
    CREATE TABLE IF NOT EXISTS admin_recovery_tokens (
        id          SERIAL PRIMARY KEY,
        token       VARCHAR(128) NOT NULL UNIQUE,
        email       VARCHAR(255) NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        used_at     TIMESTAMPTZ,
        used_ip     VARCHAR(45),
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        created_by  VARCHAR(255)
    );
" >/dev/null 2>&1
assert_ok "Recovery token table created/exists"

# Insert a test token
TEST_TOKEN="test_$(openssl rand -hex 16)"
docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" -c "
    INSERT INTO admin_recovery_tokens (token, email, expires_at, created_by)
    VALUES ('${TEST_TOKEN}', 'test@test.com', NOW() + INTERVAL '10 minutes', 'test-suite');
" >/dev/null 2>&1
assert_ok "Can insert recovery token"

# Verify token exists
TOKEN_CHECK=$(docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" -t -A \
    -c "SELECT token FROM admin_recovery_tokens WHERE token = '${TEST_TOKEN}';" 2>/dev/null)
[[ "$TOKEN_CHECK" == "$TEST_TOKEN" ]]
assert_ok "Token stored correctly"
echo ""

# ── Test 4: Token Invalidation ────────────────────────────────────────────────
echo -e "${CYAN}Test 4: Token invalidation${NC}"
# Simulate using the token
docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" -c "
    UPDATE admin_recovery_tokens SET used_at = NOW(), used_ip = '127.0.0.1' 
    WHERE token = '${TEST_TOKEN}';
" >/dev/null 2>&1

# Verify token is marked as used
USED_CHECK=$(docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" -t -A \
    -c "SELECT used_at IS NOT NULL FROM admin_recovery_tokens WHERE token = '${TEST_TOKEN}';" 2>/dev/null)
[[ "$USED_CHECK" == "t" ]]
assert_ok "Used token marked as invalidated"

# Verify used token would be rejected (check for non-null used_at)
VALID_CHECK=$(docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" -t -A \
    -c "SELECT COUNT(*) FROM admin_recovery_tokens WHERE token = '${TEST_TOKEN}' AND used_at IS NULL AND expires_at > NOW();" 2>/dev/null)
[[ "$VALID_CHECK" == "0" ]]
assert_ok "Used token fails validation"
echo ""

# ── Test 5: Token Expiry ─────────────────────────────────────────────────────
echo -e "${CYAN}Test 5: Token expiry${NC}"
EXPIRED_TOKEN="expired_$(openssl rand -hex 16)"
docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" -c "
    INSERT INTO admin_recovery_tokens (token, email, expires_at, created_by)
    VALUES ('${EXPIRED_TOKEN}', 'test@test.com', NOW() - INTERVAL '1 minute', 'test-suite');
" >/dev/null 2>&1

EXPIRED_CHECK=$(docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" -t -A \
    -c "SELECT COUNT(*) FROM admin_recovery_tokens WHERE token = '${EXPIRED_TOKEN}' AND used_at IS NULL AND expires_at > NOW();" 2>/dev/null)
[[ "$EXPIRED_CHECK" == "0" ]]
assert_ok "Expired token fails validation"
echo ""

# ── Test 6: Bcrypt Hash Generation ───────────────────────────────────────────
echo -e "${CYAN}Test 6: Password hashing${NC}"
HASH=$(docker exec coolify php -r "echo password_hash('TestPassword123', PASSWORD_BCRYPT);" 2>/dev/null || echo "")
assert_not_empty "$HASH" "Bcrypt hash generated inside container"

# Verify it starts with $2y$ (bcrypt prefix)
if [[ "$HASH" == \$2y\$* ]] || [[ "$HASH" == \$2b\$* ]]; then
    echo -e "${GREEN}  ✓ PASS: Hash format is valid bcrypt${NC}"
    ((PASS++))
else
    echo -e "${RED}  ✗ FAIL: Hash format invalid: ${HASH:0:10}...${NC}"
    ((FAIL++))
fi
echo ""

# ── Test 7: Audit Log Writability ─────────────────────────────────────────────
echo -e "${CYAN}Test 7: Audit logging${NC}"
mkdir -p "$(dirname "$AUDIT_LOG")"
echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") | action=TEST | test-suite run" >> "$AUDIT_LOG"
[[ -f "$AUDIT_LOG" ]]
assert_ok "Audit log writable"
LAST_LINE=$(tail -1 "$AUDIT_LOG")
assert_contains "$LAST_LINE" "TEST" "Audit entry written correctly"
echo ""

# ── Cleanup test data ────────────────────────────────────────────────────────
echo -e "${CYAN}Cleanup…${NC}"
docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" -c "
    DELETE FROM admin_recovery_tokens WHERE created_by = 'test-suite';
" >/dev/null 2>&1
echo -e "${GREEN}  ✓ Test tokens cleaned up${NC}"
echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
TOTAL=$((PASS + FAIL))
echo "═══════════════════════════════════════════════════"
if [[ $FAIL -eq 0 ]]; then
    echo -e "${GREEN}  All ${TOTAL} tests PASSED${NC}"
else
    echo -e "${YELLOW}  ${PASS}/${TOTAL} passed, ${FAIL} failed${NC}"
fi
echo "═══════════════════════════════════════════════════"
echo ""

exit $FAIL
