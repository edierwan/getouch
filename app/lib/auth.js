/**
 * Auth middleware for Getouch
 * Session-based auth for web UI, API key auth for programmatic access
 */

const { query } = require('./db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

/**
 * Hash an API key for storage
 */
function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Require authenticated session (for web UI routes)
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  // If it's an API request, return 401
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  // Redirect to login for web pages
  return res.redirect('/auth/login');
}

/**
 * Require API key auth (Bearer token)
 * Used for WA gateway proxy endpoints
 */
async function requireApiKey(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Missing or invalid Authorization header',
      hint: 'Use: Authorization: Bearer <your-api-key>',
    });
  }

  const apiKey = authHeader.replace('Bearer ', '');

  try {
    const keyHash = hashApiKey(apiKey);
    const prefix = apiKey.substring(0, 8);

    const result = await query(
      `SELECT ak.id, ak.user_id, ak.name, ak.scopes, ak.is_active, ak.expires_at,
              u.email, u.name as user_name
       FROM api_keys ak
       JOIN users u ON u.id = ak.user_id
       WHERE ak.key_prefix = $1
         AND ak.key_hash = $2
         AND ak.is_active = true
         AND u.is_active = true`,
      [prefix, keyHash]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    const keyRecord = result.rows[0];

    // Check expiration
    if (keyRecord.expires_at && new Date(keyRecord.expires_at) < new Date()) {
      return res.status(401).json({ error: 'API key has expired' });
    }

    // Update last_used
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    query(
      `UPDATE api_keys SET last_used_at = NOW(), last_used_ip = $1 WHERE id = $2`,
      [clientIp, keyRecord.id]
    ).catch(() => {}); // fire and forget

    // Log usage
    query(
      `INSERT INTO api_key_usage_log (api_key_id, user_id, endpoint, method, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [keyRecord.id, keyRecord.user_id, req.path, req.method, clientIp]
    ).catch(() => {});

    // Attach to request
    req.apiKey = {
      id: keyRecord.id,
      userId: keyRecord.user_id,
      email: keyRecord.email,
      userName: keyRecord.user_name,
      scopes: keyRecord.scopes,
    };

    next();
  } catch (err) {
    console.error('[auth] API key validation error:', err.message);
    return res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * Optionally load user from session (for pages that work with or without auth)
 */
async function loadUser(req, res, next) {
  if (req.session && req.session.userId) {
    try {
      const result = await query(
        'SELECT id, email, name, is_active, created_at FROM users WHERE id = $1 AND is_active = true',
        [req.session.userId]
      );
      if (result.rows.length > 0) {
        req.user = result.rows[0];
      }
    } catch (err) {
      // ignore — template will just not show user info
    }
  }
  next();
}

module.exports = { requireAuth, requireApiKey, loadUser, hashApiKey };
