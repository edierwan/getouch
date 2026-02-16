# 09 — VPS Hardening Guide

> **Target**: Ubuntu 24.04 VPS with Docker Compose, Cloudflare Tunnel, Tailscale  
> **Host**: `deploy@100.103.248.15` (Tailscale IP)  
> **Date**: February 2025  

---

## Table of Contents

1. [Pre-flight Audit](#1-pre-flight-audit)
2. [UFW Firewall](#2-ufw-firewall)
3. [Cloudflare Tunnel Validation](#3-cloudflare-tunnel-validation)
4. [Caddy Security Headers & Routing](#4-caddy-security-headers--routing)
5. [Timezone Configuration](#5-timezone-configuration)
6. [Operational Guardrails](#6-operational-guardrails)
7. [Unattended Security Updates](#7-unattended-security-updates)
8. [Docker Daemon Hardening](#8-docker-daemon-hardening)
9. [Verification Checklist](#9-verification-checklist)
10. [Rollback Procedures](#10-rollback-procedures)

---

## 1. Pre-flight Audit

Before making changes, capture the current state:

```bash
# SSH in via Tailscale
ssh deploy@100.103.248.15

# Snapshot current state
date && uname -a
timedatectl
ufw status verbose
ss -tlnp
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker network ls
ip addr show tailscale0
```

Save the output for rollback reference.

---

## 2. UFW Firewall

### Architecture Context

```
Internet → Cloudflare Edge (TLS terminated)
              ↓ (outbound-only from VPS)
           cloudflared container → Caddy (127.0.0.1:80)
              ↓
           App services (internal Docker network)

Admin → Tailscale VPN (100.x.x.x) → SSH port 22
```

Since cloudflared connects **outbound** to Cloudflare's edge, **no inbound ports are needed for web traffic**. Only Tailscale needs inbound.

### Apply the firewall

```bash
# Copy the script to VPS
scp scripts/harden-ufw.sh deploy@100.103.248.15:/tmp/

# Run it (keep current SSH session open!)
ssh deploy@100.103.248.15 'sudo bash /tmp/harden-ufw.sh'
```

### What the script does

| Rule | Direction | Port | Source | Purpose |
|------|-----------|------|--------|---------|
| Default | Incoming | ALL | ALL | **DENY** |
| Default | Outgoing | ALL | ALL | ALLOW |
| Allow | Incoming | 22/tcp | 100.64.0.0/10 | SSH via Tailscale only |
| Allow | Incoming | 41641/udp | ANY | Tailscale WireGuard direct |

### Verify (from another terminal)

```bash
# 1. SSH via Tailscale still works
ssh deploy@100.103.248.15 echo "SSH OK"

# 2. Web access via Cloudflare tunnel works
curl -sI https://getouch.co | head -5

# 3. No unexpected open ports
ssh deploy@100.103.248.15 'sudo ufw status numbered'

# 4. Direct HTTP access is blocked (should timeout/refuse)
curl -sI --connect-timeout 5 http://100.103.248.15:80 || echo "BLOCKED ✓"
```

---

## 3. Cloudflare Tunnel Validation

The tunnel uses a **token-based configuration** (managed in Cloudflare dashboard). Validation steps:

### Check tunnel health

```bash
# On VPS
docker logs cloudflared --tail 30

# Look for:
#   "Registered tunnel connection" messages
#   "Connection ... registered" (one per edge connection, typically 4)
#   No "ERR" or "failed" messages
```

### Verify ingress rules (in Cloudflare Dashboard)

1. Go to **Cloudflare Dashboard → Zero Trust → Networks → Tunnels**
2. Click your tunnel → **Public Hostname** tab
3. Verify these routes exist:

| Hostname | Service | Path |
|----------|---------|------|
| `getouch.co` | `http://caddy:80` | — |
| `bot.getouch.co` | `http://caddy:80` | — |
| `wa.getouch.co` | `http://caddy:80` | — |
| `api.getouch.co` | `http://caddy:80` | — |

> All routes should point to `caddy:80` (the container name on the `getouch_ingress` network). Caddy then routes by Host header to the correct service.

### Enable Cloudflare WAF (recommended)

In Cloudflare Dashboard → your zone → **Security → WAF**:

- Enable **Managed Rules** (free tier includes OWASP core rules)
- Enable **Bot Fight Mode** under Security → Bots
- Consider **Rate Limiting** on `api.getouch.co` (free tier: 1 rule, e.g., 100 req/10s)

---

## 4. Caddy Security Headers & Routing

The updated [Caddyfile](../config/Caddyfile) now includes:

### Security headers (applied to all routes)

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Content-Type-Options` | `nosniff` | Prevent MIME sniffing |
| `X-Frame-Options` | `DENY` | Prevent clickjacking |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limit referrer leakage |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | Restrict browser APIs |
| `X-XSS-Protection` | `1; mode=block` | Legacy XSS filter |
| `-Server` | *(removed)* | Hide server identity |

### Endpoint blocking

`/metrics` and `/debug/*` are blocked (403) on all app subdomains to prevent information disclosure.

### Deploy

```bash
# Copy updated Caddyfile to VPS
scp config/Caddyfile deploy@100.103.248.15:/opt/getouch/config/Caddyfile

# Reload Caddy (no downtime)
ssh deploy@100.103.248.15 'docker exec caddy caddy reload --config /etc/caddy/Caddyfile'

# Verify headers
curl -sI https://getouch.co | grep -iE 'x-content|x-frame|referrer|permissions|server'
```

Expected output:
```
x-content-type-options: nosniff
x-frame-options: DENY
referrer-policy: strict-origin-when-cross-origin
permissions-policy: camera=(), microphone=(), geolocation=()
x-xss-protection: 1; mode=block
```

---

## 5. Timezone Configuration

### Server timezone

```bash
ssh deploy@100.103.248.15 '
  sudo timedatectl set-timezone Asia/Kuala_Lumpur
  timedatectl
'
```

### Container timezone

All compose files have been updated with `TZ: Asia/Kuala_Lumpur` in every service's `environment` block.

### Deploy

```bash
# Copy updated compose files
scp compose/*.yml deploy@100.103.248.15:/opt/getouch/compose/

# Recreate containers to pick up TZ changes
ssh deploy@100.103.248.15 '
  cd /opt/getouch/compose
  docker compose up -d
  docker compose -f docker-compose.db.yml up -d
  docker compose -f docker-compose.apps.yml up -d --build
  docker compose -f docker-compose.mon.yml up -d
  docker compose -f docker-compose.ollama.yml up -d
'

# Verify timezone in a container
ssh deploy@100.103.248.15 'docker exec postgres date'
# Expected: ... MYT 2025 (or +08)
```

---

## 6. Operational Guardrails

### What was added to all compose files

| Feature | Config | Purpose |
|---------|--------|---------|
| **Restart policies** | `restart: unless-stopped` | Auto-recover from crashes (already present, verified) |
| **Healthchecks** | `healthcheck:` on every service | Docker auto-restarts unhealthy containers, monitoring via `docker ps` |
| **Log rotation** | `logging: json-file, max-size: 10m, max-file: 3-5` | Prevent disk exhaustion from runaway logs |
| **Resource limits** | `deploy.resources.limits.memory: 2G` (Postgres) | Prevent OOM from taking down the host |
| **TZ everywhere** | `TZ: Asia/Kuala_Lumpur` | Consistent log timestamps across all services |
| **NODE_ENV** | `NODE_ENV: production` | Disable debug output in app services |
| **whoami removed** | Dropped from core compose | Remove unnecessary attack surface |

### Verify healthchecks

```bash
ssh deploy@100.103.248.15 '
  docker ps --format "table {{.Names}}\t{{.Status}}"
'
# Look for "(healthy)" in Status column. Allow 1-2 minutes after restart.
```

---

## 7. Unattended Security Updates

```bash
ssh deploy@100.103.248.15 '
  sudo apt-get install -y unattended-upgrades
  sudo dpkg-reconfigure -plow unattended-upgrades
  # Select "Yes" when prompted

  # Verify
  cat /etc/apt/apt.conf.d/20auto-upgrades
'
```

Expected:
```
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
```

---

## 8. Docker Daemon Hardening

### Prevent Docker from bypassing UFW

Docker modifies iptables directly. To prevent it from exposing ports past UFW:

```bash
ssh deploy@100.103.248.15 '
  sudo tee /etc/docker/daemon.json <<EOF
{
  "iptables": false,
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
EOF
  sudo systemctl restart docker
'
```

> **Note**: Since all ports are bound to `127.0.0.1`, disabling Docker iptables is safe. Internal Docker networking (bridge, overlay) still works. The `log-driver` config provides a fallback default for any container that doesn't specify its own logging.

### Verify Docker still works after daemon restart

```bash
ssh deploy@100.103.248.15 '
  docker ps
  curl -s http://127.0.0.1:80 | head -1
'
```

---

## 9. Verification Checklist

Run this after all changes are applied:

```bash
ssh deploy@100.103.248.15 'bash -s' << 'VERIFY'
echo "=== 1. Timezone ==="
timedatectl | grep "Time zone"
docker exec postgres date +%Z

echo ""
echo "=== 2. UFW Status ==="
sudo ufw status numbered

echo ""
echo "=== 3. Open Ports (non-loopback) ==="
ss -tlnp | grep -v '127.0.0.1' | grep -v '::1' || echo "None ✓"

echo ""
echo "=== 4. Container Health ==="
docker ps --format "table {{.Names}}\t{{.Status}}" | head -20

echo ""
echo "=== 5. Caddy Config Test ==="
docker exec caddy caddy validate --config /etc/caddy/Caddyfile && echo "Caddy config OK ✓"

echo ""
echo "=== 6. Cloudflared Tunnel ==="
docker logs cloudflared --tail 5 2>&1 | grep -i "registered\|connection\|error" || echo "Check logs manually"

echo ""
echo "=== 7. Security Headers ==="
curl -sI http://127.0.0.1:80 -H "Host: getouch.co" | grep -iE 'x-content|x-frame|referrer|permissions' || echo "Headers not yet applied"

echo ""
echo "=== 8. Docker Daemon ==="
cat /etc/docker/daemon.json 2>/dev/null || echo "No daemon.json (create one)"

echo ""
echo "=== 9. Unattended Upgrades ==="
cat /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null || echo "Not configured"

echo ""
echo "=== 10. Metrics Endpoints Blocked ==="
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:80/metrics -H "Host: api.getouch.co"
echo " (expect 403)"
VERIFY
```

---

## 10. Rollback Procedures

### UFW — Disable firewall

```bash
sudo ufw disable
# Or reset to allow everything:
sudo ufw --force reset
```

### Caddy — Restore original config

```bash
# Keep a backup before deploying:
ssh deploy@100.103.248.15 'cp /opt/getouch/config/Caddyfile /opt/getouch/config/Caddyfile.bak'

# To rollback:
ssh deploy@100.103.248.15 '
  cp /opt/getouch/config/Caddyfile.bak /opt/getouch/config/Caddyfile
  docker exec caddy caddy reload --config /etc/caddy/Caddyfile
'
```

### Docker Compose — Restore old compose files

```bash
# Before deploying, back up on VPS:
ssh deploy@100.103.248.15 '
  cp -r /opt/getouch/compose /opt/getouch/compose.bak
'

# To rollback:
ssh deploy@100.103.248.15 '
  cp /opt/getouch/compose.bak/*.yml /opt/getouch/compose/
  cd /opt/getouch/compose
  docker compose up -d
  docker compose -f docker-compose.db.yml up -d
  docker compose -f docker-compose.apps.yml up -d --build
  docker compose -f docker-compose.mon.yml up -d
  docker compose -f docker-compose.ollama.yml up -d
'
```

### Docker daemon — Remove iptables restriction

```bash
ssh deploy@100.103.248.15 '
  sudo rm /etc/docker/daemon.json
  sudo systemctl restart docker
'
```

### Timezone — Revert to UTC

```bash
ssh deploy@100.103.248.15 'sudo timedatectl set-timezone UTC'
```

---

## Summary of Changes

| Layer | Change | File(s) |
|-------|--------|---------|
| **Firewall** | UFW default deny, SSH via Tailscale only, Tailscale UDP allowed | `scripts/harden-ufw.sh` |
| **Caddy** | Security headers, `/metrics` blocked, server identity hidden | `config/Caddyfile` |
| **Docker Compose** | TZ, healthchecks, log rotation, NODE_ENV, whoami removed | All 5 compose files |
| **Postgres** | Memory limit 2G | `docker-compose.db.yml` |
| **Docker Daemon** | iptables disabled, default log rotation | `/etc/docker/daemon.json` |
| **OS** | Timezone Asia/Kuala_Lumpur, unattended-upgrades | System config |

### Deployment Order

1. **Back up** all config files on VPS first
2. **Timezone** — `timedatectl set-timezone` (zero risk)
3. **Docker daemon** — `/etc/docker/daemon.json` + restart (brief container restart)
4. **Compose files** — Copy & recreate containers (rolling, brief downtime)
5. **Caddyfile** — Copy & reload (zero downtime)
6. **UFW** — Run `harden-ufw.sh` (**keep SSH session open** until verified)
7. **Unattended upgrades** — Install package
8. **Run verification checklist**
