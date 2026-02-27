try { require('dotenv').config(); } catch(e) {}

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
const smsGatewayRoutes  = require('./routes/sms-gateway');
const smsAdminRoutes    = require('./routes/sms-admin');
const waAdminRoutes     = require('./routes/wa-admin');
const reportingRoutes   = require('./routes/reporting');
const smsWorker         = require('./lib/sms-worker');
const { visitorMiddleware } = require('./lib/usage');

/* ── Config ─────────────────────────────────────────────── */
const PORT    = process.env.PORT || 3001;
const VERSION = process.env.VERSION || '1.0.0';
const ASSET_V = VERSION + '.' + Date.now();  // cache-bust token
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
  VERSION: ASSET_V,
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
  pages.smsAdmin   = loadPage('sms-admin.html');
  pages.waAdmin    = loadPage('wa-admin.html');
  pages.tryBot     = loadPage('try-bot.html');
  pages.tryWhatsapp = loadPage('try-whatsapp.html');
  pages.pair       = loadPage('pair.html');
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
  maxAge: isDev ? 0 : '1h',
  etag: true,
}));

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

/* ── Visitor tracking cookie ──────────────────────────────── */
app.use(visitorMiddleware);

/* ── Session ─────────────────────────────────────────────── */
const pgSessionStore = new PgStore({
  pool,
  tableName: 'session',
  createTableIfMissing: true,
  errorLog: (err) => console.error('[session-store] PgStore error:', err.message),
});

const sessionMiddleware = session({
  store: pgSessionStore,
  secret: process.env.SESSION_SECRET || 'getouch-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // TLS terminated by Cloudflare at edge, internal network is secure
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: 'lax',
  },
});

// Wrap session middleware so DB failures don't crash public pages
app.use((req, res, next) => {
  sessionMiddleware(req, res, (err) => {
    if (err) {
      console.error('[session] Session init failed:', err.message);
      // Continue without session — public pages still work
      req.session = null;
    }
    next();
  });
});

/* ── Passport ────────────────────────────────────────────── */
app.use(passport.initialize());
app.use((req, res, next) => {
  if (!req.session) return next(); // Skip passport if session unavailable
  passport.session()(req, res, next);
});

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
app.use('/v1/admin', reportingRoutes);
app.use('/v1/sms', smsGatewayRoutes);
app.use('/v1/admin/sms', smsAdminRoutes);
app.use('/v1/admin/wa', waAdminRoutes);

/* ── Public guest threshold endpoint (for soft gate) ──── */
app.get('/v1/guest/thresholds', async (_req, res) => {
  const { getSetting } = require('./lib/settings');
  res.json({
    soft_gate_after_chats: await getSetting('guest.soft_gate_after_chats', 5),
    soft_gate_after_images: await getSetting('guest.soft_gate_after_images', 2),
  });
});

/* ── Authenticated API endpoints ─────────────────────────── */
app.get('/api/me', requireAuth, async (req, res) => {
  const { query } = require('./lib/db');
  try {
    const result = await query(
      'SELECT id, email, name, avatar_url, created_at FROM users WHERE id = $1',
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

/* Device pairing landing page (public — code is validated client-side) */
app.get('/pair', (_req, res) => {
  if (isDev) reloadPages();
  res.type('html').send(pages.pair);
});

app.get('/admin', (_req, res) => res.redirect(301, '/admin/'));

app.get('/admin/', (req, res) => {
  if (isDev) reloadPages();
  // Persist CF Access identity into session so AJAX calls to /v1/admin/* pass auth
  const cfEmail = req.headers['cf-access-authenticated-user-email'];
  if (cfEmail && req.session) {
    req.session.cfEmail = cfEmail;
  }
  res.type('html').send(pages.admin);
});

app.get('/admin/ops', (req, res) => {
  if (isDev) reloadPages();
  const cfEmail = req.headers['cf-access-authenticated-user-email'];
  if (cfEmail && req.session) {
    req.session.cfEmail = cfEmail;
  }
  res.type('html').send(pages.ops);
});

app.get('/admin/services/sms', (req, res) => {
  if (isDev) reloadPages();
  const cfEmail = req.headers['cf-access-authenticated-user-email'];
  if (cfEmail && req.session) {
    req.session.cfEmail = cfEmail;
  }
  res.type('html').send(pages.smsAdmin);
});

app.get('/admin/services/whatsapp', (req, res) => {
  if (isDev) reloadPages();
  const cfEmail = req.headers['cf-access-authenticated-user-email'];
  if (cfEmail && req.session) {
    req.session.cfEmail = cfEmail;
  }
  res.type('html').send(pages.waAdmin);
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

/* ── Admin: Registered Users API ─────────────────────────── */
app.get('/v1/admin/users', async (req, res) => {
  const { query: dbQuery } = require('./lib/db');
  try {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();

    let whereClause = '';
    let params = [];

    if (search) {
      whereClause = `WHERE u.email ILIKE $1 OR u.name ILIKE $1`;
      params.push(`%${search}%`);
    }

    // Count total
    const countResult = await dbQuery(
      `SELECT COUNT(*) as total FROM users u ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total);

    // Fetch users with OAuth provider info
    const usersResult = await dbQuery(
      `SELECT u.id, u.email, u.name, u.avatar_url, u.is_active,
              u.email_verified_at, u.created_at, u.updated_at,
              COALESCE(
                (SELECT json_agg(json_build_object('provider', oa.provider, 'provider_email', oa.provider_email))
                 FROM oauth_accounts oa WHERE oa.user_id = u.id),
                '[]'::json
              ) as oauth_providers
       FROM users u
       ${whereClause}
       ORDER BY u.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({
      users: usersResult.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('[admin] Users list error:', err.message);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

/* ── Admin: User Stats ───────────────────────────────────── */
app.get('/v1/admin/users/stats', async (_req, res) => {
  const { query: dbQuery } = require('./lib/db');
  try {
    const stats = await dbQuery(`
      SELECT
        COUNT(*) as total_users,
        COUNT(*) FILTER (WHERE is_active = true) as active_users,
        COUNT(*) FILTER (WHERE email_verified_at IS NOT NULL) as verified_users,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as new_last_7d,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') as new_last_30d
      FROM users
    `);

    const oauthStats = await dbQuery(`
      SELECT provider, COUNT(DISTINCT user_id) as user_count
      FROM oauth_accounts
      GROUP BY provider
    `);

    const providers = {};
    oauthStats.rows.forEach(function(r) { providers[r.provider] = parseInt(r.user_count); });

    res.json({
      ...stats.rows[0],
      oauth_providers: providers,
    });
  } catch (err) {
    console.error('[admin] User stats error:', err.message);
    res.status(500).json({ error: 'Failed to load user stats' });
  }
});

/* ── 404 ─────────────────────────────────────────────────── */
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
});

/* ── Global error handler ────────────────────────────────── */
app.use((err, req, res, _next) => {
  console.error(`[app] Unhandled error on ${req.method} ${req.path}:`, err.message);
  if (isDev) console.error(err.stack);
  res.status(500).json({
    error: 'internal_server_error',
    message: isDev ? err.message : 'Something went wrong',
    path: req.path,
  });
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

  // Migration 003 — SMS Gateway schema
  try {
    const { initSmsSchema } = require('./lib/sms-db');
    await initSmsSchema();
    console.log('[db] Migration 003 (SMS gateway) applied');
  } catch (err) {
    console.error('[db] Migration 003 error (may already exist):', err.message);
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

      const migration008dev = require('fs').readFileSync(
        require('path').join(__dirname, 'migrations', '008_usage_events.sql'), 'utf8'
      );
      await poolDev.query(migration008dev);
      console.log('[db:dev] Migrations applied on dev pool');
    } catch (err) {
      console.error('[db:dev] Migration error (may already exist):', err.message);
    }
  }

  // Migration 008 — Usage events tracking
  try {
    const migration008 = require('fs').readFileSync(
      require('path').join(__dirname, 'migrations', '008_usage_events.sql'), 'utf8'
    );
    await pool.query(migration008);
    console.log('[db] Migration 008 (usage events) applied');
  } catch (err) {
    console.error('[db] Migration 008 error (may already exist):', err.message);
  }
}

// Warmup Ollama model so first chat response is fast
async function warmupOllama() {
  const OLLAMA_HOST = process.env.OLLAMA_HOST || 'ollama';
  const OLLAMA_PORT = process.env.OLLAMA_PORT || '11434';
  const ollamaUrl = `http://${OLLAMA_HOST}:${OLLAMA_PORT}`;
  try {
    const { getSetting } = require('./lib/settings');
    const defaultModel = await getSetting('ai.default_text_model', 'llama3.1:8b');
    console.log(`[ollama] Warming up model: ${defaultModel}...`);
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), 120_000); // 2 min timeout for model load
    const r = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: defaultModel,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        keep_alive: '30m',
        options: { num_predict: 1 },
      }),
      signal: ac.signal,
    });
    clearTimeout(tm);
    if (r.ok) {
      console.log(`[ollama] Model ${defaultModel} warmed up (kept alive 30m)`);
    } else {
      console.warn(`[ollama] Warmup returned HTTP ${r.status}`);
    }

    // Also warm up vision model if different
    const visionModel = await getSetting('ai.default_vision_model', 'qwen2.5vl:32b');
    if (visionModel && visionModel !== defaultModel) {
      console.log(`[ollama] Warming up vision model: ${visionModel}...`);
      const ac2 = new AbortController();
      const tm2 = setTimeout(() => ac2.abort(), 180_000);
      const r2 = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: visionModel,
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
          keep_alive: '30m',
          options: { num_predict: 1 },
        }),
        signal: ac2.signal,
      });
      clearTimeout(tm2);
      if (r2.ok) {
        console.log(`[ollama] Vision model ${visionModel} warmed up (kept alive 30m)`);
      } else {
        console.warn(`[ollama] Vision warmup returned HTTP ${r2.status}`);
      }
    }
  } catch (err) {
    console.warn('[ollama] Warmup failed (model will load on first request):', err.message);
  }
}

initSchema()
  .then(() => runMigrations())
  .then(() => {
    // Start SMS worker
    try { smsWorker.startWorker(); console.log('[sms] Worker started'); }
    catch(err) { console.error('[sms] Worker start error:', err.message); }

    // Warmup Ollama in background (don't block startup)
    warmupOllama();

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
      try { smsWorker.stopWorker(); } catch(_) {}
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
