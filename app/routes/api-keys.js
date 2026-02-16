/**
 * API Key management routes
 * Self-serve key creation, listing, and revocation
 */

const express = require('express');
const crypto = require('crypto');
const { query } = require('../lib/db');
const { requireAuth, hashApiKey } = require('../lib/auth');

const router = express.Router();

// All routes require authenticated session
router.use(requireAuth);

/**
 * GET /api/keys — List user's API keys
 */
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, key_prefix, scopes, is_active, last_used_at, last_used_ip, expires_at, environment, created_at, revoked_at
       FROM api_keys
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.session.userId]
    );
    res.json({ keys: result.rows });
  } catch (err) {
    console.error('[api-keys] List error:', err.message);
    res.status(500).json({ error: 'Failed to list API keys' });
  }
});

/**
 * POST /api/keys — Create a new API key
 * Returns the plaintext key ONCE — it cannot be retrieved again
 *
 * Body: { name, scopes?, expiresInDays?, environment? }
 * environment: 'prod' (default) | 'dev'
 * Key prefix: prod_xxxx or dev_xxxx
 */
router.post('/', async (req, res) => {
  const { name, scopes, expiresInDays, environment } = req.body;

  if (!name || name.trim().length === 0) {
    return res.status(400).json({ error: 'Key name is required' });
  }

  // Validate environment
  const env = (environment === 'dev') ? 'dev' : 'prod';

  // Limit keys per user
  const countResult = await query(
    'SELECT COUNT(*) as cnt FROM api_keys WHERE user_id = $1 AND is_active = true',
    [req.session.userId]
  );
  if (parseInt(countResult.rows[0].cnt) >= 10) {
    return res.status(400).json({ error: 'Maximum 10 active keys per account' });
  }

  try {
    // Generate a random API key with environment prefix
    const rawKey = crypto.randomBytes(24).toString('hex');
    const apiKey = `${env}_${rawKey}`;
    const prefix = apiKey.substring(0, 8); // "prod_xxx" or "dev_xxxx"
    const keyHash = hashApiKey(apiKey);

    const validScopes = ['wa:read', 'wa:write', 'bot:read', 'bot:write'];
    const keyScopes = Array.isArray(scopes)
      ? scopes.filter(s => validScopes.includes(s))
      : ['wa:read', 'wa:write'];

    let expiresAt = null;
    if (expiresInDays && Number(expiresInDays) > 0) {
      expiresAt = new Date(Date.now() + Number(expiresInDays) * 86400000).toISOString();
    }

    const result = await query(
      `INSERT INTO api_keys (user_id, name, key_prefix, key_hash, scopes, expires_at, environment)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, key_prefix, scopes, is_active, expires_at, environment, created_at`,
      [req.session.userId, name.trim(), prefix, keyHash, keyScopes, expiresAt, env]
    );

    res.status(201).json({
      key: result.rows[0],
      // Return plaintext key ONCE
      apiKey,
      warning: 'Save this API key now. It cannot be shown again.',
    });
  } catch (err) {
    console.error('[api-keys] Create error:', err.message);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

/**
 * DELETE /api/keys/:id — Revoke an API key
 */
router.delete('/:id', async (req, res) => {
  try {
    const result = await query(
      `UPDATE api_keys SET is_active = false, revoked_at = NOW()
       WHERE id = $1 AND user_id = $2 AND is_active = true
       RETURNING id`,
      [req.params.id, req.session.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Key not found or already revoked' });
    }

    res.json({ success: true, message: 'API key revoked' });
  } catch (err) {
    console.error('[api-keys] Revoke error:', err.message);
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

/**
 * PATCH /api/keys/:id — Update key name
 */
router.patch('/:id', async (req, res) => {
  const { name } = req.body;
  if (!name || name.trim().length === 0) {
    return res.status(400).json({ error: 'Name is required' });
  }

  try {
    const result = await query(
      `UPDATE api_keys SET name = $1 WHERE id = $2 AND user_id = $3 AND is_active = true RETURNING id, name`,
      [name.trim(), req.params.id, req.session.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Key not found' });
    }

    res.json({ success: true, key: result.rows[0] });
  } catch (err) {
    console.error('[api-keys] Update error:', err.message);
    res.status(500).json({ error: 'Failed to update API key' });
  }
});

module.exports = router;
