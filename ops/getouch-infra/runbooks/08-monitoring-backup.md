# Runbook 08 — Monitoring & Backup

## Monitoring Stack

Defined in `docker-compose.mon.yml`:

### Components

| Service | Purpose | Port (internal) |
|---------|---------|----------------|
| prometheus | Metrics collection | 9090 |
| grafana | Dashboards | 3001 |
| node-exporter | Host metrics | 9100 |
| cadvisor | Container metrics | 8080 |

### Prometheus Targets

```yaml
scrape_configs:
  - job_name: node
    static_configs:
      - targets: ['node-exporter:9100']
  - job_name: cadvisor
    static_configs:
      - targets: ['cadvisor:8080']
  - job_name: postgres
    static_configs:
      - targets: ['postgres-exporter:9187']
```

### Access

Grafana is accessible internally or via Tailscale. NOT exposed via Cloudflare Tunnel for security.

## Backup Automation

### Postgres Backup Script

`/opt/getouch/scripts/backup.sh`:

```bash
#!/bin/bash
set -euo pipefail

BACKUP_DIR="/opt/getouch/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RETAIN_DAYS=7

# Dump Postgres
docker exec postgres pg_dump -U getouch getouch | \
  gzip > "${BACKUP_DIR}/pg_${TIMESTAMP}.sql.gz"

# Prune old backups
find "${BACKUP_DIR}" -name "pg_*.sql.gz" -mtime +${RETAIN_DAYS} -delete

echo "[$(date)] Backup completed: pg_${TIMESTAMP}.sql.gz"
```

### Cron Schedule

```bash
# Add to deploy user crontab
crontab -e

# Daily at 3 AM
0 3 * * * /opt/getouch/scripts/backup.sh >> /opt/getouch/backups/backup.log 2>&1
```

## Verification

```bash
# Check monitoring stack
docker compose -f docker-compose.mon.yml ps

# Check Prometheus targets
curl http://localhost:9090/api/v1/targets

# Check Grafana
curl http://localhost:3001/api/health

# Test backup
bash /opt/getouch/scripts/backup.sh
ls -la /opt/getouch/backups/
```
