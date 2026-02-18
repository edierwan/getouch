#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Coolify Emergency Admin Bootstrap (Option C)
#
# Ensures an admin user exists with the specified credentials.
# Designed to run as a one-shot init container or entrypoint wrapper.
#
# Required env vars:
#   EMERGENCY_ADMIN_EMAIL     — admin email to create/reset
#   EMERGENCY_ADMIN_PASSWORD  — new password (min 8 chars)
#   ENABLE_EMERGENCY_ADMIN    — must be "true" to activate
#
# After successful run, creates /data/coolify/.emergency-admin-done marker
# to prevent re-execution on subsequent restarts.
#
# Usage (standalone):
#   sudo bash coolify-emergency-admin.sh
#
# Usage (via docker-compose override):
#   See docker-compose.coolify-recovery.yml
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

CONTAINER_COOLIFY="coolify"
CONTAINER_DB="coolify-db"
DB_NAME="coolify"
DB_USER="coolify"
AUDIT_LOG="/data/coolify/recovery-audit.log"
MARKER_FILE="/data/coolify/.emergency-admin-done"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_audit() {
    local ts; ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    mkdir -p "$(dirname "$AUDIT_LOG")"
    echo "${ts} | action=$1 | $2" >> "$AUDIT_LOG"
}

die() { echo -e "${RED}ERROR: $1${NC}" >&2; exit 1; }

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  Coolify Emergency Admin Bootstrap${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo ""

# ── Check env flag ────────────────────────────────────────────────────────────
ENABLE_EMERGENCY_ADMIN="${ENABLE_EMERGENCY_ADMIN:-false}"
EMERGENCY_ADMIN_EMAIL="${EMERGENCY_ADMIN_EMAIL:-}"
EMERGENCY_ADMIN_PASSWORD="${EMERGENCY_ADMIN_PASSWORD:-}"

if [[ "$ENABLE_EMERGENCY_ADMIN" != "true" ]]; then
    echo -e "${YELLOW}ENABLE_EMERGENCY_ADMIN is not 'true'. Skipping.${NC}"
    echo "Set these env vars and re-run:"
    echo "  export ENABLE_EMERGENCY_ADMIN=true"
    echo "  export EMERGENCY_ADMIN_EMAIL=edierwan@gmail.com"
    echo "  export EMERGENCY_ADMIN_PASSWORD=YourNewPassword123"
    exit 0
fi

# ── Check marker (idempotency) ────────────────────────────────────────────────
if [[ -f "$MARKER_FILE" ]]; then
    echo -e "${YELLOW}Emergency admin already provisioned (marker exists).${NC}"
    echo "To re-run, delete: $MARKER_FILE"
    exit 0
fi

# ── Validate inputs ──────────────────────────────────────────────────────────
[[ -z "$EMERGENCY_ADMIN_EMAIL" ]] && die "EMERGENCY_ADMIN_EMAIL is required"
[[ -z "$EMERGENCY_ADMIN_PASSWORD" ]] && die "EMERGENCY_ADMIN_PASSWORD is required"
[[ ${#EMERGENCY_ADMIN_PASSWORD} -lt 8 ]] && die "Password must be at least 8 characters"

# ── Pre-flight ────────────────────────────────────────────────────────────────
docker info >/dev/null 2>&1 || die "Cannot connect to Docker."

# Wait for DB to be ready (important for boot-time usage)
echo "Waiting for coolify-db to be ready…"
for i in $(seq 1 30); do
    if docker exec "$CONTAINER_DB" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
        echo -e "${GREEN}  ✓ Database ready${NC}"
        break
    fi
    if [[ "$i" -eq 30 ]]; then
        die "Database not ready after 30 attempts."
    fi
    sleep 2
done

# Wait for Coolify container to be running
echo "Waiting for Coolify container…"
for i in $(seq 1 30); do
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_COOLIFY}$"; then
        echo -e "${GREEN}  ✓ Coolify container running${NC}"
        break
    fi
    if [[ "$i" -eq 30 ]]; then
        die "Coolify container not running after 30 attempts."
    fi
    sleep 2
done

# Give Laravel a moment to boot
sleep 5

log_audit "EMERGENCY_ADMIN_ATTEMPT" "email=${EMERGENCY_ADMIN_EMAIL}"

# ── Generate bcrypt hash ─────────────────────────────────────────────────────
ESCAPED_PASS="${EMERGENCY_ADMIN_PASSWORD//\'/\\\'}"
BCRYPT_HASH=$(docker exec "$CONTAINER_COOLIFY" php -r "echo password_hash('${ESCAPED_PASS}', PASSWORD_BCRYPT);" 2>/dev/null)

if [[ -z "$BCRYPT_HASH" ]]; then
    die "Failed to generate bcrypt hash inside Coolify container."
fi

# ── Check if user exists or needs creation ───────────────────────────────────
USER_ID=$(docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" -t -A \
    -c "SELECT id FROM users WHERE email = '${EMERGENCY_ADMIN_EMAIL}';" 2>/dev/null)

if [[ -n "$USER_ID" ]]; then
    echo "User exists (ID: ${USER_ID}). Resetting password…"
    docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" \
        -c "UPDATE users SET password = '${BCRYPT_HASH}', updated_at = NOW() WHERE email = '${EMERGENCY_ADMIN_EMAIL}';" >/dev/null
    ACTION="RESET"
else
    echo "User does not exist. Creating admin…"
    docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" \
        -c "INSERT INTO users (name, email, password, created_at, updated_at)
            VALUES ('$(echo "${EMERGENCY_ADMIN_EMAIL}" | cut -d@ -f1)', '${EMERGENCY_ADMIN_EMAIL}', '${BCRYPT_HASH}', NOW(), NOW());" >/dev/null
    USER_ID=$(docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" -t -A \
        -c "SELECT id FROM users WHERE email = '${EMERGENCY_ADMIN_EMAIL}';" 2>/dev/null)
    ACTION="CREATED"
fi

# ── Write marker ──────────────────────────────────────────────────────────────
mkdir -p "$(dirname "$MARKER_FILE")"
echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") | email=${EMERGENCY_ADMIN_EMAIL} | user_id=${USER_ID}" > "$MARKER_FILE"
chmod 600 "$MARKER_FILE"

log_audit "EMERGENCY_ADMIN_${ACTION}" "email=${EMERGENCY_ADMIN_EMAIL} user_id=${USER_ID}"

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✓ Emergency admin ${ACTION} successfully${NC}"
echo -e "${GREEN}    Email:   ${EMERGENCY_ADMIN_EMAIL}${NC}"
echo -e "${GREEN}    User ID: ${USER_ID}${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}⚠  IMPORTANT: Clear sensitive env vars now:${NC}"
echo "  unset EMERGENCY_ADMIN_PASSWORD"
echo "  unset ENABLE_EMERGENCY_ADMIN"
echo ""
echo -e "${YELLOW}⚠  Marker file created at: ${MARKER_FILE}${NC}"
echo "  Delete it to allow future emergency resets."
echo ""
echo "Login at: https://coolify.getouch.co"
