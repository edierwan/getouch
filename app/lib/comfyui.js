/**
 * ComfyUI client — sends workflow prompts and retrieves generated images.
 * ComfyUI is internal-only; this module is the sole gateway.
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const COMFYUI_HOST = process.env.COMFYUI_HOST || 'comfyui';
const COMFYUI_PORT = process.env.COMFYUI_PORT || '8188';
const COMFYUI_URL  = `http://${COMFYUI_HOST}:${COMFYUI_PORT}`;

// Path to the SDXL workflow template
const WORKFLOW_PATH = path.join(__dirname, '..', 'workflows', 'sdxl_basic.json');

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
 * Build SDXL workflow from template with user parameters
 */
function buildWorkflow(params) {
  const template = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));

  // The template has placeholder nodes — patch them
  const prompt     = params.prompt || 'a beautiful landscape';
  const negative   = params.negative_prompt || 'blurry, low quality, watermark, text';
  const width      = Math.min(params.width  || 1024, 1024);
  const height     = Math.min(params.height || 1024, 1024);
  const steps      = Math.min(params.steps  || 25, 40);
  const cfg        = params.cfg || 7.0;
  const seed       = params.seed || Math.floor(Math.random() * 2 ** 32);

  // Patch the workflow nodes
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

  return { workflow: template, seed, width, height, steps, cfg };
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

module.exports = { isHealthy, generateImage, buildWorkflow };
