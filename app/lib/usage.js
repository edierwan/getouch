/**
 * Usage tracking — visitor identification + event logging
 *
 * logUsageEvent()   — insert into usage_events table (fire-and-forget)
 * visitorMiddleware — sets/reads visitor_id cookie on every request
 * getGuestUsage()   — count recent events for guest limit checks
 */

const crypto = require('crypto');
const { query } = require('./db');

/* ── Visitor ID cookie middleware ────────────────────────── */
const COOKIE_NAME = 'vid';
const COOKIE_MAX_AGE = 180 * 24 * 60 * 60 * 1000; // 180 days

/** Parse cookies from raw header (avoids adding cookie-parser dep) */
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(pair => {
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 0) return;
    const key = pair.substring(0, eqIdx).trim();
    const val = pair.substring(eqIdx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}

function visitorMiddleware(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  let vid = cookies[COOKIE_NAME];
  if (!vid) {
    vid = crypto.randomUUID();
    res.cookie(COOKIE_NAME, vid, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE,
      secure: process.env.NODE_ENV === 'production',
    });
  }
  req.visitorId = vid;
  next();
}

/* ── Log usage event (fire-and-forget) ──────────────────── */
function logUsageEvent({
  visitorId,
  userId = null,
  eventType,       // 'chat' | 'image'
  mode = null,     // 'text' | 'vision' | 'sdxl' | 'flux'
  model = null,
  status = 'ok',
  latencyMs = null,
  inputLen = null,
  tokensIn = null,
  tokensOut = null,
  environment = 'prod',
  meta = null,
}) {
  return query(
    `INSERT INTO usage_events
       (visitor_id, user_id, event_type, mode, model, status, latency_ms, input_len, tokens_in, tokens_out, environment, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [visitorId, userId, eventType, mode, model, status, latencyMs, inputLen, tokensIn, tokensOut, environment, meta ? JSON.stringify(meta) : null]
  ).catch(err => {
    console.error('[usage] Failed to log event:', err.message);
  });
}

/* ── Guest usage queries (for limit enforcement) ────────── */

/**
 * Count chat events in the last `windowMs` for this visitor
 */
async function getGuestChatCount(visitorId, windowMs = 3600000) {
  try {
    const result = await query(
      `SELECT COUNT(*)::int AS cnt FROM usage_events
       WHERE visitor_id = $1 AND event_type = 'chat' AND status = 'ok'
         AND created_at > NOW() - INTERVAL '1 millisecond' * $2`,
      [visitorId, windowMs]
    );
    return result.rows[0].cnt;
  } catch {
    return 0;
  }
}

/**
 * Count image events today for this visitor
 */
async function getGuestImageCountToday(visitorId) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const result = await query(
      `SELECT COUNT(*)::int AS cnt FROM usage_events
       WHERE visitor_id = $1 AND event_type = 'image' AND status = 'ok'
         AND created_at >= $2::date`,
      [visitorId, today]
    );
    return result.rows[0].cnt;
  } catch {
    return 0;
  }
}

/**
 * Get total event counts for a visitor (for soft gate threshold)
 */
async function getVisitorTotals(visitorId) {
  try {
    const result = await query(
      `SELECT
         COUNT(*) FILTER (WHERE event_type = 'chat')::int   AS chats,
         COUNT(*) FILTER (WHERE event_type = 'image')::int  AS images
       FROM usage_events
       WHERE visitor_id = $1 AND user_id IS NULL AND status = 'ok'`,
      [visitorId]
    );
    return result.rows[0];
  } catch {
    return { chats: 0, images: 0 };
  }
}

/**
 * Count document upload events today for this visitor
 */
async function getGuestDocCountToday(visitorId) {
  try {
    const result = await query(
      `SELECT COUNT(*)::int AS cnt FROM usage_events
       WHERE visitor_id = $1 AND event_type = 'chat' AND mode LIKE 'doc-%' AND status = 'ok'
         AND created_at >= CURRENT_DATE`,
      [visitorId]
    );
    return result.rows[0].cnt;
  } catch {
    return 0;
  }
}

/**
 * Get route-type breakdown for analytics
 */
async function getRouteBreakdown(days = 7) {
  try {
    const result = await query(
      `SELECT
         meta->>'route' AS route,
         COUNT(*)::int AS count,
         ROUND(AVG(latency_ms))::int AS avg_latency_ms,
         ROUND(AVG(tokens_out))::int AS avg_tokens_out
       FROM usage_events
       WHERE event_type = 'chat' AND status = 'ok'
         AND created_at >= NOW() - INTERVAL '1 day' * $1
         AND meta->>'route' IS NOT NULL
       GROUP BY meta->>'route'
       ORDER BY count DESC`,
      [days]
    );
    return result.rows;
  } catch {
    return [];
  }
}

module.exports = {
  visitorMiddleware,
  logUsageEvent,
  getGuestChatCount,
  getGuestImageCountToday,
  getGuestDocCountToday,
  getVisitorTotals,
  getRouteBreakdown,
};
