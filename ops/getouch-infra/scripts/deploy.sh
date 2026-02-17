#!/usr/bin/env bash
#
# Getouch Deploy Script
# Run from your LOCAL machine (macOS) to deploy to the VPS.
#
# Usage:
#   ./deploy.sh              # auto-detect: main→prod, develop→staging
#   ./deploy.sh prod         # deploy main   → getouch.co    (NVMe postgres)
#   ./deploy.sh staging      # deploy develop → dev.getouch.co (SSD postgres)
#   ./deploy.sh all          # deploy both environments
#
# Environment:
#   GETOUCH_VPS_IP   — override VPS address (default: 100.103.248.15)
#   GETOUCH_VPS_USER — override SSH user     (default: deploy)
#
set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────
VPS_USER="${GETOUCH_VPS_USER:-deploy}"
VPS_HOST="${GETOUCH_VPS_IP:-100.103.248.15}"
REPO_REMOTE="/home/deploy/getouch-repo"
COMPOSE_DIR="/opt/getouch/compose"
SSH_CMD="ssh ${VPS_USER}@${VPS_HOST}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
info()  { echo -e "${GREEN}▸${NC} $*"; }
warn()  { echo -e "${YELLOW}▸${NC} $*"; }
err()   { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

deploy_env() {
  local env="$1"
  local branch service_dir compose_file containers label

  case "$env" in
    prod)
      branch="main"
      service_dir="/opt/getouch/services"
      compose_file="docker-compose.apps.yml"
      containers="landing"
      label="PRODUCTION (main → getouch.co)"
      ;;
    staging)
      branch="develop"
      service_dir="/opt/getouch-stg/services"
      compose_file="staging/docker-compose.apps.yml"
      containers="landing-stg"
      label="STAGING (develop → dev.getouch.co)"
      ;;
  esac

  echo ""
  echo -e "${BOLD}═══ Deploying $label ═══${NC}"

  info "Pulling $branch on VPS..."
  $SSH_CMD bash -s <<REMOTE
    set -e
    cd $REPO_REMOTE
    git fetch --all --prune
    git checkout $branch
    git pull origin $branch
    echo "  Commit: \$(git log --oneline -1)"
REMOTE

  info "Syncing app source → $service_dir/landing ..."
  $SSH_CMD bash -s <<REMOTE
    set -e
    mkdir -p $service_dir/landing
    rsync -a --delete --exclude node_modules --exclude .git \
      $REPO_REMOTE/app/ $service_dir/landing/
REMOTE

  info "Syncing configs..."
  $SSH_CMD bash -s <<REMOTE
    set -e
    cp $REPO_REMOTE/ops/getouch-infra/config/Caddyfile /opt/getouch/config/Caddyfile
    rsync -a --exclude .env --exclude '*.bak*' \
      $REPO_REMOTE/ops/getouch-infra/compose/ $COMPOSE_DIR/
REMOTE

  info "Rebuilding $containers ..."
  $SSH_CMD bash -s <<REMOTE
    set -e
    cd $COMPOSE_DIR
    docker compose -f $compose_file up -d --build --no-deps $containers
REMOTE

  info "Reloading Caddy..."
  $SSH_CMD bash -s <<'REMOTE'
    docker exec compose-caddy-1 caddy reload --config /etc/caddy/Caddyfile 2>/dev/null || \
      docker restart compose-caddy-1
REMOTE

  info "Verifying..."
  $SSH_CMD "docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -E '$containers|caddy'"

  info "✓ $label deployed"
}

# ── Detect environment ────────────────────────────────────────────
ENV="${1:-auto}"

if [[ "$ENV" == "auto" ]]; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  case "$BRANCH" in
    main)    ENV="prod" ;;
    develop) ENV="staging" ;;
    *)       err "Branch '$BRANCH' is not main or develop. Specify: ./deploy.sh prod|staging|all" ;;
  esac
fi

case "$ENV" in
  prod|production)   deploy_env prod ;;
  staging|stg|dev)   deploy_env staging ;;
  all)               deploy_env prod; deploy_env staging ;;
  *)                 err "Unknown environment: $ENV. Use prod, staging, or all." ;;
esac

echo ""
echo -e "${GREEN}✓ All done.${NC}"
