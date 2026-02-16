# One Gate — Unified Tool Access via Cloudflare Access

## Overview

**One Gate** is the architecture pattern for exposing all internal infrastructure tools (Grafana, Prometheus, pgAdmin, Coolify) through public HTTPS subdomains, protected by **Cloudflare Access** with Google SSO. No VPN or Tailscale required — authenticate once on any `*.getouch.co` subdomain and the session carries across all tools.

## Architecture

```
Internet → Cloudflare Edge → CF Tunnel → Caddy (reverse proxy) → Internal Service
                ↓
        CF Access Policy
        (Google SSO gate)
```

Each tool gets:
- A public subdomain (e.g., `grafana.getouch.co`)
- A Cloudflare Tunnel public hostname route
- A Caddy reverse-proxy vhost
- A Cloudflare Access application policy

## Tool Matrix

| Tool       | Subdomain              | Internal Port | Compose File               | CF Access | Tool Login          |
|------------|------------------------|---------------|-----------------------------|-----------|---------------------|
| Grafana    | grafana.getouch.co     | 3001          | docker-compose.mon.yml      | ✅ Google  | SSO auto-login      |
| Prometheus | metrics.getouch.co     | 9090          | docker-compose.mon.yml      | ✅ Google  | None (read-only)    |
| pgAdmin    | db.getouch.co          | 5050          | docker-compose.db.yml       | ✅ Google  | pgAdmin credentials |
| Coolify    | coolify.getouch.co     | 8000          | docker-compose.coolify.yml  | ✅ Google  | Coolify credentials |

## Setup Checklist

### 1. Cloudflare Tunnel Public Hostnames

In the [Cloudflare Dashboard](https://dash.cloudflare.com) → Zero Trust → Access → Tunnels → your tunnel → Public Hostname tab, add:

| Hostname               | Service          |
|------------------------|------------------|
| `grafana.getouch.co`   | `http://caddy:80` |
| `metrics.getouch.co`   | `http://caddy:80` |
| `db.getouch.co`        | `http://caddy:80` |
| `coolify.getouch.co`   | `http://caddy:80` |

### 2. Cloudflare Access Applications

In Zero Trust → Access → Applications, create one per tool:

- **Name**: `Grafana` (or `Prometheus`, `pgAdmin`, `Coolify`)
- **Application Domain**: `grafana.getouch.co`
- **Session Duration**: 24h
- **Policy**: Allow → Include: Emails ending in `@gmail.com` (or specific email list)
- **Identity Provider**: Google

> **Tip**: You can create a single "Wildcard" application for `*.getouch.co` if all tools use the same access policy.

### 3. Caddy Reverse Proxy

Already configured in `config/Caddyfile`:

```
grafana.getouch.co:80 {
    reverse_proxy grafana:3001
}

metrics.getouch.co:80 {
    reverse_proxy prometheus:9090
}

db.getouch.co:80 {
    reverse_proxy pgadmin:5050
}

coolify.getouch.co:80 {
    reverse_proxy 127.0.0.1:8000
}
```

### 4. Docker Compose

Coolify is deployed via `docker-compose.coolify.yml`:

```bash
cd /opt/getouch/compose
docker compose -f docker-compose.coolify.yml up -d
```

## Admin Dashboard Integration

The admin panel at `/admin` includes:

- **Quick Access tiles** with direct links to all tools
- **Infrastructure Tools** section in Services tab with live status badges
- **Ops Status API** (`/api/ops/status`) that probes each tool internally

Status badges auto-refresh on page load and can be manually refreshed with the "Refresh Status" button.

## Troubleshooting

### ERR_NAME_NOT_RESOLVED

**Cause**: Missing Cloudflare Tunnel public hostname for the subdomain.

**Fix**: Add the hostname in CF Dashboard → Zero Trust → Tunnels → Public Hostname tab.

### 403 Forbidden

**Cause**: CF Access policy blocking the request.

**Fix**: Check the Access Application policy allows your email/identity provider.

### 502 Bad Gateway

**Cause**: Internal service is down or Caddy can't reach it.

**Fix**: Check `docker ps` and ensure the service container is running and on the correct Docker network.

## Security Notes

- All traffic is encrypted end-to-end (Cloudflare edge TLS + tunnel encryption)
- No ports exposed to the public internet (UFW denies all inbound)
- CF Access JWT is validated at the edge before traffic reaches the server
- Some tools (pgAdmin, Coolify) have their own login as a second layer
