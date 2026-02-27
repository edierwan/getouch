/**
 * ComfyUI client — sends workflow prompts and retrieves generated images.
 * ComfyUI is internal-only; this module is the sole gateway.
 *
 * Supports multiple engines: sdxl, flux
 * Supports img2img via source image upload
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const COMFYUI_HOST = process.env.COMFYUI_HOST || 'comfyui';
const COMFYUI_PORT = process.env.COMFYUI_PORT || '8188';
const COMFYUI_URL  = `http://${COMFYUI_HOST}:${COMFYUI_PORT}`;

// Workflow templates per engine
const WORKFLOWS = {
  sdxl:       path.join(__dirname, '..', 'workflows', 'sdxl_basic.json'),
  flux:       path.join(__dirname, '..', 'workflows', 'flux_basic.json'),
  sdxl_i2i:   path.join(__dirname, '..', 'workflows', 'sdxl_img2img.json'),
};

/**
 * Check if ComfyUI is healthy
 */
async function isHealthy() {
  try {
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), 3000);
    const r  = await fetch(`${COMFYUI_URL}/system_stats`, { signal: ac.signal });
    clearTimeout(tm);
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Build workflow from template with user parameters.
 * Supports engines: 'sdxl' (default), 'flux'
 */
function buildWorkflow(params) {
  const engine = params.engine || 'sdxl';
  const isImg2Img = !!params.source_image_name;

  // Select workflow: img2img for source image, otherwise txt2img
  let workflowKey;
  if (isImg2Img) {
    workflowKey = engine === 'flux' ? 'sdxl_i2i' : `${engine}_i2i`;
  } else {
    workflowKey = engine;
  }
  const workflowPath = WORKFLOWS[workflowKey] || WORKFLOWS[engine] || WORKFLOWS.sdxl;

  if (!fs.existsSync(workflowPath)) {
    throw new Error(`Workflow template not found for engine: ${engine}${isImg2Img ? ' (img2img)' : ''}`);
  }

  const template = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));

  const prompt     = params.prompt || 'a beautiful landscape';
  const negative   = params.negative_prompt || 'blurry, low quality, watermark, text';
  const width      = Math.min(params.width  || 1024, 1024);
  const height     = Math.min(params.height || 1024, 1024);
  const steps      = Math.min(params.steps  || (engine === 'flux' ? 20 : 25), 40);
  const cfg        = params.cfg || (engine === 'flux' ? 1.0 : 7.0);
  const seed       = params.seed || Math.floor(Math.random() * 2 ** 32);
  const denoise    = params.denoise || (isImg2Img ? 0.45 : 1.0);

  if (isImg2Img) {
    // img2img workflow — set source image, prompt, and denoise
    if (template['10']) {
      template['10'].inputs.image = params.source_image_name;
    }
    if (template['6']) {
      template['6'].inputs.text = prompt;
    }
    if (template['7']) {
      template['7'].inputs.text = negative;
    }
    if (template['3']) {
      template['3'].inputs.seed = seed;
      template['3'].inputs.steps = steps;
      template['3'].inputs.cfg = cfg;
      template['3'].inputs.denoise = denoise;
    }
  } else if (engine === 'flux') {
    // FLUX workflow node patching
    // Node "6" = CLIPTextEncode (prompt)
    if (template['6']) {
      template['6'].inputs.text = prompt;
    }
    // Node "25" = RandomNoise (seed)
    if (template['25']) {
      template['25'].inputs.noise_seed = seed;
    }
    // Node "5" = EmptySD3LatentImage (dimensions)
    if (template['5']) {
      template['5'].inputs.width = width;
      template['5'].inputs.height = height;
      template['5'].inputs.batch_size = 1;
    }
    // Node "17" = BasicScheduler (steps)
    if (template['17']) {
      template['17'].inputs.steps = steps;
    }
    // Node "26" = FluxGuidance (cfg)
    if (template['26']) {
      template['26'].inputs.guidance = cfg;
    }
  } else {
    // SDXL workflow node patching (original)
    // Node "3" = KSampler
    if (template['3']) {
      template['3'].inputs.seed = seed;
      template['3'].inputs.steps = steps;
      template['3'].inputs.cfg = cfg;
    }
    // Node "6" = CLIP Text Encode (positive)
    if (template['6']) {
      template['6'].inputs.text = prompt;
    }
    // Node "7" = CLIP Text Encode (negative)
    if (template['7']) {
      template['7'].inputs.text = negative;
    }
    // Node "5" = Empty Latent Image
    if (template['5']) {
      template['5'].inputs.width = width;
      template['5'].inputs.height = height;
      template['5'].inputs.batch_size = 1;
    }
  }

  return { workflow: template, seed, width, height, steps, cfg, engine };
}

/**
 * Queue a prompt on ComfyUI and wait for the result
 * Returns { image_path, seed, timings }
 */
async function generateImage(params, outputDir) {
  const { workflow, seed, width, height, steps, cfg } = buildWorkflow(params);

  const clientId = crypto.randomUUID();

  // Queue the prompt
  const queueRes = await fetch(`${COMFYUI_URL}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: workflow,
      client_id: clientId,
    }),
  });

  if (!queueRes.ok) {
    const err = await queueRes.text();
    throw new Error(`ComfyUI queue failed: ${err}`);
  }

  const { prompt_id } = await queueRes.json();
  const startTime = Date.now();

  // Poll for completion (max 120s)
  let imageInfo = null;
  for (let i = 0; i < 240; i++) {
    await new Promise(r => setTimeout(r, 500));

    const histRes = await fetch(`${COMFYUI_URL}/history/${prompt_id}`);
    if (!histRes.ok) continue;

    const hist = await histRes.json();
    if (!hist[prompt_id]) continue;

    const outputs = hist[prompt_id].outputs;
    if (!outputs) continue;

    // Find image output (usually node "9" = SaveImage)
    for (const nodeId of Object.keys(outputs)) {
      const nodeOut = outputs[nodeId];
      if (nodeOut.images && nodeOut.images.length > 0) {
        imageInfo = nodeOut.images[0];
        break;
      }
    }
    if (imageInfo) break;
  }

  if (!imageInfo) {
    throw new Error('Image generation timed out (120s)');
  }

  const genTime = Date.now() - startTime;

  // Download the image from ComfyUI
  const imgUrl = `${COMFYUI_URL}/view?filename=${encodeURIComponent(imageInfo.filename)}&subfolder=${encodeURIComponent(imageInfo.subfolder || '')}&type=${imageInfo.type || 'output'}`;
  const imgRes = await fetch(imgUrl);
  if (!imgRes.ok) throw new Error('Failed to download image from ComfyUI');

  // Save to our output directory
  const ext = path.extname(imageInfo.filename) || '.png';
  const outName = `${crypto.randomUUID()}${ext}`;
  const outPath = path.join(outputDir, outName);

  fs.mkdirSync(outputDir, { recursive: true });
  const buffer = Buffer.from(await imgRes.arrayBuffer());
  fs.writeFileSync(outPath, buffer);

  return {
    file_path: outPath,
    file_name: outName,
    seed,
    timings: {
      generation_ms: genTime,
      steps,
      cfg,
      width,
      height,
    },
  };
}

/**
 * Upload an image to ComfyUI's input folder via /upload/image API.
 * Returns the filename as stored by ComfyUI (used in LoadImage node).
 *
 * @param {Buffer} imageBuffer - raw image bytes
 * @param {string} [filename]  - original filename hint
 * @returns {Promise<string>}  - the ComfyUI-side filename
 */
async function uploadImage(imageBuffer, filename = 'input.png') {
  // ComfyUI /upload/image expects multipart/form-data with field "image"
  const boundary = '----ComfyBoundary' + crypto.randomUUID().replace(/-/g, '');
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');

  // Detect content type
  let contentType = 'image/png';
  if (/\.jpe?g$/i.test(safeName)) contentType = 'image/jpeg';
  else if (/\.webp$/i.test(safeName)) contentType = 'image/webp';

  // Build multipart body manually (no external dependency)
  const parts = [];
  parts.push(`--${boundary}\r\n`);
  parts.push(`Content-Disposition: form-data; name="image"; filename="${safeName}"\r\n`);
  parts.push(`Content-Type: ${contentType}\r\n\r\n`);
  const header = Buffer.from(parts.join(''), 'utf8');
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([header, imageBuffer, footer]);

  const res = await fetch(`${COMFYUI_URL}/upload/image`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length.toString(),
    },
    body,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`ComfyUI image upload failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  // ComfyUI returns { name, subfolder, type }
  return data.name || safeName;
}

/**
 * Generate an image using img2img (source image + prompt).
 * Uploads source image, runs img2img workflow, downloads result.
 *
 * @param {object} params - { prompt, negative_prompt, source_image (Buffer), source_filename, denoise, engine, steps, cfg, seed }
 * @param {string} outputDir
 * @returns {Promise<object>}
 */
async function generateImg2Img(params, outputDir) {
  // Step 1: Upload source image to ComfyUI
  const uploadedName = await uploadImage(params.source_image, params.source_filename || 'source.png');
  console.log(`[comfyui] Uploaded source image as: ${uploadedName}`);

  // Step 2: Build img2img workflow
  const img2imgParams = {
    ...params,
    source_image_name: uploadedName,
    denoise: params.denoise || 0.45,
  };

  // Step 3: Run standard generation with the img2img workflow
  return generateImage(img2imgParams, outputDir);
}

module.exports = { isHealthy, generateImage, generateImg2Img, uploadImage, buildWorkflow };
