#!/usr/bin/env bash
# ============================================================================
# UFW Firewall Hardening for Getouch VPS
# Target: Ubuntu 24.04 with Docker + Tailscale + Cloudflare Tunnel
#
# Architecture:
#   Internet → Cloudflare Edge (TLS) → cloudflared (outbound tunnel) → Caddy
#   Admin    → Tailscale (100.x.x.x)  → SSH / pgAdmin / Grafana
#
# This script hardens the host firewall. Since cloudflared connects OUTBOUND
# to Cloudflare's edge network, NO inbound ports are needed for web traffic.
# Only Tailscale (for admin SSH) needs inbound access.
#
# Run as root: sudo bash harden-ufw.sh
# ============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*"; }

# ── Pre-flight checks ─────────────────────────────────────────────

if [[ $EUID -ne 0 ]]; then
  err "This script must be run as root (sudo)."
  exit 1
fi

if ! command -v ufw &>/dev/null; then
  warn "UFW not installed. Installing..."
  apt-get update -qq && apt-get install -yqq ufw
fi

# ── Detect Tailscale interface & subnet ────────────────────────────

TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || true)
if [[ -z "$TAILSCALE_IP" ]]; then
  warn "Tailscale not detected. Using default Tailscale CGNAT range 100.64.0.0/10"
  TAILSCALE_SUBNET="100.64.0.0/10"
else
  log "Tailscale IP detected: $TAILSCALE_IP"
  TAILSCALE_SUBNET="100.64.0.0/10"
fi

# ── Docker + UFW compatibility ─────────────────────────────────────
# Docker manipulates iptables directly, bypassing UFW. To prevent Docker
# from punching holes in the firewall, we configure the Docker daemon
# to NOT manipulate iptables and rely on docker-proxy for port forwarding.
# Since all our ports are bound to 127.0.0.1, this is safe.

DOCKER_DAEMON_JSON="/etc/docker/daemon.json"
if [[ -f "$DOCKER_DAEMON_JSON" ]]; then
  if ! grep -q '"iptables": false' "$DOCKER_DAEMON_JSON" 2>/dev/null; then
    warn "Docker daemon.json exists but does not disable iptables."
    warn "Review $DOCKER_DAEMON_JSON manually and add: \"iptables\": false"
    warn "Then restart Docker: systemctl restart docker"
  else
    log "Docker iptables already disabled in daemon.json"
  fi
else
  warn "No $DOCKER_DAEMON_JSON found."
  warn "After this script, consider creating it with:"
  warn '  { "iptables": false, "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }'
  warn "Then: systemctl restart docker"
fi

# ── Reset UFW to clean state ──────────────────────────────────────

warn "Resetting UFW to clean state..."
ufw --force reset

# ── Default policies ──────────────────────────────────────────────

ufw default deny incoming
ufw default allow outgoing
log "Default policies: deny incoming, allow outgoing"

# ── Allow SSH from Tailscale only ─────────────────────────────────
# This is the critical rule — SSH is only accessible via Tailscale VPN.

ufw allow from "$TAILSCALE_SUBNET" to any port 22 proto tcp comment "SSH via Tailscale"
log "SSH (22/tcp) allowed from Tailscale ($TAILSCALE_SUBNET)"

# ── Allow Tailscale UDP (WireGuard) ───────────────────────────────
# Tailscale uses UDP 41641 for direct connections. Without this,
# Tailscale falls back to DERP relays (slower).

ufw allow 41641/udp comment "Tailscale WireGuard"
log "Tailscale WireGuard (41641/udp) allowed"

# ── Allow LAN access (optional — for local admin from same network) ─
# Uncomment if you want to access pgAdmin/Grafana from LAN without Tailscale.
# ufw allow from 192.168.0.0/16 to any port 22 proto tcp comment "SSH from LAN"
# ufw allow from 10.0.0.0/8 to any port 22 proto tcp comment "SSH from LAN"

# ── Enable UFW ────────────────────────────────────────────────────

warn "Enabling UFW (this will apply rules NOW)..."
ufw --force enable
log "UFW enabled and active"

# ── Display status ────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════"
echo "  UFW Status"
echo "═══════════════════════════════════════════════════"
ufw status verbose
echo ""

# ── Verification ──────────────────────────────────────────────────

echo "═══════════════════════════════════════════════════"
echo "  Verification Checklist"
echo "═══════════════════════════════════════════════════"
echo ""
echo "  1. From another terminal (via Tailscale), verify SSH still works:"
echo "     ssh deploy@$TAILSCALE_IP"
echo ""
echo "  2. Verify Docker containers are running:"
echo "     docker ps"
echo ""
echo "  3. Verify cloudflared tunnel is healthy:"
echo "     docker logs cloudflared --tail 20"
echo ""
echo "  4. Test web access via Cloudflare tunnel:"
echo "     curl -sI https://getouch.co"
echo ""
echo "  5. Verify NO public ports are exposed:"
echo "     ss -tlnp | grep -v '127.0.0.1'"
echo ""

log "Firewall hardening complete."
echo ""
warn "IMPORTANT: Keep your current SSH session open until you verify"
warn "that you can still connect via Tailscale from another terminal!"
