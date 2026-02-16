# Getouch App

Platform landing page, admin dashboard, and operations console.

## Quick Start

```bash
cd app
cp .env.example .env      # edit if needed
npm install
npm run dev               # → http://localhost:3000
```

## Routes

| Path | Description |
|------|-------------|
| `/` | Landing page — services catalog + status badges |
| `/admin/` | Admin dashboard — health grid + quick links |
| `/admin/ops` | Operations dashboard — all service links |
| `/health` | JSON health check |
| `/api/status` | Server-side service status probes |

## Architecture

```
app/
├── server.js          # Express server, templating, /api/status
├── pages/
│   ├── landing.html   # Public landing page
│   ├── admin.html     # Admin dashboard
│   └── ops.html       # Operations dashboard
├── public/
│   ├── css/styles.css # Shared dark-theme stylesheet
│   └── js/app.js      # Client-side status updater
├── Dockerfile         # Production container
└── .env.example       # Environment config
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server listen port |
| `NODE_ENV` | — | `production` disables page hot-reload |
| `BOT_INTERNAL_URL` | `http://bot:3000` | Bot service for health probes |
| `WA_INTERNAL_URL` | `http://wa:3000` | WA service for health probes |
| `API_INTERNAL_URL` | `http://api:3000` | API service for health probes |
| `PUBLIC_BOT_URL` | `https://bot.getouch.co` | Bot URL rendered in page links |
| `PUBLIC_WA_URL` | `https://wa.getouch.co` | WA URL rendered in page links |
| `PUBLIC_API_URL` | `https://api.getouch.co` | API URL rendered in page links |
| `PUBLIC_DB_URL` | `https://db.getouch.co` | pgAdmin URL rendered in page links |

## Domain Routing (Production)

| Domain | Target | Auth |
|--------|--------|------|
| `getouch.co` | Landing + Admin (this app) | Public / CF Access for /admin |
| `bot.getouch.co` | Bot/AI service | Public /health, CF Access /api/internal |
| `wa.getouch.co` | WhatsApp gateway | CF Access for /api/internal |
| `api.getouch.co` | REST API | Public |
| `db.getouch.co` | pgAdmin | CF Access |
| `dev.getouch.co` | Coolify dev deployment | — |

## Smoke Tests

```bash
# Landing page returns 200 with service cards
curl -s http://localhost:3000/ | grep -q "Platform Services" && echo "✓ landing"

# Health endpoint
curl -s http://localhost:3000/health | jq .status
# → "ok"

# Status API returns service probes
curl -s http://localhost:3000/api/status | jq .services
# → { bot: {status: "offline"}, wa: {...}, api: {...} }

# Admin page loads
curl -s http://localhost:3000/admin/ | grep -q "Dashboard" && echo "✓ admin"

# Ops dashboard loads with expected sections
curl -s http://localhost:3000/admin/ops | grep -q "Operations Dashboard" && echo "✓ ops"
curl -s http://localhost:3000/admin/ops | grep -q "whatsapp" && echo "✓ wa section"
curl -s http://localhost:3000/admin/ops | grep -q "coolify" && echo "✓ coolify section"
```

### Production smoke tests

```bash
# Landing
curl -s https://getouch.co/ | grep -q "Platform Services" && echo "✓ landing"

# Bot health
curl -s https://bot.getouch.co/health | jq .status
# → "ok"

# WA health
curl -s https://wa.getouch.co/health | jq .status
# → "ok"

# Admin ops
curl -s https://getouch.co/admin/ops | grep -q "Operations Dashboard" && echo "✓ ops"
```

## Deployment

### Docker (standalone)

```bash
docker build -t getouch-app .
docker run -p 3000:3000 \
  -e NODE_ENV=production \
  -e BOT_INTERNAL_URL=http://bot:3000 \
  -e WA_INTERNAL_URL=http://wa:3000 \
  -e API_INTERNAL_URL=http://api:3000 \
  getouch-app
```

### Coolify (dev.getouch.co)

1. Connect GitHub repo to Coolify
2. Set build context to `app/`
3. Set Dockerfile path to `Dockerfile`
4. Add env vars for the deployment target
5. Deploy → accessible at `dev.getouch.co`

## License

Private — Getouch Platform
