# 11 — Monitoring HTTPS Access (Grafana & Prometheus)

> **Status**: Infrastructure deployed. CF Dashboard config required (manual steps below).

## Architecture

```
Browser ──HTTPS──▶ Cloudflare Edge
                        │
                    CF Tunnel (encrypted)
                        │
                  cloudflared container
                        │  getouch_ingress
                    Caddy (:80)
                        │  getouch_app
                ┌───────┴───────┐
          grafana:3000    prometheus:9090
```

- **No host port exposure** — Grafana/Prometheus are only reachable via Caddy on the `getouch_app` Docker network.
- **Cloudflare Access** gates every request; Grafana trusts the `Cf-Access-Authenticated-User-Email` header (auth proxy mode) — **no second login**.
- Prometheus is read-only behind CF Access; no native auth needed.

## Subdomains

| Service    | URL                         | Internal target     |
|------------|-----------------------------|---------------------|
| Grafana    | https://grafana.getouch.co  | `grafana:3000`      |
| Prometheus | https://metrics.getouch.co  | `prometheus:9090`   |
| pgAdmin    | https://db.getouch.co       | `pgadmin:5050`      |

## What Was Done (Server-Side)

1. **docker-compose.mon.yml** — Added `getouch_app` network to `grafana` and `prometheus`; removed host port bindings (`0.0.0.0:3001:3000` and `0.0.0.0:9090:9090`); added Grafana auth-proxy env vars:
   ```yaml
   GF_AUTH_PROXY_ENABLED: "true"
   GF_AUTH_PROXY_HEADER_NAME: Cf-Access-Authenticated-User-Email
   GF_AUTH_PROXY_AUTO_SIGN_UP: "true"
   GF_AUTH_BASIC_ENABLED: "false"
   GF_AUTH_DISABLE_LOGIN_FORM: "true"
   GF_SERVER_DOMAIN: grafana.getouch.co
   GF_SERVER_ROOT_URL: https://grafana.getouch.co
   GF_SECURITY_COOKIE_SECURE: "true"
   ```

2. **Caddyfile** — Added two new vhosts:
   ```
   grafana.getouch.co:80 { reverse_proxy grafana:3000 }
   metrics.getouch.co:80 { reverse_proxy prometheus:9090 }
   ```

3. **Landing server.js** — All `http://100.103.248.15:3001` → `https://grafana.getouch.co`, all `http://100.103.248.15:9090` → `https://metrics.getouch.co`, updated monitoring tab descriptions.

## Cloudflare Dashboard Steps (MANUAL)

### Step 1 — Add Public Hostnames to Tunnel

1. Go to **Cloudflare Zero Trust** → **Networks** → **Tunnels**
2. Click on your **getouch** tunnel → **Public Hostname** tab
3. Add two new routes:

| Public hostname         | Service              |
|------------------------|----------------------|
| `grafana.getouch.co`   | `http://caddy:80`    |
| `metrics.getouch.co`   | `http://caddy:80`    |

> The tunnel already routes `getouch.co`, `bot.getouch.co`, `wa.getouch.co`, `api.getouch.co`, `db.getouch.co` — just add the two new ones.

### Step 2 — Add Access Policies

1. Go to **Cloudflare Zero Trust** → **Access** → **Applications**
2. Create two **Self-hosted** applications:

#### Grafana Application
- **Name**: Grafana
- **Application domain**: `grafana.getouch.co`
- **Session duration**: 24 hours
- **Policy name**: Allow Admins
- **Policy action**: Allow
- **Include rule**: Emails — `your-admin@email.com` (same emails as your existing /admin policy)

#### Metrics (Prometheus) Application
- **Name**: Metrics
- **Application domain**: `metrics.getouch.co`
- **Session duration**: 24 hours
- **Policy name**: Allow Admins
- **Policy action**: Allow
- **Include rule**: Emails — `your-admin@email.com`

> **Tip**: You can also use an Access Group if you already have one configured for admin users. This keeps all monitoring behind the same SSO gate as `/admin` and `db.getouch.co`.

### Step 3 — Verify

1. Open `https://grafana.getouch.co` — should trigger CF Access login, then land in Grafana (auto-signed-up user, no Grafana login page)
2. Open `https://metrics.getouch.co` — same CF Access gate, then Prometheus UI
3. Confirm old Tailscale ports are closed: `curl http://100.103.248.15:3001` and `:9090` should timeout/refuse

## Rollback

If something goes wrong:

```bash
cd /opt/getouch/compose

# Re-expose host ports temporarily
sudo docker compose -f docker-compose.mon.yml down
# Edit docker-compose.mon.yml: add back ports sections
sudo docker compose -f docker-compose.mon.yml up -d
```

## Grafana Auth Proxy Notes

- Grafana trusts the `Cf-Access-Authenticated-User-Email` header from CF Access
- Users are auto-created on first login with **Viewer** role
- To promote a user to Admin: Grafana UI → Administration → Users → Change role
- If CF Access is bypassed somehow, Grafana has no login form — this is by design (defence in depth via Docker network isolation)
