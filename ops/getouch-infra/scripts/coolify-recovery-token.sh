#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Coolify Admin Recovery Token — One-Time URL (Option B)
#
# Generates a time-limited, single-use recovery token that allows password
# reset via a web page accessible ONLY from localhost / private IP.
#
# Usage:
#   sudo bash coolify-recovery-token.sh --email edierwan@gmail.com
#   sudo bash coolify-recovery-token.sh   # interactive
#
# The token is:
#   - Stored in the Coolify PostgreSQL DB (admin_recovery_tokens table)
#   - Valid for 10 minutes
#   - Invalidated after first use
#   - Only accessible from 127.0.0.1 / ::1 / private IPs
#
# Security:
#   - Server-level access required to generate token
#   - Logs all events to /data/coolify/recovery-audit.log
#   - Rate limited: max 3 tokens per hour
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

CONTAINER_DB="coolify-db"
DB_NAME="coolify"
DB_USER="coolify"
AUDIT_LOG="/data/coolify/recovery-audit.log"
RATE_LIMIT_MAX=3
RATE_LIMIT_WINDOW=3600
TOKEN_EXPIRY_MINUTES=10

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_audit() {
    local ts; ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local ip; ip=$(who am i 2>/dev/null | awk '{print $NF}' | tr -d '()' || echo "console")
    local user; user=$(whoami)
    mkdir -p "$(dirname "$AUDIT_LOG")"
    echo "${ts} | action=$1 | user=${user} | ip=${ip} | $2" >> "$AUDIT_LOG"
}

die() { echo -e "${RED}ERROR: $1${NC}" >&2; log_audit "ERROR" "$1"; exit 1; }
info() { echo -e "${CYAN}$1${NC}"; }
success() { echo -e "${GREEN}$1${NC}"; }
warn() { echo -e "${YELLOW}$1${NC}"; }

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  Coolify One-Time Recovery Token Generator${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo ""

# Pre-flight
docker info >/dev/null 2>&1 || die "Cannot connect to Docker."
docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_DB}$" || die "Container '${CONTAINER_DB}' not running."

log_audit "TOKEN_GEN_ATTEMPT" "script started"

# ── Ensure recovery table exists ──────────────────────────────────────────────
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
    CREATE INDEX IF NOT EXISTS idx_recovery_token ON admin_recovery_tokens(token);
    -- Cleanup expired/used tokens older than 24h
    DELETE FROM admin_recovery_tokens WHERE created_at < NOW() - INTERVAL '24 hours';
" >/dev/null 2>&1

# ── Rate limit check ─────────────────────────────────────────────────────────
RECENT_TOKENS=$(docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" -t -A \
    -c "SELECT COUNT(*) FROM admin_recovery_tokens WHERE created_at > NOW() - INTERVAL '${RATE_LIMIT_WINDOW} seconds';" 2>/dev/null || echo "0")

if (( RECENT_TOKENS >= RATE_LIMIT_MAX )); then
    die "Rate limit: max ${RATE_LIMIT_MAX} tokens per hour. Wait and try again."
fi

# ── Get target email ──────────────────────────────────────────────────────────
TARGET_EMAIL=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --email|-e) TARGET_EMAIL="$2"; shift 2 ;;
        *) shift ;;
    esac
done

if [[ -z "$TARGET_EMAIL" ]]; then
    info "Existing users:"
    docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" -t \
        -c "SELECT id, email, name FROM users ORDER BY id;" 2>/dev/null
    echo ""
    read -rp "Enter email for recovery: " TARGET_EMAIL
fi

# Verify user exists
USER_EXISTS=$(docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" -t -A \
    -c "SELECT id FROM users WHERE email = '${TARGET_EMAIL}';" 2>/dev/null)
if [[ -z "$USER_EXISTS" ]]; then
    die "No user found with email: ${TARGET_EMAIL}"
fi

# ── Generate token ────────────────────────────────────────────────────────────
TOKEN=$(openssl rand -hex 32)
CREATED_BY=$(whoami)

docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" -c "
    INSERT INTO admin_recovery_tokens (token, email, expires_at, created_by)
    VALUES ('${TOKEN}', '${TARGET_EMAIL}', NOW() + INTERVAL '${TOKEN_EXPIRY_MINUTES} minutes', '${CREATED_BY}');
" >/dev/null 2>&1

log_audit "TOKEN_GENERATED" "email=${TARGET_EMAIL} token_prefix=${TOKEN:0:8}*** expires=${TOKEN_EXPIRY_MINUTES}m"

echo ""
success "═══════════════════════════════════════════════════"
success "  ✓ Recovery token generated"
success ""
success "  Email:   ${TARGET_EMAIL}"
success "  Expires: ${TOKEN_EXPIRY_MINUTES} minutes from now"
success "  Token:   ${TOKEN}"
success ""
success "  Recovery URL (localhost only):"
success "  http://127.0.0.1:8000/admin-recovery?token=${TOKEN}"
success "═══════════════════════════════════════════════════"
echo ""
warn "⚠  This token can be used ONCE only."
warn "⚠  After use, or after ${TOKEN_EXPIRY_MINUTES} minutes, it is invalid."
warn "⚠  The recovery page only works from localhost (127.0.0.1)."
echo ""
info "If using SSH tunnel:"
info "  ssh -L 8000:127.0.0.1:8000 your-server"
info "  Then open: http://localhost:8000/admin-recovery?token=${TOKEN}"
echo ""
