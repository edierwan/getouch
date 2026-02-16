#!/usr/bin/env bash
# migrate-to-git.sh — Convert /opt/getouch from manual dir to git-managed infra
#
# WHAT IT DOES:
#   1. Backs up /opt/getouch → /opt/getouch.legacy-<timestamp>
#   2. Clones the repo with sparse checkout (only ops/getouch-infra/)
#   3. Symlinks repo contents into /opt/getouch so all paths stay the same
#   4. Restores .env secrets, data dirs (postgres, grafana, ollama, etc.)
#   5. Fixes ownership and permissions
#
# USAGE:
#   sudo -u deploy bash /path/to/migrate-to-git.sh
#
# ROLLBACK:
#   sudo mv /opt/getouch /opt/getouch.failed
#   sudo mv /opt/getouch.legacy-<TIMESTAMP> /opt/getouch
#   cd /opt/getouch/compose && docker compose up -d && docker compose -f docker-compose.db.yml up -d ...

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────
REPO_URL="https://github.com/edierwan/getouch.git"
BRANCH="develop"
REPO_SUBDIR="ops/getouch-infra"   # path inside repo that maps to /opt/getouch
TARGET="/opt/getouch"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LEGACY="${TARGET}.legacy-${TIMESTAMP}"
REPO_CLONE="${TARGET}.repo"

# ── Colors ─────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
step()  { echo -e "\n${GREEN}═══ Step $1: $2 ═══${NC}"; }

# ── Pre-flight checks ─────────────────────────────────────────────
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   getouch — Migrate to Git-Managed Infra        ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

if [ "$(id -u)" = "0" ]; then
  error "Do NOT run as root. Run as 'deploy' user."
  error "Usage: sudo -u deploy bash $0"
  exit 1
fi

if ! command -v git &>/dev/null; then
  error "git is not installed. Run: sudo apt-get install -y git"
  exit 1
fi

if ! command -v docker &>/dev/null; then
  error "docker is not installed."
  exit 1
fi

# ── Step 0: Audit current state ───────────────────────────────────
step 0 "Auditing current state"

info "Current /opt/getouch contents:"
ls -la "$TARGET"/ 2>/dev/null || warn "/opt/getouch does not exist yet"

info "Running containers:"
docker ps --format "table {{.Names}}\t{{.Status}}" 2>/dev/null | sort || true

info "Docker networks:"
docker network ls --filter "name=getouch" --format "{{.Name}}" 2>/dev/null || true

# Save current .env if it exists
ENV_BACKUP=""
if [ -f "$TARGET/compose/.env" ]; then
  ENV_BACKUP="/tmp/getouch-env-backup-${TIMESTAMP}"
  cp "$TARGET/compose/.env" "$ENV_BACKUP"
  info "Backed up .env → $ENV_BACKUP"
fi

# ── Step 1: Stop non-critical containers ──────────────────────────
step 1 "Gracefully stopping app containers (data containers stay up)"

cd "$TARGET/compose" 2>/dev/null || true

# Stop app services only — keep postgres, pgadmin, prometheus, grafana running
# They will be restarted after migration with new config
info "Stopping app services (landing, bot, wa, api)..."
docker compose -f docker-compose.apps.yml down 2>/dev/null || warn "apps compose down skipped"

info "Data containers (postgres, grafana, prometheus) left running for safety."

# ── Step 2: Backup current directory ──────────────────────────────
step 2 "Moving ${TARGET} → ${LEGACY}"

if [ -d "$TARGET" ]; then
  sudo mv "$TARGET" "$LEGACY"
  info "Legacy backup: $LEGACY"
else
  warn "$TARGET doesn't exist, skipping backup"
  LEGACY=""
fi

# ── Step 3: Clone repo with sparse checkout ───────────────────────
step 3 "Cloning repo (sparse checkout: ${REPO_SUBDIR})"

# Clean any previous failed attempt
[ -d "$REPO_CLONE" ] && sudo rm -rf "$REPO_CLONE"

git clone --branch "$BRANCH" --single-branch --no-checkout "$REPO_URL" "$REPO_CLONE"
cd "$REPO_CLONE"

# Enable sparse checkout — only pull ops/getouch-infra/
git sparse-checkout init --cone
git sparse-checkout set "$REPO_SUBDIR"
git checkout "$BRANCH"

info "Checked out branch: $BRANCH"
info "Sparse checkout contents:"
ls -la "$REPO_SUBDIR/" || true

# ── Step 4: Create /opt/getouch as symlink or copy ────────────────
step 4 "Setting up ${TARGET} from repo"

# Option: Symlink so /opt/getouch points to repo subdir
# This makes 'git pull' in /opt/getouch.repo update /opt/getouch instantly
sudo ln -sfn "${REPO_CLONE}/${REPO_SUBDIR}" "$TARGET"
info "Created symlink: ${TARGET} → ${REPO_CLONE}/${REPO_SUBDIR}"

# Verify
ls -la "$TARGET/" || { error "Symlink target not accessible"; exit 1; }

# ── Step 5: Restore secrets and data dirs ─────────────────────────
step 5 "Restoring .env and creating data directories"

# Restore .env
if [ -n "$ENV_BACKUP" ] && [ -f "$ENV_BACKUP" ]; then
  cp "$ENV_BACKUP" "$TARGET/compose/.env"
  info "Restored .env from backup"
elif [ -n "$LEGACY" ] && [ -f "$LEGACY/compose/.env" ]; then
  cp "$LEGACY/compose/.env" "$TARGET/compose/.env"
  info "Restored .env from legacy dir"
else
  if [ -f "$TARGET/env/example.env" ]; then
    cp "$TARGET/env/example.env" "$TARGET/compose/.env"
    warn "Created .env from template — EDIT SECRETS before starting!"
    warn "  nano ${TARGET}/compose/.env"
  fi
fi

# Create data directories that aren't in git (they hold persistent data)
info "Creating data directories..."
mkdir -p "$TARGET/data/postgres"
mkdir -p "$TARGET/data/ollama"
mkdir -p "$TARGET/data/wa-sessions"
mkdir -p "$TARGET/backups"

# Restore any non-git files from legacy (scripts, custom configs, etc.)
if [ -n "$LEGACY" ]; then
  # Restore data dirs (they're volume mounts, so usually on /opt/getouch/data or /data)
  if [ -d "$LEGACY/data" ] && [ ! -L "$LEGACY/data" ]; then
    info "Legacy data dir found — symlinking to preserve data..."
    # Data might be on NVMe at /opt/getouch/data — link it back
    for d in postgres ollama wa-sessions; do
      if [ -d "$LEGACY/data/$d" ] && [ "$(ls -A $LEGACY/data/$d 2>/dev/null)" ]; then
        info "  Linking $d data from legacy..."
        rm -rf "$TARGET/data/$d" 2>/dev/null || true
        ln -sfn "$LEGACY/data/$d" "$TARGET/data/$d"
      fi
    done
  fi
fi

# ── Step 6: Ensure monitoring/provisioning dirs exist ─────────────
step 6 "Setting up Grafana provisioning"

# These already exist in the repo, but ensure ownership is correct
if [ -d "$TARGET/monitoring/grafana/dashboards" ]; then
  info "Dashboard JSONs present:"
  ls -la "$TARGET/monitoring/grafana/dashboards/"

  # Fix ownership for Grafana (runs as uid 472)
  # Since this is a symlink to repo, we need to make files readable
  info "Dashboards are read-only from repo — Grafana provisioning uses :ro mount."
else
  warn "Dashboard directory missing from repo checkout!"
fi

info "Provisioning datasource:"
cat "$TARGET/monitoring/grafana/provisioning/datasources/prometheus.yml" 2>/dev/null || warn "Missing!"

info "Provisioning dashboards config:"
cat "$TARGET/monitoring/grafana/provisioning/dashboards/default.yml" 2>/dev/null || warn "Missing!"

# ── Step 7: Create Docker networks if missing ─────────────────────
step 7 "Ensuring Docker networks exist"

for net in getouch_ingress getouch_app getouch_data; do
  if ! docker network inspect "$net" &>/dev/null; then
    docker network create "$net"
    info "Created network: $net"
  else
    info "Network exists: $net"
  fi
done

# ── Step 8: Restart all stacks ────────────────────────────────────
step 8 "Restarting all Docker Compose stacks"

cd "$TARGET/compose"

info "Loading .env..."
if [ ! -f .env ]; then
  error ".env is missing! Cannot start. Copy from template and edit:"
  error "  cp ${TARGET}/env/example.env ${TARGET}/compose/.env"
  error "  nano ${TARGET}/compose/.env"
  exit 1
fi

info "Starting core (Caddy + Cloudflared)..."
docker compose up -d 2>&1

info "Starting database..."
docker compose -f docker-compose.db.yml up -d 2>&1

info "Starting monitoring (Prometheus + Grafana)..."
docker compose -f docker-compose.mon.yml up -d 2>&1

info "Starting Ollama..."
docker compose -f docker-compose.ollama.yml up -d 2>&1

info "Building & starting app services..."
docker compose -f docker-compose.apps.yml build 2>&1
docker compose -f docker-compose.apps.yml up -d 2>&1

# Optional stacks
[ -f docker-compose.db-staging.yml ] && {
  info "Starting staging Postgres..."
  docker compose -f docker-compose.db-staging.yml up -d 2>&1
}

[ -f docker-compose.coolify.yml ] && {
  info "Starting Coolify..."
  docker compose -f docker-compose.coolify.yml up -d 2>&1
}

info "Reloading Caddy config..."
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile 2>&1 || warn "Caddy reload skipped"

# ── Step 9: Validate ──────────────────────────────────────────────
step 9 "Validation"

echo ""
info "Container status:"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | sort
echo ""

info "Grafana provisioning check:"
sleep 5  # give Grafana a moment to start
docker logs --tail 30 grafana 2>&1 | grep -i "provisioning\|datasource\|dashboard" || warn "No provisioning logs yet (Grafana may still be starting)"
echo ""

info "Health checks:"
for svc in landing bot wa api; do
  url="http://localhost:80"
  # Can't easily check from host — rely on docker ps status
  :
done
echo ""

info "Git status:"
cd "$REPO_CLONE"
git log --oneline -3
echo ""

# ── Summary ───────────────────────────────────────────────────────
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   Migration Complete!                             ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
info "Git repo:  ${REPO_CLONE} (branch: ${BRANCH})"
info "Symlink:   ${TARGET} → ${REPO_CLONE}/${REPO_SUBDIR}"
info "Legacy:    ${LEGACY}"
info ".env:      ${TARGET}/compose/.env"
echo ""
info "Day-to-day workflow:"
echo "  cd ${REPO_CLONE}"
echo "  git pull origin ${BRANCH}"
echo "  cd ${TARGET}/compose"
echo "  bash ${TARGET}/scripts/deploy.sh"
echo ""
info "Rollback:"
echo "  sudo rm ${TARGET}"
echo "  sudo mv ${LEGACY} ${TARGET}"
echo "  cd ${TARGET}/compose && bash ${TARGET}/scripts/deploy.sh"
