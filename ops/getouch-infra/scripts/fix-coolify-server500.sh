#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# fix-coolify-server500.sh — Fix Coolify 500 error on server/show page
#
# Error: "Call to a member function isNotEmpty() on null"
# Cause: server record has NULL proxy/settings in the database
# Fix:   Run migrations + seed missing server_settings rows
#
# Usage:  sudo bash fix-coolify-server500.sh
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

CONTAINER="coolify"

echo "══════════════════════════════════════════════════════"
echo "  Fix Coolify 500 — Server Show Page"
echo "══════════════════════════════════════════════════════"
echo ""

# 0. Pre-check
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "❌ Container '${CONTAINER}' is not running."
  echo "   Start the stack first:  docker compose -f docker-compose.coolify.yml up -d"
  exit 1
fi

# 1. Run any pending database migrations
echo "[1/4] Running pending database migrations…"
docker exec "${CONTAINER}" php artisan migrate --force 2>&1 || {
  echo "       ⚠ migrate had warnings (may be fine if already migrated)"
}
echo "       ✓ Migrations complete"

# 2. Fix NULL server_settings rows
echo "[2/4] Fixing NULL server_settings…"
docker exec "${CONTAINER}" php artisan tinker --execute="
  \$servers = \App\Models\Server::all();
  foreach (\$servers as \$server) {
    if (!\$server->settings) {
      \App\Models\Server\ServerSetting::create([
        'server_id' => \$server->id,
      ]);
      echo \"  → Created settings for server: {\$server->name} (id: {\$server->id})\n\";
    } else {
      echo \"  ✓ Server {\$server->name} already has settings\n\";
    }
  }
" 2>&1
echo "       ✓ Server settings fixed"

# 3. Fix NULL proxy field on servers
echo "[3/4] Fixing NULL proxy configuration on servers…"
docker exec "${CONTAINER}" php artisan tinker --execute="
  \$servers = \App\Models\Server::all();
  foreach (\$servers as \$server) {
    try {
      if (is_null(\$server->proxy)) {
        \$server->proxy = new \App\Models\Server\Proxy([
          'type' => 'TRAEFIK_V2',
          'status' => 'stopped',
        ]);
        \$server->save();
        echo \"  → Set proxy defaults for server: {\$server->name}\n\";
      } else {
        echo \"  ✓ Server {\$server->name} proxy OK\n\";
      }
    } catch (\Throwable \$e) {
      echo \"  ⚠ Server {\$server->name}: \" . \$e->getMessage() . \"\n\";
    }
  }
" 2>&1
echo "       ✓ Proxy config fixed"

# 4. Clear all caches
echo "[4/4] Clearing Laravel caches…"
docker exec "${CONTAINER}" php artisan cache:clear   2>&1
docker exec "${CONTAINER}" php artisan config:clear  2>&1
docker exec "${CONTAINER}" php artisan view:clear    2>&1
docker exec "${CONTAINER}" php artisan route:clear   2>&1
echo "       ✓ Caches cleared"

echo ""
echo "══════════════════════════════════════════════════════"
echo "  ✓ Fix complete — refresh https://coolify.getouch.co"
echo "  Try clicking Getouch-Coolify server again."
echo "══════════════════════════════════════════════════════"
