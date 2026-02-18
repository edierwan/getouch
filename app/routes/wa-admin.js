/**
 * WhatsApp Gateway — Admin API Routes
 *
 * Protected by admin auth (Cloudflare Access + session).
 * Mounted at /v1/admin/wa in server.js.
 *
 * Admin Endpoints:
 *   GET    /v1/admin/wa/health         — Full health/metrics
 *   GET    /v1/admin/wa/stats          — Dashboard KPIs
 *
 *   GET    /v1/admin/wa/tenants        — List tenants
 *   POST   /v1/admin/wa/tenants        — Create tenant
 *   PATCH  /v1/admin/wa/tenants/:id    — Update/suspend tenant
 *
 *   GET    /v1/admin/wa/keys           — List API keys (by tenant)
 *   POST   /v1/admin/wa/keys           — Create API key
 *   DELETE /v1/admin/wa/keys/:id       — Revoke key
 *   POST   /v1/admin/wa/keys/:id/rotate — Rotate key
 *
 *   GET    /v1/admin/wa/sessions       — List all sessions
 *   GET    /v1/admin/wa/sessions/:tenantId — Session detail + events
 *   POST   /v1/admin/wa/sessions/:tenantId/start   — Start/reconnect
 *   GET    /v1/admin/wa/sessions/:tenantId/qr      — Get QR code
 *   POST   /v1/admin/wa/sessions/:tenantId/logout   — Disconnect session
 *   POST   /v1/admin/wa/sessions/:tenantId/clear    — Clear session data
 *
 *   GET    /v1/admin/wa/messages       — List messages (by tenant)
 *   POST   /v1/admin/wa/test-send      — Send a test message
 *
 *   GET    /v1/admin/wa/audit          — Audit logs
 */

const { Router } = require('express');
const {
  listTenants,
  createTenant,
  updateTenant,
  getTenantById,
  listApiKeys,
  createApiKey,
  revokeApiKey,
  rotateApiKey,
  listSessions,
  getSession,
  upsertSession,
  clearSession,
  logSessionEvent,
  getSessionEvents,
  listMessages,
  getMessageStats,
  createMessage,
  updateMessageStatus,
  checkRateLimit,
  auditLog,
  getAuditLogs,
  getHealthMetrics,
} = require('../lib/wa-db');

const router = Router();

const WA_INTERNAL = process.env.WA_INTERNAL_URL || 'http://wa:3000';
const PROXY_TIMEOUT = 15000;

/* ── Admin auth ────────────────────────────────────────── */
function requireAdmin(req, res, next) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken) {
    const auth = req.headers.authorization;
    if (auth === `Bearer ${adminToken}`) return next();
  }
  const cfEmail = req.headers['cf-access-authenticated-user-email'];
  if (cfEmail) return next();
  if (req.session && (req.session.userId || req.session.cfEmail)) return next();
  const cfJwt = req.headers['cf-access-jwt-assertion'];
  if (cfJwt) return next();
  return res.status(403).json({ error: 'Admin access required' });
}

router.use(requireAdmin);

function getAdminActor(req) {
  return req.headers['cf-access-authenticated-user-email']
    || req.session?.cfEmail
    || req.session?.userId
    || 'admin';
}

/* ── WA proxy helper ───────────────────────────────────── */
async function proxyToWa(path, method, body) {
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), PROXY_TIMEOUT);
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: ac.signal,
  };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const url = `${WA_INTERNAL}${path}`;
  console.log(`[wa-admin] ${method} ${url}`);
  const r = await fetch(url, opts);
  clearTimeout(tm);
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('json')) return { status: r.status, data: await r.json() };
  return { status: r.status, data: await r.text() };
}

/* ══════════════════════════════════════════════════════════
 * HEALTH
 * ══════════════════════════════════════════════════════════ */

router.get('/health', async (_req, res) => {
  try {
    const metrics = await getHealthMetrics();

    // Probe WA container
    let waService = { status: 'offline' };
    try {
      const { data } = await proxyToWa('/health', 'GET');
      waService = { status: 'ok', ...data };
    } catch { /* offline */ }

    res.json({ wa_service: waService, ...metrics, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[wa-admin] health error:', err);
    res.status(500).json({ error: 'Failed to get health metrics' });
  }
});

router.get('/stats', async (_req, res) => {
  try {
    const metrics = await getHealthMetrics();
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

/* ══════════════════════════════════════════════════════════
 * TENANTS
 * ══════════════════════════════════════════════════════════ */

router.get('/tenants', async (_req, res) => {
  try {
    const result = await listTenants();
    res.json({ tenants: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list tenants' });
  }
});

router.post('/tenants', async (req, res) => {
  try {
    const { slug, name, plan, daily_limit, monthly_limit, webhook_url } = req.body;
    if (!slug || !name) return res.status(400).json({ error: 'slug and name are required' });

    const result = await createTenant({ slug, name, plan, daily_limit, monthly_limit, webhook_url });
    await auditLog(result.rows[0].id, getAdminActor(req), 'tenant_created', { slug, name, plan });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Tenant slug already exists' });
    console.error('[wa-admin] create tenant error:', err);
    res.status(500).json({ error: 'Failed to create tenant' });
  }
});

router.patch('/tenants/:id', async (req, res) => {
  try {
    const result = await updateTenant(req.params.id, req.body);
    if (!result.rows.length) return res.status(404).json({ error: 'Tenant not found' });
    await auditLog(req.params.id, getAdminActor(req), 'tenant_updated', req.body);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update tenant' });
  }
});

/* ══════════════════════════════════════════════════════════
 * API KEYS
 * ══════════════════════════════════════════════════════════ */

router.get('/keys', async (req, res) => {
  try {
    const tenantId = req.query.tenant_id;
    if (!tenantId) return res.status(400).json({ error: 'tenant_id is required' });
    const result = await listApiKeys(tenantId);
    res.json({ keys: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list keys' });
  }
});

router.post('/keys', async (req, res) => {
  try {
    const { tenant_id, label, scopes, rate_limit } = req.body;
    if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required' });
    const key = await createApiKey(tenant_id, label, scopes, rate_limit);
    await auditLog(tenant_id, getAdminActor(req), 'api_key_created', { label, prefix: key.key_prefix });
    res.status(201).json(key);
  } catch (err) {
    console.error('[wa-admin] create key error:', err);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

router.delete('/keys/:id', async (req, res) => {
  try {
    const result = await revokeApiKey(req.params.id);
    if (!result.rows.length) return res.status(404).json({ error: 'Key not found' });
    await auditLog(result.rows[0].tenant_id, getAdminActor(req), 'api_key_revoked', { id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to revoke key' });
  }
});

router.post('/keys/:id/rotate', async (req, res) => {
  try {
    const key = await rotateApiKey(req.params.id);
    if (!key.id) return res.status(404).json({ error: 'Key not found' });
    await auditLog(key.tenant_id, getAdminActor(req), 'api_key_rotated', { id: req.params.id, new_prefix: key.key_prefix });
    res.json(key);
  } catch (err) {
    res.status(500).json({ error: 'Failed to rotate key' });
  }
});

/* ══════════════════════════════════════════════════════════
 * SESSIONS
 * ══════════════════════════════════════════════════════════ */

router.get('/sessions', async (_req, res) => {
  try {
    const result = await listSessions();
    res.json({ sessions: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

router.get('/sessions/:tenantId', async (req, res) => {
  try {
    const session = await getSession(req.params.tenantId);
    const events = await getSessionEvents(req.params.tenantId, 20);
    res.json({ session, events: events.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get session' });
  }
});

router.post('/sessions/:tenantId/start', async (req, res) => {
  try {
    const tenantId = parseInt(req.params.tenantId);
    // Update local status
    await upsertSession(tenantId, { status: 'connecting' });
    await logSessionEvent(tenantId, 'start_requested', { actor: getAdminActor(req) });

    // Proxy start to WA container
    try {
      const { status, data } = await proxyToWa('/api/internal/wa/status', 'GET');
      await upsertSession(tenantId, {
        status: data.connected ? 'connected' : 'qr_pending',
        phone_number: data.phone || null,
        jid: data.jid || null,
        push_name: data.pushName || null,
      });
    } catch { /* container offline */ }

    const session = await getSession(tenantId);
    await auditLog(tenantId, getAdminActor(req), 'session_started', {});
    res.json({ ok: true, session });
  } catch (err) {
    console.error('[wa-admin] session start error:', err);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

router.get('/sessions/:tenantId/qr', async (req, res) => {
  try {
    const tenantId = parseInt(req.params.tenantId);
    // Try to get QR from WA container
    try {
      const { status, data } = await proxyToWa('/api/internal/wa/qr', 'GET');
      if (data.qr) {
        // Store QR in local DB
        await upsertSession(tenantId, {
          status: 'qr_pending',
          qr_data: data.qr,
          qr_expires_at: new Date(Date.now() + 60000).toISOString(),
        });
        return res.json({ qr: data.qr, status: 'qr_pending' });
      }
      if (data.connected) {
        await upsertSession(tenantId, { status: 'connected', jid: data.jid, push_name: data.pushName });
        return res.json({ status: 'connected', message: 'Already connected' });
      }
      return res.json({ status: data.status || 'unknown', message: 'No QR available' });
    } catch {
      return res.json({ status: 'offline', message: 'WA service offline' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to get QR' });
  }
});

router.post('/sessions/:tenantId/logout', async (req, res) => {
  try {
    const tenantId = parseInt(req.params.tenantId);
    await clearSession(tenantId);
    await logSessionEvent(tenantId, 'logout', { actor: getAdminActor(req) });
    await auditLog(tenantId, getAdminActor(req), 'session_logout', {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to logout' });
  }
});

router.post('/sessions/:tenantId/clear', async (req, res) => {
  try {
    const tenantId = parseInt(req.params.tenantId);
    await clearSession(tenantId);
    await logSessionEvent(tenantId, 'session_cleared', { actor: getAdminActor(req) });
    await auditLog(tenantId, getAdminActor(req), 'session_cleared', {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear session' });
  }
});

/* ══════════════════════════════════════════════════════════
 * MESSAGES
 * ══════════════════════════════════════════════════════════ */

router.get('/messages', async (req, res) => {
  try {
    const { tenant_id, direction, limit, offset } = req.query;
    if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required' });
    const result = await listMessages(tenant_id, { direction, limit: parseInt(limit) || 50, offset: parseInt(offset) || 0 });
    const stats = await getMessageStats(tenant_id);
    res.json({ messages: result.rows, stats: stats.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list messages' });
  }
});

router.post('/test-send', async (req, res) => {
  try {
    const { tenant_id, to, text } = req.body;
    if (!tenant_id || !to || !text) return res.status(400).json({ error: 'tenant_id, to, text required' });

    // Check tenant
    const tRes = await getTenantById(tenant_id);
    if (!tRes.rows.length) return res.status(404).json({ error: 'Tenant not found' });
    const tenant = tRes.rows[0];

    // Check rate limit
    const rl = await checkRateLimit(tenant_id, tenant.daily_limit, tenant.monthly_limit);
    if (!rl.ok) return res.status(429).json({ error: 'Rate limit exceeded', ...rl });

    // Create message record
    const toE164 = to.startsWith('+') ? to : `+${to}`;
    const waJid = toE164.replace('+', '') + '@s.whatsapp.net';
    const msgRes = await createMessage(tenant_id, 'outbound', waJid, toE164, text);
    const msgId = msgRes.rows[0].id;

    // Proxy to WA service
    try {
      const { status, data } = await proxyToWa('/api/internal/wa/send', 'POST', {
        tenant_id: parseInt(tenant_id),
        to_e164: toE164,
        text,
      });

      if (status >= 200 && status < 300) {
        await updateMessageStatus(msgId, 'sent', data.message_id || data.wa_message_id);
        await auditLog(tenant_id, getAdminActor(req), 'test_send', { to: toE164, status: 'sent' });
        return res.json({ ok: true, message_id: msgId, wa_response: data });
      }
      await updateMessageStatus(msgId, 'failed', null, JSON.stringify(data));
      return res.status(status).json({ error: 'WA send failed', detail: data });
    } catch (err) {
      await updateMessageStatus(msgId, 'failed', null, err.message);
      return res.status(502).json({ error: 'WA service unavailable' });
    }
  } catch (err) {
    console.error('[wa-admin] test-send error:', err);
    res.status(500).json({ error: 'Failed to send test message' });
  }
});

/* ══════════════════════════════════════════════════════════
 * AUDIT
 * ══════════════════════════════════════════════════════════ */

router.get('/audit', async (req, res) => {
  try {
    const tenantId = req.query.tenant_id || null;
    const result = await getAuditLogs(tenantId ? parseInt(tenantId) : null);
    res.json({ logs: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get audit logs' });
  }
});

module.exports = router;
