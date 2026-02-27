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
    'ai.default_vision_model',
    'ai.enable_image',
    'ai.default_image_engine',
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
    'guest.chat_per_hour',
    'guest.chat_per_day',
    'guest.doc_per_day',
    'guest.image_per_day',
    'guest.images_per_day',
    'guest.soft_gate_after_chats',
    'guest.soft_gate_after_images',
    'guest.require_register_after_n',
    // Web research settings
    'web_research.enabled',
    'web_research.search_provider',
    'web_research.searxng_url',
    'web_research.max_sources',
    'web_research.max_fetch',
    'web_research.allowed_domains',
    'web_research.blocked_domains',
    'web_research.cache_ttl_minutes',
    'web_research.timeout_seconds',
    // Personality & routing settings
    'ai.personality_enabled',
    'ai.dialect_mirroring',
    'ai.smalltalk_stabilizer',
    'ai.dialect_mirroring_level',
    'ai.smalltalk_max_tokens',
    'ai.general_max_tokens',
    'ai.task_max_tokens',
    // Performance limits
    'limits.max_upload_mb',
    'limits.max_file_size_mb',
    'limits.max_pdf_pages',
    'limits.max_pdf_pages_guest',
    'limits.max_pdf_pages_registered',
    'limits.max_sheets',
    'limits.max_rows_per_sheet',
    'limits.max_web_sources',
    'limits.max_context_chars',
    // Tool settings
    'tool.order_lookup.enabled',
    'tool.points_lookup.enabled',
    'tool.qr_verify.enabled',
    'tool.db_read.enabled',
  ];

  if (!allowedKeys.includes(key)) {
    return res.status(400).json({ error: `Unknown setting: ${key}` });
  }

  // Validate specific settings
  // Validate model settings — accept any string (dynamic from Ollama)
  if (key === 'ai.default_text_model' || key === 'ai.default_vision_model') {
    if (typeof value !== 'string' || value.length > 100) {
      return res.status(400).json({ error: 'Model name must be a string (max 100 chars)' });
    }
  }

  if (key === 'ai.enable_image' && typeof value !== 'boolean') {
    return res.status(400).json({ error: 'value must be boolean' });
  }

  if (key === 'ai.default_image_engine') {
    if (!['sdxl', 'flux'].includes(value)) {
      return res.status(400).json({ error: 'value must be "sdxl" or "flux"' });
    }
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
    'guest.chat_per_hour',
    'guest.chat_per_day',
    'guest.doc_per_day',
    'guest.image_per_day',
    'guest.images_per_day',
    'guest.soft_gate_after_chats',
    'guest.soft_gate_after_images',
    'guest.require_register_after_n',
  ];
  if (numericKeys.includes(key)) {
    if (typeof value !== 'number' || value < 0 || value > 1000) {
      return res.status(400).json({ error: 'value must be a number between 0 and 1000' });
    }
  }

  // Validate web research settings
  if (key === 'web_research.enabled' && typeof value !== 'boolean') {
    return res.status(400).json({ error: 'value must be boolean' });
  }
  if (key === 'web_research.search_provider') {
    if (!['searxng', 'tavily', 'serpapi'].includes(value)) {
      return res.status(400).json({ error: 'value must be "searxng", "tavily", or "serpapi"' });
    }
  }
  if (key === 'web_research.searxng_url') {
    if (typeof value !== 'string' || value.length > 200) {
      return res.status(400).json({ error: 'value must be a URL string (max 200 chars)' });
    }
  }
  const webNumericKeys = [
    'web_research.max_sources',
    'web_research.max_fetch',
    'web_research.cache_ttl_minutes',
    'web_research.timeout_seconds',
  ];
  if (webNumericKeys.includes(key)) {
    if (typeof value !== 'number' || value < 1 || value > 999) {
      return res.status(400).json({ error: 'value must be a number between 1 and 999' });
    }
  }
  if (key === 'web_research.allowed_domains' || key === 'web_research.blocked_domains') {
    if (typeof value !== 'string' || value.length > 2000) {
      return res.status(400).json({ error: 'value must be a comma-separated string (max 2000 chars)' });
    }
  }

  // Validate personality settings
  if (key === 'ai.personality_enabled' && typeof value !== 'boolean') {
    return res.status(400).json({ error: 'value must be boolean' });
  }
  if (key === 'ai.dialect_mirroring' && typeof value !== 'boolean') {
    return res.status(400).json({ error: 'value must be boolean' });
  }
  if (key === 'ai.smalltalk_stabilizer' && typeof value !== 'boolean') {
    return res.status(400).json({ error: 'value must be boolean' });
  }
  if (key === 'ai.dialect_mirroring_level') {
    if (!['off', 'light', 'medium'].includes(value)) {
      return res.status(400).json({ error: 'value must be "off", "light", or "medium"' });
    }
  }
  // Validate tool enable/disable settings
  if (key.startsWith('tool.') && key.endsWith('.enabled') && typeof value !== 'boolean') {
    return res.status(400).json({ error: 'value must be boolean' });
  }
  const personalityNumericKeys = [
    'ai.smalltalk_max_tokens',
    'ai.general_max_tokens',
    'ai.task_max_tokens',
  ];
  if (personalityNumericKeys.includes(key)) {
    if (typeof value !== 'number' || value < 64 || value > 8192) {
      return res.status(400).json({ error: 'value must be a number between 64 and 8192' });
    }
  }
  const limitsNumericKeys = [
    'limits.max_upload_mb',
    'limits.max_file_size_mb',
    'limits.max_pdf_pages',
    'limits.max_pdf_pages_guest',
    'limits.max_pdf_pages_registered',
    'limits.max_sheets',
    'limits.max_rows_per_sheet',
    'limits.max_web_sources',
    'limits.max_context_chars',
  ];
  if (limitsNumericKeys.includes(key)) {
    if (typeof value !== 'number' || value < 1 || value > 500000) {
      return res.status(400).json({ error: 'value must be a positive number' });
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
