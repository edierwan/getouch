# Server Hardening — Getouch VPS

Hardening scripts for the Getouch VPS running Ubuntu 24.04 + Docker + Tailscale + Cloudflare Tunnel.

> **NVMe-safe**: No heavy disk writes, no large data migrations. Only config changes and permission fixes.

## Architecture Recap

```
Internet → Cloudflare Edge (TLS) → cloudflared (outbound tunnel) → Caddy → Services
Admin    → Tailscale (100.x.x.x) → SSH / pgAdmin / Grafana
```

All Docker ports are bound to `127.0.0.1` — no public exposure.

---

## Scripts

| Script | Purpose | Auto-restart? |
|--------|---------|---------------|
| `../harden-ufw.sh` | UFW firewall rules (Tailscale-only SSH) | UFW enabled |
| `01-fail2ban-setup.sh` | Brute-force protection with IP banning | Fail2ban restarted |
| `02-docker-log-rotation.sh` | Docker log size limits (10m × 5 files) | **No** — manual restart |
| `03-prometheus-alerts.sh` | Deploy alert rules (CPU/memory/disk/container) | **No** — manual restart |
| `04-secrets-hardening.sh` | Audit & fix file permissions, SSH config audit | N/A — audit only |
| `run-all.sh` | Runs all scripts in sequence | Mixed |

---

## Quick Start

### Run All Steps

```bash
sudo bash /opt/getouch/scripts/hardening/run-all.sh
```

### Run Individual Steps

```bash
# 1. UFW (already exists)
sudo bash /opt/getouch/scripts/harden-ufw.sh

# 2. Fail2ban
sudo bash /opt/getouch/scripts/hardening/01-fail2ban-setup.sh

# 3. Docker log rotation
sudo bash /opt/getouch/scripts/hardening/02-docker-log-rotation.sh

# 4. Prometheus alerts
sudo bash /opt/getouch/scripts/hardening/03-prometheus-alerts.sh

# 5. Secrets audit
sudo bash /opt/getouch/scripts/hardening/04-secrets-hardening.sh
```

---

## Post-Hardening Checklist

After running the scripts, you **must** complete these manual steps:

### 1. Restart Docker (maintenance window)

```bash
systemctl restart docker
```

This applies:
- Log rotation settings from `daemon.json`
- `iptables: false` (Docker won't punch holes in UFW)

### 2. Restart Prometheus

```bash
cd /opt/getouch
docker compose -f compose/docker-compose.mon.yml restart prometheus
```

Verify rules loaded:
```bash
docker exec prometheus promtool check rules /etc/prometheus/alert-rules.yml
```

### 3. Verify SSH (KEEP current session open!)

From **another** terminal via Tailscale:
```bash
ssh deploy@<tailscale-ip>
```

### 4. Verify Web Access

```bash
curl -sI https://getouch.co
```

### 5. Verify Fail2ban

```bash
fail2ban-client status sshd
```

---

## Docker Compose Volume Mount

Add the alert rules volume to `docker-compose.mon.yml` under the Prometheus service:

```yaml
volumes:
  - /opt/getouch/monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro
  - /opt/getouch/monitoring/alert-rules.yml:/etc/prometheus/alert-rules.yml:ro  # ← Add this
  - prometheus_data:/prometheus
```

---

## Alert Categories

The Prometheus alert rules (`config/alerting/alert-rules.yml`) cover:

| Category | Alerts |
|----------|--------|
| **Host** | CPU > 85%/95%, Memory > 85%/95%, Disk > 80%/90%, High I/O |
| **Container** | Container down, High CPU/Memory, Frequent restarts |
| **Network** | High traffic, Node exporter down |
| **Prometheus** | Scrape target down, Rule evaluation failures |

---

## What's NOT Changed

These scripts intentionally **do not**:

- ❌ Modify Docker volumes or data directories
- ❌ Restart Docker automatically (requires manual restart)
- ❌ Move files across mount points (NVMe-safe)
- ❌ Modify Cloudflare tunnel config
- ❌ Touch database data or storage volumes
