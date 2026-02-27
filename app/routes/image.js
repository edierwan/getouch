/**
 * POST /v1/image/generate — Image generation via ComfyUI (SDXL / FLUX)
 * GET  /v1/image/quota    — Remaining daily quota
 * GET  /v1/image/:id      — Serve generated image
 *
 * Environment-aware: quota and metadata tagged per environment.
 */
const { Router }  = require('express');
const path        = require('path');
const fs          = require('fs');
const crypto      = require('crypto');
const { query, queryFor } = require('../lib/db');
const { getSetting }    = require('../lib/settings');
const { checkRateLimit, getActor } = require('../lib/rate-limit');
const { logUsageEvent, getGuestImageCountToday, getVisitorTotals } = require('../lib/usage');
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
  const env   = req.env || 'prod';

  // Per-environment rate limiting
  const rateKey = `rate_limit.image.${env}`;
  const rateMax = await getSetting(rateKey, env === 'dev' ? 20 : 5);
  const rl = checkRateLimit(`${env}:${actor}`, 'image', rateMax, 60_000);
  if (!rl.allowed) {
    return res.status(429).json({ error: 'Rate limit exceeded', retry_after: rl.retryAfter });
  }

  // Check if image generation is enabled
  const enabled = await getSetting('ai.enable_image', true);
  if (!enabled) {
    return res.status(503).json({ error: 'Image generation is currently disabled' });
  }

  // Guest daily image limit (unauthenticated users only)
  const isGuest = !(req.session && req.session.userId);
  if (isGuest && req.visitorId) {
    const guestImgMax = await getSetting('guest.images_per_day', 3);
    const guestImgUsed = await getGuestImageCountToday(req.visitorId);
    if (guestImgUsed >= guestImgMax) {
      return res.status(429).json({
        error: 'Guest image limit reached',
        action: 'register',
        limit: guestImgMax,
        used: guestImgUsed,
      });
    }
  }

  // Check daily quota (per environment)
  const quotaKey = `ai.image.max_per_day_free.${env}`;
  const maxPerDay = await getSetting(quotaKey, await getSetting('ai.image.max_per_day_free', 5));
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  try {
    const usageRes = await queryFor(env,
      'SELECT count FROM image_usage WHERE day = $1 AND actor = $2 AND environment = $3',
      [today, actor, env]
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
  const { prompt, negative_prompt, width, height, steps, cfg, seed,
          source_image, source_image_mime, source_filename, denoise,
          mode } = req.body || {};

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
    return res.status(400).json({ error: 'prompt is required (min 3 characters)' });
  }
  if (prompt.length > 1000) {
    return res.status(400).json({ error: 'prompt too long (max 1000 characters)' });
  }

  // Check if this is img2img (source image provided)
  const hasSourceImage = source_image && typeof source_image === 'string' && source_image.length > 0;
  let sourceImageBuffer = null;
  if (hasSourceImage) {
    sourceImageBuffer = Buffer.from(source_image, 'base64');
    const sourceSizeMB = sourceImageBuffer.length / (1024 * 1024);
    if (sourceSizeMB > 10) {
      return res.status(400).json({ error: 'Source image too large (max 10 MB)' });
    }
  }

  // Detect restore mode: 'restore' = upscaler-only, 'enhance' = upscaler + light diffusion, 'edit' = img2img
  // Default: if source image provided with no explicit mode, use 'restore'
  const imageMode = hasSourceImage ? (mode || 'restore') : 'generate';

  const params = {
    prompt: prompt.trim(),
    negative_prompt: negative_prompt || undefined,
    width:  Math.min(Math.max(width  || 1024, 256), 1024),
    height: Math.min(Math.max(height || 1024, 256), 1024),
    steps:  Math.min(Math.max(steps  || 25, 1), 40),
    cfg:    Math.min(Math.max(cfg    || 7.0, 1), 20),
    seed:   seed || undefined,
    engine: await getSetting('ai.default_image_engine', 'sdxl'),
  };

  // Create image record (in environment-specific DB)
  let imageId;
  try {
    const insRes = await queryFor(env,
      `INSERT INTO images (actor, prompt, params, status, environment)
       VALUES ($1, $2, $3, 'processing', $4)
       RETURNING id`,
      [actor, params.prompt, JSON.stringify(params), env]
    );
    imageId = insRes.rows[0].id;
  } catch (err) {
    console.error('[image] DB insert failed:', err.message);
    return res.status(500).json({ error: 'Failed to create image job' });
  }

  // Check ComfyUI health
  const healthy = await comfyui.isHealthy();
  if (!healthy) {
    await queryFor(env, `UPDATE images SET status = 'error', error_msg = 'ComfyUI offline' WHERE id = $1`, [imageId]);
    return res.status(503).json({ error: 'Image generation service is offline' });
  }

  // Generate image
  try {
    let result;

    if (sourceImageBuffer && (imageMode === 'restore' || imageMode === 'enhance')) {
      // RESTORE mode: neural upscaler, NO diffusion hallucination
      //   'restore'  → pure upscale (4x-UltraSharp) → scale back
      //   'enhance'  → upscale + very light KSampler (denoise ≤ 0.20)
      console.log(`[image:${env}] Restore mode=${imageMode} for ${source_filename || 'source'}`);
      result = await comfyui.generateRestore({
        source_image: sourceImageBuffer,
        source_filename: source_filename || 'source.png',
        restore_mode: imageMode === 'enhance' ? 'enhanced' : 'upscale',
        upscale_model: '4x-UltraSharp.pth',
        prompt: params.prompt,
        denoise: Math.min(denoise || 0.10, 0.20),
        seed: params.seed,
      }, IMAGE_DIR);
    } else if (sourceImageBuffer && imageMode === 'edit') {
      // EDIT mode: img2img with moderate denoise for creative edits
      console.log(`[image:${env}] Edit (img2img) mode for ${source_filename || 'source'}`);
      result = await comfyui.generateImg2Img({
        ...params,
        source_image: sourceImageBuffer,
        source_filename: source_filename || 'source.png',
        denoise: denoise || 0.25,
      }, IMAGE_DIR);
    } else {
      // txt2img: generate from prompt only
      result = await comfyui.generateImage(params, IMAGE_DIR);
    }

    // Update image record
    await queryFor(env,
      `UPDATE images SET file_path = $1, seed = $2, status = 'done' WHERE id = $3`,
      [result.file_name, result.seed, imageId]
    );

    // Increment daily usage (per environment)
    await queryFor(env,
      `INSERT INTO image_usage (day, actor, count, environment) VALUES ($1, $2, 1, $3)
       ON CONFLICT (day, actor, environment) DO UPDATE SET count = image_usage.count + 1`,
      [today, actor, env]
    );

    res.json({
      id: imageId,
      image_url: `/v1/image/${imageId}`,
      seed: result.seed,
      environment: env,
      timings: result.timings,
    });

    // Log usage event for reporting
    logUsageEvent({
      visitorId: req.visitorId || actor,
      userId: req.session && req.session.userId ? req.session.userId : null,
      eventType: 'image',
      mode: params.engine || 'sdxl',
      model: params.engine || 'sdxl',
      status: 'ok',
      latencyMs: result.timings ? Math.round((result.timings.total || 0) * 1000) : null,
      inputLen: prompt.length,
      environment: env,
    });

  } catch (err) {
    console.error(`[image:${env}] Generation failed:`, err.message);
    await queryFor(env,
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
  const env   = req.env || 'prod';
  const quotaKey = `ai.image.max_per_day_free.${env}`;
  const maxPerDay = await getSetting(quotaKey, await getSetting('ai.image.max_per_day_free', 5));
  const today = new Date().toISOString().slice(0, 10);

  try {
    const usageRes = await queryFor(env,
      'SELECT count FROM image_usage WHERE day = $1 AND actor = $2 AND environment = $3',
      [today, actor, env]
    );
    const used = usageRes.rows.length > 0 ? usageRes.rows[0].count : 0;

    res.json({
      environment: env,
      limit: maxPerDay,
      used,
      remaining: Math.max(0, maxPerDay - used),
      resets_at: `${today}T23:59:59Z`,
    });
  } catch (err) {
    res.json({ environment: env, limit: maxPerDay, used: 0, remaining: maxPerDay });
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
    // Query both pools — the image may be in either environment
    const env = req.env || 'prod';
    const result = await queryFor(env,
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

/**
 * GET /v1/image/health — ComfyUI health check
 */
router.get('/image/health', async (_req, res) => {
  const healthy = await comfyui.isHealthy();
  res.json({
    service: 'comfyui',
    status: healthy ? 'ok' : 'offline',
    endpoint: `http://${process.env.COMFYUI_HOST || 'comfyui'}:${process.env.COMFYUI_PORT || '8188'}`,
  });
});

module.exports = router;
