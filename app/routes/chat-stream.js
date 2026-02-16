/**
 * POST /v1/chat — SSE streaming text generation via Ollama
 * GET  /v1/chat/models — list available text models
 *
 * Environment-aware: uses req.env from resolveEnvironment middleware.
 * Rate limits and logging are per-environment.
 */
const { Router } = require('express');
const { getSetting }    = require('../lib/settings');
const { queryFor }      = require('../lib/db');
const { checkRateLimit, getActor } = require('../lib/rate-limit');

const router = Router();

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'ollama';
const OLLAMA_PORT = process.env.OLLAMA_PORT || '11434';
const OLLAMA_URL  = `http://${OLLAMA_HOST}:${OLLAMA_PORT}`;

const MAX_INPUT_LENGTH = 4000; // characters
const RATE_LIMIT_RPM   = 15;  // requests per minute

/**
 * POST /v1/chat — Server-Sent Events streaming
 *
 * Body: { message, model?, temperature?, max_tokens? }
 *
 * SSE events:
 *   event: token    data: {"delta":"..."}
 *   event: done     data: {"model":"...","usage":{...}}
 *   event: error    data: {"message":"..."}
 */
router.post('/chat', async (req, res) => {
  const actor = getActor(req);
  const env   = req.env || 'prod';

  // Per-environment rate limiting
  const rpmKey = `rate_limit.chat.${env}`;
  const rateMax = await getSetting(rpmKey, env === 'dev' ? 60 : RATE_LIMIT_RPM);
  const rl = checkRateLimit(`${env}:${actor}`, 'chat', rateMax, 60_000);
  if (!rl.allowed) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      retry_after: rl.retryAfter,
    });
  }

  const { message, model, temperature, max_tokens } = req.body || {};

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required (string)' });
  }
  if (message.length > MAX_INPUT_LENGTH) {
    return res.status(400).json({ error: `message too long (max ${MAX_INPUT_LENGTH} chars)` });
  }

  // Resolve model
  let selectedModel = model;
  if (!selectedModel) {
    selectedModel = await getSetting('ai.default_text_model', 'llama3.1:8b');
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx/caddy buffering
  });

  // Handle client disconnect
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  try {
    const ollamaRes = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: selectedModel,
        messages: [
          {
            role: 'system',
            content: 'You are Getouch AI, a helpful assistant. Be concise and clear. You run on-premises for privacy.',
          },
          { role: 'user', content: message },
        ],
        stream: true,
        options: {
          temperature: temperature ?? 0.7,
          num_predict: max_tokens || 1024,
        },
      }),
      signal: ac.signal,
    });

    if (!ollamaRes.ok) {
      const errText = await ollamaRes.text();
      res.write(`event: error\ndata: ${JSON.stringify({ message: `Ollama error: ${ollamaRes.status}` })}\n\n`);
      res.end();
      return;
    }

    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let finalModel = selectedModel;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Ollama streams NDJSON — one JSON object per line
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);

          if (chunk.message && chunk.message.content) {
            // Stream token
            res.write(`event: token\ndata: ${JSON.stringify({ delta: chunk.message.content })}\n\n`);
          }

          if (chunk.done) {
            // Final chunk with usage stats
            totalTokensIn  = chunk.prompt_eval_count || 0;
            totalTokensOut = chunk.eval_count || 0;
            finalModel     = chunk.model || selectedModel;
          }
        } catch (parseErr) {
          // Skip malformed lines
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const chunk = JSON.parse(buffer);
        if (chunk.message && chunk.message.content) {
          res.write(`event: token\ndata: ${JSON.stringify({ delta: chunk.message.content })}\n\n`);
        }
        if (chunk.done) {
          totalTokensIn  = chunk.prompt_eval_count || 0;
          totalTokensOut = chunk.eval_count || 0;
          finalModel     = chunk.model || selectedModel;
        }
      } catch {}
    }

    // Send done event with environment tag
    res.write(`event: done\ndata: ${JSON.stringify({
      model: finalModel,
      environment: env,
      usage: { prompt_tokens: totalTokensIn, completion_tokens: totalTokensOut },
    })}\n\n`);

    // Log chat to environment-specific DB (fire-and-forget)
    queryFor(env,
      `INSERT INTO chat_messages (actor, role, content, model, tokens_in, tokens_out, environment)
       VALUES ($1, 'user', $2, $3, $4, $5, $6)`,
      [actor, message, finalModel, totalTokensIn, totalTokensOut, env]
    ).catch(() => {});

  } catch (err) {
    if (err.name === 'AbortError') {
      // Client disconnected — normal
      return;
    }
    console.error('[chat] Streaming error:', err.message);
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'Internal AI error. The model may be loading.' })}\n\n`);
    } catch {}
  } finally {
    try { res.end(); } catch {}
  }
});

/**
 * GET /v1/chat/models — list available text models
 */
router.get('/chat/models', async (_req, res) => {
  try {
    const defaultModel = await getSetting('ai.default_text_model', 'llama3.1:8b');
    const models = [
      { id: 'llama3.1:8b',              name: 'Llama 3.1 8B',       label: 'Fast',  default: defaultModel === 'llama3.1:8b' },
      { id: 'qwen2.5:14b-instruct',     name: 'Qwen 2.5 14B',      label: 'Smart', default: defaultModel === 'qwen2.5:14b-instruct' },
    ];
    res.json({ models, default_model: defaultModel });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load models' });
  }
});

module.exports = router;
