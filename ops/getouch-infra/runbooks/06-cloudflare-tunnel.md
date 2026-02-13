# Runbook 06 — Cloudflare Tunnel

## Overview

A single Cloudflare Tunnel (`getouch-home`) provides public HTTPS access to all subdomains without opening any inbound ports on the router/firewall. The `cloudflared` daemon runs as a Docker container and establishes an outbound-only connection to Cloudflare's edge.

## Prerequisites

- Cloudflare account with `getouch.co` domain
- Zero Trust dashboard access

## Step 1 — Create Tunnel in Cloudflare Dashboard

> **USER ACTION REQUIRED**

1. Go to [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → Networks → Tunnels
2. Click **Create a tunnel**
3. Choose **Cloudflared** connector
4. Name: `getouch-home`
5. Choose environment: **Docker**
6. Copy the token shown (starts with `eyJ...`)
7. Paste the token back here

## Step 2 — Configure Public Hostnames

In the tunnel config UI, add these public hostnames:

| Public hostname | Service | URL |
|----------------|---------|-----|
| `getouch.co` | HTTP | `caddy:80` |
| `bot.getouch.co` | HTTP | `caddy:80` |
| `wa.getouch.co` | HTTP | `caddy:80` |
| `api.getouch.co` | HTTP | `caddy:80` |

Cloudflare will auto-create CNAME DNS records pointing to the tunnel.

## Step 3 — Add cloudflared to Docker Compose

The `cloudflared` service is defined in the main `docker-compose.yml`:

```yaml
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel run
    environment:
      TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN}
    networks:
      - getouch_ingress
```

## Deploy

```bash
cd /opt/getouch/compose
docker compose up -d cloudflared
```

## Verification

```bash
docker logs cloudflared --tail 100
# From local Mac:
curl -I https://getouch.co
curl -I https://bot.getouch.co
curl -I https://wa.getouch.co
curl -I https://api.getouch.co
```

## Troubleshooting

- **Tunnel not connecting:** Verify token is correct in `.env`
- **DNS not resolving:** Check CNAME records in Cloudflare DNS dashboard
- **502 errors:** Ensure Caddy is running and on `getouch_ingress` network
