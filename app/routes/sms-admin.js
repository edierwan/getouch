/**
 * SMS Gateway — Admin API Routes
 *
 * Protected by existing admin auth (Cloudflare Access + session).
 * Mounted at /v1/admin/sms in server.js.
 *
 * Admin Endpoints:
 *   GET    /v1/admin/sms/health        — Full health/metrics
 *   GET    /v1/admin/sms/stats         — Dashboard KPIs
 *
 *   GET    /v1/admin/sms/tenants       — List tenants
 *   POST   /v1/admin/sms/tenants       — Create tenant
 *   PATCH  /v1/admin/sms/tenants/:id   — Update/suspend tenant
 *
 *   GET    /v1/admin/sms/keys          — List API keys (by tenant)
 *   POST   /v1/admin/sms/keys          — Create API key
 *   DELETE /v1/admin/sms/keys/:id      — Revoke key
 *   POST   /v1/admin/sms/keys/:id/rotate — Rotate key
 *
 *   GET    /v1/admin/sms/devices       — List devices
 *   POST   /v1/admin/sms/devices       — Add device
 *   PATCH  /v1/admin/sms/devices/:id   — Update device
 *   POST   /v1/admin/sms/devices/:id/rotate-token — Rotate device token
 *   GET    /v1/admin/sms/devices/:id/events — Device events
 *
 *   GET    /v1/admin/sms/outbound      — List outbound messages
 *   GET    /v1/admin/sms/outbound/:id  — Message detail + timeline
 *   GET    /v1/admin/sms/inbound       — List inbound messages
 *
 *   GET    /v1/admin/sms/webhooks      — List webhooks
 *   POST   /v1/admin/sms/webhooks      — Create webhook
 *   PATCH  /v1/admin/sms/webhooks/:id  — Update webhook
 *   DELETE /v1/admin/sms/webhooks/:id  — Delete webhook
 *   POST   /v1/admin/sms/webhooks/:id/rotate — Rotate signing secret
 *
 *   GET    /v1/admin/sms/audit         — Audit logs
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
  listDevices,
  getDevice,
  createDevice,
  updateDevice,
  rotateDeviceToken,
  getDeviceEvents,
  listOutboundMessages,
  getOutboundMessage,
  getMessageTimeline,
  listInboundMessages,
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  rotateWebhookSecret,
  auditLog,
  getHealthMetrics,
  smsQuery,
  genRequestId,
  getDbDebugInfo,
  createPairCode,
  listPairCodes,
} = require('../lib/sms-db');

const router = Router();

/**
 * Admin auth middleware (same as settings.js)
 */
function requireAdmin(req, res, next) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken) {
    const auth = req.headers.authorization;
    if (auth === `Bearer ${adminToken}`) return next();
  }

  const cfEmail = req.headers['cf-access-authenticated-user-email'];
  if (cfEmail) return next();

  if (req.session && (req.session.userId || req.session.cfEmail)) {
    return next();
  }

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

function getIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
}

/* ━━━ Health & Stats ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * GET /v1/admin/sms/health — Full health endpoint
 */
router.get('/health', async (_req, res) => {
  try {
    const metrics = await getHealthMetrics();
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get health metrics', detail: err.message });
  }
});

/**
 * GET /v1/admin/sms/stats — Dashboard KPIs
 */
router.get('/stats', async (_req, res) => {
  try {
    const [metrics, tenantCount, keyCount, deviceCount] = await Promise.all([
      getHealthMetrics(),
      smsQuery(`SELECT COUNT(*) as count FROM sms_tenants`),
      smsQuery(`SELECT COUNT(*) as count FROM sms_api_keys WHERE is_active = true`),
      smsQuery(`SELECT COUNT(*) as count FROM sms_devices WHERE is_enabled = true`),
    ]);

    res.json({
      ...metrics,
      tenants: parseInt(tenantCount.rows[0]?.count || 0),
      active_keys: parseInt(keyCount.rows[0]?.count || 0),
      active_devices: parseInt(deviceCount.rows[0]?.count || 0),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get stats', detail: err.message });
  }
});

/* ━━━ Tenants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

router.get('/tenants', async (_req, res) => {
  try {
    const tenants = await listTenants();
    res.json({ tenants });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list tenants' });
  }
});

router.post('/tenants', async (req, res) => {
  const { name, slug, plan, status } = req.body || {};
  if (!name || !slug) {
    return res.status(400).json({ error: '`name` and `slug` are required' });
  }

  // Validate slug format
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'Slug must be lowercase alphanumeric with hyphens only' });
  }

  try {
    const tenant = await createTenant({ name, slug, plan, status });
    await auditLog({
      tenantId: tenant.id,
      actor: getAdminActor(req),
      action: 'tenant.create',
      resource: 'sms_tenants',
      resourceId: tenant.id,
      details: { name, slug, plan },
      ipAddress: getIp(req),
    });
    res.status(201).json({ tenant });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Tenant slug already exists' });
    }
    res.status(500).json({ error: 'Failed to create tenant' });
  }
});

router.patch('/tenants/:id', async (req, res) => {
  const { name, plan, status, settings } = req.body || {};

  try {
    const tenant = await updateTenant(req.params.id, { name, plan, status, settings });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    await auditLog({
      tenantId: tenant.id,
      actor: getAdminActor(req),
      action: status === 'suspended' ? 'tenant.suspend' : 'tenant.update',
      resource: 'sms_tenants',
      resourceId: tenant.id,
      details: { name, plan, status },
      ipAddress: getIp(req),
    });

    res.json({ tenant });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update tenant' });
  }
});

/* ━━━ API Keys ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

router.get('/keys', async (req, res) => {
  const { tenant_id } = req.query;
  if (!tenant_id) return res.status(400).json({ error: 'tenant_id query param required' });

  try {
    const keys = await listApiKeys(tenant_id);
    res.json({ keys });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list API keys' });
  }
});

router.post('/keys', async (req, res) => {
  const { tenant_id, name, scopes, rate_limit_rpm, expires_at } = req.body || {};
  if (!tenant_id || !name) {
    return res.status(400).json({ error: '`tenant_id` and `name` are required' });
  }

  try {
    const { key, rawKey } = await createApiKey({
      tenantId: tenant_id,
      name,
      scopes,
      rateLimitRpm: rate_limit_rpm,
      expiresAt: expires_at,
    });

    await auditLog({
      tenantId: tenant_id,
      actor: getAdminActor(req),
      action: 'api_key.create',
      resource: 'sms_api_keys',
      resourceId: key.id,
      details: { name, scopes: key.scopes },
      ipAddress: getIp(req),
    });

    res.status(201).json({
      key,
      secret: rawKey,
      warning: 'Save this API key now. It cannot be shown again.',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

router.delete('/keys/:id', async (req, res) => {
  try {
    const key = await revokeApiKey(req.params.id);
    if (!key) return res.status(404).json({ error: 'Key not found or already revoked' });

    await auditLog({
      tenantId: key.tenant_id,
      actor: getAdminActor(req),
      action: 'api_key.revoke',
      resource: 'sms_api_keys',
      resourceId: key.id,
      ipAddress: getIp(req),
    });

    res.json({ ok: true, message: 'API key revoked' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to revoke key' });
  }
});

router.post('/keys/:id/rotate', async (req, res) => {
  try {
    const result = await rotateApiKey(req.params.id);
    if (!result) return res.status(404).json({ error: 'Key not found' });

    await auditLog({
      tenantId: result.key.tenant_id,
      actor: getAdminActor(req),
      action: 'api_key.rotate',
      resource: 'sms_api_keys',
      resourceId: result.key.id,
      ipAddress: getIp(req),
    });

    res.json({
      key: result.key,
      secret: result.rawKey,
      warning: 'Save this new API key now. It cannot be shown again.',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to rotate key' });
  }
});

/* ━━━ Devices ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

router.get('/devices', async (req, res) => {
  const rid = genRequestId();
  const tenantId = req.query.tenant_id || null;
  try {
    console.log(`[sms-admin] GET /devices rid=${rid} tenant_id=${tenantId || 'ALL'}`);
    const devices = await listDevices(tenantId, rid);
    console.log(`[sms-admin] GET /devices rid=${rid} count=${devices.length}`);
    res.json({ devices, request_id: rid });
  } catch (err) {
    console.error(`[sms-admin] GET /devices FAILED rid=${rid} err=${err.message}`, err.stack);
    res.status(500).json({ error: 'Failed to list devices', detail: err.message, request_id: rid });
  }
});

router.post('/devices', async (req, res) => {
  const rid = genRequestId();
  const { tenant_id, name, phone_number, is_shared_pool } = req.body || {};
  if (!name) return res.status(400).json({ error: '`name` is required', request_id: rid });

  // Validate shared-pool ↔ tenant mutual exclusivity
  if (is_shared_pool && tenant_id) {
    return res.status(400).json({
      error: 'Cannot set is_shared_pool=true with a tenant_id. Shared pool devices must not be assigned to a tenant.',
      request_id: rid,
    });
  }

  try {
    console.log(`[sms-admin] POST /devices rid=${rid} name=${name} tenant_id=${tenant_id || 'null'} shared=${!!is_shared_pool}`);

    const { device, deviceToken } = await createDevice({
      tenantId: tenant_id || null,
      name,
      phoneNumber: phone_number,
      isSharedPool: is_shared_pool || false,
      requestId: rid,
    });

    await auditLog({
      tenantId: tenant_id,
      actor: getAdminActor(req),
      action: 'device.create',
      resource: 'sms_devices',
      resourceId: device.id,
      details: { name, phone_number, is_shared_pool: device.is_shared_pool, request_id: rid },
      ipAddress: getIp(req),
    });

    console.log(`[sms-admin] POST /devices OK rid=${rid} id=${device.id}`);
    res.status(201).json({
      device,
      device_token: deviceToken,
      warning: 'Save the device token. Configure it on the Android device.',
      request_id: rid,
    });
  } catch (err) {
    console.error(`[sms-admin] POST /devices FAILED rid=${rid} err=${err.message}`, err.stack);
    res.status(500).json({ error: 'Failed to create device', detail: err.message, request_id: rid });
  }
});

router.patch('/devices/:id', async (req, res) => {
  const { name, phone_number, status, is_shared_pool, is_enabled, tenant_id, metadata } = req.body || {};

  try {
    const device = await updateDevice(req.params.id, {
      name, phone_number, status, is_shared_pool, is_enabled, tenant_id, metadata,
    });
    if (!device) return res.status(404).json({ error: 'Device not found' });

    if (is_enabled === false) {
      await auditLog({
        tenantId: device.tenant_id,
        actor: getAdminActor(req),
        action: 'device.disable',
        resource: 'sms_devices',
        resourceId: device.id,
        ipAddress: getIp(req),
      });
    }

    res.json({ device });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update device' });
  }
});

router.post('/devices/:id/rotate-token', async (req, res) => {
  try {
    const result = await rotateDeviceToken(req.params.id);
    if (!result.device) return res.status(404).json({ error: 'Device not found' });

    await auditLog({
      tenantId: result.device.tenant_id,
      actor: getAdminActor(req),
      action: 'device.rotate_token',
      resource: 'sms_devices',
      resourceId: result.device.id,
      ipAddress: getIp(req),
    });

    res.json({
      device: result.device,
      device_token: result.deviceToken,
      warning: 'Update the token on the Android device.',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to rotate device token' });
  }
});

router.get('/devices/:id/events', async (req, res) => {
  try {
    const events = await getDeviceEvents(
      req.params.id,
      Math.min(100, parseInt(req.query.limit) || 50)
    );
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get device events' });
  }
});

/* ━━━ Messages ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

router.get('/outbound', async (req, res) => {
  try {
    // Admin can view all tenants or filter by tenant_id
    const tenantId = req.query.tenant_id;
    if (!tenantId) {
      // Get all messages across tenants
      const result = await smsQuery(
        `SELECT m.*, d.name as device_name, t.name as tenant_name
         FROM sms_outbound_messages m
         LEFT JOIN sms_devices d ON d.id = m.from_device_id
         LEFT JOIN sms_tenants t ON t.id = m.tenant_id
         ORDER BY m.created_at DESC
         LIMIT $1 OFFSET $2`,
        [Math.min(100, parseInt(req.query.limit) || 50), parseInt(req.query.offset) || 0]
      );
      return res.json({ messages: result.rows, count: result.rows.length });
    }

    const messages = await listOutboundMessages(tenantId, {
      status: req.query.status,
      limit: Math.min(100, parseInt(req.query.limit) || 50),
      offset: parseInt(req.query.offset) || 0,
    });
    res.json({ messages, count: messages.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list outbound messages' });
  }
});

router.get('/outbound/:id', async (req, res) => {
  try {
    // Admin can view any message
    const result = await smsQuery(
      `SELECT m.*, d.name as device_name, t.name as tenant_name
       FROM sms_outbound_messages m
       LEFT JOIN sms_devices d ON d.id = m.from_device_id
       LEFT JOIN sms_tenants t ON t.id = m.tenant_id
       WHERE m.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Message not found' });

    const timeline = await getMessageTimeline(req.params.id);
    res.json({ message: result.rows[0], timeline });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get message' });
  }
});

router.get('/inbound', async (req, res) => {
  try {
    const tenantId = req.query.tenant_id;
    if (!tenantId) {
      const result = await smsQuery(
        `SELECT m.*, d.name as device_name, t.name as tenant_name
         FROM sms_inbound_messages m
         LEFT JOIN sms_devices d ON d.id = m.device_id
         LEFT JOIN sms_tenants t ON t.id = m.tenant_id
         ORDER BY m.created_at DESC
         LIMIT $1 OFFSET $2`,
        [Math.min(100, parseInt(req.query.limit) || 50), parseInt(req.query.offset) || 0]
      );
      return res.json({ messages: result.rows, count: result.rows.length });
    }

    const messages = await listInboundMessages(tenantId, {
      limit: Math.min(100, parseInt(req.query.limit) || 50),
      offset: parseInt(req.query.offset) || 0,
    });
    res.json({ messages, count: messages.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list inbound messages' });
  }
});

/* ━━━ Webhooks ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

router.get('/webhooks', async (req, res) => {
  const { tenant_id } = req.query;
  if (!tenant_id) return res.status(400).json({ error: 'tenant_id required' });

  try {
    const webhooks = await listWebhooks(tenant_id);
    res.json({ webhooks });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list webhooks' });
  }
});

router.post('/webhooks', async (req, res) => {
  const { tenant_id, event_type, url, retry_policy } = req.body || {};
  if (!tenant_id || !event_type || !url) {
    return res.status(400).json({ error: '`tenant_id`, `event_type`, and `url` required' });
  }

  try {
    const { webhook, signingSecret } = await createWebhook({
      tenantId: tenant_id,
      eventType: event_type,
      url,
      retryPolicy: retry_policy,
    });

    res.status(201).json({
      webhook,
      signing_secret: signingSecret,
      warning: 'Save the signing secret. It cannot be shown again.',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create webhook' });
  }
});

router.patch('/webhooks/:id', async (req, res) => {
  try {
    const webhook = await updateWebhook(req.params.id, req.body);
    if (!webhook) return res.status(404).json({ error: 'Webhook not found' });
    res.json({ webhook });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update webhook' });
  }
});

router.delete('/webhooks/:id', async (req, res) => {
  try {
    await deleteWebhook(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete webhook' });
  }
});

router.post('/webhooks/:id/rotate', async (req, res) => {
  try {
    const { webhook, signingSecret } = await rotateWebhookSecret(req.params.id);
    if (!webhook) return res.status(404).json({ error: 'Webhook not found' });
    res.json({
      webhook,
      signing_secret: signingSecret,
      warning: 'Update your webhook handler with the new signing secret.',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to rotate webhook secret' });
  }
});

/* ━━━ Pair Codes ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * POST /v1/admin/sms/devices/:id/pair-code — Mint a one-time pairing code
 * Body: { ttl_minutes? } (default 30 min)
 * Returns the raw code (shown once) and a pairing URL.
 */
router.post('/devices/:id/pair-code', async (req, res) => {
  const { ttl_minutes } = req.body || {};
  try {
    const device = await getDevice(req.params.id);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (!device.is_enabled) return res.status(403).json({ error: 'Device is disabled' });

    const ttl = Math.min(Math.max(parseInt(ttl_minutes) || 30, 5), 1440); // 5 min – 24 hr
    const actor = getAdminActor(req);
    const { pairCode, rawCode } = await createPairCode(device.id, actor, ttl);

    const pairUrl = `${req.protocol}://${req.get('host')}/pair?code=${rawCode}`;

    await auditLog({
      tenantId: device.tenant_id,
      actor,
      action: 'device.pair_code_created',
      resource: 'sms_pair_codes',
      resourceId: pairCode.id,
      details: { device_id: device.id, device_name: device.name, ttl_minutes: ttl },
      ipAddress: getIp(req),
    });

    res.json({
      pair_code: pairCode,
      code: rawCode,
      pair_url: pairUrl,
      warning: 'This code is shown only once and expires in ' + ttl + ' minutes.',
    });
  } catch (err) {
    console.error('[sms-admin] pair-code error:', err.message);
    res.status(500).json({ error: 'Failed to create pairing code' });
  }
});

/**
 * GET /v1/admin/sms/devices/:id/pair-codes — List pair codes for device
 */
router.get('/devices/:id/pair-codes', async (req, res) => {
  try {
    const codes = await listPairCodes(req.params.id);
    res.json({ codes });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list pair codes' });
  }
});

/* ━━━ Audit Logs ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

router.get('/audit', async (req, res) => {
  try {
    const { tenant_id, action, limit, offset } = req.query;
    let q = `SELECT a.*, t.name as tenant_name
             FROM sms_audit_logs a
             LEFT JOIN sms_tenants t ON t.id = a.tenant_id
             WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (tenant_id) {
      q += ` AND a.tenant_id = $${idx}`;
      params.push(tenant_id);
      idx++;
    }
    if (action) {
      q += ` AND a.action = $${idx}`;
      params.push(action);
      idx++;
    }

    q += ` ORDER BY a.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
    params.push(Math.min(100, parseInt(limit) || 50), parseInt(offset) || 0);

    const result = await smsQuery(q, params);
    res.json({ logs: result.rows, count: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get audit logs', detail: err.message });
  }
});

/* ━━━ Debug DB ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

router.get('/_debug/db', async (_req, res) => {
  try {
    const info = await getDbDebugInfo();
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
