/**
 * Admin Reporting API
 * Protected via same admin middleware as settings.
 *
 * GET /v1/admin/reporting/summary   — top-level KPI cards
 * GET /v1/admin/reporting/daily     — daily event counts for charts
 * GET /v1/admin/reporting/breakdown — breakdown by mode/model/engine
 * GET /v1/admin/reporting/top-visitors — most active anonymous visitors
 * GET /v1/admin/reporting/guest-limits — current guest limit config + live counts
 */
const { Router } = require('express');
const { query }  = require('../lib/db');
const { getAllSettings } = require('../lib/settings');

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
  if (req.session && (req.session.userId || req.session.cfEmail)) return next();
  const cfJwt = req.headers['cf-access-jwt-assertion'];
  if (cfJwt) return next();
  return res.status(403).json({ error: 'Admin access required' });
}

router.use(requireAdmin);

/** Parse ?days=N query param (default 7, max 90) */
function parseDays(req) {
  const d = parseInt(req.query.days, 10);
  if (!d || d < 1) return 7;
  return Math.min(d, 90);
}

/**
 * GET /v1/admin/reporting/summary — KPI cards
 */
router.get('/reporting/summary', async (req, res) => {
  const days = parseDays(req);
  try {
    const result = await query(`
      SELECT
        COUNT(*)::int                                        AS total_events,
        COUNT(*) FILTER (WHERE event_type = 'chat')::int     AS total_chats,
        COUNT(*) FILTER (WHERE event_type = 'image')::int    AS total_images,
        COUNT(DISTINCT visitor_id)::int                      AS unique_visitors,
        COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL)::int AS registered_users,
        COUNT(*) FILTER (WHERE user_id IS NULL)::int         AS guest_events,
        ROUND(AVG(latency_ms) FILTER (WHERE latency_ms IS NOT NULL))::int AS avg_latency_ms,
        COALESCE(SUM(tokens_in),0)::bigint                   AS total_tokens_in,
        COALESCE(SUM(tokens_out),0)::bigint                  AS total_tokens_out
      FROM usage_events
      WHERE created_at >= NOW() - INTERVAL '1 day' * $1
        AND status = 'ok'
    `, [days]);

    // Today's stats
    const todayResult = await query(`
      SELECT
        COUNT(*)::int                                        AS events_today,
        COUNT(*) FILTER (WHERE event_type = 'chat')::int     AS chats_today,
        COUNT(*) FILTER (WHERE event_type = 'image')::int    AS images_today,
        COUNT(DISTINCT visitor_id)::int                      AS visitors_today
      FROM usage_events
      WHERE created_at >= CURRENT_DATE
        AND status = 'ok'
    `);

    res.json({
      period_days: days,
      ...result.rows[0],
      ...todayResult.rows[0],
    });
  } catch (err) {
    console.error('[reporting] Summary error:', err.message);
    res.status(500).json({ error: 'Failed to load summary' });
  }
});

/**
 * GET /v1/admin/reporting/daily — daily series for charts
 */
router.get('/reporting/daily', async (req, res) => {
  const days = parseDays(req);
  try {
    const result = await query(`
      SELECT
        d.day::date AS day,
        COALESCE(e.chats, 0)::int   AS chats,
        COALESCE(e.images, 0)::int  AS images,
        COALESCE(e.visitors, 0)::int AS visitors,
        COALESCE(e.guests, 0)::int   AS guests,
        COALESCE(e.registered, 0)::int AS registered
      FROM generate_series(
        (CURRENT_DATE - ($1 - 1) * INTERVAL '1 day')::date,
        CURRENT_DATE,
        '1 day'
      ) AS d(day)
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE event_type = 'chat')  AS chats,
          COUNT(*) FILTER (WHERE event_type = 'image') AS images,
          COUNT(DISTINCT visitor_id)                    AS visitors,
          COUNT(*) FILTER (WHERE user_id IS NULL)       AS guests,
          COUNT(*) FILTER (WHERE user_id IS NOT NULL)   AS registered
        FROM usage_events
        WHERE created_at >= d.day
          AND created_at < d.day + INTERVAL '1 day'
          AND status = 'ok'
      ) e ON TRUE
      ORDER BY d.day
    `, [days]);

    res.json({ days, series: result.rows });
  } catch (err) {
    console.error('[reporting] Daily error:', err.message);
    res.status(500).json({ error: 'Failed to load daily data' });
  }
});

/**
 * GET /v1/admin/reporting/breakdown — by mode, model, engine
 */
router.get('/reporting/breakdown', async (req, res) => {
  const days = parseDays(req);
  try {
    // By event type + mode
    const byMode = await query(`
      SELECT event_type, mode, COUNT(*)::int AS count
      FROM usage_events
      WHERE created_at >= NOW() - INTERVAL '1 day' * $1
        AND status = 'ok'
      GROUP BY event_type, mode
      ORDER BY count DESC
    `, [days]);

    // By model
    const byModel = await query(`
      SELECT model, COUNT(*)::int AS count,
             COALESCE(SUM(tokens_in),0)::bigint AS tokens_in,
             COALESCE(SUM(tokens_out),0)::bigint AS tokens_out
      FROM usage_events
      WHERE created_at >= NOW() - INTERVAL '1 day' * $1
        AND status = 'ok' AND model IS NOT NULL
      GROUP BY model
      ORDER BY count DESC
    `, [days]);

    // Error rate
    const errors = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status != 'ok')::int AS error_count,
        COUNT(*)::int AS total
      FROM usage_events
      WHERE created_at >= NOW() - INTERVAL '1 day' * $1
    `, [days]);

    res.json({
      period_days: days,
      by_mode: byMode.rows,
      by_model: byModel.rows,
      errors: errors.rows[0],
    });
  } catch (err) {
    console.error('[reporting] Breakdown error:', err.message);
    res.status(500).json({ error: 'Failed to load breakdown' });
  }
});

/**
 * GET /v1/admin/reporting/top-visitors — most active anonymous visitors
 */
router.get('/reporting/top-visitors', async (req, res) => {
  const days = parseDays(req);
  try {
    const result = await query(`
      SELECT
        visitor_id,
        user_id,
        COUNT(*)::int AS total_events,
        COUNT(*) FILTER (WHERE event_type = 'chat')::int AS chats,
        COUNT(*) FILTER (WHERE event_type = 'image')::int AS images,
        MIN(created_at) AS first_seen,
        MAX(created_at) AS last_seen
      FROM usage_events
      WHERE created_at >= NOW() - INTERVAL '1 day' * $1
        AND status = 'ok'
      GROUP BY visitor_id, user_id
      ORDER BY total_events DESC
      LIMIT 20
    `, [days]);

    res.json({ period_days: days, visitors: result.rows });
  } catch (err) {
    console.error('[reporting] Top visitors error:', err.message);
    res.status(500).json({ error: 'Failed to load top visitors' });
  }
});

/**
 * GET /v1/admin/reporting/guest-limits — current config + active counts
 */
router.get('/reporting/guest-limits', async (_req, res) => {
  try {
    const settings = await getAllSettings();
    const guestSettings = {};
    for (const [k, v] of Object.entries(settings)) {
      if (k.startsWith('guest.')) guestSettings[k] = v;
    }

    // Active guest counts (last hour for chat, today for images)
    const counts = await query(`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'chat'
          AND created_at >= NOW() - INTERVAL '1 hour'
          AND user_id IS NULL)::int AS guest_chats_last_hour,
        COUNT(*) FILTER (WHERE event_type = 'image'
          AND created_at >= CURRENT_DATE
          AND user_id IS NULL)::int AS guest_images_today,
        COUNT(DISTINCT visitor_id) FILTER (WHERE user_id IS NULL
          AND created_at >= NOW() - INTERVAL '1 hour')::int AS active_guests
      FROM usage_events
      WHERE status = 'ok'
    `);

    res.json({
      settings: guestSettings,
      ...counts.rows[0],
    });
  } catch (err) {
    console.error('[reporting] Guest limits error:', err.message);
    res.status(500).json({ error: 'Failed to load guest limits' });
  }
});

/**
 * GET /v1/admin/reporting/route-breakdown — pipeline route analytics
 */
router.get('/reporting/route-breakdown', async (req, res) => {
  const days = parseDays(req);
  try {
    const result = await query(`
      SELECT
        route_type,
        COUNT(*)::int AS count,
        COUNT(*) FILTER (WHERE status = 'ok')::int AS success,
        COUNT(*) FILTER (WHERE status = 'error')::int AS errors,
        ROUND(AVG(duration_ms) FILTER (WHERE status = 'ok'))::int AS avg_duration_ms,
        ROUND(AVG(tokens_in) FILTER (WHERE tokens_in > 0))::int AS avg_tokens_in,
        ROUND(AVG(tokens_out) FILTER (WHERE tokens_out > 0))::int AS avg_tokens_out
      FROM pipeline_audit
      WHERE created_at >= NOW() - INTERVAL '1 day' * $1
      GROUP BY route_type
      ORDER BY count DESC
    `, [days]);

    // Language/dialect breakdown
    const langBreakdown = await query(`
      SELECT
        language, dialect,
        COUNT(*)::int AS count
      FROM pipeline_audit
      WHERE created_at >= NOW() - INTERVAL '1 day' * $1
        AND status = 'ok'
      GROUP BY language, dialect
      ORDER BY count DESC
      LIMIT 20
    `, [days]);

    // Intent breakdown
    const intentBreakdown = await query(`
      SELECT
        intent,
        COUNT(*)::int AS count
      FROM pipeline_audit
      WHERE created_at >= NOW() - INTERVAL '1 day' * $1
        AND status = 'ok'
        AND intent IS NOT NULL
      GROUP BY intent
      ORDER BY count DESC
    `, [days]);

    res.json({
      period_days: days,
      by_route: result.rows,
      by_language: langBreakdown.rows,
      by_intent: intentBreakdown.rows,
    });
  } catch (err) {
    console.error('[reporting] Route breakdown error:', err.message);
    res.status(500).json({ error: 'Failed to load route breakdown' });
  }
});

/**
 * GET /v1/admin/reporting/pipeline-errors — recent pipeline errors
 */
router.get('/reporting/pipeline-errors', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  try {
    const result = await query(`
      SELECT
        request_id, route_type, intent, language, dialect,
        model_used, duration_ms, error_message,
        created_at
      FROM pipeline_audit
      WHERE status = 'error'
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);

    res.json({ errors: result.rows });
  } catch (err) {
    console.error('[reporting] Pipeline errors:', err.message);
    res.status(500).json({ error: 'Failed to load errors' });
  }
});

module.exports = router;
