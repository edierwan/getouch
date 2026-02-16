#!/usr/bin/env bash
# ============================================================================
# Docker Log Rotation for Getouch VPS
# Target: Ubuntu 24.04 with Docker Engine
#
# Configures Docker daemon to use json-file logging with size + count limits.
# Prevents log files from consuming all disk space on NVMe.
#
# ⚠️ This script writes daemon.json but does NOT restart Docker automatically.
#    You must restart Docker manually during a maintenance window:
#      systemctl restart docker
#
# Run as root: sudo bash 02-docker-log-rotation.sh
# ============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*"; }

# ── Pre-flight ─────────────────────────────────────────────────────

if [[ $EUID -ne 0 ]]; then
  err "This script must be run as root (sudo)."
  exit 1
fi

DAEMON_JSON="/etc/docker/daemon.json"

# ── Backup existing config ────────────────────────────────────────

if [[ -f "$DAEMON_JSON" ]]; then
  BACKUP="${DAEMON_JSON}.backup.$(date +%Y%m%d%H%M%S)"
  cp "$DAEMON_JSON" "$BACKUP"
  log "Backed up existing daemon.json → $BACKUP"
fi

# ── Merge or create daemon.json ───────────────────────────────────
# We use jq to merge if present, otherwise write fresh.

if command -v jq &>/dev/null && [[ -f "$DAEMON_JSON" ]]; then
  # Merge log settings into existing config
  EXISTING=$(cat "$DAEMON_JSON")
  echo "$EXISTING" | jq '
    . + {
      "log-driver": "json-file",
      "log-opts": {
        "max-size": "10m",
        "max-file": "5"
      },
      "iptables": false
    }
  ' > "$DAEMON_JSON"
  log "Merged log-rotation settings into existing daemon.json"
else
  # Write fresh config
  cat > "$DAEMON_JSON" << 'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "5"
  },
  "iptables": false
}
EOF
  log "Created $DAEMON_JSON with log-rotation settings"
fi

# ── Validate JSON ─────────────────────────────────────────────────

if command -v jq &>/dev/null; then
  if jq empty "$DAEMON_JSON" 2>/dev/null; then
    log "daemon.json is valid JSON"
  else
    err "daemon.json is NOT valid JSON — fix before restarting Docker!"
    exit 1
  fi
fi

# ── Show current config ───────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Docker Daemon Configuration"
echo "═══════════════════════════════════════════════════"
cat "$DAEMON_JSON"
echo ""

# ── Check current log disk usage ──────────────────────────────────

echo "═══════════════════════════════════════════════════"
echo "  Current Docker Log Disk Usage"
echo "═══════════════════════════════════════════════════"
TOTAL_LOG_SIZE=$(find /var/lib/docker/containers -name "*-json.log" -exec du -sh {} + 2>/dev/null | sort -rh | head -20 || echo "  (no logs found or permission denied)")
echo "$TOTAL_LOG_SIZE"
echo ""

warn "⚠️  Docker restart required to apply changes!"
warn "    Run during a maintenance window:"
warn "      systemctl restart docker"
echo ""
warn "    Existing log files won't be truncated automatically."
warn "    To manually truncate a large log:"
warn "      truncate -s 0 /var/lib/docker/containers/<id>/<id>-json.log"
echo ""

log "Docker log rotation configured. Restart Docker to apply."
