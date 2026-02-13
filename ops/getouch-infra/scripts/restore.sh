#!/usr/bin/env bash
# restore.sh — Restore Postgres from a backup file
# Usage: bash restore.sh /opt/getouch/backups/pg_all_20260213_140949.sql.gz
set -euo pipefail

BACKUP_FILE="${1:?Usage: restore.sh <backup_file.sql.gz>}"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: File not found: $BACKUP_FILE"
  exit 1
fi

echo "=== Getouch Postgres Restore ==="
echo "File: $BACKUP_FILE"
echo "Size: $(du -h "$BACKUP_FILE" | cut -f1)"
echo ""
echo "WARNING: This will overwrite ALL databases!"
read -p "Continue? (yes/no): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Aborted."
  exit 0
fi

echo "[1/3] Creating pre-restore backup..."
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
docker exec postgres pg_dumpall -U "${POSTGRES_USER:-getouch}" | \
  gzip > "/opt/getouch/backups/pg_all_pre_restore_${TIMESTAMP}.sql.gz"
echo "  Saved to: pg_all_pre_restore_${TIMESTAMP}.sql.gz"

echo "[2/3] Restoring from backup..."
gunzip -c "$BACKUP_FILE" | docker exec -i postgres psql -U "${POSTGRES_USER:-getouch}" -d postgres 2>&1

echo "[3/3] Verifying..."
docker exec postgres psql -U "${POSTGRES_USER:-getouch}" -c "\l"

echo ""
echo "Restore complete at $(date)"
