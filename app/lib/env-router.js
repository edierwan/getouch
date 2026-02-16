/**
 * Environment Resolution Middleware
 *
 * Resolves request environment based on API key prefix:
 *   prod_xxxxx → environment = 'prod'  → DATABASE_URL_PROD
 *   dev_xxxxx  → environment = 'dev'   → DATABASE_URL_DEV
 *   gt_xxxxx   → environment = 'prod'  (legacy keys default to prod)
 *
 * Attaches to req:
 *   req.env        — 'prod' | 'dev'
 *   req.envLabel   — 'production' | 'development'
 *
 * Security: prod_ keys cannot touch dev DB and vice versa.
 */

const { queryFor } = require('./db');
const crypto = require('crypto');

/**
 * Resolve environment from API key in Authorization header.
 * For session-based requests (web UI), defaults to 'prod'.
 */
function resolveEnvironment(req, _res, next) {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const apiKey = authHeader.replace('Bearer ', '');

    if (apiKey.startsWith('prod_')) {
      req.env = 'prod';
    } else if (apiKey.startsWith('dev_')) {
      req.env = 'dev';
    } else {
      // Legacy gt_ keys and admin tokens → prod
      req.env = 'prod';
    }
  } else {
    // Session-based or unauthenticated → prod
    req.env = 'prod';
  }

  req.envLabel = req.env === 'dev' ? 'development' : 'production';
  next();
}

/**
 * Require API key auth with environment-aware validation.
 * Replaces the old requireApiKey from auth.js for /v1/* routes.
 *
 * Validates key against the correct environment's database.
 * Enforces: prod_ keys only in prod DB, dev_ keys only in dev DB.
 */
async function requireApiKeyWithEnv(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Missing or invalid Authorization header',
      hint: 'Use: Authorization: Bearer <your-api-key>',
    });
  }

  const apiKey = authHeader.replace('Bearer ', '');

  // Determine environment from prefix
  let env = 'prod';
  if (apiKey.startsWith('prod_')) {
    env = 'prod';
  } else if (apiKey.startsWith('dev_')) {
    env = 'dev';
  } else if (apiKey.startsWith('gt_')) {
    env = 'prod'; // Legacy keys
  }

  req.env = env;
  req.envLabel = env === 'dev' ? 'development' : 'production';

  try {
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const prefix = apiKey.substring(0, 8);

    // Query against the PROD pool always — api_keys table lives in prod
    // (keys are registered once, environment column determines routing)
    const { queryFor: qf } = require('./db');
    const result = await qf('prod',
      `SELECT ak.id, ak.user_id, ak.name, ak.scopes, ak.is_active, ak.expires_at,
              ak.environment,
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

    // Enforce: key's registered environment must match its prefix
    if (keyRecord.environment !== env) {
      return res.status(403).json({
        error: 'Environment mismatch',
        detail: `This key is registered for ${keyRecord.environment} but prefix indicates ${env}`,
      });
    }

    // Check expiration
    if (keyRecord.expires_at && new Date(keyRecord.expires_at) < new Date()) {
      return res.status(401).json({ error: 'API key has expired' });
    }

    // Update last_used (fire-and-forget on prod pool)
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    qf('prod',
      `UPDATE api_keys SET last_used_at = NOW(), last_used_ip = $1 WHERE id = $2`,
      [clientIp, keyRecord.id]
    ).catch(() => {});

    // Log usage with environment tag
    qf('prod',
      `INSERT INTO api_key_usage_log (api_key_id, user_id, endpoint, method, ip_address, environment)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [keyRecord.id, keyRecord.user_id, req.path, req.method, clientIp, env]
    ).catch(() => {});

    // Attach to request
    req.apiKey = {
      id: keyRecord.id,
      userId: keyRecord.user_id,
      email: keyRecord.email,
      userName: keyRecord.user_name,
      scopes: keyRecord.scopes,
      environment: env,
    };

    next();
  } catch (err) {
    console.error(`[auth:${env}] API key validation error:`, err.message);
    return res.status(500).json({ error: 'Authentication failed' });
  }
}

module.exports = { resolveEnvironment, requireApiKeyWithEnv };
