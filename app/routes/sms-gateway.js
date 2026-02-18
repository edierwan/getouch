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

/* ━━━ Android Device Endpoints ━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * Verify HMAC signature from Android devices
 * Signature = HMAC-SHA256(device_token, device_id + timestamp + nonce + body)
 */
function verifyDeviceSignature(req, res, next) {
  const sig       = req.headers['x-device-signature'];
  const deviceId  = req.headers['x-device-id'];
  const ts        = req.headers['x-timestamp'];
  const nonce     = req.headers['x-nonce'];
  const token     = req.headers['x-device-token'];

  if (!sig || !deviceId || !ts || !nonce || !token) {
    return res.status(401).json({ error: 'Missing device auth headers' });
  }

  // Reject if timestamp > 5 min old
  const age = Math.abs(Date.now() - parseInt(ts, 10));
  if (isNaN(age) || age > 5 * 60 * 1000) {
    return res.status(401).json({ error: 'Request expired (clock skew > 5 min)' });
  }

  const body = JSON.stringify(req.body || {});
  const payload = `${deviceId}:${ts}:${nonce}:${body}`;
  const expected = crypto.createHmac('sha256', token).update(payload).digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  req.deviceToken = token;
  req.deviceIdHeader = deviceId;
  next();
}

/**
 * POST /v1/sms/internal/android/pair — Validate pairing token
 * Android app calls this after scanning QR / entering token manually
 */
router.post('/internal/android/pair', async (req, res) => {
  const { device_token, device_info } = req.body || {};
  if (!device_token) {
    return res.status(400).json({ error: '`device_token` required' });
  }

  try {
    const { smsQuery } = require('../lib/sms-db');
    const dev = await smsQuery(
      `SELECT d.id, d.name, d.phone_number, d.status, d.is_enabled,
              t.id as tenant_id, t.name as tenant_name, t.slug as tenant_slug
       FROM sms_devices d
       LEFT JOIN sms_tenants t ON t.id = d.tenant_id
       WHERE d.device_token = $1`,
      [device_token]
    );

    if (!dev.rows[0]) {
      return res.status(404).json({ error: 'Invalid pairing token' });
    }

    const device = dev.rows[0];
    if (!device.is_enabled) {
      return res.status(403).json({ error: 'Device is disabled' });
    }

    // Update device status + store device_info metadata
    const metaUpdate = device_info ? { device_info, paired_at: new Date().toISOString() } : { paired_at: new Date().toISOString() };
    await smsQuery(
      `UPDATE sms_devices SET status = 'online', last_seen_at = NOW(), updated_at = NOW(),
       metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [device.id, JSON.stringify(metaUpdate)]
    );

    await auditLog({
      tenantId: device.tenant_id,
      action: 'device.paired',
      actor: 'android-app',
      resourceType: 'device',
      resourceId: device.id,
      details: { name: device.name, device_info },
    });

    res.json({
      ok: true,
      device_id: device.id,
      device_name: device.name,
      tenant_name: device.tenant_name || 'Default',
      server_time: Date.now(),
      poll_interval_seconds: 10,
    });
  } catch (err) {
    console.error('[sms-android] Pair error:', err.message);
    res.status(500).json({ error: 'Pairing failed' });
  }
});

/**
 * POST /v1/sms/internal/android/redeem-code — Redeem a one-time pairing code
 * Android app calls this with the code from the deep link / QR.
 * Returns device_token (never exposed in URL) + device info so the app
 * can then call /pair to complete pairing.
 */
router.post('/internal/android/redeem-code', async (req, res) => {
  const { code, device_info } = req.body || {};
  if (!code) {
    return res.status(400).json({ error: '`code` required' });
  }

  try {
    const { redeemPairCode, auditLog: smsAuditLog, smsQuery: sq } = require('../lib/sms-db');
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;

    const device = await redeemPairCode(code, ip);
    if (!device) {
      return res.status(404).json({ error: 'Invalid, expired, or already-used pairing code' });
    }
    if (!device.is_enabled) {
      return res.status(403).json({ error: 'Device is disabled' });
    }

    // Update device status + store device_info metadata
    const metaUpdate = { paired_at: new Date().toISOString(), paired_via: 'pair_code' };
    if (device_info) metaUpdate.device_info = device_info;
    await sq(
      `UPDATE sms_devices SET status = 'online', last_seen_at = NOW(), updated_at = NOW(),
       metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [device.id, JSON.stringify(metaUpdate)]
    );

    await smsAuditLog({
      tenantId: device.tenant_id,
      action: 'device.paired_via_code',
      actor: 'android-app',
      resourceType: 'device',
      resourceId: device.id,
      details: { name: device.name, paired_via: 'pair_code', device_info },
    });

    res.json({
      ok: true,
      device_token: device.device_token,
      device_id: device.id,
      device_name: device.name,
      tenant_name: device.tenant_name || 'Default',
      server_time: Date.now(),
      poll_interval_seconds: 10,
    });
  } catch (err) {
    console.error('[sms-android] Redeem code error:', err.message);
    res.status(500).json({ error: 'Code redemption failed' });
  }
});

/**
 * POST /v1/sms/internal/android/heartbeat — Device heartbeat with HMAC
 */
router.post('/internal/android/heartbeat', verifyDeviceSignature, async (req, res) => {
  const { battery_pct, is_charging, network_type, app_version } = req.body || {};

  try {
    const device = await recordDeviceHeartbeat(req.deviceToken);
    if (!device) {
      return res.status(404).json({ error: 'Device not found or disabled' });
    }

    // Store extended metadata
    const meta = { last_heartbeat_detail: Date.now() };
    if (battery_pct !== undefined) meta.battery_pct = battery_pct;
    if (is_charging !== undefined) meta.is_charging = is_charging;
    if (network_type) meta.network_type = network_type;
    if (app_version) meta.app_version = app_version;

    const { smsQuery } = require('../lib/sms-db');
    await smsQuery(
      `UPDATE sms_devices SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [device.id, JSON.stringify(meta)]
    );

    res.json({
      ok: true,
      device_id: device.id,
      server_time: Date.now(),
      poll_interval_seconds: 10,
    });
  } catch (err) {
    console.error('[sms-android] Heartbeat error:', err.message);
    res.status(500).json({ error: 'Heartbeat failed' });
  }
});

/**
 * POST /v1/sms/internal/android/pull-outbound — Pull pending messages for device
 * Android app polls this to get messages assigned to it for sending
 */
router.post('/internal/android/pull-outbound', verifyDeviceSignature, async (req, res) => {
  try {
    const { smsQuery, getQueuedMessages, pickDevice } = require('../lib/sms-db');

    // Resolve device
    const dev = await smsQuery(
      `SELECT id, tenant_id, is_shared_pool FROM sms_devices WHERE device_token = $1 AND is_enabled = true`,
      [req.deviceToken]
    );
    if (!dev.rows[0]) {
      return res.status(404).json({ error: 'Device not found' });
    }
    const device = dev.rows[0];

    // Get queued messages assigned to this device or tenant
    const msgs = await smsQuery(
      `SELECT id, to_number, message_body, tenant_id, preferred_device_id, idempotency_key
       FROM sms_outbound_messages
       WHERE status = 'queued'
         AND next_retry_at <= NOW()
         AND attempts < max_attempts
         AND (
           preferred_device_id = $1
           OR (preferred_device_id IS NULL AND tenant_id = $2)
           OR (preferred_device_id IS NULL AND $3 = true)
         )
       ORDER BY next_retry_at ASC
       LIMIT 5
       FOR UPDATE SKIP LOCKED`,
      [device.id, device.tenant_id, device.is_shared_pool]
    );

    if (msgs.rows.length === 0) {
      return res.json({ messages: [] });
    }

    // Mark as processing and assign to this device
    const messageIds = msgs.rows.map(m => m.id);
    await smsQuery(
      `UPDATE sms_outbound_messages
       SET status = 'processing', from_device_id = $2, updated_at = NOW()
       WHERE id = ANY($1::uuid[])`,
      [messageIds, device.id]
    );

    const messages = msgs.rows.map(m => ({
      message_id: m.id,
      to_number: m.to_number,
      body: m.message_body,
      send_ref: m.idempotency_key || m.id,
    }));

    res.json({ messages });
  } catch (err) {
    console.error('[sms-android] Pull outbound error:', err.message);
    res.status(500).json({ error: 'Failed to pull messages' });
  }
});

/**
 * POST /v1/sms/internal/android/outbound-ack — Acknowledge outbound send result
 * Android app calls this after attempting to send SMS
 */
router.post('/internal/android/outbound-ack', verifyDeviceSignature, async (req, res) => {
  const { message_id, status, error_code, error_message, external_ref } = req.body || {};

  if (!message_id || !status) {
    return res.status(400).json({ error: '`message_id` and `status` required' });
  }

  try {
    const { markMessageSent, markMessageFailed } = require('../lib/sms-db');

    if (status === 'sent') {
      await markMessageSent(message_id, external_ref || null, null);

      // Fire webhooks
      const { smsQuery } = require('../lib/sms-db');
      const m = await smsQuery('SELECT tenant_id FROM sms_outbound_messages WHERE id = $1', [message_id]);
      if (m.rows[0]) {
        fireWebhooksForEvent(m.rows[0].tenant_id, 'sms.sent', { message_id }).catch(() => {});
      }
    } else if (status === 'failed') {
      const permanent = ['INVALID_NUMBER', 'BLOCKED', 'SIM_ERROR'].includes(error_code);
      await markMessageFailed(message_id, error_message || 'Send failed', error_code || 'UNKNOWN', permanent);

      const { smsQuery } = require('../lib/sms-db');
      const m = await smsQuery('SELECT tenant_id FROM sms_outbound_messages WHERE id = $1', [message_id]);
      if (m.rows[0]) {
        fireWebhooksForEvent(m.rows[0].tenant_id, 'sms.failed', { message_id, error_code, error_message }).catch(() => {});
      }
    }

    res.json({ ok: true, message_id });
  } catch (err) {
    console.error('[sms-android] Outbound ACK error:', err.message);
    res.status(500).json({ error: 'Failed to process ACK' });
  }
});

/**
 * POST /v1/sms/internal/android/inbound — Inbound SMS from Android device with HMAC
 */
router.post('/internal/android/inbound', verifyDeviceSignature, async (req, res) => {
  const { from_number, to_number, body, received_at, message_ref } = req.body || {};

  if (!from_number || !body) {
    return res.status(400).json({ error: '`from_number` and `body` required' });
  }

  try {
    const { smsQuery } = require('../lib/sms-db');
    let tenantId = null;
    let deviceId = null;

    const dev = await smsQuery(
      `SELECT id, tenant_id FROM sms_devices WHERE device_token = $1`,
      [req.deviceToken]
    );
    if (dev.rows[0]) {
      deviceId = dev.rows[0].id;
      tenantId = dev.rows[0].tenant_id;
    }

    if (!tenantId) {
      const defaultTenant = await getDefaultTenant();
      tenantId = defaultTenant?.id;
    }

    if (!tenantId) {
      return res.status(400).json({ error: 'No tenant resolved' });
    }

    const msg = await createInboundMessage({
      tenantId,
      deviceId,
      fromNumber: from_number,
      toNumber: to_number,
      messageBody: body,
      externalId: message_ref,
      metadata: { received_at, source: 'android-app' },
    });

    fireWebhooksForEvent(tenantId, 'sms.inbound', {
      message_id: msg.id, from: from_number, to: to_number, message: body,
    }).catch(() => {});

    res.status(201).json({ ok: true, id: msg.id });
  } catch (err) {
    console.error('[sms-android] Inbound error:', err.message);
    res.status(500).json({ error: 'Failed to process inbound SMS' });
  }
});

/**
 * POST /v1/sms/internal/android/delivery — Delivery report from Android with HMAC
 */
router.post('/internal/android/delivery', verifyDeviceSignature, async (req, res) => {
  const { message_id, status, external_ref } = req.body || {};

  if (!message_id) {
    return res.status(400).json({ error: '`message_id` required' });
  }

  try {
    if (status === 'delivered') {
      await markMessageDelivered(message_id);
      const { smsQuery } = require('../lib/sms-db');
      const m = await smsQuery('SELECT tenant_id FROM sms_outbound_messages WHERE id = $1', [message_id]);
      if (m.rows[0]) {
        fireWebhooksForEvent(m.rows[0].tenant_id, 'sms.delivered', { message_id }).catch(() => {});
      }
    }

    res.json({ ok: true, message_id });
  } catch (err) {
    console.error('[sms-android] Delivery error:', err.message);
    res.status(500).json({ error: 'Failed to process delivery report' });
  }
});

/* ━━━ Legacy Internal Ingestion Endpoints ━━━━━━━━━━━━━━ */

/**
 * POST /v1/sms/internal/inbound — Inbound SMS ingestion (legacy, shared-secret auth)
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
