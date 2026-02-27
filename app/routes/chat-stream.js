/**
 * POST /v1/chat — SSE streaming text generation via Ollama
 * GET  /v1/chat/models — list available text models
 *
 * Production Pipeline v2: Input Normalizer → Language/Dialect Detection →
 *   Intent Classification → Router → Personality/Stabilizer → Model Selection → Stream
 *
 * Environment-aware: uses req.env from resolveEnvironment middleware.
 * Rate limits and logging are per-environment.
 *
 * Supports:
 *   - Text-only chat (SMALLTALK / TASK / QUESTION / GENERAL_CHAT)
 *   - Image + text (vision)
 *   - Document upload (PDF, DOCX, TXT, PPTX, XLS/XLSX, CSV) with auto-summarize
 *   - Web research (auto-detect or forced)
 *   - Dialect mirroring with SMALLTALK_STABILIZER
 *   - Attachment-only send (empty message → auto-prompt)
 */
const { Router } = require('express');
const crypto = require('crypto');
const { getSetting }    = require('../lib/settings');
const { queryFor, query: dbQuery } = require('../lib/db');
const { checkRateLimit, getActor } = require('../lib/rate-limit');
const { logUsageEvent, getGuestChatCount, getVisitorTotals } = require('../lib/usage');
const {
  ingestAttachment, IngestionError, MIME_IMAGE, cleanupFiles,
  getDefaultPrompt, getSystemPromptForDoc, getUserPromptWithQuestion,
} = require('../lib/document-ingestion');
const { performWebResearch } = require('../lib/web-research');
const { routeMessage, ROUTE } = require('../lib/router');
const { sanitizeOutput } = require('../lib/input-normalizer');
const {
  addUserTurn, addAssistantTurn,
  getRouterContext, getHistoryMessages, isDocFollowUp,
  applyExplicitRequest, setPreference,
} = require('../lib/conversation-context');
const { applyDialectPostProcess } = require('../lib/dialect');

const router = Router();

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'ollama';
const OLLAMA_PORT = process.env.OLLAMA_PORT || '11434';
const OLLAMA_URL  = `http://${OLLAMA_HOST}:${OLLAMA_PORT}`;

const MAX_INPUT_LENGTH = 8000; // characters (increased for doc questions)
const RATE_LIMIT_RPM   = 15;
const GLOBAL_TIMEOUT   = 120_000; // 2 minutes max per request

/**
 * POST /v1/chat — Server-Sent Events streaming
 */
router.post('/chat', async (req, res) => {
  const requestId = crypto.randomUUID();
  const requestStart = Date.now();
  const actor = getActor(req);
  const env   = req.env || 'prod';
  const isGuest = !(req.session && req.session.userId);

  // ── Rate limiting ──
  const rpmKey = `rate_limit.chat.${env}`;
  const rateMax = await getSetting(rpmKey, env === 'dev' ? 60 : RATE_LIMIT_RPM);
  const rl = checkRateLimit(`${env}:${actor}`, 'chat', rateMax, 60_000);
  if (!rl.allowed) {
    return res.status(429).json({ error: 'Rate limit exceeded', retry_after: rl.retryAfter });
  }

  // ── Guest limits ──
  if (isGuest && req.visitorId) {
    const [guestHourlyMax, guestDailyMax] = await Promise.all([
      getSetting('guest.chat_per_hour', 20),
      getSetting('guest.chat_per_day', 50),
    ]);
    const [hourlyUsed, dailyUsed] = await Promise.all([
      getGuestChatCount(req.visitorId, 3600000),
      getGuestChatCount(req.visitorId, 86400000),
    ]);
    if (hourlyUsed >= guestHourlyMax || dailyUsed >= guestDailyMax) {
      return res.status(429).json({
        error: 'Guest chat limit reached',
        action: 'register',
        limit: Math.min(Number(guestHourlyMax), Number(guestDailyMax)),
        used: Math.max(hourlyUsed, dailyUsed),
      });
    }

    // 2nd visit push register
    const registerAfterN = await getSetting('guest.require_register_after_n', 5);
    const totals = await getVisitorTotals(req.visitorId);
    if (registerAfterN && totals.chats >= Number(registerAfterN)) {
      // Soft gate — still allow but suggest registration
      // (handled in done event below)
    }
  }

  const { message, model, temperature, max_tokens, image, image_mime,
          doc_base64, doc_name, doc_mime } = req.body || {};

  const hasImage = image && typeof image === 'string' && image.length > 0;
  const hasDoc   = doc_base64 && typeof doc_base64 === 'string' && doc_base64.length > 0;
  const hasText  = message && typeof message === 'string' && message.trim().length > 0;

  if (!hasText && !hasImage && !hasDoc) {
    return res.status(400).json({ error: 'message or attachment is required' });
  }
  if (hasText && message.length > MAX_INPUT_LENGTH) {
    return res.status(400).json({ error: `message too long (max ${MAX_INPUT_LENGTH} chars)` });
  }

  // ── Image validation ──
  if (hasImage && !hasDoc) {
    const approxBytes = image.length * 0.75;
    if (approxBytes > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image too large (max 10MB)' });
    }
    if (image_mime && !['image/png', 'image/jpeg', 'image/webp'].includes(image_mime)) {
      return res.status(400).json({ error: 'Unsupported image type. Use PNG, JPEG, or WebP.' });
    }
  }

  /* ── Document ingestion with timeout ───────────────────── */
  let doc = null;
  let tempFiles = [];

  if (hasDoc) {
    // Guest doc limit
    if (isGuest && req.visitorId) {
      const docDailyMax = await getSetting('guest.doc_per_day', 5);
      const docUsedToday = await getGuestDocCount(req.visitorId);
      if (docUsedToday >= Number(docDailyMax)) {
        return res.status(429).json({ error: 'Guest document limit reached. Please register for more.', action: 'register' });
      }
    }

    try {
      const buf = Buffer.from(doc_base64, 'base64');

      // File size limit from settings
      const maxMb = await getSetting('limits.max_file_size_mb', 20);
      const sizeMB = buf.length / (1024 * 1024);
      if (sizeMB > Number(maxMb)) {
        return res.status(400).json({ error: `File too large (${sizeMB.toFixed(1)} MB). Maximum is ${maxMb} MB.` });
      }

      doc = await ingestAttachment(buf, doc_name || 'document', doc_mime || 'application/octet-stream');
      if (doc.pages) tempFiles = doc.pages.map(p => p.imagePath).filter(Boolean);
    } catch (err) {
      if (err instanceof IngestionError) {
        return res.status(400).json({ error: err.message });
      }
      console.error('[chat] Document ingestion error:', err);
      return res.status(500).json({ error: 'Failed to process document.' });
    }
  }

  /* ── Central Router (enhanced pipeline) ────────────────── */
  // Build conversation context for the router
  const ctxKey = req.session?.userId ? `user:${req.session.userId}` : (req.visitorId || actor);
  const convContext = getRouterContext(ctxKey);
  const docFollowUp = isDocFollowUp(ctxKey);

  const decision = await routeMessage(message, { hasImage, hasDoc, doc }, { convContext, docFollowUp });
  const routeType = decision.routeType;

  // ── Apply explicit dialect/language requests to session preferences ──
  if (decision.explicitRequest && decision.explicitRequest.requested) {
    applyExplicitRequest(ctxKey, decision.explicitRequest);
  }

  /* ── Model selection ───────────────────────────────────── */
  let selectedModel = model;
  const needsVision = hasImage || (doc && (doc.kind === 'pages' || doc.kind === 'image'));

  if (!selectedModel) {
    if (needsVision) {
      selectedModel = await getSetting('ai.default_vision_model', 'qwen2.5vl:32b');
    } else {
      selectedModel = await getSetting('ai.default_text_model', 'llama3.1:8b');
    }
  }

  /* ── Build messages based on route ─────────────────────── */
  let systemContent, userContent, userImages;
  let webResearchResult = null;

  if (doc) {
    // ── Document analysis path ──
    const lang = doc.detectedLanguage || 'unknown';
    const effLang = lang === 'unknown' ? 'ms' : lang;
    const fileName = doc.meta.fileName;

    const docSystemBase = getSystemPromptForDoc(effLang, fileName, doc.kind);
    const personalityHint = decision.lang.dialect === 'UTARA'
      ? '\nThe user speaks Northern Malay dialect. Mirror it lightly (max 1-2 words) in your response.'
      : (decision.lang.language === 'ms'
        ? '\nThe user speaks Malay. Reply in Bahasa Melayu.'
        : '');
    // Add structured summarizer template
    const summarizerTemplate = effLang === 'ms'
      ? '\nMulakan jawapan dengan: "Saya telah semak dokumen yang dimuat naik: [nama fail]"\nGunakan nombor berseksyen (1️⃣, 2️⃣) dan bullet points. Highlight angka penting (RM, tarikh, nama).'
      : '\nStart with: "I reviewed the document you uploaded: [filename]"\nUse numbered sections (1️⃣, 2️⃣) and bullet points. Highlight important figures, dates, and names.';
    systemContent = docSystemBase + personalityHint + summarizerTemplate;

    if (doc.kind === 'text') {
      // Check if chunking needed (map-reduce for large docs)
      const docText = doc.text || '';
      const maxContextChars = 100000; // ~25k tokens

      if (docText.length > maxContextChars) {
        // Map-reduce: chunk and summarize
        const chunks = chunkText(docText, 30000);
        const summaryParts = [];
        for (let i = 0; i < chunks.length; i++) {
          summaryParts.push(`--- SECTION ${i + 1} of ${chunks.length} ---\n${chunks[i]}`);
        }
        const docTextBlock = summaryParts.join('\n\n');
        userContent = (hasText
          ? getUserPromptWithQuestion(message.trim(), effLang, fileName)
          : getDefaultPrompt(effLang, fileName, false)
        ) + '\n\n' + docTextBlock;
      } else {
        const docTextBlock = `--- DOCUMENT START ---\n${docText}\n--- DOCUMENT END ---`;
        userContent = (hasText
          ? getUserPromptWithQuestion(message.trim(), effLang, fileName)
          : getDefaultPrompt(effLang, fileName, false)
        ) + '\n\n' + docTextBlock;
      }
    } else if (doc.kind === 'pages') {
      userImages = doc.pages.map(p => p.imageBase64);
      const pageLabel = doc.pages.length > 1
        ? `These are pages 1–${doc.pages.length} in order. Keep references to page numbers.`
        : 'This is page 1 of the document.';
      userContent = (hasText
        ? getUserPromptWithQuestion(message.trim(), effLang, fileName)
        : getDefaultPrompt(effLang, fileName, true)
      ) + '\n\n' + pageLabel;
    } else if (doc.kind === 'image') {
      userImages = [doc.imageBase64];
      userContent = hasText ? message.trim() : 'Analyze this image in detail.';
    }
  } else if (hasImage) {
    systemContent = decision.systemPrompt || 'You are Getouch AI, a helpful vision assistant. Analyze the provided image and respond to the user query about it. Be concise and clear.';
    userContent = hasText ? message.trim() : 'Describe this image';
    userImages = [image];
  } else if (routeType === ROUTE.WEB_RESEARCH) {
    // ── Web research path ──
    systemContent = decision.systemPrompt || 'You are Getouch AI, a helpful assistant.';
    userContent = message.trim();

    try {
      res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`event: status\ndata: ${JSON.stringify({
        status: 'browsing',
        reason: decision.webDecision?.reason || 'auto',
        route: routeType,
      })}\n\n`);

      const researchStart = Date.now();
      webResearchResult = await performWebResearch(message);

      if (webResearchResult && webResearchResult.sources.length > 0) {
        // Build language/tone hint from router's dialect detection
        let webLangHint = '';
        if (decision.lang.language === 'ms') {
          webLangHint = '\nJawab dalam Bahasa Melayu.';
          if (decision.lang.formality === 'casual') {
            webLangHint += ' Guna gaya santai — jangan guna "Anda", guna "awak" atau ikut gaya pengguna.';
          }
          if (decision.lang.dialect === 'UTARA') {
            webLangHint += ' Pengguna guna loghat Utara — boleh selitkan 1-2 perkataan Utara (hang, ja, dak).';
          } else if (decision.lang.dialect === 'KELANTAN') {
            webLangHint += ' Pengguna guna loghat Kelantan — boleh selitkan 1-2 perkataan Klate (demo, gapo, ore).';
          }
        }
        systemContent = webResearchResult.systemPrompt + webLangHint;
        userContent = webResearchResult.contextBlock + '\n\nUSER QUESTION:\n' + message.trim();

        res.write(`event: status\ndata: ${JSON.stringify({
          status: 'researched',
          sources: webResearchResult.sources.length,
          cached: webResearchResult.fromCache,
          durationMs: webResearchResult.durationMs,
          route: routeType,
        })}\n\n`);

        logUsageEvent({
          visitorId: req.visitorId || actor,
          userId: req.session?.userId || null,
          eventType: 'web_research',
          mode: webResearchResult.provider,
          model: selectedModel,
          status: 'ok',
          latencyMs: webResearchResult.durationMs,
          inputLen: message.length,
          environment: env,
          meta: {
            requestId,
            query: message.slice(0, 200),
            provider: webResearchResult.provider,
            sourcesCount: webResearchResult.sources.length,
            fromCache: webResearchResult.fromCache,
            reason: decision.webDecision?.reason,
            route: routeType,
          },
        });
      } else {
        res.write(`event: status\ndata: ${JSON.stringify({ status: 'browse_fallback', reason: 'no_sources' })}\n\n`);
      }
    } catch (webErr) {
      console.error('[chat] Web research error:', webErr.message);
    }
  } else {
    // ── Text chat with personality-aware routing ──
    systemContent = decision.systemPrompt;
    userContent = (message || '').trim();
  }

  // ── SSE headers ──
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  }

  // Send route info
  if (routeType !== ROUTE.WEB_RESEARCH) {
    res.write(`event: status\ndata: ${JSON.stringify({
      status: 'routed',
      route: routeType,
      lang: decision.lang.language,
      dialect: decision.lang.dialect,
    })}\n\n`);
  }

  // Handle client disconnect + global timeout
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  const globalTimer = setTimeout(() => {
    ac.abort();
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'Request timed out.' })}\n\n`);
      res.end();
    } catch {}
  }, GLOBAL_TIMEOUT);

  try {
    const userMessage = { role: 'user', content: userContent };
    if (userImages && userImages.length > 0) {
      userMessage.images = userImages;
    }

    // Build conversation history for multi-turn context
    const historyMsgs = getHistoryMessages(ctxKey, 6);

    // Record user turn BEFORE streaming (so context is available for next request)
    addUserTurn(ctxKey, hasText ? message : '[attachment]', {
      route: routeType,
      lang: decision.lang.language,
      dialect: decision.lang.dialect,
      intent: decision.intent?.intent,
      docId: doc ? doc.meta?.fileName : null,
    });

    // Vision model fallback: if vision fails, try text OCR
    let ollamaRes;
    try {
      ollamaRes = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          messages: [
            { role: 'system', content: systemContent },
            ...historyMsgs,
            userMessage,
          ],
          stream: true,
          keep_alive: '30m',
          options: {
            temperature: temperature ?? (decision.decodingConfig?.temperature ?? 0.7),
            top_p:       decision.decodingConfig?.top_p ?? 0.9,
            num_predict: max_tokens || decision.numPredict || (webResearchResult ? 2048 : (doc ? 4096 : 1024)),
          },
        }),
        signal: ac.signal,
      });
    } catch (fetchErr) {
      if (fetchErr.name === 'AbortError') throw fetchErr;
      // Model might be loading — report and try fallback
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'AI model is loading. Please try again in a moment.' })}\n\n`);
      return;
    }

    if (!ollamaRes.ok) {
      const errText = await ollamaRes.text().catch(() => '');
      console.error(`[chat] Ollama ${ollamaRes.status}: ${errText.slice(0, 200)}`);

      // If vision model fails, try fallback to text model for docs
      if (needsVision && doc && doc.kind === 'pages') {
        res.write(`event: status\ndata: ${JSON.stringify({ status: 'vision_fallback', reason: 'model_error' })}\n\n`);
        // Could implement OCR text fallback here in the future
      }

      res.write(`event: error\ndata: ${JSON.stringify({ message: `AI error (${ollamaRes.status}). The model may be loading.` })}\n\n`);
      return;
    }

    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let finalModel = selectedModel;
    let fullAssistantResponse = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.message && chunk.message.content) {
            res.write(`event: token\ndata: ${JSON.stringify({ delta: chunk.message.content })}\n\n`);
            fullAssistantResponse += chunk.message.content;
          }
          if (chunk.done) {
            totalTokensIn  = chunk.prompt_eval_count || 0;
            totalTokensOut = chunk.eval_count || 0;
            finalModel     = chunk.model || selectedModel;
          }
        } catch {}
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      try {
        const chunk = JSON.parse(buffer);
        if (chunk.message?.content) {
          res.write(`event: token\ndata: ${JSON.stringify({ delta: chunk.message.content })}\n\n`);
          fullAssistantResponse += chunk.message.content;
        }
        if (chunk.done) {
          totalTokensIn  = chunk.prompt_eval_count || 0;
          totalTokensOut = chunk.eval_count || 0;
          finalModel     = chunk.model || selectedModel;
        }
      } catch {}
    }

    // Record assistant turn for conversation context
    // Apply dialect post-processing if needed (light-touch transforms)
    const effectiveDialect = decision.lang.dialect;
    const dialectIntensity = decision.lang._prefDialectIntensity || 0.25;
    const dialectIsExplicit = decision.lang._dialectIsExplicit || false;
    const dialectConfidence = decision.lang.confidence || 0;

    // Post-process is applied to the stored response for consistency tracking
    // The actual streamed tokens were already sent — post-processing affects
    // future context awareness but the system prompt handles the main dialect work
    addAssistantTurn(ctxKey, fullAssistantResponse, { route: routeType });

    // ── Done event ──
    const donePayload = {
      model: finalModel,
      environment: env,
      route: routeType,
      lang: decision.lang.language,
      dialect: decision.lang.dialect,
      usage: { prompt_tokens: totalTokensIn, completion_tokens: totalTokensOut },
    };
    if (webResearchResult) {
      donePayload.web_research = {
        sources: webResearchResult.sources.map(s => ({ title: s.title, url: s.url })),
        provider: webResearchResult.provider,
        cached: webResearchResult.fromCache,
      };
    }

    // Suggest registration for heavy guest users
    if (isGuest && req.visitorId) {
      const registerAfterN = await getSetting('guest.require_register_after_n', 5);
      const totals = await getVisitorTotals(req.visitorId);
      if (registerAfterN && totals.chats >= Number(registerAfterN) - 1) {
        donePayload.suggest_register = true;
      }
    }

    res.write(`event: done\ndata: ${JSON.stringify(donePayload)}\n\n`);

    // ── Logging (fire-and-forget) ──
    const totalDuration = Date.now() - requestStart;

    queryFor(env,
      `INSERT INTO chat_messages (actor, role, content, model, tokens_in, tokens_out, environment)
       VALUES ($1, 'user', $2, $3, $4, $5, $6)`,
      [actor, hasText ? message : `[Document: ${doc ? doc.meta.fileName : 'image'}]`, finalModel, totalTokensIn, totalTokensOut, env]
    ).catch(() => {});

    const usageMode = webResearchResult ? 'web_research' : (doc ? `doc-${doc.meta.extractionMethod}` : (hasImage ? 'vision' : 'text'));
    logUsageEvent({
      visitorId: req.visitorId || actor,
      userId: req.session?.userId || null,
      eventType: 'chat',
      mode: usageMode,
      model: finalModel,
      status: 'ok',
      latencyMs: totalDuration,
      inputLen: (hasText ? message.length : 0) + (doc ? (doc.text || '').length : 0),
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      environment: env,
      meta: {
        requestId,
        route: routeType,
        lang: decision.lang.language,
        dialect: decision.lang.dialect,
        formality: decision.lang.formality,
        tone: decision.lang.tone,
        intentReason: decision.intent?.reason,
        fileType: doc ? doc.meta.mimeType : (hasImage ? 'image' : null),
        pipeline: decision.pipeline ? {
          corrections: decision.pipeline.corrections,
          normMeta: decision.pipeline.normMeta,
          durationMs: decision.pipeline.durationMs,
        } : null,
      },
    });

    // Pipeline audit log
    dbQuery(
      `INSERT INTO pipeline_audit (request_id, visitor_id, user_id, route_type, intent, language, dialect, formality, model_used, duration_ms, tokens_in, tokens_out, status, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [requestId, req.visitorId, req.session?.userId || null, routeType,
       decision.intent?.intent, decision.lang.language, decision.lang.dialect, decision.lang.formality,
       finalModel, totalDuration, totalTokensIn, totalTokensOut, 'ok',
       JSON.stringify({ reason: decision.reason, intentReason: decision.intent?.reason })]
    ).catch(() => {});

  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[chat] Streaming error:', err.message);
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'Internal AI error. The model may be loading.' })}\n\n`);
    } catch {}

    // Log error in pipeline audit
    dbQuery(
      `INSERT INTO pipeline_audit (request_id, visitor_id, user_id, route_type, intent, language, dialect, model_used, duration_ms, status, error_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [requestId, req.visitorId, req.session?.userId || null, routeType,
       decision.intent?.intent, decision.lang.language, decision.lang.dialect,
       selectedModel, Date.now() - requestStart, 'error', err.message]
    ).catch(() => {});
  } finally {
    clearTimeout(globalTimer);
    try { res.end(); } catch {}
    if (tempFiles.length > 0) cleanupFiles(...tempFiles);
  }
});

/* ── Helper: chunk text for map-reduce summarization ─────── */
function chunkText(text, chunkSize = 30000) {
  const chunks = [];
  // Try to split on headings/sections first
  const sections = text.split(/\n(?=#{1,3}\s|[A-Z][A-Z\s]{3,}[:\n])/);

  let current = '';
  for (const section of sections) {
    if ((current + section).length > chunkSize && current.length > 0) {
      chunks.push(current.trim());
      current = section;
    } else {
      current += (current ? '\n' : '') + section;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // If no heading splits worked, fall back to character splitting
  if (chunks.length <= 1 && text.length > chunkSize) {
    chunks.length = 0;
    for (let i = 0; i < text.length; i += chunkSize) {
      // Try to break at paragraph boundary
      let end = Math.min(i + chunkSize, text.length);
      if (end < text.length) {
        const paraBreak = text.lastIndexOf('\n\n', end);
        if (paraBreak > i + chunkSize * 0.5) end = paraBreak;
      }
      chunks.push(text.slice(i, end).trim());
      if (end !== i + chunkSize) i = end - chunkSize; // adjust for break point
    }
  }

  return chunks.length > 0 ? chunks : [text];
}

/* ── Helper: get guest doc count for today ───────────────── */
async function getGuestDocCount(visitorId) {
  try {
    const result = await dbQuery(
      `SELECT COUNT(*)::int AS cnt FROM usage_events
       WHERE visitor_id = $1 AND event_type = 'chat' AND mode LIKE 'doc-%' AND status = 'ok'
         AND created_at >= CURRENT_DATE`,
      [visitorId]
    );
    return result.rows[0]?.cnt || 0;
  } catch { return 0; }
}

/**
 * GET /v1/chat/models — list available text models from Ollama
 */
router.get('/chat/models', async (_req, res) => {
  try {
    const defaultModel = await getSetting('ai.default_text_model', 'llama3.1:8b');
    const defaultVision = await getSetting('ai.default_vision_model', 'qwen2.5vl:32b');

    let ollamaModels = [];
    try {
      const ollamaRes = await fetch(`${OLLAMA_URL}/api/tags`);
      if (ollamaRes.ok) {
        const data = await ollamaRes.json();
        ollamaModels = (data.models || []).map(m => ({
          id: m.name,
          name: m.name,
          size_gb: (m.size / 1e9).toFixed(1),
          is_vision: /vl|vision|llava|minicpm-v/i.test(m.name),
          default: m.name === defaultModel,
          default_vision: m.name === defaultVision,
        }));
      }
    } catch {}

    if (ollamaModels.length === 0) {
      ollamaModels = [
        { id: 'llama3.1:8b', name: 'llama3.1:8b', size_gb: '4.9', is_vision: false, default: true, default_vision: false },
      ];
    }

    res.json({ models: ollamaModels, default_model: defaultModel, default_vision_model: defaultVision });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load models' });
  }
});

/**
 * POST /v1/chat/feedback — record quality signal (thumbs up/down)
 */
router.post('/chat/feedback', async (req, res) => {
  const { rating, route, model, responseLength } = req.body || {};
  if (!rating || !['up', 'down'].includes(rating)) {
    return res.status(400).json({ error: 'rating must be "up" or "down"' });
  }

  const actor = getActor(req);
  const visitorId = req.visitorId || actor;
  const env = req.env || 'prod';

  try {
    await dbQuery(
      `INSERT INTO quality_signals (visitor_id, user_id, rating, route_type, model, response_length, environment)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [visitorId, req.session?.userId || null, rating, route || null, model || null, responseLength || 0, env]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[feedback] DB error:', err.message);
    // Still return OK — don't block UI for feedback failures
    res.json({ ok: true });
  }
});

module.exports = router;
