# Runbook 02 — Directory Layout & Docker Networks

## Create Server Directories

```bash
sudo mkdir -p /opt/getouch/{compose,data,config,backups,monitoring}
sudo chown -R deploy:deploy /opt/getouch
```

## Create Docker Networks

Three isolated networks for tiered architecture:

```bash
docker network create getouch_ingress   # cloudflared ↔ caddy
docker network create getouch_app       # caddy ↔ app containers
docker network create getouch_data      # app containers ↔ postgres/ollama
```

## Verification

```bash
ls -la /opt/getouch/
docker network ls | grep getouch
```

Expected output:

```
getouch_ingress   bridge
getouch_app       bridge
getouch_data      bridge
```

## Directory Purpose

| Path | Purpose |
|------|---------|
| `/opt/getouch/compose/` | Docker Compose files |
| `/opt/getouch/data/` | Persistent volumes (postgres, ollama models) |
| `/opt/getouch/config/` | Caddyfile, app configs |
| `/opt/getouch/backups/` | Scheduled pg_dump output |
| `/opt/getouch/monitoring/` | Prometheus, Grafana configs |
