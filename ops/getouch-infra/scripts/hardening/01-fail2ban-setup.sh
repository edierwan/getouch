#!/usr/bin/env bash
# ============================================================================
# Fail2ban Setup for Getouch VPS
# Target: Ubuntu 24.04 with Docker + Tailscale + Cloudflare Tunnel
#
# Protects against brute-force SSH attacks by banning IPs after repeated
# failed login attempts. Tailscale IPs (100.64.0.0/10) are whitelisted.
#
# Run as root: sudo bash 01-fail2ban-setup.sh
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

# ── Install Fail2ban ───────────────────────────────────────────────

if ! command -v fail2ban-client &>/dev/null; then
  log "Installing Fail2ban..."
  apt-get update -qq && apt-get install -yqq fail2ban
else
  log "Fail2ban already installed"
fi

# ── Create jail.local config ──────────────────────────────────────

JAIL_LOCAL="/etc/fail2ban/jail.local"

cat > "$JAIL_LOCAL" << 'EOF'
# ============================================================================
# Getouch Fail2ban Configuration
# ============================================================================

[DEFAULT]
# Ban duration: 1 hour
bantime  = 3600
# Detection window: 10 minutes
findtime = 600
# Max retries before ban
maxretry = 5
# Whitelist Tailscale CGNAT + localhost
ignoreip = 127.0.0.1/8 ::1 100.64.0.0/10
# Use systemd backend (Ubuntu 24.04)
backend  = systemd
# Ban action: use UFW for banning
banaction = ufw

[sshd]
enabled  = true
port     = ssh
filter   = sshd
logpath  = /var/log/auth.log
maxretry = 3
bantime  = 7200
findtime = 600
EOF

log "Created $JAIL_LOCAL"

# ── Enable & start Fail2ban ───────────────────────────────────────

systemctl enable fail2ban
systemctl restart fail2ban

log "Fail2ban enabled and started"

# ── Status ────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Fail2ban Status"
echo "═══════════════════════════════════════════════════"
fail2ban-client status
echo ""
fail2ban-client status sshd
echo ""

log "Fail2ban setup complete."
echo ""
echo "  Useful commands:"
echo "  • fail2ban-client status sshd        — Check SSH jail"
echo "  • fail2ban-client set sshd unbanip X  — Unban an IP"
echo "  • fail2ban-client banned              — List all bans"
echo "  • journalctl -u fail2ban -f           — Follow logs"
