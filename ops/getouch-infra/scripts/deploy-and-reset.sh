#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Quick Deploy & Reset — copies scripts to server and runs the reset
#
# Usage (from your Mac):
#   bash deploy-and-reset.sh <server-ip-or-hostname>
#   bash deploy-and-reset.sh root@your-server
#
# This will:
#   1. SCP all recovery scripts to /opt/getouch/scripts/
#   2. SSH in and run coolify-admin-reset.sh for edierwan@gmail.com
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="${1:?Usage: $0 <user@server>}"
REMOTE_DIR="/opt/getouch/scripts"

echo "═══════════════════════════════════════════════════"
echo "  Deploy Coolify Recovery Scripts to ${SERVER}"
echo "═══════════════════════════════════════════════════"
echo ""

# Upload scripts
echo "[1/3] Uploading scripts to ${SERVER}:${REMOTE_DIR}/"
ssh "$SERVER" "mkdir -p ${REMOTE_DIR}"
scp "${SCRIPT_DIR}/coolify-admin-reset.sh" \
    "${SCRIPT_DIR}/coolify-admin-list.sh" \
    "${SCRIPT_DIR}/coolify-recovery-token.sh" \
    "${SCRIPT_DIR}/coolify-emergency-admin.sh" \
    "${SERVER}:${REMOTE_DIR}/"

echo "[2/3] Setting permissions…"
ssh "$SERVER" "chmod 700 ${REMOTE_DIR}/coolify-*.sh"

echo "[3/3] Running password reset…"
echo ""
echo "──────────────────────────────────────────────────"
ssh -t "$SERVER" "cd ${REMOTE_DIR} && bash coolify-admin-reset.sh --email edierwan@gmail.com"
echo "──────────────────────────────────────────────────"
echo ""
echo "✓ Done. Login at https://coolify.getouch.co"
