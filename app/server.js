require('dotenv').config();

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const session  = require('express-session');
const PgStore  = require('connect-pg-simple')(session);

/* ── Database & Auth ────────────────────────────────────── */
const { pool, endAll, initSchema }  = require('./lib/db');
const { requireAuth, loadUser } = require('./lib/auth');
const { resolveEnvironment }    = require('./lib/env-router');
const passport        = require('./lib/passport');
const authRoutes        = require('./routes/auth');
const oauthRoutes       = require('./routes/oauth');
const apiKeysRoutes     = require('./routes/api-keys');
const waGatewayRoutes   = require('./routes/wa-gateway');
const chatStreamRoutes  = require('./routes/chat-stream');
const imageRoutes       = require('./routes/image');
const settingsRoutes    = require('./routes/settings');

/* ── Config ─────────────────────────────────────────────── */
const PORT    = 3000;
const VERSION = process.env.VERSION || '1.0.0';
const isDev   = process.env.NODE_ENV !== 'production';

const INTERNAL = {
  bot:     process.env.BOT_INTERNAL_URL     || 'http://bot:3000',
  wa:      process.env.WA_INTERNAL_URL      || 'http://wa:3000',
  api:     process.env.API_INTERNAL_URL     || 'http://api:3000',
};

/* AI-infrastructure endpoints (different health paths) */
const AI_PROBES = {
  ollama:  { url: `http://${process.env.OLLAMA_HOST  || 'ollama'}:${process.env.OLLAMA_PORT  || '11434'}`, health: '/' },
  comfyui: { url: `http://${process.env.COMFYUI_HOST || 'comfyui'}:${process.env.COMFYUI_PORT || '8188'}`, health: '/system_stats' },
};

const VARS = {
  BOT_URL: process.env.PUBLIC_BOT_URL || 'https://bot.getouch.co',
  WA_URL:  process.env.PUBLIC_WA_URL  || 'https://wa.getouch.co',
  API_URL: process.env.PUBLIC_API_URL || 'https://api.getouch.co',
  DB_URL:  process.env.PUBLIC_DB_URL  || 'https://db.getouch.co',
  VERSION,
  YEAR: String(new Date().getFullYear()),
};

/* ── Template loader ────────────────────────────────────── */
function loadPage(file) {
  let html = fs.readFileSync(path.join(__dirname, 'views', file), 'utf8');
  for (const [k, v] of Object.entries(VARS)) {
    html = html.replaceAll(`{{${k}}}`, v);
  }
  return html;
}

let pages = {};
function reloadPages() {
  pages.landing    = loadPage('landing.html');
  pages.admin      = loadPage('admin.html');
  pages.ops        = loadPage('ops.html');
  pages.tryBot     = loadPage('try-bot.html');
  pages.tryWhatsapp = loadPage('try-whatsapp.html');
}
reloadPages();

/* ── Express ────────────────────────────────────────────── */
const app = express();
app.set('strict routing', true);
app.set('trust proxy', 1); // Trust Caddy/Cloudflare proxy chain for secure cookies

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: isDev ? 0 : '7d',
  etag: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ── Session ─────────────────────────────────────────────── */
app.use(session({
  store: new PgStore({
    pool,
    tableName: 'session',
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET || 'getouch-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // TLS terminated by Cloudflare at edge, internal network is secure
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: 'lax',
  },
}));

/* ── Passport ────────────────────────────────────────────── */
app.use(passport.initialize());
app.use(passport.session());

/* ── Auth & API routes ───────────────────────────────────── */
app.use('/auth', authRoutes);
app.use('/api/auth', oauthRoutes);
app.use('/api/keys', apiKeysRoutes);

/* ── Environment resolution for all /v1 routes ───────────── */
app.use('/v1', resolveEnvironment);
app.use('/v1', waGatewayRoutes);
app.use('/v1', chatStreamRoutes);
app.use('/v1', imageRoutes);
app.use('/v1/admin', settingsRoutes);

/* ── Authenticated API endpoints ─────────────────────────── */
app.get('/api/me', requireAuth, async (req, res) => {
  const { query } = require('./lib/db');
  try {
    const result = await query(
      'SELECT id, email, name, created_at FROM users WHERE id = $1',
      [req.session.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load user' });
  }
});

/* ── Health ──────────────────────────────────────────────── */
app.get('/health', (_req, res) => {
  res.json({
    service: 'app',
    status: 'ok',
    version: VERSION,
    timestamp: new Date().toISOString(),
  });
});

/* ── Status API (server-side probes, 2 s timeout) ────────── */
app.get('/api/status', async (_req, res) => {
  const probes = Object.entries(INTERNAL).map(async ([name, baseUrl]) => {
    const t0 = Date.now();
    try {
      const ac = new AbortController();
      const tm = setTimeout(() => ac.abort(), 2000);
      const r  = await fetch(`${baseUrl}/health`, { signal: ac.signal });
      clearTimeout(tm);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      return {
        name,
        status:     d.status  || 'unknown',
        latency_ms: Date.now() - t0,
        version:    d.version || null,
        model:      d.model   || null,
      };
    } catch {
      return { name, status: 'offline', latency_ms: Date.now() - t0 };
    }
  });

  /* AI infrastructure probes (Ollama, ComfyUI) */
  const aiProbes = Object.entries(AI_PROBES).map(async ([name, cfg]) => {
    const t0 = Date.now();
    try {
      const ac = new AbortController();
      const tm = setTimeout(() => ac.abort(), 3000);
      const r  = await fetch(`${cfg.url}${cfg.health}`, { signal: ac.signal });
      clearTimeout(tm);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { name, status: 'ok', latency_ms: Date.now() - t0 };
    } catch {
      return { name, status: 'offline', latency_ms: Date.now() - t0 };
    }
  });

  const results  = await Promise.all([...probes, ...aiProbes]);
  const services = {};
  for (const r of results) services[r.name] = r;
  res.json({ services, timestamp: new Date().toISOString() });
});

/* ── Pages ───────────────────────────────────────────────── */
app.get('/', (_req, res) => {
  if (isDev) reloadPages();
  res.type('html').send(pages.landing);
});

app.get('/try/bot', (_req, res) => {
  if (isDev) reloadPages();
  res.type('html').send(pages.tryBot);
});

app.get('/try/whatsapp', (_req, res) => {
  if (isDev) reloadPages();
  res.type('html').send(pages.tryWhatsapp);
});

app.get('/admin', (_req, res) => res.redirect(301, '/admin/'));

app.get('/admin/', (_req, res) => {
  if (isDev) reloadPages();
  res.type('html').send(pages.admin);
});

app.get('/admin/ops', (_req, res) => {
  if (isDev) reloadPages();
  res.type('html').send(pages.ops);
});

/* ── Dashboard (authenticated) ───────────────────────────── */
app.get('/dashboard', requireAuth, (_req, res) => {
  let html = fs.readFileSync(path.join(__dirname, 'views', 'dashboard.html'), 'utf8');
  html = html.replace('{{YEAR}}', String(new Date().getFullYear()));
  res.type('html').send(html);
});

/* ── Chat API (proxy to bot service) ─────────────────────── */
app.post('/api/chat', async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Message is required' });

  try {
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), 30000);

    // Use internal endpoint (accessible from Docker network without API key)
    const r = await fetch(`${INTERNAL.bot}/api/internal/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, stream: false }),
      signal: ac.signal,
    });
    clearTimeout(tm);

    if (!r.ok) throw new Error(`Bot returned HTTP ${r.status}`);
    const data = await r.json();
    res.json({ reply: data.reply || data.message || data.response || 'No response from model' });
  } catch (err) {
    res.json({
      error: 'Bot service is currently unavailable. The service may be offline or the AI model is loading.',
      detail: isDev ? err.message : undefined,
    });
  }
});

/* ── WhatsApp Demo API (proxy to WA service) ─────────────── */
app.post('/api/wa-demo', async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Message is required' });

  try {
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), 5000);

    const r = await fetch(`${INTERNAL.wa}/api/v1/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
      signal: ac.signal,
    });
    clearTimeout(tm);

    if (!r.ok) throw new Error(`WA returned HTTP ${r.status}`);
    const data = await r.json();
    res.json({ reply: data.reply || data.message || null });
  } catch {
    // Return null so the client-side demo fallback handles it
    res.json({ reply: null });
  }
});

/* ── 404 ─────────────────────────────────────────────────── */
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
});

/* ── Start ───────────────────────────────────────────────── */
// Run AI platform migration after base schema
async function runMigrations() {
  try {
    const migrationSQL = require('fs').readFileSync(
      require('path').join(__dirname, 'migrations', '001_ai_platform.sql'), 'utf8'
    );
    await pool.query(migrationSQL);
    console.log('[db] Migration 001 (AI platform) applied');
  } catch (err) {
    console.error('[db] Migration 001 error (may already exist):', err.message);
  }

  // Migration 002 — Dual environment columns
  try {
    const migration002 = require('fs').readFileSync(
      require('path').join(__dirname, 'migrations', '002_dual_environment.sql'), 'utf8'
    );
    await pool.query(migration002);
    console.log('[db] Migration 002 (dual environment) applied');
  } catch (err) {
    console.error('[db] Migration 002 error (may already exist):', err.message);
  }

  // If dev pool exists, also apply schema migrations there
  const { poolDev } = require('./lib/db');
  if (poolDev) {
    try {
      const migrationSQL = require('fs').readFileSync(
        require('path').join(__dirname, 'migrations', '001_ai_platform.sql'), 'utf8'
      );
      await poolDev.query(migrationSQL);

      const migration002 = require('fs').readFileSync(
        require('path').join(__dirname, 'migrations', '002_dual_environment.sql'), 'utf8'
      );
      await poolDev.query(migration002);
      console.log('[db:dev] Migrations applied on dev pool');
    } catch (err) {
      console.error('[db:dev] Migration error (may already exist):', err.message);
    }
  }
}

initSchema()
  .then(() => runMigrations())
  .then(() => {
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`[app] v${VERSION} → http://localhost:${PORT}`);
      console.log(`[app] env=${isDev ? 'development' : 'production'}`);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[app] Port ${PORT} still in use after predev.`);
        console.error(`[app] Run: lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
        process.exit(1);
      }
      throw err;
    });

    /* ── Graceful shutdown (Ctrl+C / Docker SIGTERM) ─────────── */
    let shuttingDown = false;
    function shutdown(signal) {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[app] ${signal} — closing`);
      server.close(() => {
        endAll().then(() => process.exit(0));
      });
      setTimeout(() => process.exit(1), 3000);
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));
  })
  .catch((err) => {
    console.error('[app] Failed to initialize database:', err.message);
    console.error('[app] Starting without database...');

    // Start anyway for non-DB features (landing page, demos)
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`[app] v${VERSION} → http://localhost:${PORT} (no DB)`);
    });

    let shuttingDown = false;
    function shutdown(signal) {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[app] ${signal} — closing`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 3000);
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));
  });
