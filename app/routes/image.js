/**
 * POST /v1/image/generate — Image generation via ComfyUI (SDXL)
 * GET  /v1/image/quota    — Remaining daily quota
 * GET  /v1/image/:id      — Serve generated image
 */
const { Router }  = require('express');
const path        = require('path');
const fs          = require('fs');
const crypto      = require('crypto');
const { query }   = require('../lib/db');
const { getSetting }    = require('../lib/settings');
const { checkRateLimit, getActor } = require('../lib/rate-limit');
const comfyui      = require('../lib/comfyui');

const router = Router();

const IMAGE_DIR = process.env.IMAGE_DIR || path.join(__dirname, '..', 'data', 'images');

/**
 * POST /v1/image/generate
 *
 * Body: { prompt, negative_prompt?, width?, height?, steps?, cfg?, seed? }
 *
 * Response: { id, image_url, seed, timings }
 */
router.post('/image/generate', async (req, res) => {
  const actor = getActor(req);

  // Rate limiting (5 per minute)
  const rl = checkRateLimit(actor, 'image', 5, 60_000);
  if (!rl.allowed) {
    return res.status(429).json({ error: 'Rate limit exceeded', retry_after: rl.retryAfter });
  }

  // Check if image generation is enabled
  const enabled = await getSetting('ai.enable_image', true);
  if (!enabled) {
    return res.status(503).json({ error: 'Image generation is currently disabled' });
  }

  // Check daily quota
  const maxPerDay = await getSetting('ai.image.max_per_day_free', 5);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  try {
    const usageRes = await query(
      'SELECT count FROM image_usage WHERE day = $1 AND actor = $2',
      [today, actor]
    );
    const used = usageRes.rows.length > 0 ? usageRes.rows[0].count : 0;

    if (used >= maxPerDay) {
      return res.status(429).json({
        error: 'Daily image quota exceeded',
        limit: maxPerDay,
        used,
        resets_at: `${today}T23:59:59Z`,
      });
    }
  } catch (err) {
    console.error('[image] Quota check failed:', err.message);
    // Continue anyway — don't block on quota DB errors
  }

  // Validate input
  const { prompt, negative_prompt, width, height, steps, cfg, seed } = req.body || {};

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
    return res.status(400).json({ error: 'prompt is required (min 3 characters)' });
  }
  if (prompt.length > 1000) {
    return res.status(400).json({ error: 'prompt too long (max 1000 characters)' });
  }

  const params = {
    prompt: prompt.trim(),
    negative_prompt: negative_prompt || undefined,
    width:  Math.min(Math.max(width  || 1024, 256), 1024),
    height: Math.min(Math.max(height || 1024, 256), 1024),
    steps:  Math.min(Math.max(steps  || 25, 1), 40),
    cfg:    Math.min(Math.max(cfg    || 7.0, 1), 20),
    seed:   seed || undefined,
  };

  // Create image record
  let imageId;
  try {
    const insRes = await query(
      `INSERT INTO images (actor, prompt, params, status)
       VALUES ($1, $2, $3, 'processing')
       RETURNING id`,
      [actor, params.prompt, JSON.stringify(params)]
    );
    imageId = insRes.rows[0].id;
  } catch (err) {
    console.error('[image] DB insert failed:', err.message);
    return res.status(500).json({ error: 'Failed to create image job' });
  }

  // Check ComfyUI health
  const healthy = await comfyui.isHealthy();
  if (!healthy) {
    await query(`UPDATE images SET status = 'error', error_msg = 'ComfyUI offline' WHERE id = $1`, [imageId]);
    return res.status(503).json({ error: 'Image generation service is offline' });
  }

  // Generate image
  try {
    const result = await comfyui.generateImage(params, IMAGE_DIR);

    // Update image record
    await query(
      `UPDATE images SET file_path = $1, seed = $2, status = 'done' WHERE id = $3`,
      [result.file_name, result.seed, imageId]
    );

    // Increment daily usage
    await query(
      `INSERT INTO image_usage (day, actor, count) VALUES ($1, $2, 1)
       ON CONFLICT (day, actor) DO UPDATE SET count = image_usage.count + 1`,
      [today, actor]
    );

    res.json({
      id: imageId,
      image_url: `/v1/image/${imageId}`,
      seed: result.seed,
      timings: result.timings,
    });

  } catch (err) {
    console.error('[image] Generation failed:', err.message);
    await query(
      `UPDATE images SET status = 'error', error_msg = $1 WHERE id = $2`,
      [err.message.slice(0, 500), imageId]
    ).catch(() => {});

    res.status(500).json({ error: 'Image generation failed', detail: err.message });
  }
});

/**
 * GET /v1/image/quota — Daily remaining
 */
router.get('/image/quota', async (req, res) => {
  const actor = getActor(req);
  const maxPerDay = await getSetting('ai.image.max_per_day_free', 5);
  const today = new Date().toISOString().slice(0, 10);

  try {
    const usageRes = await query(
      'SELECT count FROM image_usage WHERE day = $1 AND actor = $2',
      [today, actor]
    );
    const used = usageRes.rows.length > 0 ? usageRes.rows[0].count : 0;

    res.json({
      limit: maxPerDay,
      used,
      remaining: Math.max(0, maxPerDay - used),
      resets_at: `${today}T23:59:59Z`,
    });
  } catch (err) {
    res.json({ limit: maxPerDay, used: 0, remaining: maxPerDay });
  }
});

/**
 * GET /v1/image/:id — Serve generated image
 */
router.get('/image/:id', async (req, res) => {
  const { id } = req.params;

  // Validate UUID format
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid image ID' });
  }

  try {
    const result = await query(
      'SELECT file_path, status, error_msg FROM images WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Image not found' });
    }

    const img = result.rows[0];

    if (img.status === 'processing') {
      return res.status(202).json({ status: 'processing', message: 'Image is still being generated' });
    }

    if (img.status === 'error') {
      return res.status(500).json({ status: 'error', message: img.error_msg || 'Generation failed' });
    }

    if (!img.file_path) {
      return res.status(404).json({ error: 'Image file not available' });
    }

    // Safe path join — prevent directory traversal
    const safeName = path.basename(img.file_path);
    const filePath = path.join(IMAGE_DIR, safeName);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Image file not found on disk' });
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(filePath).pipe(res);

  } catch (err) {
    console.error('[image] Serve error:', err.message);
    res.status(500).json({ error: 'Failed to serve image' });
  }
});

module.exports = router;
