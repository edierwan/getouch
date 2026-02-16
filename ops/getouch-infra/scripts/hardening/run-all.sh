#!/usr/bin/env bash
# ============================================================================
# Run All Hardening Scripts for Getouch VPS
# Target: Ubuntu 24.04 with Docker + Tailscale + Cloudflare Tunnel
#
# This script runs all hardening steps in sequence.
# The existing harden-ufw.sh in ../harden-ufw.sh handles UFW setup.
#
# Run as root: sudo bash run-all.sh
# ============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*"; }
info() { echo -e "${CYAN}[i]${NC} $*"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Pre-flight ─────────────────────────────────────────────────────

if [[ $EUID -ne 0 ]]; then
  err "This script must be run as root (sudo)."
  exit 1
fi

echo ""
echo "╔═══════════════════════════════════════════════════╗"
echo "║  Getouch VPS Hardening — Full Suite               ║"
echo "╠═══════════════════════════════════════════════════╣"
echo "║  1. UFW Firewall          (../harden-ufw.sh)      ║"
echo "║  2. Fail2ban              (01-fail2ban-setup.sh)   ║"
echo "║  3. Docker Log Rotation   (02-docker-log-rotation) ║"
echo "║  4. Prometheus Alerts     (03-prometheus-alerts)    ║"
echo "║  5. Secrets Hardening     (04-secrets-hardening)    ║"
echo "╚═══════════════════════════════════════════════════╝"
echo ""

read -p "Proceed with all hardening steps? (y/N): " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  info "Aborted."
  exit 0
fi

PASSED=0
FAILED=0

run_step() {
  local step_name="$1"
  local script_path="$2"

  echo ""
  echo "────────────────────────────────────────────────────"
  info "Step: $step_name"
  echo "────────────────────────────────────────────────────"

  if [[ -f "$script_path" ]]; then
    if bash "$script_path"; then
      log "$step_name — DONE"
      ((PASSED++))
    else
      err "$step_name — FAILED (exit code $?)"
      ((FAILED++))
    fi
  else
    err "Script not found: $script_path"
    ((FAILED++))
  fi
}

# ── Step 1: UFW ────────────────────────────────────────────────────

UFW_SCRIPT="$SCRIPT_DIR/../harden-ufw.sh"
run_step "UFW Firewall Hardening" "$UFW_SCRIPT"

# ── Step 2: Fail2ban ───────────────────────────────────────────────

run_step "Fail2ban Setup" "$SCRIPT_DIR/01-fail2ban-setup.sh"

# ── Step 3: Docker Log Rotation ───────────────────────────────────

run_step "Docker Log Rotation" "$SCRIPT_DIR/02-docker-log-rotation.sh"

# ── Step 4: Prometheus Alerts ─────────────────────────────────────

run_step "Prometheus Alert Rules" "$SCRIPT_DIR/03-prometheus-alerts.sh"

# ── Step 5: Secrets Hardening ─────────────────────────────────────

run_step "Secrets Hardening" "$SCRIPT_DIR/04-secrets-hardening.sh"

# ── Summary ───────────────────────────────────────────────────────

echo ""
echo "╔═══════════════════════════════════════════════════╗"
echo "║  Hardening Complete                                ║"
echo "╠═══════════════════════════════════════════════════╣"
echo "║  Passed: $PASSED / $((PASSED + FAILED))                                      ║"
if [[ $FAILED -gt 0 ]]; then
echo "║  Failed: $FAILED — review output above               ║"
fi
echo "╚═══════════════════════════════════════════════════╝"
echo ""

# ── Post-hardening reminders ──────────────────────────────────────

warn "═══ POST-HARDENING CHECKLIST ═══"
echo ""
warn "1. Restart Docker (in maintenance window):"
warn "   systemctl restart docker"
echo ""
warn "2. Restart Prometheus to load alert rules:"
warn "   cd /opt/getouch && docker compose -f compose/docker-compose.mon.yml restart prometheus"
echo ""
warn "3. Verify SSH access (from ANOTHER terminal via Tailscale):"
warn "   ssh deploy@<tailscale-ip>"
echo ""
warn "4. Verify web access:"
warn "   curl -sI https://getouch.co"
echo ""
warn "5. Check Fail2ban status:"
warn "   fail2ban-client status sshd"
echo ""

if [[ $FAILED -gt 0 ]]; then
  exit 1
fi
