/**
 * SMS Gateway — Database Helper
 *
 * Provides tenant-scoped query functions for the SMS gateway tables.
 * Connects to the sms.getouch.co database via SMS_DATABASE_URL env var,
 * falls back to the main pool if not set.
 */

const { Pool } = require('pg');
const crypto = require('crypto');

/* ── Request-ID helper ──────────────────────────────────── */
function genRequestId() {
  return 'req_' + crypto.randomBytes(8).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/* ── SMS Pool ──────────────────────────────────────────── */
const SMS_DATABASE_URL = process.env.SMS_DATABASE_URL;
let smsPool;

if (SMS_DATABASE_URL) {
  smsPool = new Pool({
    connectionString: SMS_DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  smsPool.on('error', (err) => {
    console.error('[sms-db] Unexpected pool error:', err.message);
  });
  console.log('[sms-db] SMS pool connected (dedicated database)');
} else {
  // Fallback to main pool
  const { pool } = require('./db');
  smsPool = pool;
  console.log('[sms-db] SMS pool using main database (set SMS_DATABASE_URL for dedicated)');
}

/* ── Query helpers ────────────────────────────────────── */
async function smsQuery(text, params) {
  const start = Date.now();
  const res = await smsPool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.NODE_ENV === 'development' && duration > 100) {
    console.log(`[sms-db] slow query (${duration}ms):`, text.substring(0, 80));
  }
  return res;
}

async function smsGetClient() {
  return smsPool.connect();
}

/* ── API Key helpers ──────────────────────────────────── */
function hashSmsKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function generateSmsKey() {
  const raw = crypto.randomBytes(32).toString('hex');
  return `sms_${raw}`;
}

/* ── Tenant helpers ─────────────────────────────────────── */
async function getDefaultTenant() {
  const res = await smsQuery(
    `SELECT * FROM sms_tenants WHERE slug = 'getouch' LIMIT 1`
  );
  return res.rows[0] || null;
}

async function getTenantById(id) {
  const res = await smsQuery(
    `SELECT * FROM sms_tenants WHERE id = $1`,
    [id]
  );
  return res.rows[0] || null;
}

async function listTenants() {
  const res = await smsQuery(
    `SELECT * FROM sms_tenants ORDER BY created_at DESC`
  );
  return res.rows;
}

async function createTenant({ name, slug, plan, status }) {
  const res = await smsQuery(
    `INSERT INTO sms_tenants (name, slug, plan, status)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [name, slug, plan || 'free', status || 'active']
  );
  return res.rows[0];
}

async function updateTenant(id, updates) {
  const fields = [];
  const values = [];
  let idx = 1;

  for (const [key, val] of Object.entries(updates)) {
    if (['name', 'plan', 'status', 'settings'].includes(key)) {
      fields.push(`${key} = $${idx}`);
      values.push(key === 'settings' ? JSON.stringify(val) : val);
      idx++;
    }
  }

  if (updates.status === 'suspended') {
    fields.push(`suspended_at = NOW()`);
  }

  fields.push('updated_at = NOW()');
  values.push(id);

  const res = await smsQuery(
    `UPDATE sms_tenants SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0];
}

/* ── API Key CRUD ───────────────────────────────────────── */
async function resolveApiKey(rawKey) {
  const keyHash = hashSmsKey(rawKey);
  const res = await smsQuery(
    `SELECT k.*, t.status as tenant_status, t.slug as tenant_slug, t.name as tenant_name
     FROM sms_api_keys k
     JOIN sms_tenants t ON t.id = k.tenant_id
     WHERE k.key_hash = $1 AND k.is_active = true`,
    [keyHash]
  );
  if (res.rows.length === 0) return null;

  const key = res.rows[0];

  // Check expiration
  if (key.expires_at && new Date(key.expires_at) < new Date()) return null;

  // Check tenant status
  if (key.tenant_status !== 'active') return null;

  // Update last_used (fire-and-forget)
  smsQuery(
    `UPDATE sms_api_keys SET last_used_at = NOW() WHERE id = $1`,
    [key.id]
  ).catch(() => {});

  return key;
}

async function createApiKey({ tenantId, name, scopes, rateLimitRpm, expiresAt }) {
  const rawKey = generateSmsKey();
  const keyHash = hashSmsKey(rawKey);
  const keyLast4 = rawKey.slice(-4);

  const res = await smsQuery(
    `INSERT INTO sms_api_keys (tenant_id, name, key_hash, key_last4, scopes, rate_limit_rpm, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      tenantId,
      name,
      keyHash,
      keyLast4,
      scopes || ['sms:send', 'sms:read'],
      rateLimitRpm || 60,
      expiresAt || null,
    ]
  );

  return { key: res.rows[0], rawKey };
}

async function listApiKeys(tenantId) {
  const res = await smsQuery(
    `SELECT id, tenant_id, name, key_last4, scopes, rate_limit_rpm, is_active,
            last_used_at, last_used_ip, expires_at, created_at, revoked_at
     FROM sms_api_keys
     WHERE tenant_id = $1
     ORDER BY created_at DESC`,
    [tenantId]
  );
  return res.rows;
}

async function revokeApiKey(id) {
  const res = await smsQuery(
    `UPDATE sms_api_keys SET is_active = false, revoked_at = NOW()
     WHERE id = $1 AND is_active = true RETURNING *`,
    [id]
  );
  return res.rows[0];
}

async function rotateApiKey(id) {
  const oldKey = await smsQuery(`SELECT * FROM sms_api_keys WHERE id = $1`, [id]);
  if (oldKey.rows.length === 0) return null;

  const old = oldKey.rows[0];

  // Revoke old
  await smsQuery(
    `UPDATE sms_api_keys SET is_active = false, revoked_at = NOW() WHERE id = $1`,
    [id]
  );

  // Create new with same settings
  return createApiKey({
    tenantId: old.tenant_id,
    name: old.name + ' (rotated)',
    scopes: old.scopes,
    rateLimitRpm: old.rate_limit_rpm,
    expiresAt: old.expires_at,
  });
}

/* ── Device CRUD ───────────────────────────────────────── */
async function listDevices(tenantId, requestId) {
  const rid = requestId || genRequestId();
  let q = `SELECT * FROM sms_devices`;
  const params = [];
  if (tenantId) {
    q += ` WHERE tenant_id = $1 OR is_shared_pool = true`;
    params.push(tenantId);
  }
  q += ` ORDER BY created_at DESC`;
  try {
    const res = await smsQuery(q, params);
    console.log(`[sms-db] listDevices rid=${rid} tenant_id=${tenantId || 'ALL'} returned=${res.rows.length}`);
    return res.rows;
  } catch (err) {
    console.error(`[sms-db] listDevices FAILED rid=${rid} tenant_id=${tenantId || 'ALL'} err=${err.message}`);
    throw err;
  }
}

async function getDevice(id) {
  const res = await smsQuery(`SELECT * FROM sms_devices WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function createDevice({ tenantId, name, phoneNumber, isSharedPool, requestId }) {
  const rid = requestId || genRequestId();
  const deviceToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(deviceToken);
  const tokenLast4 = deviceToken.slice(-4);

  // Validate shared-pool ↔ tenant mutual exclusivity
  const safeTenantId = isSharedPool ? null : (tenantId || null);
  const safeShared = safeTenantId ? false : (isSharedPool || false);

  console.log(`[sms-db] createDevice rid=${rid} name=${name} tenant_id=${safeTenantId} shared=${safeShared}`);

  const res = await smsQuery(
    `INSERT INTO sms_devices (tenant_id, name, phone_number, device_token, is_shared_pool, pairing_token_hash, pairing_token_last4)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [safeTenantId, name, phoneNumber || null, deviceToken, safeShared, tokenHash, tokenLast4]
  );

  const device = res.rows[0];
  if (!device) {
    console.error(`[sms-db] createDevice FAILED rid=${rid} INSERT returned no rows`);
    throw new Error('INSERT returned no rows — device not persisted');
  }

  // Post-insert verification: confirm the row is readable
  const verify = await smsQuery(`SELECT id FROM sms_devices WHERE id = $1`, [device.id]);
  if (!verify.rows.length) {
    console.error(`[sms-db] createDevice VERIFY FAILED rid=${rid} id=${device.id} — row not found after insert`);
    throw new Error('Device created but not readable — possible DB mismatch');
  }

  console.log(`[sms-db] createDevice OK rid=${rid} id=${device.id}`);
  return { device, deviceToken };
}

async function updateDevice(id, updates) {
  const fields = [];
  const values = [];
  let idx = 1;

  for (const [key, val] of Object.entries(updates)) {
    if (['name', 'phone_number', 'status', 'is_shared_pool', 'is_enabled', 'tenant_id', 'metadata'].includes(key)) {
      fields.push(`${key} = $${idx}`);
      values.push(key === 'metadata' ? JSON.stringify(val) : val);
      idx++;
    }
  }

  fields.push('updated_at = NOW()');
  values.push(id);

  const res = await smsQuery(
    `UPDATE sms_devices SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0];
}

async function rotateDeviceToken(id) {
  const newToken = crypto.randomBytes(32).toString('hex');
  const res = await smsQuery(
    `UPDATE sms_devices SET device_token = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [newToken, id]
  );
  return { device: res.rows[0], deviceToken: newToken };
}

async function recordDeviceHeartbeat(deviceToken) {
  const res = await smsQuery(
    `UPDATE sms_devices SET status = 'online', last_seen_at = NOW(), updated_at = NOW()
     WHERE device_token = $1 AND is_enabled = true
     RETURNING *`,
    [deviceToken]
  );
  if (res.rows[0]) {
    // Log event (fire-and-forget)
    smsQuery(
      `INSERT INTO sms_device_events (device_id, event_type, details)
       VALUES ($1, 'heartbeat', $2)`,
      [res.rows[0].id, JSON.stringify({ timestamp: new Date().toISOString() })]
    ).catch(() => {});
  }
  return res.rows[0] || null;
}

async function getDeviceEvents(deviceId, limit = 50) {
  const res = await smsQuery(
    `SELECT * FROM sms_device_events WHERE device_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [deviceId, limit]
  );
  return res.rows;
}

/* ── Outbound Messages ─────────────────────────────────── */
async function createOutboundMessage({ tenantId, toNumber, messageBody, senderDeviceId, idempotencyKey, metadata }) {
  const res = await smsQuery(
    `INSERT INTO sms_outbound_messages (tenant_id, to_number, message_body, sender_device_id, idempotency_key, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [tenantId, toNumber, messageBody, senderDeviceId || null, idempotencyKey || null, metadata ? JSON.stringify(metadata) : '{}']
  );

  // Add timeline event
  await addStatusEvent(res.rows[0].id, 'outbound', 'queued', { source: 'api' });

  return res.rows[0];
}

async function getOutboundMessage(id, tenantId) {
  const res = await smsQuery(
    `SELECT m.*, d.name as device_name, d.phone_number as device_phone
     FROM sms_outbound_messages m
     LEFT JOIN sms_devices d ON d.id = m.from_device_id
     WHERE m.id = $1 AND m.tenant_id = $2`,
    [id, tenantId]
  );
  return res.rows[0] || null;
}

async function listOutboundMessages(tenantId, { status, limit, offset, from, to } = {}) {
  let q = `SELECT m.*, d.name as device_name
           FROM sms_outbound_messages m
           LEFT JOIN sms_devices d ON d.id = m.from_device_id
           WHERE m.tenant_id = $1`;
  const params = [tenantId];
  let idx = 2;

  if (status) {
    q += ` AND m.status = $${idx}`;
    params.push(status);
    idx++;
  }
  if (from) {
    q += ` AND m.created_at >= $${idx}`;
    params.push(from);
    idx++;
  }
  if (to) {
    q += ` AND m.created_at <= $${idx}`;
    params.push(to);
    idx++;
  }

  q += ` ORDER BY m.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
  params.push(limit || 50, offset || 0);

  const res = await smsQuery(q, params);
  return res.rows;
}

async function getQueuedMessages(limit = 10) {
  const client = await smsGetClient();
  try {
    await client.query('BEGIN');

    // Lock rows for processing (skip locked for parallel workers)
    const res = await client.query(
      `UPDATE sms_outbound_messages
       SET status = 'processing', updated_at = NOW()
       WHERE id IN (
         SELECT id FROM sms_outbound_messages
         WHERE status = 'queued'
           AND next_retry_at <= NOW()
           AND attempts < max_attempts
         ORDER BY next_retry_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [limit]
    );

    await client.query('COMMIT');
    return res.rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function markMessageSent(id, externalId, deviceId) {
  await smsQuery(
    `UPDATE sms_outbound_messages
     SET status = 'sent', external_id = $2, from_device_id = $3,
         attempts = attempts + 1, updated_at = NOW()
     WHERE id = $1`,
    [id, externalId, deviceId]
  );
  await addStatusEvent(id, 'outbound', 'sent', { external_id: externalId, device_id: deviceId });
}

async function markMessageDelivered(id) {
  await smsQuery(
    `UPDATE sms_outbound_messages
     SET status = 'delivered', delivered_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [id]
  );
  await addStatusEvent(id, 'outbound', 'delivered', {});
}

async function markMessageFailed(id, error, errorCode, permanent = false) {
  if (permanent) {
    await smsQuery(
      `UPDATE sms_outbound_messages
       SET status = 'failed', last_error = $2, error_code = $3, failed_at = NOW(),
           attempts = attempts + 1, updated_at = NOW()
       WHERE id = $1`,
      [id, error, errorCode]
    );
  } else {
    // Exponential backoff: 30s, 2m, 10m
    await smsQuery(
      `UPDATE sms_outbound_messages
       SET status = 'queued', last_error = $2, error_code = $3,
           attempts = attempts + 1,
           next_retry_at = NOW() + (POWER(2, LEAST(attempts, 5)) * INTERVAL '30 seconds'),
           updated_at = NOW()
       WHERE id = $1`,
      [id, error, errorCode]
    );
  }
  await addStatusEvent(id, 'outbound', permanent ? 'failed' : 'retry_scheduled', { error, error_code: errorCode });
}

/* ── Inbound Messages ──────────────────────────────────── */
async function createInboundMessage({ tenantId, deviceId, fromNumber, toNumber, messageBody, externalId, metadata }) {
  // Idempotent: skip if external_id already exists
  if (externalId) {
    const existing = await smsQuery(
      `SELECT id FROM sms_inbound_messages WHERE external_id = $1 AND tenant_id = $2`,
      [externalId, tenantId]
    );
    if (existing.rows.length > 0) return existing.rows[0];
  }

  const res = await smsQuery(
    `INSERT INTO sms_inbound_messages (tenant_id, device_id, from_number, to_number, message_body, external_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [tenantId, deviceId || null, fromNumber, toNumber || null, messageBody, externalId || null, metadata ? JSON.stringify(metadata) : '{}']
  );

  await addStatusEvent(res.rows[0].id, 'inbound', 'received', { from: fromNumber });
  return res.rows[0];
}

async function listInboundMessages(tenantId, { limit, offset, from, to } = {}) {
  let q = `SELECT m.*, d.name as device_name
           FROM sms_inbound_messages m
           LEFT JOIN sms_devices d ON d.id = m.device_id
           WHERE m.tenant_id = $1`;
  const params = [tenantId];
  let idx = 2;

  if (from) {
    q += ` AND m.created_at >= $${idx}`;
    params.push(from);
    idx++;
  }
  if (to) {
    q += ` AND m.created_at <= $${idx}`;
    params.push(to);
    idx++;
  }

  q += ` ORDER BY m.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
  params.push(limit || 50, offset || 0);

  const res = await smsQuery(q, params);
  return res.rows;
}

/* ── Status Events Timeline ────────────────────────────── */
async function addStatusEvent(messageId, direction, status, details) {
  await smsQuery(
    `INSERT INTO sms_message_status_events (message_id, direction, status, details)
     VALUES ($1, $2, $3, $4)`,
    [messageId, direction, status, JSON.stringify(details)]
  ).catch(() => {});
}

async function getMessageTimeline(messageId) {
  const res = await smsQuery(
    `SELECT * FROM sms_message_status_events WHERE message_id = $1 ORDER BY created_at ASC`,
    [messageId]
  );
  return res.rows;
}

/* ── Webhooks ──────────────────────────────────────────── */
async function listWebhooks(tenantId) {
  const res = await smsQuery(
    `SELECT id, tenant_id, event_type, url, is_active, retry_policy,
            last_triggered, last_status, created_at, updated_at
     FROM sms_webhooks WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId]
  );
  return res.rows;
}

async function createWebhook({ tenantId, eventType, url, retryPolicy }) {
  const signingSecret = crypto.randomBytes(32).toString('hex');
  const res = await smsQuery(
    `INSERT INTO sms_webhooks (tenant_id, event_type, url, signing_secret, retry_policy)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [tenantId, eventType, url, signingSecret, JSON.stringify(retryPolicy || { max_retries: 3, backoff_ms: 1000 })]
  );
  return { webhook: res.rows[0], signingSecret };
}

async function updateWebhook(id, updates) {
  const fields = [];
  const values = [];
  let idx = 1;
  for (const [key, val] of Object.entries(updates)) {
    if (['url', 'event_type', 'is_active', 'retry_policy'].includes(key)) {
      fields.push(`${key} = $${idx}`);
      values.push(key === 'retry_policy' ? JSON.stringify(val) : val);
      idx++;
    }
  }
  fields.push('updated_at = NOW()');
  values.push(id);
  const res = await smsQuery(
    `UPDATE sms_webhooks SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0];
}

async function rotateWebhookSecret(id) {
  const newSecret = crypto.randomBytes(32).toString('hex');
  const res = await smsQuery(
    `UPDATE sms_webhooks SET signing_secret = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [newSecret, id]
  );
  return { webhook: res.rows[0], signingSecret: newSecret };
}

async function deleteWebhook(id) {
  await smsQuery(`DELETE FROM sms_webhooks WHERE id = $1`, [id]);
}

async function getActiveWebhooks(tenantId, eventType) {
  const res = await smsQuery(
    `SELECT * FROM sms_webhooks WHERE tenant_id = $1 AND event_type = $2 AND is_active = true`,
    [tenantId, eventType]
  );
  return res.rows;
}

/* ── Audit Log ────────────────────────────────────────── */
async function auditLog({ tenantId, actor, action, resource, resourceId, details, ipAddress }) {
  await smsQuery(
    `INSERT INTO sms_audit_logs (tenant_id, actor, action, resource, resource_id, details, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, actor, action, resource || null, resourceId || null, JSON.stringify(details || {}), ipAddress || null]
  ).catch((err) => console.error('[sms-audit] Log error:', err.message));
}

/* ── Health / Metrics ─────────────────────────────────── */
async function getHealthMetrics() {
  try {
    const [devices, queue, sent24h, failed24h, inbound24h, worker] = await Promise.all([
      smsQuery(`SELECT status, COUNT(*) as count FROM sms_devices WHERE is_enabled = true GROUP BY status`),
      smsQuery(`SELECT COUNT(*) as depth, MIN(created_at) as oldest FROM sms_outbound_messages WHERE status IN ('queued', 'processing')`),
      smsQuery(`SELECT COUNT(*) as count FROM sms_outbound_messages WHERE status IN ('sent', 'delivered') AND created_at > NOW() - INTERVAL '24 hours'`),
      smsQuery(`SELECT COUNT(*) as count FROM sms_outbound_messages WHERE status = 'failed' AND created_at > NOW() - INTERVAL '24 hours'`),
      smsQuery(`SELECT COUNT(*) as count FROM sms_inbound_messages WHERE created_at > NOW() - INTERVAL '24 hours'`),
      smsQuery(`SELECT * FROM sms_worker_health WHERE id = 'main'`),
    ]);

    const devicesByStatus = {};
    devices.rows.forEach(r => { devicesByStatus[r.status] = parseInt(r.count); });

    const onlineDevices = devicesByStatus.online || 0;
    const workerRow = worker.rows[0];
    const workerHealthy = workerRow && workerRow.status === 'running' &&
      (new Date() - new Date(workerRow.last_heartbeat)) < 120000; // 2min threshold

    const queueDepth = parseInt(queue.rows[0]?.depth || 0);
    const failures24h = parseInt(failed24h.rows[0]?.count || 0);

    let overallStatus = 'offline';
    if (onlineDevices > 0 && workerHealthy) {
      overallStatus = 'online';
      if (queueDepth > 100 || failures24h > 50) {
        overallStatus = 'degraded';
      }
    } else if (workerHealthy || onlineDevices > 0) {
      overallStatus = 'degraded';
    }

    return {
      status: overallStatus,
      devices: {
        total: Object.values(devicesByStatus).reduce((a, b) => a + b, 0),
        online: onlineDevices,
        offline: devicesByStatus.offline || 0,
        degraded: devicesByStatus.degraded || 0,
        byStatus: devicesByStatus,
      },
      queue: {
        depth: queueDepth,
        oldest: queue.rows[0]?.oldest || null,
      },
      metrics_24h: {
        sent: parseInt(sent24h.rows[0]?.count || 0),
        failed: failures24h,
        inbound: parseInt(inbound24h.rows[0]?.count || 0),
      },
      worker: {
        healthy: workerHealthy,
        last_heartbeat: workerRow?.last_heartbeat || null,
        messages_processed: workerRow?.messages_processed || 0,
        status: workerRow?.status || 'unknown',
      },
    };
  } catch (err) {
    console.error('[sms-db] Health metrics error:', err.message);
    return {
      status: 'offline',
      error: err.message,
      devices: { total: 0, online: 0 },
      queue: { depth: 0 },
      metrics_24h: { sent: 0, failed: 0, inbound: 0 },
      worker: { healthy: false },
    };
  }
}

async function updateWorkerHealth(processed = 0) {
  await smsQuery(
    `UPDATE sms_worker_health
     SET last_heartbeat = NOW(), messages_processed = messages_processed + $1, status = 'running'
     WHERE id = 'main'`,
    [processed]
  );
}

async function markWorkerStopped() {
  await smsQuery(
    `UPDATE sms_worker_health SET status = 'stopped' WHERE id = 'main'`
  );
}

/* ── Device routing ─────────────────────────────────────── */
async function pickDevice(tenantId, preferredDeviceId) {
  // 1. If preferred device specified and online, use it
  if (preferredDeviceId) {
    const res = await smsQuery(
      `SELECT * FROM sms_devices WHERE id = $1 AND status = 'online' AND is_enabled = true`,
      [preferredDeviceId]
    );
    if (res.rows[0]) return res.rows[0];
  }

  // 2. Tenant-assigned online device
  if (tenantId) {
    const res = await smsQuery(
      `SELECT * FROM sms_devices
       WHERE tenant_id = $1 AND status = 'online' AND is_enabled = true
       ORDER BY last_seen_at DESC LIMIT 1`,
      [tenantId]
    );
    if (res.rows[0]) return res.rows[0];
  }

  // 3. Shared pool fallback
  const res = await smsQuery(
    `SELECT * FROM sms_devices
     WHERE is_shared_pool = true AND status = 'online' AND is_enabled = true
     ORDER BY last_seen_at DESC LIMIT 1`
  );
  return res.rows[0] || null;
}

/* ── Stale device cleanup ───────────────────────────────── */
async function markStaleDevicesOffline(thresholdMs = 120000) {
  const res = await smsQuery(
    `UPDATE sms_devices
     SET status = 'offline', updated_at = NOW()
     WHERE status = 'online'
       AND last_seen_at < NOW() - ($1 || ' milliseconds')::INTERVAL
     RETURNING id, name`,
    [String(thresholdMs)]
  );
  return res.rows;
}

/* ── Init SMS schema ────────────────────────────────────── */
async function initSmsSchema() {
  try {
    const fs = require('fs');
    const path = require('path');
    const migrationSQL = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', '003_sms_gateway.sql'), 'utf8'
    );
    await smsPool.query(migrationSQL);
    console.log('[sms-db] Migration 003 (SMS gateway) applied');
  } catch (err) {
    console.error('[sms-db] Migration 003 error (may already exist):', err.message);
  }

  // Migration 005 — SMS devices fix
  try {
    const fs = require('fs');
    const path = require('path');
    const sql005 = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', '005_sms_devices_fix.sql'), 'utf8'
    );
    await smsPool.query(sql005);
    console.log('[sms-db] Migration 005 (devices fix) applied');
  } catch (err) {
    console.error('[sms-db] Migration 005 error (may already exist):', err.message);
  }

  // Migration 006 — Android device enhancements
  try {
    const fs = require('fs');
    const path = require('path');
    const sql006 = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', '006_android_device_enhancements.sql'), 'utf8'
    );
    await smsPool.query(sql006);
    console.log('[sms-db] Migration 006 (android enhancements) applied');
  } catch (err) {
    console.error('[sms-db] Migration 006 error (may already exist):', err.message);
  }

  // Migration 007 — One-time pairing codes
  try {
    const fs = require('fs');
    const path = require('path');
    const sql007 = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', '007_pair_codes.sql'), 'utf8'
    );
    await smsPool.query(sql007);
    console.log('[sms-db] Migration 007 (pair codes) applied');
  } catch (err) {
    console.error('[sms-db] Migration 007 error (may already exist):', err.message);
  }
}

/* ── DB Debug Info (admin only) ────────────────────────── */

/* ── Pair Codes ─────────────────────────────────────────── */

/**
 * Create a one-time pairing code for a device.
 * Returns the raw code (shown once) and the persisted record.
 * Code is 24-char URL-safe random string. Only SHA-256 hash is stored.
 */
async function createPairCode(deviceId, createdBy, ttlMinutes = 30) {
  const rawCode = crypto.randomBytes(18).toString('base64url'); // 24 chars
  const codeHash = hashToken(rawCode);
  const codePrefix = rawCode.substring(0, 6);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

  const res = await smsQuery(
    `INSERT INTO sms_pair_codes (code_hash, code_prefix, device_id, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, code_prefix, device_id, created_by, expires_at, created_at`,
    [codeHash, codePrefix, deviceId, createdBy, expiresAt]
  );
  return { pairCode: res.rows[0], rawCode };
}

/**
 * Redeem a pairing code. Returns the device_token if valid,
 * marks code as used, and prevents re-use.
 */
async function redeemPairCode(rawCode, ip) {
  const codeHash = hashToken(rawCode);

  // Atomic: find valid code + mark used in one statement
  const codeRes = await smsQuery(
    `UPDATE sms_pair_codes
     SET used_at = NOW(), used_by_ip = $2
     WHERE code_hash = $1 AND used_at IS NULL AND expires_at > NOW()
     RETURNING id, device_id`,
    [codeHash, ip || null]
  );

  if (!codeRes.rows[0]) return null; // expired, already used, or not found

  const { device_id } = codeRes.rows[0];

  // Fetch device with tenant info
  const devRes = await smsQuery(
    `SELECT d.id, d.name, d.device_token, d.phone_number, d.status, d.is_enabled,
            t.id as tenant_id, t.name as tenant_name
     FROM sms_devices d
     LEFT JOIN sms_tenants t ON t.id = d.tenant_id
     WHERE d.id = $1`,
    [device_id]
  );

  return devRes.rows[0] || null;
}

/**
 * List active (unused, non-expired) pair codes for a device.
 */
async function listPairCodes(deviceId) {
  const res = await smsQuery(
    `SELECT id, code_prefix, device_id, created_by, expires_at, used_at, created_at
     FROM sms_pair_codes
     WHERE device_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [deviceId]
  );
  return res.rows;
}

/* ── DB Debug Info (admin only) ────────────────────────── */
async function getDbDebugInfo() {
  try {
    const [dbInfo, schemaInfo, migrationCheck] = await Promise.all([
      smsQuery(`SELECT current_database() AS db_name, inet_server_addr() AS host, inet_server_port() AS port, current_schema() AS schema_name, version() AS pg_version`),
      smsQuery(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'sms_%' ORDER BY table_name`),
      smsQuery(`SELECT COUNT(*) as device_count FROM sms_devices`),
    ]);
    return {
      database: dbInfo.rows[0]?.db_name,
      host: dbInfo.rows[0]?.host,
      port: dbInfo.rows[0]?.port,
      schema: dbInfo.rows[0]?.schema_name,
      pg_version: dbInfo.rows[0]?.pg_version,
      sms_tables: schemaInfo.rows.map(r => r.table_name),
      device_count: parseInt(migrationCheck.rows[0]?.device_count || 0),
      pool_type: SMS_DATABASE_URL ? 'dedicated' : 'shared',
    };
  } catch (err) {
    return { error: err.message, pool_type: SMS_DATABASE_URL ? 'dedicated' : 'shared' };
  }
}

module.exports = {
  smsPool,
  smsQuery,
  smsGetClient,
  hashSmsKey,
  generateSmsKey,
  genRequestId,
  hashToken,
  initSmsSchema,
  getDbDebugInfo,
  // Tenants
  getDefaultTenant,
  getTenantById,
  listTenants,
  createTenant,
  updateTenant,
  // API Keys
  resolveApiKey,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  // Devices
  listDevices,
  getDevice,
  createDevice,
  updateDevice,
  rotateDeviceToken,
  recordDeviceHeartbeat,
  getDeviceEvents,
  pickDevice,
  markStaleDevicesOffline,
  // Messages
  createOutboundMessage,
  getOutboundMessage,
  listOutboundMessages,
  getQueuedMessages,
  markMessageSent,
  markMessageDelivered,
  markMessageFailed,
  createInboundMessage,
  listInboundMessages,
  // Timeline
  addStatusEvent,
  getMessageTimeline,
  // Webhooks
  listWebhooks,
  createWebhook,
  updateWebhook,
  rotateWebhookSecret,
  deleteWebhook,
  getActiveWebhooks,
  // Audit
  auditLog,
  // Health
  getHealthMetrics,
  updateWorkerHealth,
  markWorkerStopped,
  // Pair Codes
  createPairCode,
  redeemPairCode,
  listPairCodes,
};
