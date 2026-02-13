# Getouch Home GPU Platform

> Production-grade home server on Ubuntu 24.04 — Docker, Caddy, Cloudflare Tunnel, Postgres, Ollama (GPU).

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  INTERNET                                                       │
│                                                                 │
│  getouch.co  bot.getouch.co  wa.getouch.co  api.getouch.co     │
│       │            │              │              │               │
│       └────────────┴──────────────┴──────────────┘               │
│                        │                                        │
│              ┌─────────▼──────────┐                             │
│              │  Cloudflare Edge   │  (Free plan, DNS + Proxy)   │
│              │  SSL termination   │                             │
│              └─────────┬──────────┘                             │
│                        │  Cloudflare Tunnel (Argo)              │
└────────────────────────┼────────────────────────────────────────┘
                         │  (outbound only — no inbound ports)
┌────────────────────────┼────────────────────────────────────────┐
│  HOME SERVER (Ubuntu 24.04, hostname: getouch)                  │
│                        │                                        │
│  ┌─────────────────────▼──────────────────────┐                 │
│  │  cloudflared  (Docker)                     │                 │
│  │  getouch_ingress network                   │                 │
│  └─────────────────────┬──────────────────────┘                 │
│                        │                                        │
│  ┌─────────────────────▼──────────────────────┐                 │
│  │  Caddy  (reverse proxy)                    │                 │
│  │  getouch_ingress + getouch_app networks    │                 │
│  │  Routes by Host header:                    │                 │
│  │    getouch.co      → landing:3000          │                 │
│  │    bot.getouch.co  → bot:3000              │                 │
│  │    wa.getouch.co   → wa:3000  (Baileys)    │                 │
│  │    api.getouch.co  → api:3000              │                 │
│  └──────┬─────────┬──────────┬────────────────┘                 │
│         │         │          │                                  │
│  ┌──────▼───┐ ┌───▼────┐ ┌──▼─────┐  ┌──────────┐             │
│  │ landing  │ │  bot   │ │  wa    │  │  api     │  getouch_app │
│  │ :3000    │ │ :3000  │ │ :3000  │  │ :3000   │              │
│  └──────────┘ └───┬────┘ └──┬─────┘  └──┬──────┘             │
│                   │         │            │                      │
│  ┌────────────────┴─────────┴────────────┴───┐                 │
│  │  getouch_data network                     │                 │
│  │  ┌────────────┐   ┌──────────────────┐    │                 │
│  │  │ Postgres   │   │ Ollama (GPU)     │    │                 │
│  │  │ :5432      │   │ Qwen2.5 7B      │    │                 │
│  │  └────────────┘   └──────────────────┘    │                 │
│  └───────────────────────────────────────────┘                 │
│                                                                 │
│  Monitoring: Prometheus + Grafana + node-exporter               │
│  Backups:    pg_dump cron → /opt/getouch/backups                │
│  SSH:        Tailscale only (no port 22 exposed)                │
└─────────────────────────────────────────────────────────────────┘
```

## Phases

| Phase | Issue | Description |
|-------|-------|-------------|
| 1 | Issue 1 | Repo + Runbooks (this folder) |
| 2 | Issue 2 | Server Foundation — Docker, dirs, networks |
| 3 | Issue 3 | Caddy reverse proxy + local smoke test |
| 4 | Issue 4 | Cloudflare Tunnel — single public ingress |
| 5 | Issue 5 | Postgres database |
| 6 | Issue 6 | Ollama GPU + Qwen2.5 7B |
| 7 | Issue 7 | Service skeletons (landing, bot, wa, api) |
| 8 | Issue 8 | Monitoring & backup automation |

## Directory Layout (server)

```
/opt/getouch/
├── compose/          # docker-compose files
├── config/           # Caddyfile, app configs
├── data/             # persistent volumes (postgres, ollama models)
├── backups/          # scheduled backup dumps
└── monitoring/       # prometheus, grafana configs
```

## Repo Layout

```
ops/getouch-infra/
├── README.md
├── env/
│   └── example.env
├── compose/
│   ├── docker-compose.yml          # core stack (caddy, cloudflared)
│   ├── docker-compose.db.yml       # postgres
│   ├── docker-compose.ollama.yml   # ollama GPU
│   ├── docker-compose.apps.yml     # service skeletons
│   └── docker-compose.mon.yml      # monitoring + backup
├── config/
│   └── Caddyfile
├── scripts/
│   ├── bootstrap.sh                # one-shot server setup
│   ├── deploy.sh                   # pull & restart
│   └── backup.sh                   # pg_dump + prune
└── runbooks/
    ├── 00-prereqs.md
    ├── 01-docker.md
    ├── 02-layout.md
    ├── 03-caddy.md
    ├── 04-postgres.md
    ├── 05-ollama.md
    ├── 06-cloudflare-tunnel.md
    ├── 07-services.md
    └── 08-monitoring-backup.md
```

## Key Decisions

- **No inbound ports** — all public traffic via Cloudflare Tunnel (outbound-only connection).
- **SSH via Tailscale** — port 22 never exposed to public internet.
- **Caddy** handles host-based routing inside the Docker network; Cloudflare terminates TLS at edge.
- **Docker networks** isolate ingress / app / data tiers.
- **NVIDIA GPU** passed to Ollama container via `nvidia` runtime.
