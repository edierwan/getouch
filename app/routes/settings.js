/**
 * Admin settings API
 * Protected via admin token or Cloudflare Access.
 *
 * GET    /v1/admin/settings        — list all settings
 * PUT    /v1/admin/settings/:key   — update a setting
 */
const { Router } = require('express');
const { getAllSettings, getSetting, setSetting } = require('../lib/settings');

const router = Router();

/**
 * Admin auth middleware — check for admin token or Cloudflare Access header
 */
function requireAdmin(req, res, next) {
  // Option 1: Bearer token (ADMIN_TOKEN env var)
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken) {
    const auth = req.headers.authorization;
    if (auth === `Bearer ${adminToken}`) return next();
  }

  // Option 2: Cloudflare Access authenticated user
  const cfEmail = req.headers['cf-access-authenticated-user-email'];
  if (cfEmail) return next();

  // Option 3: Session-based admin (userId or CF Access email saved to session)
  if (req.session && (req.session.userId || req.session.cfEmail)) {
    return next();
  }

  // Option 4: CF Access JWT assertion header (present for all CF-protected reqs)
  const cfJwt = req.headers['cf-access-jwt-assertion'];
  if (cfJwt) return next();

  return res.status(403).json({ error: 'Admin access required' });
}

router.use(requireAdmin);

/**
 * GET /v1/admin/settings — all settings
 */
router.get('/settings', async (_req, res) => {
  try {
    const settings = await getAllSettings();
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

/**
 * PUT /v1/admin/settings/:key — update one setting
 *
 * Body: { value: any }
 */
router.put('/settings/:key', async (req, res) => {
  const { key } = req.params;
  const { value } = req.body || {};

  if (value === undefined) {
    return res.status(400).json({ error: 'value is required' });
  }

  // Whitelist allowed settings
  const allowedKeys = [
    'ai.default_text_model',
    'ai.enable_image',
    'ai.image.max_per_day_free',
    'ai.image.max_per_day_free.prod',
    'ai.image.max_per_day_free.dev',
    'rate_limit.chat.prod',
    'rate_limit.chat.dev',
    'rate_limit.image.prod',
    'rate_limit.image.dev',
    'typing.enabled',
    'typing.mode',
    'typing.speed',
    'typing.adaptive_catchup',
  ];

  if (!allowedKeys.includes(key)) {
    return res.status(400).json({ error: `Unknown setting: ${key}` });
  }

  // Validate specific settings
  if (key === 'ai.default_text_model') {
    const validModels = ['llama3.1:8b', 'qwen2.5:14b-instruct'];
    if (!validModels.includes(value)) {
      return res.status(400).json({ error: `Invalid model. Options: ${validModels.join(', ')}` });
    }
  }

  if (key === 'ai.enable_image' && typeof value !== 'boolean') {
    return res.status(400).json({ error: 'value must be boolean' });
  }

  // Validate typing settings
  if (key === 'typing.enabled' && typeof value !== 'boolean') {
    return res.status(400).json({ error: 'value must be boolean' });
  }
  if (key === 'typing.mode' && !['word', 'char'].includes(value)) {
    return res.status(400).json({ error: 'value must be "word" or "char"' });
  }
  if (key === 'typing.speed') {
    if (typeof value !== 'number' || value < 5 || value > 200) {
      return res.status(400).json({ error: 'value must be a number between 5 and 200' });
    }
  }
  if (key === 'typing.adaptive_catchup' && typeof value !== 'boolean') {
    return res.status(400).json({ error: 'value must be boolean' });
  }

  // Validate numeric quota/rate settings
  const numericKeys = [
    'ai.image.max_per_day_free',
    'ai.image.max_per_day_free.prod',
    'ai.image.max_per_day_free.dev',
    'rate_limit.chat.prod',
    'rate_limit.chat.dev',
    'rate_limit.image.prod',
    'rate_limit.image.dev',
  ];
  if (numericKeys.includes(key)) {
    if (typeof value !== 'number' || value < 0 || value > 1000) {
      return res.status(400).json({ error: 'value must be a number between 0 and 1000' });
    }
  }

  try {
    await setSetting(key, value);
    res.json({ ok: true, key, value });
  } catch (err) {
    console.error('[admin] Setting update failed:', err.message);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

module.exports = router;
