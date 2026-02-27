/**
 * Core Router — central decision engine for Getouch AI
 *
 * Determines how to handle each user message by combining:
 *   - Input normalization
 *   - Attachment detection (doc / image)
 *   - Web research trigger
 *   - Intent classification (with attachment context)
 *   - Language / dialect detection
 *   - Smalltalk stabilizer
 *   - Personality prompt building
 *
 * Routing is deterministic and fully logged.
 *
 * Usage:
 *   const decision = await routeMessage(message, attachments, config);
 *   // decision.routeType, decision.systemPrompt, decision.lang, etc.
 */

const { classifyIntent, INTENT } = require('./intent');
const { detectLanguageAndDialect, conservativeSpellCorrect, detectExplicitRequest } = require('./dialect');
const { buildSystemPrompt } = require('./personality');
const { shouldBrowseWeb } = require('./web-research');
const { normalizeInput } = require('./input-normalizer');
const { getSetting } = require('./settings');

/* ── Route types ─────────────────────────────────────────── */
const ROUTE = {
  SMALLTALK:         'SMALLTALK',
  GENERAL_CHAT:      'GENERAL_CHAT',
  QUESTION:          'QUESTION',
  DOCUMENT_ANALYSIS: 'DOCUMENT_ANALYSIS',
  IMAGE_TASK:        'IMAGE_TASK',
  IMAGE_GEN:         'IMAGE_GEN',
  WEB_RESEARCH:      'WEB_RESEARCH',
  STRUCTURED_TASK:   'STRUCTURED_TASK',
  UNKNOWN:           'UNKNOWN',
};

/**
 * Route an incoming message to the appropriate handler.
 *
 * Pipeline:
 *   1. Normalize input
 *   2. Detect language & dialect
 *   3. Conservative spell correction (optional, preserving dialect)
 *   4. Classify intent (with attachment context + conversation context)
 *   5. Check web research trigger
 *   6. Route based on priority: attachment > web_research > intent
 *   7. Build personality-aware system prompt with stabilizer
 *   8. Attach per-route decoding config
 *
 * @param {string}      message      - user's text message (may be empty if attachment-only)
 * @param {object}      attachments  - { hasImage, hasDoc, doc }
 * @param {object}      [config]     - optional overrides + { convContext, docFollowUp }
 * @returns {Promise<RouteDecision>}
 */
async function routeMessage(message, attachments = {}, config = {}) {
  const { hasImage = false, hasDoc = false, doc = null } = attachments;
  const { convContext, docFollowUp } = config;
  const startTime = Date.now();

  // ── Step 1: Normalize input ──
  const { original, normalized, meta: normMeta } = normalizeInput(message);
  const text = normalized;

  // ── Step 2: Detect language & dialect ──
  const lang = detectLanguageAndDialect(text);

  // ── Step 2b: Apply session preferences (priority: explicit > session > detection) ──
  // Check for explicit request in this message
  const explicitReq = lang.explicitRequest;

  // Resolve effective language and dialect using priority chain
  const pref = convContext?.pref || { language: 'auto', dialect: 'none', dialectIntensity: 0.25 };
  let effectiveLang = lang.language;
  let effectiveDialect = lang.dialect;
  let dialectIsExplicit = false;

  if (explicitReq && explicitReq.requested) {
    // Highest priority: explicit request in this message
    if (explicitReq.lang) effectiveLang = explicitReq.lang;
    if (explicitReq.dialect !== undefined && explicitReq.dialect !== null) effectiveDialect = explicitReq.dialect;
    dialectIsExplicit = true;
  } else if (pref.language !== 'auto' || pref.dialect !== 'none') {
    // Second priority: sticky session preferences
    if (pref.language !== 'auto') effectiveLang = pref.language;
    if (pref.dialect === 'klate') effectiveDialect = 'KELANTAN';
    else if (pref.dialect === 'utara') effectiveDialect = 'UTARA';
    else if (pref.dialect === 'none' && pref.language !== 'auto') effectiveDialect = lang.dialect; // keep detection
    dialectIsExplicit = pref.dialect !== 'none';
  }
  // If English sticky preference and no dialect markers in this message → stay English, no dialect
  if (effectiveLang === 'en' && lang.utaraScore === 0 && lang.kelantanScore === 0) {
    effectiveDialect = null;
  }

  // Patch lang object with effective values for downstream use
  const effectiveLangResult = {
    ...lang,
    language: effectiveLang,
    dialect: effectiveDialect,
    _detectedLang: lang.language,    // original detection
    _detectedDialect: lang.dialect,  // original detection
    _dialectIsExplicit: dialectIsExplicit,
    _prefDialectIntensity: pref.dialectIntensity || 0.25,
  };

  // ── Step 3: Conservative spell correction (preserve dialect tokens) ──
  const { corrected: correctedText, corrections } = conservativeSpellCorrect(text, effectiveLangResult.dialectTokensFound);
  // Use corrected text for intent classification but original for model
  const textForClassify = correctedText || text;

  // ── Step 4: Load settings ──
  const [dialectLevel, stabilizerEnabled] = await Promise.all([
    getSetting('ai.dialect_mirroring_level', 'light'),
    getSetting('ai.smalltalk_stabilizer', true),
  ]);
  const isStabilizerOn = stabilizerEnabled === true || stabilizerEnabled === 'true';
  const effDialectLevel = (dialectLevel === 'false' || dialectLevel === false) ? 'off' : (dialectLevel || 'light');

  // ── Step 5: Attachment routing (highest priority) ──
  if (hasDoc && doc) {
    const needsVision = doc.kind === 'pages' || doc.kind === 'image';
    const routeType = ROUTE.DOCUMENT_ANALYSIS;

    return buildDecision({
      routeType,
      systemPrompt: null, // Document analysis uses its own prompt
      lang: effectiveLangResult,
      intent: { intent: INTENT.DOCUMENT, confidence: 1, reason: 'attachment', reasons: ['doc_attachment'] },
      reason: `document_upload:${doc.meta.extractionMethod}`,
      numPredict: 4096,
      normalized: text,
      original,
      normMeta,
      corrections,
      needsVision,
      durationMs: Date.now() - startTime,
    });
  }

  if (hasImage && !hasDoc) {
    // Check if user wants image editing vs analysis
    const intent = classifyIntent(text, { hasImage: true });

    return buildDecision({
      routeType: ROUTE.IMAGE_TASK,
      systemPrompt: buildSystemPrompt({
        routeType: ROUTE.IMAGE_TASK,
        language: effectiveLangResult.language,
        dialect: effectiveLangResult.dialect,
        formality: effectiveLangResult.formality,
        tone: effectiveLangResult.tone,
        langResult: effectiveLangResult,
        dialectLevel: effDialectLevel,
        stabilizerEnabled: isStabilizerOn,
      }),
      lang: effectiveLangResult,
      intent,
      reason: 'image_upload',
      numPredict: 2048,
      normalized: text,
      original,
      normMeta,
      corrections,
      durationMs: Date.now() - startTime,
    });
  }

  // ── Step 6: Intent classification (text-only, with conversation context) ──
  const intent = classifyIntent(textForClassify, { hasImage, hasDoc, convContext });

  // ── Step 7: Web research check ──
  if (text && (intent.intent === INTENT.WEB_RESEARCH || intent.intent === INTENT.QUESTION)) {
    try {
      const webEnabled = await getSetting('web_research.enabled', false);
      const isEnabled = webEnabled === true || webEnabled === 'true';

      if (isEnabled) {
        const webDecision = shouldBrowseWeb(text);
        if (webDecision.shouldBrowse || intent.intent === INTENT.WEB_RESEARCH) {
          return buildDecision({
            routeType: ROUTE.WEB_RESEARCH,
            systemPrompt: null,
            lang: effectiveLangResult,
            intent: { ...intent, reason: 'web_research' },
            webDecision: webDecision.shouldBrowse ? webDecision : { shouldBrowse: true, reason: 'intent_classified' },
            reason: `web_research:${webDecision.reason || 'intent'}`,
            numPredict: 2048,
            normalized: text,
            original,
            normMeta,
            corrections,
            durationMs: Date.now() - startTime,
          });
        }
      }
    } catch (err) {
      console.error('[router] Web research check failed:', err.message);
    }
  }

  // ── Step 8: Map intent to route ──
  let routeType;
  switch (intent.intent) {
    case INTENT.SMALLTALK:
      routeType = ROUTE.SMALLTALK;
      break;
    case INTENT.TASK:
      routeType = ROUTE.STRUCTURED_TASK;
      break;
    case INTENT.IMAGE_GEN:
      routeType = ROUTE.IMAGE_GEN;
      break;
    case INTENT.IMAGE_EDIT:
      routeType = ROUTE.IMAGE_TASK;
      break;
    case INTENT.DOCUMENT:
      routeType = ROUTE.DOCUMENT_ANALYSIS;
      break;
    case INTENT.QUESTION:
      routeType = ROUTE.GENERAL_CHAT;
      break;
    default:
      routeType = ROUTE.GENERAL_CHAT;
  }

  // ── Step 8b: Doc follow-up override ──
  // If user recently uploaded a doc and asks a follow-up question, keep in DOCUMENT_ANALYSIS
  if (docFollowUp && docFollowUp.isFollowUp && !hasDoc && !hasImage &&
      routeType !== ROUTE.WEB_RESEARCH && routeType !== ROUTE.IMAGE_GEN) {
    const isLikelyFollowUp = text && (
      /\b(yang tadi|tu tadi|dokumen|document|file|the one|dalam tu|yang tu|summarize|summary|from that|point|section|part|pasal|bahagian|berapa|how much|total|amount|what about)\b/i.test(text) ||
      (convContext && convContext.lastRoute === 'DOCUMENT_ANALYSIS')
    );
    if (isLikelyFollowUp) {
      routeType = ROUTE.DOCUMENT_ANALYSIS;
      intent.intent = INTENT.DOCUMENT;
      intent.reason = 'doc_followup';
    }
  }

  // ── Step 9: Build personality-aware system prompt ──
  const systemPrompt = buildSystemPrompt({
    routeType,
    language: effectiveLangResult.language,
    dialect: effectiveLangResult.dialect,
    formality: effectiveLangResult.formality,
    tone: effectiveLangResult.tone,
    langResult: effectiveLangResult,
    dialectLevel: effDialectLevel,
    stabilizerEnabled: isStabilizerOn,
  });

  // Token limits by route type (can be overridden by settings)
  const numPredictMap = {
    [ROUTE.SMALLTALK]: 256,
    [ROUTE.GENERAL_CHAT]: 1024,
    [ROUTE.STRUCTURED_TASK]: 2048,
    [ROUTE.QUESTION]: 1024,
    [ROUTE.IMAGE_GEN]: 512,
    [ROUTE.IMAGE_TASK]: 2048,
    [ROUTE.DOCUMENT_ANALYSIS]: 4096,
    [ROUTE.WEB_RESEARCH]: 2048,
  };

  // ── Per-route decoding config (temperature, top_p) ──
  // Smalltalk: warm/creative, short
  // Document/Web: low-temp, factual
  // Task: structured, moderate
  // General: balanced
  const DECODING_CONFIGS = {
    [ROUTE.SMALLTALK]:         { temperature: 0.6, top_p: 0.85 },
    [ROUTE.GENERAL_CHAT]:      { temperature: 0.7, top_p: 0.9 },
    [ROUTE.QUESTION]:          { temperature: 0.5, top_p: 0.85 },
    [ROUTE.STRUCTURED_TASK]:   { temperature: 0.4, top_p: 0.8 },
    [ROUTE.DOCUMENT_ANALYSIS]: { temperature: 0.3, top_p: 0.8 },
    [ROUTE.WEB_RESEARCH]:      { temperature: 0.2, top_p: 0.8 },
    [ROUTE.IMAGE_GEN]:         { temperature: 0.8, top_p: 0.95 },
    [ROUTE.IMAGE_TASK]:        { temperature: 0.5, top_p: 0.85 },
  };
  const decodingConfig = DECODING_CONFIGS[routeType] || { temperature: 0.7, top_p: 0.9 };

  return buildDecision({
    routeType,
    systemPrompt,
    lang: effectiveLangResult,
    intent,
    reason: `intent:${intent.reason}`,
    numPredict: numPredictMap[routeType] || 1024,
    decodingConfig,
    normalized: text,
    original,
    normMeta,
    corrections,
    convContext: convContext || null,
    durationMs: Date.now() - startTime,
    explicitRequest: explicitReq,
  });
}

/**
 * Build a standardized route decision object.
 */
function buildDecision({
  routeType, systemPrompt, lang, intent, reason, numPredict,
  webDecision, normalized, original, normMeta, corrections,
  needsVision, durationMs, decodingConfig, convContext, explicitRequest,
}) {
  const decision = {
    routeType,
    systemPrompt,
    lang,
    intent,
    reason,
    numPredict,
    decodingConfig: decodingConfig || { temperature: 0.7, top_p: 0.9 },
    explicitRequest: explicitRequest || null,
    // Pipeline metadata (for logging / debugging)
    pipeline: {
      original,
      normalized,
      normMeta,
      corrections,
      needsVision: needsVision || false,
      durationMs: durationMs || 0,
      convContext: convContext ? { turnCount: convContext.turnCount, lastRoute: convContext.lastRoute } : null,
    },
  };
  if (webDecision) decision.webDecision = webDecision;
  return decision;
}

module.exports = { routeMessage, ROUTE };
