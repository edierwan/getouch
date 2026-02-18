/**
 * SMS Gateway — Public API Routes
 *
 * Tenant-aware SMS API authenticated via SMS API keys.
 * Mounted at /v1/sms in server.js.
 *
 * Public API:
 *   POST /v1/sms/send            — Send an SMS
 *   GET  /v1/sms/messages/:id    — Get message details + timeline
 *   GET  /v1/sms/outbound        — List outbound messages
 *   GET  /v1/sms/inbox           — List inbound messages
 *
 * Internal ingestion (device callbacks, protected by shared secret):
 *   POST /v1/sms/internal/inbound      — Inbound SMS ingestion
 *   POST /v1/sms/internal/delivery     — Delivery receipt ingestion
 *   POST /v1/sms/internal/heartbeat    — Device heartbeat
 *
 * Health:
 *   GET  /v1/sms/health          — SMS gateway health
 */

const express = require('express');
const crypto = require('crypto');
const {
  resolveApiKey,
  createOutboundMessage,
  getOutboundMessage,
  listOutboundMessages,
  listInboundMessages,
  getMessageTimeline,
  createInboundMessage,
  markMessageDelivered,
  recordDeviceHeartbeat,
  getDefaultTenant,
  auditLog,
  getHealthMetrics,
} = require('../lib/sms-db');
const { checkRateLimit } = require('../lib/rate-limit');
const { fireWebhooksForEvent } = require('../lib/sms-android-adapter');

const router = express.Router();

const SMS_INTERNAL_SECRET = process.env.SMS_INTERNAL_SECRET || 'sms-internal-dev-secret';

/* ── Helpers ──────────────────────────────────────────── */

/**
 * Validate E.164 phone number format
 */
function isE164(phone) {
  return /^\+[1-9]\d{1,14}$/.test(phone);
}

/**
 * SMS API Key auth middleware
 * Resolves tenant from API key, enforces scopes
 */
function requireSmsApiKey(...requiredScopes) {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Missing or invalid Authorization header',
        hint: 'Use: Authorization: Bearer <sms-api-key>',
      });
    }

    const rawKey = authHeader.replace('Bearer ', '');

    // Must be an SMS key (starts with sms_)
    if (!rawKey.startsWith('sms_')) {
      return res.status(401).json({
        error: 'Invalid SMS API key format',
        hint: 'SMS API keys start with sms_',
      });
    }

    try {
      const apiKey = await resolveApiKey(rawKey);
      if (!apiKey) {
        return res.status(401).json({ error: 'Invalid or expired SMS API key' });
      }

      // Check required scopes
      if (requiredScopes.length > 0) {
        const hasScope = requiredScopes.some(s => apiKey.scopes.includes(s));
        if (!hasScope) {
          return res.status(403).json({
            error: 'Insufficient scopes',
            required: requiredScopes,
            granted: apiKey.scopes,
          });
        }
      }

      // Rate limiting per API key
      const rateResult = checkRateLimit(
        `sms:${apiKey.id}`,
        'sms:send',
        apiKey.rate_limit_rpm || 60,
        60000
      );
      if (!rateResult.allowed) {
        return res.status(429).json({
          error: 'Rate limit exceeded',
          retry_after: rateResult.retryAfter,
        });
      }

      // Attach to request
      req.smsKey = apiKey;
      req.tenantId = apiKey.tenant_id;

      next();
    } catch (err) {
      console.error('[sms-api] Auth error:', err.message);
      return res.status(500).json({ error: 'Authentication failed' });
    }
  };
}

/**
 * Internal endpoint auth: shared secret
 */
function requireInternalAuth(req, res, next) {
  const token = req.headers['x-sms-internal-secret'] || req.headers.authorization?.replace('Bearer ', '');
  if (token !== SMS_INTERNAL_SECRET) {
    return res.status(403).json({ error: 'Internal access denied' });
  }
  next();
}

/* ━━━ Public API ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * POST /v1/sms/send — Send an SMS
 *
 * Body: { to, message, sender_device_id?, idempotency_key? }
 * Header: Idempotency-Key (optional, overrides body)
 */
router.post('/send', requireSmsApiKey('sms:send'), async (req, res) => {
  const { to, message, sender_device_id, metadata } = req.body || {};

  // Idempotency key from header or body
  const idempotencyKey = req.headers['idempotency-key'] || req.body?.idempotency_key || null;

  // Validate
  if (!to || !message) {
    return res.status(400).json({ error: '`to` and `message` are required' });
  }

  if (!isE164(to)) {
    return res.status(400).json({
      error: 'Invalid phone number format',
      hint: 'Use E.164 format: +1234567890',
    });
  }

  if (message.length > 1600) {
    return res.status(400).json({
      error: 'Message too long',
      hint: 'Maximum 1600 characters (will be split into multiple SMS segments)',
    });
  }

  try {
    const msg = await createOutboundMessage({
      tenantId: req.tenantId,
      toNumber: to,
      messageBody: message,
      senderDeviceId: sender_device_id || null,
      idempotencyKey,
      metadata,
    });

    res.status(201).json({
      message_id: msg.id,
      status: msg.status,
      to: msg.to_number,
      created_at: msg.created_at,
    });
  } catch (err) {
    // Idempotency conflict — return existing
    if (err.code === '23505' && idempotencyKey) {
      // Unique violation on idempotency_key
      const { smsQuery } = require('../lib/sms-db');
      const existing = await smsQuery(
        `SELECT id, status, to_number, created_at FROM sms_outbound_messages
         WHERE tenant_id = $1 AND idempotency_key = $2`,
        [req.tenantId, idempotencyKey]
      );
      if (existing.rows[0]) {
        return res.status(200).json({
          message_id: existing.rows[0].id,
          status: existing.rows[0].status,
          to: existing.rows[0].to_number,
          created_at: existing.rows[0].created_at,
          idempotent: true,
        });
      }
    }

    console.error('[sms-api] Send error:', err.message);
    res.status(500).json({ error: 'Failed to queue message' });
  }
});

/**
 * GET /v1/sms/messages/:id — Get message details with timeline
 */
router.get('/messages/:id', requireSmsApiKey('sms:read'), async (req, res) => {
  try {
    const msg = await getOutboundMessage(req.params.id, req.tenantId);
    if (!msg) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const timeline = await getMessageTimeline(msg.id);

    res.json({
      message: msg,
      timeline,
    });
  } catch (err) {
    console.error('[sms-api] Get message error:', err.message);
    res.status(500).json({ error: 'Failed to get message' });
  }
});

/**
 * GET /v1/sms/outbound — List outbound messages
 */
router.get('/outbound', requireSmsApiKey('sms:read'), async (req, res) => {
  try {
    const messages = await listOutboundMessages(req.tenantId, {
      status: req.query.status,
      limit: Math.min(100, parseInt(req.query.limit) || 50),
      offset: parseInt(req.query.offset) || 0,
      from: req.query.from,
      to: req.query.to,
    });

    res.json({ messages, count: messages.length });
  } catch (err) {
    console.error('[sms-api] List outbound error:', err.message);
    res.status(500).json({ error: 'Failed to list messages' });
  }
});

/**
 * GET /v1/sms/inbox — List inbound messages
 */
router.get('/inbox', requireSmsApiKey('sms:inbox'), async (req, res) => {
  try {
    const messages = await listInboundMessages(req.tenantId, {
      limit: Math.min(100, parseInt(req.query.limit) || 50),
      offset: parseInt(req.query.offset) || 0,
      from: req.query.from,
      to: req.query.to,
    });

    res.json({ messages, count: messages.length });
  } catch (err) {
    console.error('[sms-api] List inbox error:', err.message);
    res.status(500).json({ error: 'Failed to list inbox' });
  }
});

/* ━━━ Internal Ingestion Endpoints ━━━━━━━━━━━━━━━━━━━━ */

/**
 * POST /v1/sms/internal/inbound — Inbound SMS ingestion
 * Called by android-sms-gateway when device receives an SMS
 */
router.post('/internal/inbound', requireInternalAuth, async (req, res) => {
  const { from, to, message, device_token, external_id, metadata } = req.body || {};

  if (!from || !message) {
    return res.status(400).json({ error: '`from` and `message` are required' });
  }

  try {
    // Resolve device → tenant
    const { smsQuery } = require('../lib/sms-db');
    let tenantId = null;
    let deviceId = null;

    if (device_token) {
      const dev = await smsQuery(
        `SELECT id, tenant_id FROM sms_devices WHERE device_token = $1`,
        [device_token]
      );
      if (dev.rows[0]) {
        deviceId = dev.rows[0].id;
        tenantId = dev.rows[0].tenant_id;
      }
    }

    // Fallback to default tenant
    if (!tenantId) {
      const defaultTenant = await getDefaultTenant();
      tenantId = defaultTenant?.id;
    }

    if (!tenantId) {
      return res.status(400).json({ error: 'No tenant resolved for inbound message' });
    }

    const msg = await createInboundMessage({
      tenantId,
      deviceId,
      fromNumber: from,
      toNumber: to,
      messageBody: message,
      externalId: external_id,
      metadata,
    });

    // Fire inbound webhooks (fire-and-forget)
    fireWebhooksForEvent(tenantId, 'sms.inbound', {
      message_id: msg.id,
      from,
      to,
      message,
    }).catch(() => {});

    res.status(201).json({ id: msg.id, status: 'received' });
  } catch (err) {
    console.error('[sms-internal] Inbound error:', err.message);
    res.status(500).json({ error: 'Failed to process inbound SMS' });
  }
});

/**
 * POST /v1/sms/internal/delivery — Delivery receipt ingestion
 * Called when device confirms SMS delivery
 */
router.post('/internal/delivery', requireInternalAuth, async (req, res) => {
  const { message_id, external_id, status, details } = req.body || {};

  if (!message_id && !external_id) {
    return res.status(400).json({ error: '`message_id` or `external_id` required' });
  }

  try {
    const { smsQuery } = require('../lib/sms-db');

    // Find message by internal ID or external ID
    let msg;
    if (message_id) {
      const res = await smsQuery(
        `SELECT id, tenant_id FROM sms_outbound_messages WHERE id = $1`,
        [message_id]
      );
      msg = res.rows[0];
    } else {
      const res = await smsQuery(
        `SELECT id, tenant_id FROM sms_outbound_messages WHERE external_id = $1`,
        [external_id]
      );
      msg = res.rows[0];
    }

    if (!msg) {
      return res.status(404).json({ error: 'Message not found' });
    }

    if (status === 'delivered') {
      await markMessageDelivered(msg.id);
      fireWebhooksForEvent(msg.tenant_id, 'sms.delivered', {
        message_id: msg.id,
      }).catch(() => {});
    }

    res.json({ ok: true, message_id: msg.id });
  } catch (err) {
    console.error('[sms-internal] Delivery error:', err.message);
    res.status(500).json({ error: 'Failed to process delivery receipt' });
  }
});

/**
 * POST /v1/sms/internal/heartbeat — Device heartbeat
 * Called periodically by Android devices to report they're alive
 */
router.post('/internal/heartbeat', requireInternalAuth, async (req, res) => {
  const { device_token, metadata } = req.body || {};

  if (!device_token) {
    return res.status(400).json({ error: '`device_token` required' });
  }

  try {
    const device = await recordDeviceHeartbeat(device_token);
    if (!device) {
      return res.status(404).json({ error: 'Device not found or disabled' });
    }

    res.json({
      ok: true,
      device_id: device.id,
      status: device.status,
    });
  } catch (err) {
    console.error('[sms-internal] Heartbeat error:', err.message);
    res.status(500).json({ error: 'Failed to process heartbeat' });
  }
});

/* ━━━ Health ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * GET /v1/sms/health — SMS gateway health (public, no auth)
 */
router.get('/health', async (_req, res) => {
  try {
    const metrics = await getHealthMetrics();
    const statusCode = metrics.status === 'online' ? 200 : metrics.status === 'degraded' ? 200 : 503;
    res.status(statusCode).json({
      service: 'sms-gateway',
      ...metrics,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      service: 'sms-gateway',
      status: 'offline',
      error: err.message,
    });
  }
});

module.exports = router;
