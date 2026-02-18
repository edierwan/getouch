/**
 * WhatsApp Gateway — Database Helper
 *
 * Provides tenant-scoped query functions for the wa_ tables.
 * Uses the main pool (same DB as landing app).
 */

const crypto = require('crypto');

/* ── Pool (reuse main) ─────────────────────────────────── */
const { pool } = require('./db');

async function waQuery(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const dur = Date.now() - start;
  if (process.env.NODE_ENV === 'development' && dur > 100) {
    console.log(`[wa-db] slow query (${dur}ms):`, text.substring(0, 80));
  }
  return res;
}

/* ── API Key helpers ───────────────────────────────────── */
function hashWaKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function generateWaKey() {
  const raw = crypto.randomBytes(32).toString('hex');
  return `wa_${raw}`;
}

/* ── Tenants ───────────────────────────────────────────── */
async function listTenants() {
  return waQuery(`
    SELECT t.*,
      (SELECT count(*) FROM wa_api_keys k WHERE k.tenant_id = t.id AND k.is_active) AS active_keys,
      (SELECT status FROM wa_sessions s WHERE s.tenant_id = t.id) AS session_status
    FROM wa_tenants t
    ORDER BY t.created_at DESC
  `);
}

async function getTenantById(id) {
  return waQuery('SELECT * FROM wa_tenants WHERE id = $1', [id]);
}

async function getTenantBySlug(slug) {
  return waQuery('SELECT * FROM wa_tenants WHERE slug = $1', [slug]);
}

async function createTenant({ slug, name, plan, daily_limit, monthly_limit, webhook_url }) {
  return waQuery(`
    INSERT INTO wa_tenants (slug, name, plan, daily_limit, monthly_limit, webhook_url)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [slug, name, plan || 'free', daily_limit || 100, monthly_limit || 1000, webhook_url || null]);
}

async function updateTenant(id, fields) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (['name', 'plan', 'status', 'daily_limit', 'monthly_limit', 'webhook_url', 'webhook_secret', 'metadata'].includes(k)) {
      sets.push(`${k} = $${i}`);
      vals.push(k === 'metadata' ? JSON.stringify(v) : v);
      i++;
    }
  }
  if (!sets.length) return { rows: [] };
  sets.push(`updated_at = now()`);
  vals.push(id);
  return waQuery(`UPDATE wa_tenants SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
}

/* ── API Keys ──────────────────────────────────────────── */
async function listApiKeys(tenantId) {
  return waQuery(`
    SELECT id, tenant_id, key_prefix, label, scopes, rate_limit, is_active, last_used_at, expires_at, created_at
    FROM wa_api_keys WHERE tenant_id = $1
    ORDER BY created_at DESC
  `, [tenantId]);
}

async function createApiKey(tenantId, label, scopes, rateLimit) {
  const rawKey = generateWaKey();
  const prefix = rawKey.substring(0, 12);
  const hash = hashWaKey(rawKey);
  const result = await waQuery(`
    INSERT INTO wa_api_keys (tenant_id, key_prefix, key_hash, label, scopes, rate_limit)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, tenant_id, key_prefix, label, scopes, rate_limit, is_active, created_at
  `, [tenantId, prefix, hash, label || 'default', scopes || ['wa:read', 'wa:write'], rateLimit || 60]);
  return { ...result.rows[0], raw_key: rawKey };
}

async function revokeApiKey(id) {
  return waQuery('UPDATE wa_api_keys SET is_active = false WHERE id = $1 RETURNING *', [id]);
}

async function rotateApiKey(id) {
  const rawKey = generateWaKey();
  const prefix = rawKey.substring(0, 12);
  const hash = hashWaKey(rawKey);
  const result = await waQuery(`
    UPDATE wa_api_keys SET key_prefix = $1, key_hash = $2, is_active = true
    WHERE id = $3 RETURNING id, tenant_id, key_prefix, label, scopes, rate_limit, is_active, created_at
  `, [prefix, hash, id]);
  return { ...result.rows[0], raw_key: rawKey };
}

async function resolveApiKey(rawKey) {
  const hash = hashWaKey(rawKey);
  const result = await waQuery(`
    SELECT k.*, t.slug AS tenant_slug, t.name AS tenant_name, t.status AS tenant_status
    FROM wa_api_keys k JOIN wa_tenants t ON k.tenant_id = t.id
    WHERE k.key_hash = $1 AND k.is_active = true
  `, [hash]);
  if (result.rows.length === 0) return null;
  // Update last_used_at
  waQuery('UPDATE wa_api_keys SET last_used_at = now() WHERE id = $1', [result.rows[0].id]).catch(() => {});
  return result.rows[0];
}

/* ── Sessions ──────────────────────────────────────────── */
async function getSession(tenantId) {
  const result = await waQuery('SELECT * FROM wa_sessions WHERE tenant_id = $1', [tenantId]);
  return result.rows[0] || null;
}

async function upsertSession(tenantId, fields) {
  const { status, phone_number, jid, push_name, platform, qr_data, qr_expires_at, error_message } = fields;
  return waQuery(`
    INSERT INTO wa_sessions (tenant_id, status, phone_number, jid, push_name, platform, qr_data, qr_expires_at, error_message, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
    ON CONFLICT (tenant_id) DO UPDATE SET
      status = COALESCE(EXCLUDED.status, wa_sessions.status),
      phone_number = COALESCE(EXCLUDED.phone_number, wa_sessions.phone_number),
      jid = COALESCE(EXCLUDED.jid, wa_sessions.jid),
      push_name = COALESCE(EXCLUDED.push_name, wa_sessions.push_name),
      platform = COALESCE(EXCLUDED.platform, wa_sessions.platform),
      qr_data = EXCLUDED.qr_data,
      qr_expires_at = EXCLUDED.qr_expires_at,
      error_message = EXCLUDED.error_message,
      last_seen_at = CASE WHEN EXCLUDED.status = 'connected' THEN now() ELSE wa_sessions.last_seen_at END,
      updated_at = now()
    RETURNING *
  `, [tenantId, status, phone_number || null, jid || null, push_name || null, platform || null, qr_data || null, qr_expires_at || null, error_message || null]);
}

async function clearSession(tenantId) {
  return waQuery(`
    UPDATE wa_sessions SET status = 'disconnected', qr_data = NULL, qr_expires_at = NULL, error_message = NULL, updated_at = now()
    WHERE tenant_id = $1 RETURNING *
  `, [tenantId]);
}

async function listSessions() {
  return waQuery(`
    SELECT s.*, t.slug AS tenant_slug, t.name AS tenant_name
    FROM wa_sessions s
    JOIN wa_tenants t ON s.tenant_id = t.id
    ORDER BY s.updated_at DESC
  `);
}

/* ── Session Events ────────────────────────────────────── */
async function logSessionEvent(tenantId, eventType, detail) {
  return waQuery(`
    INSERT INTO wa_session_events (tenant_id, event_type, detail)
    VALUES ($1, $2, $3)
  `, [tenantId, eventType, JSON.stringify(detail || {})]);
}

async function getSessionEvents(tenantId, limit = 50) {
  return waQuery(`
    SELECT * FROM wa_session_events WHERE tenant_id = $1
    ORDER BY created_at DESC LIMIT $2
  `, [tenantId, limit]);
}

/* ── Messages ──────────────────────────────────────────── */
async function createMessage(tenantId, direction, waJid, toE164, body, mediaUrl, mediaType) {
  return waQuery(`
    INSERT INTO wa_messages (tenant_id, direction, wa_jid, to_e164, body, media_url, media_type, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
  `, [tenantId, direction, waJid, toE164 || null, body || null, mediaUrl || null, mediaType || null,
      direction === 'outbound' ? 'queued' : 'delivered']);
}

async function updateMessageStatus(id, status, waMessageId, errorMessage) {
  return waQuery(`
    UPDATE wa_messages SET status = $2, wa_message_id = COALESCE($3, wa_message_id),
      error_message = $4, updated_at = now()
    WHERE id = $1 RETURNING *
  `, [id, status, waMessageId || null, errorMessage || null]);
}

async function listMessages(tenantId, { direction, limit = 50, offset = 0 } = {}) {
  const conditions = ['tenant_id = $1'];
  const params = [tenantId];
  if (direction) {
    conditions.push(`direction = $${params.length + 1}`);
    params.push(direction);
  }
  params.push(limit, offset);
  return waQuery(`
    SELECT * FROM wa_messages
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);
}

async function getMessageStats(tenantId) {
  return waQuery(`
    SELECT
      count(*) FILTER (WHERE direction = 'outbound') AS total_outbound,
      count(*) FILTER (WHERE direction = 'inbound') AS total_inbound,
      count(*) FILTER (WHERE direction = 'outbound' AND status = 'sent') AS sent,
      count(*) FILTER (WHERE direction = 'outbound' AND status = 'delivered') AS delivered,
      count(*) FILTER (WHERE direction = 'outbound' AND status = 'read') AS read_count,
      count(*) FILTER (WHERE direction = 'outbound' AND status = 'failed') AS failed,
      count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS last_24h,
      count(*) FILTER (WHERE created_at > now() - interval '7 days') AS last_7d
    FROM wa_messages WHERE tenant_id = $1
  `, [tenantId]);
}

/* ── Rate Limits ───────────────────────────────────────── */
async function checkRateLimit(tenantId, dailyLimit, monthlyLimit) {
  const today = new Date().toISOString().split('T')[0];
  const month = today.substring(0, 7);

  // Upsert daily counter
  const dailyRes = await waQuery(`
    INSERT INTO wa_rate_limits (tenant_id, window_type, window_key, counter, updated_at)
    VALUES ($1, 'daily', $2, 1, now())
    ON CONFLICT (tenant_id, window_type, window_key)
    DO UPDATE SET counter = wa_rate_limits.counter + 1, updated_at = now()
    RETURNING counter
  `, [tenantId, today]);

  // Upsert monthly counter
  const monthlyRes = await waQuery(`
    INSERT INTO wa_rate_limits (tenant_id, window_type, window_key, counter, updated_at)
    VALUES ($1, 'monthly', $2, 1, now())
    ON CONFLICT (tenant_id, window_type, window_key)
    DO UPDATE SET counter = wa_rate_limits.counter + 1, updated_at = now()
    RETURNING counter
  `, [tenantId, month]);

  const dailyCount = dailyRes.rows[0].counter;
  const monthlyCount = monthlyRes.rows[0].counter;

  return {
    ok: dailyCount <= dailyLimit && monthlyCount <= monthlyLimit,
    daily: { count: dailyCount, limit: dailyLimit },
    monthly: { count: monthlyCount, limit: monthlyLimit },
  };
}

/* ── Audit ─────────────────────────────────────────────── */
async function auditLog(tenantId, actor, action, detail) {
  return waQuery(`
    INSERT INTO wa_audit_logs (tenant_id, actor, action, detail)
    VALUES ($1, $2, $3, $4)
  `, [tenantId, actor, action, JSON.stringify(detail || {})]);
}

async function getAuditLogs(tenantId, limit = 100) {
  const cond = tenantId ? 'WHERE tenant_id = $1' : '';
  const params = tenantId ? [tenantId, limit] : [limit];
  return waQuery(`
    SELECT * FROM wa_audit_logs ${cond}
    ORDER BY created_at DESC
    LIMIT $${params.length}
  `, params);
}

/* ── Health ─────────────────────────────────────────────── */
async function getHealthMetrics() {
  const [tenants, sessions, msgStats, recentEvents] = await Promise.all([
    waQuery('SELECT count(*) AS total, count(*) FILTER (WHERE status = \'active\') AS active FROM wa_tenants'),
    waQuery(`SELECT count(*) AS total, count(*) FILTER (WHERE status = 'connected') AS connected FROM wa_sessions`),
    waQuery(`
      SELECT
        count(*) AS total,
        count(*) FILTER (WHERE direction = 'outbound' AND status = 'sent') AS sent_24h,
        count(*) FILTER (WHERE direction = 'outbound' AND status = 'failed') AS failed_24h,
        count(*) FILTER (WHERE direction = 'inbound') AS inbound_24h
      FROM wa_messages WHERE created_at > now() - interval '24 hours'
    `),
    waQuery(`SELECT count(*) AS total FROM wa_session_events WHERE created_at > now() - interval '24 hours'`),
  ]);

  return {
    tenants: tenants.rows[0],
    sessions: sessions.rows[0],
    messages_24h: msgStats.rows[0],
    events_24h: parseInt(recentEvents.rows[0].total),
  };
}

module.exports = {
  waQuery,
  // Keys
  hashWaKey,
  generateWaKey,
  resolveApiKey,
  // Tenants
  listTenants,
  getTenantById,
  getTenantBySlug,
  createTenant,
  updateTenant,
  // API Keys
  listApiKeys,
  createApiKey,
  revokeApiKey,
  rotateApiKey,
  // Sessions
  getSession,
  upsertSession,
  clearSession,
  listSessions,
  // Session Events
  logSessionEvent,
  getSessionEvents,
  // Messages
  createMessage,
  updateMessageStatus,
  listMessages,
  getMessageStats,
  // Rate limits
  checkRateLimit,
  // Audit
  auditLog,
  getAuditLogs,
  // Health
  getHealthMetrics,
};
