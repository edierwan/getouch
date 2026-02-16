#!/usr/bin/env bash
# setup-grafana-provisioning.sh
# Creates provisioning directories and copies config files on the VPS.
# Run from /opt/getouch/compose after git pull.
set -euo pipefail

echo "=== Grafana Provisioning Setup ==="

# 1. Create directories
echo "[1/4] Creating provisioning directories..."
mkdir -p /opt/getouch/monitoring/grafana/provisioning/datasources
mkdir -p /opt/getouch/monitoring/grafana/provisioning/dashboards
mkdir -p /opt/getouch/monitoring/grafana/dashboards

# 2. Copy provisioning YAMLs from repo
REPO="/opt/getouch/compose/../"  # adjust if repo root differs
echo "[2/4] Copying provisioning configs..."

# These files are in the git repo; the compose volume mounts point to /opt/getouch/monitoring/
# If running from the repo root, files are already at the right path via git pull.
# Otherwise, copy them:
if [ -d "/opt/getouch/monitoring/grafana/provisioning/datasources" ]; then
  echo "  Provisioning dirs exist."
fi

# 3. Copy dashboard JSONs
echo "[3/4] Checking dashboard files..."
for f in node-exporter-full.json docker-cadvisor.json; do
  if [ -f "/opt/getouch/monitoring/grafana/dashboards/$f" ]; then
    echo "  $f exists ($(wc -c < /opt/getouch/monitoring/grafana/dashboards/$f) bytes)"
  else
    echo "  WARNING: $f missing! Download from Grafana.com:"
    echo "    curl -sL 'https://grafana.com/api/dashboards/1860/revisions/latest/download' -o /opt/getouch/monitoring/grafana/dashboards/node-exporter-full.json"
    echo "    curl -sL 'https://grafana.com/api/dashboards/14282/revisions/latest/download' -o /opt/getouch/monitoring/grafana/dashboards/docker-cadvisor.json"
  fi
done

# 4. Fix ownership (Grafana runs as uid 472)
echo "[4/4] Fixing ownership..."
chown -R 472:472 /opt/getouch/monitoring/grafana/dashboards/ 2>/dev/null || true

echo ""
echo "Done. Now restart Grafana:"
echo "  cd /opt/getouch/compose"
echo "  docker compose -f docker-compose.mon.yml up -d grafana"
echo ""
echo "Verify:"
echo "  docker logs --tail 40 grafana | grep -i 'provisioning\\|datasource\\|dashboard'"
