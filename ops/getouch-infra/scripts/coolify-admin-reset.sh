#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Coolify Admin Password Reset — CLI (Option A)
#
# Resets or creates an admin user in the Coolify instance.
# Must be run on the server with Docker access (root / sudo).
#
# Usage:
#   sudo bash coolify-admin-reset.sh                          # interactive
#   sudo bash coolify-admin-reset.sh --email edierwan@gmail.com  # non-interactive
#
# Security:
#   - Requires server-level access (CLI only — not exposed to internet)
#   - Logs every invocation to /data/coolify/recovery-audit.log
#   - Never prints or stores old password
#   - Rate-limited: max 5 resets per hour
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
CONTAINER_COOLIFY="coolify"
CONTAINER_DB="coolify-db"
DB_NAME="coolify"
DB_USER="coolify"
DB_PASS="coolify"
AUDIT_LOG="/data/coolify/recovery-audit.log"
RATE_LIMIT_MAX=5
RATE_LIMIT_WINDOW=3600  # seconds (1 hour)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── Helpers ───────────────────────────────────────────────────────────────────
log_audit() {
    local action="$1"
    local detail="$2"
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local ip
    ip=$(who am i 2>/dev/null | awk '{print $NF}' | tr -d '()' || echo "console")
    local user
    user=$(whoami)
    mkdir -p "$(dirname "$AUDIT_LOG")"
    echo "${ts} | action=${action} | user=${user} | ip=${ip} | ${detail}" >> "$AUDIT_LOG"
}

die() { echo -e "${RED}ERROR: $1${NC}" >&2; log_audit "ERROR" "$1"; exit 1; }
info() { echo -e "${CYAN}$1${NC}"; }
success() { echo -e "${GREEN}$1${NC}"; }
warn() { echo -e "${YELLOW}$1${NC}"; }

check_rate_limit() {
    if [[ ! -f "$AUDIT_LOG" ]]; then return 0; fi
    local count
    count=$(awk -v cutoff="$(date -u -v-${RATE_LIMIT_WINDOW}S +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "-${RATE_LIMIT_WINDOW} seconds" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "1970-01-01T00:00:00Z")" \
        '$0 ~ /action=RESET_SUCCESS|action=RESET_ATTEMPT/ && $1 >= cutoff' "$AUDIT_LOG" | wc -l)
    if (( count >= RATE_LIMIT_MAX )); then
        die "Rate limit exceeded. ${RATE_LIMIT_MAX} resets allowed per hour. Try again later."
    fi
}

# ── Pre-flight checks ────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  Coolify Admin Password Reset (CLI)${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo ""

# Must be root or have docker access
if ! docker info >/dev/null 2>&1; then
    die "Cannot connect to Docker. Run with sudo or as a user in the docker group."
fi

# Verify containers running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_COOLIFY}$"; then
    die "Container '${CONTAINER_COOLIFY}' is not running. Start it first."
fi

check_rate_limit
log_audit "RESET_ATTEMPT" "script started"

# ── Step 1: List existing users ──────────────────────────────────────────────
info "Fetching existing Coolify users…"
echo ""

USER_LIST=$(docker exec "$CONTAINER_COOLIFY" php artisan tinker --execute="
    \$users = \App\Models\User::select('id','name','email','created_at')->get();
    foreach (\$users as \$u) {
        echo \$u->id . ' | ' . \$u->email . ' | ' . \$u->name . ' | created: ' . \$u->created_at . PHP_EOL;
    }
    if (\$users->isEmpty()) { echo 'NO_USERS_FOUND' . PHP_EOL; }
" 2>/dev/null || echo "TINKER_FAILED")

if [[ "$USER_LIST" == *"TINKER_FAILED"* ]]; then
    # Fallback: query DB directly
    warn "Artisan tinker unavailable, querying database directly…"
    USER_LIST=$(docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" -t -A \
        -c "SELECT id || ' | ' || email || ' | ' || name || ' | created: ' || created_at FROM users ORDER BY id;" 2>/dev/null \
        || echo "DB_QUERY_FAILED")
    if [[ "$USER_LIST" == *"DB_QUERY_FAILED"* ]] || [[ -z "$USER_LIST" ]]; then
        die "Cannot query users from either artisan or database. Check containers."
    fi
fi

if [[ "$USER_LIST" == *"NO_USERS_FOUND"* ]] || [[ -z "${USER_LIST// /}" ]]; then
    warn "No users found in Coolify database."
    echo ""
    warn "This means Coolify has never been set up. We'll CREATE a new admin."
    CREATE_NEW=true
else
    echo -e "${GREEN}Existing users:${NC}"
    echo "──────────────────────────────────────────────────"
    echo "ID | Email | Name | Created"
    echo "──────────────────────────────────────────────────"
    echo "$USER_LIST"
    echo "──────────────────────────────────────────────────"
    echo ""
    CREATE_NEW=false
fi

# ── Step 2: Get target email ─────────────────────────────────────────────────
TARGET_EMAIL=""

# Check CLI argument
while [[ $# -gt 0 ]]; do
    case $1 in
        --email|-e) TARGET_EMAIL="$2"; shift 2 ;;
        *) shift ;;
    esac
done

if [[ -z "$TARGET_EMAIL" ]]; then
    if [[ "$CREATE_NEW" == "true" ]]; then
        read -rp "Enter email for the new admin user: " TARGET_EMAIL
    else
        read -rp "Enter the email of the user to reset (or a new email to create): " TARGET_EMAIL
    fi
fi

# Validate email format
if [[ ! "$TARGET_EMAIL" =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; then
    die "Invalid email format: $TARGET_EMAIL"
fi

info "Target email: $TARGET_EMAIL"

# ── Step 3: Get new password ─────────────────────────────────────────────────
echo ""
while true; do
    read -rsp "Enter new password (min 8 chars): " NEW_PASS
    echo ""

    if [[ ${#NEW_PASS} -lt 8 ]]; then
        warn "Password must be at least 8 characters. Try again."
        continue
    fi

    read -rsp "Confirm new password: " CONFIRM_PASS
    echo ""

    if [[ "$NEW_PASS" != "$CONFIRM_PASS" ]]; then
        warn "Passwords do not match. Try again."
        continue
    fi

    break
done

# ── Step 4: Apply the reset / create ─────────────────────────────────────────
info "Applying password change…"

# Escape single quotes in password for PHP
ESCAPED_PASS="${NEW_PASS//\'/\\\'}"

RESULT=$(docker exec "$CONTAINER_COOLIFY" php artisan tinker --execute="
    use App\Models\User;
    use Illuminate\Support\Facades\Hash;

    \$user = User::where('email', '${TARGET_EMAIL}')->first();
    if (\$user) {
        \$user->password = Hash::make('${ESCAPED_PASS}');
        \$user->save();
        echo 'RESET_OK|' . \$user->id;
    } else {
        // Create new admin user
        \$user = User::create([
            'name'     => explode('@', '${TARGET_EMAIL}')[0],
            'email'    => '${TARGET_EMAIL}',
            'password' => Hash::make('${ESCAPED_PASS}'),
        ]);
        echo 'CREATED_OK|' . \$user->id;
    }
" 2>/dev/null || echo "TINKER_FAILED")

if [[ "$RESULT" == *"TINKER_FAILED"* ]]; then
    # Fallback: use direct DB update (bcrypt via PHP inside container)
    warn "Tinker approach failed, trying direct DB…"

    BCRYPT_HASH=$(docker exec "$CONTAINER_COOLIFY" php -r "echo password_hash('${ESCAPED_PASS}', PASSWORD_BCRYPT);" 2>/dev/null)

    if [[ -z "$BCRYPT_HASH" ]]; then
        die "Could not generate password hash. Check the Coolify container."
    fi

    # Check if user exists
    EXISTS=$(docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" -t -A \
        -c "SELECT id FROM users WHERE email = '${TARGET_EMAIL}';" 2>/dev/null)

    if [[ -n "$EXISTS" ]]; then
        docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" \
            -c "UPDATE users SET password = '${BCRYPT_HASH}' WHERE email = '${TARGET_EMAIL}';" >/dev/null 2>&1
        RESULT="RESET_OK|${EXISTS}"
    else
        docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" \
            -c "INSERT INTO users (name, email, password, created_at, updated_at)
                VALUES ('$(echo "${TARGET_EMAIL}" | cut -d@ -f1)', '${TARGET_EMAIL}', '${BCRYPT_HASH}', NOW(), NOW());" >/dev/null 2>&1
        NEW_ID=$(docker exec "$CONTAINER_DB" psql -U "$DB_USER" -d "$DB_NAME" -t -A \
            -c "SELECT id FROM users WHERE email = '${TARGET_EMAIL}';" 2>/dev/null)
        RESULT="CREATED_OK|${NEW_ID}"
    fi
fi

# ── Step 5: Report result ────────────────────────────────────────────────────
echo ""
if [[ "$RESULT" == *"RESET_OK"* ]]; then
    USER_ID=$(echo "$RESULT" | grep -oP '(?<=RESET_OK\|)\d+' || echo "unknown")
    success "═══════════════════════════════════════════════════"
    success "  ✓ Password RESET successfully"
    success "    Email:   ${TARGET_EMAIL}"
    success "    User ID: ${USER_ID}"
    success "═══════════════════════════════════════════════════"
    log_audit "RESET_SUCCESS" "email=${TARGET_EMAIL} user_id=${USER_ID}"
elif [[ "$RESULT" == *"CREATED_OK"* ]]; then
    USER_ID=$(echo "$RESULT" | grep -oP '(?<=CREATED_OK\|)\d+' || echo "unknown")
    success "═══════════════════════════════════════════════════"
    success "  ✓ Admin user CREATED successfully"
    success "    Email:   ${TARGET_EMAIL}"
    success "    User ID: ${USER_ID}"
    success "═══════════════════════════════════════════════════"
    log_audit "CREATE_SUCCESS" "email=${TARGET_EMAIL} user_id=${USER_ID}"
else
    die "Unexpected result: ${RESULT}"
fi

echo ""
info "You can now log in at: https://coolify.getouch.co"
info "Audit log: ${AUDIT_LOG}"
echo ""
