#!/usr/bin/env bash
# ============================================================================
# Prometheus Alert Rules Setup for Getouch VPS
# Target: Ubuntu 24.04 with Docker-based Prometheus
#
# Deploys alert-rules.yml to Prometheus config directory and updates
# prometheus.yml to reference the rules file.
#
# ⚠️ Does NOT restart Prometheus automatically.
#    After running: docker compose -f docker-compose.mon.yml restart prometheus
#
# Run as root: sudo bash 03-prometheus-alerts.sh
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

PROM_DIR="/opt/getouch/monitoring"
ALERT_RULES_SRC="$(cd "$(dirname "$0")/../.." && pwd)/config/alerting/alert-rules.yml"
ALERT_RULES_DST="$PROM_DIR/alert-rules.yml"
PROM_CONFIG="$PROM_DIR/prometheus.yml"

# ── Ensure directories exist ──────────────────────────────────────

mkdir -p "$PROM_DIR"

# ── Deploy alert rules ────────────────────────────────────────────

if [[ -f "$ALERT_RULES_SRC" ]]; then
  cp "$ALERT_RULES_SRC" "$ALERT_RULES_DST"
  log "Deployed alert-rules.yml → $ALERT_RULES_DST"
else
  err "Alert rules source not found: $ALERT_RULES_SRC"
  err "Expected at: config/alerting/alert-rules.yml relative to repo root"
  exit 1
fi

# ── Update prometheus.yml to reference alert rules ────────────────

if [[ -f "$PROM_CONFIG" ]]; then
  if grep -q "rule_files" "$PROM_CONFIG"; then
    # Check if alert-rules.yml is already referenced
    if grep -q "alert-rules.yml" "$PROM_CONFIG"; then
      log "prometheus.yml already references alert-rules.yml"
    else
      warn "prometheus.yml has rule_files but does not reference alert-rules.yml"
      warn "Please add the following to your prometheus.yml under rule_files:"
      warn "  - '/etc/prometheus/alert-rules.yml'"
    fi
  else
    # Add rule_files section after global section
    BACKUP="${PROM_CONFIG}.backup.$(date +%Y%m%d%H%M%S)"
    cp "$PROM_CONFIG" "$BACKUP"
    log "Backed up prometheus.yml → $BACKUP"

    # Insert rule_files after the evaluation_interval line
    sed -i '/evaluation_interval/a\\nrule_files:\n  - "/etc/prometheus/alert-rules.yml"' "$PROM_CONFIG"
    log "Added rule_files directive to prometheus.yml"
  fi
else
  warn "prometheus.yml not found at $PROM_CONFIG"
  warn "Please add the following to your prometheus.yml:"
  warn ""
  warn "  rule_files:"
  warn "    - '/etc/prometheus/alert-rules.yml'"
fi

# ── Update docker-compose to mount alert rules ───────────────────

echo ""
warn "Ensure your docker-compose.mon.yml mounts the alert rules file."
warn "Add this volume to the prometheus service:"
warn "  - /opt/getouch/monitoring/alert-rules.yml:/etc/prometheus/alert-rules.yml:ro"
echo ""

# ── Validate rules (if promtool available) ────────────────────────

if command -v promtool &>/dev/null; then
  if promtool check rules "$ALERT_RULES_DST"; then
    log "Alert rules validated with promtool"
  else
    err "Alert rules validation failed!"
    exit 1
  fi
else
  warn "promtool not available on host. Validate via Docker:"
  warn "  docker exec prometheus promtool check rules /etc/prometheus/alert-rules.yml"
fi

# ── Summary ───────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Prometheus Alerts Setup Complete"
echo "═══════════════════════════════════════════════════"
echo ""
echo "  Alert rules deployed to: $ALERT_RULES_DST"
echo ""
echo "  Alert categories:"
echo "    • Host: CPU, Memory, Disk, I/O"
echo "    • Container: Down, High CPU/Memory, Restarts"
echo "    • Network: Traffic spikes, Exporter down"
echo "    • Prometheus: Target down, Rule failures"
echo ""
warn "  Restart Prometheus to load rules:"
warn "  cd /opt/getouch && docker compose -f compose/docker-compose.mon.yml restart prometheus"
