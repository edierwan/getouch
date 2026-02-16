#!/usr/bin/env bash
# ============================================================================
# Secrets Hardening for Getouch VPS
# Target: Ubuntu 24.04 with Docker Compose + .env files
#
# Audits & hardens sensitive files, secrets, and permissions.
# NVMe-safe: no heavy disk writes, just permissions & audit.
#
# Run as root: sudo bash 04-secrets-hardening.sh
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

ISSUES=0
FIXED=0

# ── Pre-flight ─────────────────────────────────────────────────────

if [[ $EUID -ne 0 ]]; then
  err "This script must be run as root (sudo)."
  exit 1
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Getouch Secrets Hardening Audit"
echo "═══════════════════════════════════════════════════"
echo ""

# ── 1. Lock down .env files ───────────────────────────────────────

info "Checking .env file permissions..."

ENV_DIRS=("/opt/getouch" "/opt/getouch/compose" "/opt/getouch/env")

for dir in "${ENV_DIRS[@]}"; do
  if [[ -d "$dir" ]]; then
    while IFS= read -r -d '' envfile; do
      current_perms=$(stat -c '%a' "$envfile" 2>/dev/null || stat -f '%Lp' "$envfile" 2>/dev/null)
      if [[ "$current_perms" != "600" ]]; then
        chmod 600 "$envfile"
        log "Fixed permissions on $envfile (was $current_perms, now 600)"
        ((FIXED++))
      else
        log "$envfile already restricted (600)"
      fi
    done < <(find "$dir" -maxdepth 2 -name ".env*" -type f -print0 2>/dev/null)
  fi
done

# ── 2. Restrict Docker daemon.json ────────────────────────────────

info "Checking Docker daemon config permissions..."

DAEMON_JSON="/etc/docker/daemon.json"
if [[ -f "$DAEMON_JSON" ]]; then
  current_perms=$(stat -c '%a' "$DAEMON_JSON" 2>/dev/null || stat -f '%Lp' "$DAEMON_JSON" 2>/dev/null)
  if [[ "$current_perms" != "600" && "$current_perms" != "644" ]]; then
    chmod 644 "$DAEMON_JSON"
    log "Fixed $DAEMON_JSON permissions (was $current_perms, now 644)"
    ((FIXED++))
  else
    log "$DAEMON_JSON permissions OK ($current_perms)"
  fi
fi

# ── 3. Restrict SSH config ────────────────────────────────────────

info "Checking SSH hardening..."

SSHD_CONFIG="/etc/ssh/sshd_config"
if [[ -f "$SSHD_CONFIG" ]]; then
  SSHD_CHANGES=0

  # Check PasswordAuthentication
  if grep -qE "^\s*PasswordAuthentication\s+yes" "$SSHD_CONFIG"; then
    warn "Password authentication is ENABLED in sshd_config"
    warn "Consider setting: PasswordAuthentication no"
    ((ISSUES++))
  elif grep -qE "^\s*PasswordAuthentication\s+no" "$SSHD_CONFIG"; then
    log "Password authentication is disabled"
  else
    warn "PasswordAuthentication not explicitly set"
    ((ISSUES++))
  fi

  # Check PermitRootLogin
  if grep -qE "^\s*PermitRootLogin\s+yes" "$SSHD_CONFIG"; then
    warn "Root login is ENABLED in sshd_config"
    warn "Consider setting: PermitRootLogin no"
    ((ISSUES++))
  elif grep -qE "^\s*PermitRootLogin\s+no" "$SSHD_CONFIG"; then
    log "Root login is disabled"
  else
    warn "PermitRootLogin not explicitly set"
    ((ISSUES++))
  fi

  # Check MaxAuthTries
  if ! grep -qE "^\s*MaxAuthTries" "$SSHD_CONFIG"; then
    warn "MaxAuthTries not set (default: 6). Consider: MaxAuthTries 3"
    ((ISSUES++))
  else
    log "MaxAuthTries is configured"
  fi
fi

# ── 4. Check for world-readable sensitive files ───────────────────

info "Scanning for world-readable secrets..."

SENSITIVE_PATTERNS=("*.key" "*.pem" "*.p12" "*secret*" "*credential*" "*password*")
SEARCH_DIRS=("/opt/getouch" "/etc/letsencrypt" "/root")

for dir in "${SEARCH_DIRS[@]}"; do
  if [[ -d "$dir" ]]; then
    for pattern in "${SENSITIVE_PATTERNS[@]}"; do
      while IFS= read -r -d '' file; do
        current_perms=$(stat -c '%a' "$file" 2>/dev/null || stat -f '%Lp' "$file" 2>/dev/null)
        if [[ "${current_perms: -1}" != "0" ]]; then
          warn "World-readable sensitive file: $file (perms: $current_perms)"
          chmod o-rwx "$file"
          log "  Fixed: removed world access on $file"
          ((FIXED++))
        fi
      done < <(find "$dir" -maxdepth 3 -name "$pattern" -type f -print0 2>/dev/null)
    done
  fi
done

# ── 5. Check Docker socket permissions ────────────────────────────

info "Checking Docker socket..."

DOCKER_SOCK="/var/run/docker.sock"
if [[ -S "$DOCKER_SOCK" ]]; then
  socket_group=$(stat -c '%G' "$DOCKER_SOCK" 2>/dev/null || stat -f '%Sg' "$DOCKER_SOCK" 2>/dev/null)
  if [[ "$socket_group" == "docker" ]]; then
    log "Docker socket owned by docker group"
  else
    warn "Docker socket owned by group: $socket_group (expected: docker)"
    ((ISSUES++))
  fi
fi

# ── 6. Audit Docker volumes for sensitive data ───────────────────

info "Checking Docker Compose for exposed ports..."

COMPOSE_FILES=("/opt/getouch/compose/docker-compose.yml"
               "/opt/getouch/compose/docker-compose.apps.yml"
               "/opt/getouch/compose/docker-compose.db.yml"
               "/opt/getouch/compose/docker-compose.mon.yml")

for cf in "${COMPOSE_FILES[@]}"; do
  if [[ -f "$cf" ]]; then
    # Check for ports exposed on 0.0.0.0 (all interfaces)
    if grep -E '^\s+- "?\d+:\d+"?' "$cf" | grep -vE '127\.0\.0\.1' >/dev/null 2>&1; then
      warn "Ports in $cf may be exposed on all interfaces!"
      warn "  Ensure all ports are bound to 127.0.0.1"
      grep -nE '^\s+- "?\d+:\d+"?' "$cf" | grep -vE '127\.0\.0\.1' | head -5
      ((ISSUES++))
    else
      log "$(basename "$cf"): All ports bound to localhost ✓"
    fi
  fi
done

# ── 7. Check unattended-upgrades ──────────────────────────────────

info "Checking automatic security updates..."

if dpkg -l | grep -q unattended-upgrades 2>/dev/null; then
  if systemctl is-active --quiet unattended-upgrades 2>/dev/null; then
    log "unattended-upgrades is active"
  else
    warn "unattended-upgrades installed but not active"
    warn "  Enable: dpkg-reconfigure -plow unattended-upgrades"
    ((ISSUES++))
  fi
else
  warn "unattended-upgrades not installed"
  warn "  Install: apt install unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades"
  ((ISSUES++))
fi

# ── Summary ───────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Secrets Hardening Summary"
echo "═══════════════════════════════════════════════════"
echo ""
echo "  Issues found:   $ISSUES"
echo "  Auto-fixed:     $FIXED"
echo ""

if [[ $ISSUES -gt 0 ]]; then
  warn "Review the warnings above and apply fixes manually."
else
  log "All checks passed!"
fi
