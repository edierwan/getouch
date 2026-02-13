#!/usr/bin/env bash
# backup.sh — Dump ALL Postgres databases and prune old backups
set -euo pipefail

BACKUP_DIR="/opt/getouch/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RETAIN_DAYS=${RETAIN_DAYS:-14}

echo "[$(date)] Starting Postgres backup (all databases)..."

# Dump all databases
docker exec postgres pg_dumpall -U "${POSTGRES_USER:-getouch}" | \
  gzip > "${BACKUP_DIR}/pg_all_${TIMESTAMP}.sql.gz"

# Prune old backups
DELETED=$(find "${BACKUP_DIR}" -name "pg_all_*.sql.gz" -mtime +"${RETAIN_DAYS}" -print -delete | wc -l)

SIZE=$(du -h "${BACKUP_DIR}/pg_all_${TIMESTAMP}.sql.gz" | cut -f1)
echo "[$(date)] Backup completed: pg_all_${TIMESTAMP}.sql.gz (${SIZE}), pruned ${DELETED} old files"
