# Runbook 03 — Caddy Reverse Proxy

## Overview

Caddy acts as the internal reverse proxy, routing requests by `Host` header to the appropriate service container. Cloudflare terminates TLS at the edge; Caddy receives plain HTTP from `cloudflared`.

## Files

- `/opt/getouch/compose/docker-compose.yml` — Caddy + cloudflared services
- `/opt/getouch/config/Caddyfile` — Virtual host routing rules

## Deploy

```bash
cd /opt/getouch/compose
docker compose up -d caddy whoami
```

## Caddyfile Structure

```
getouch.co {
    reverse_proxy landing:3000
}

bot.getouch.co {
    reverse_proxy bot:3000
}

wa.getouch.co {
    reverse_proxy wa:3000
}

api.getouch.co {
    reverse_proxy api:3000
}
```

During initial setup, all routes point to a `whoami` container for smoke testing.

## Local Smoke Test

```bash
curl -H "Host: getouch.co" http://127.0.0.1
curl -H "Host: bot.getouch.co" http://127.0.0.1
curl -H "Host: wa.getouch.co" http://127.0.0.1
curl -H "Host: api.getouch.co" http://127.0.0.1
```

All should return a response from the whoami container.

## Verification

```bash
docker compose ps
docker logs caddy --tail 50
```

## Notes

- Caddy is configured with `auto_https off` since Cloudflare handles TLS.
- Caddy listens on port 80 only inside Docker network.
- The `whoami` container is temporary and will be replaced by real services.
