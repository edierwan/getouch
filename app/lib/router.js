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
const { detectLanguageAndDialect, conservativeSpellCorrect } = require('./dialect');
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
 *   4. Classify intent (with attachment context)
 *   5. Check web research trigger
 *   6. Route based on priority: attachment > web_research > intent
 *   7. Build personality-aware system prompt with stabilizer
 *
 * @param {string}      message      - user's text message (may be empty if attachment-only)
 * @param {object}      attachments  - { hasImage, hasDoc, doc }
 * @param {object}      [config]     - optional overrides
 * @returns {Promise<RouteDecision>}
 */
async function routeMessage(message, attachments = {}, config = {}) {
  const { hasImage = false, hasDoc = false, doc = null } = attachments;
  const startTime = Date.now();

  // ── Step 1: Normalize input ──
  const { original, normalized, meta: normMeta } = normalizeInput(message);
  const text = normalized;

  // ── Step 2: Detect language & dialect ──
  const lang = detectLanguageAndDialect(text);

  // ── Step 3: Conservative spell correction (preserve dialect tokens) ──
  const { corrected: correctedText, corrections } = conservativeSpellCorrect(text, lang.dialectTokensFound);
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
      lang,
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
        language: lang.language,
        dialect: lang.dialect,
        formality: lang.formality,
        tone: lang.tone,
        langResult: lang,
        dialectLevel: effDialectLevel,
        stabilizerEnabled: isStabilizerOn,
      }),
      lang,
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

  // ── Step 6: Intent classification (text-only) ──
  const intent = classifyIntent(textForClassify, { hasImage, hasDoc });

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
            lang,
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

  // ── Step 9: Build personality-aware system prompt ──
  const systemPrompt = buildSystemPrompt({
    routeType,
    language: lang.language,
    dialect: lang.dialect,
    formality: lang.formality,
    tone: lang.tone,
    langResult: lang,
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

  return buildDecision({
    routeType,
    systemPrompt,
    lang,
    intent,
    reason: `intent:${intent.reason}`,
    numPredict: numPredictMap[routeType] || 1024,
    normalized: text,
    original,
    normMeta,
    corrections,
    durationMs: Date.now() - startTime,
  });
}

/**
 * Build a standardized route decision object.
 */
function buildDecision({
  routeType, systemPrompt, lang, intent, reason, numPredict,
  webDecision, normalized, original, normMeta, corrections,
  needsVision, durationMs,
}) {
  const decision = {
    routeType,
    systemPrompt,
    lang,
    intent,
    reason,
    numPredict,
    // Pipeline metadata (for logging / debugging)
    pipeline: {
      original,
      normalized,
      normMeta,
      corrections,
      needsVision: needsVision || false,
      durationMs: durationMs || 0,
    },
  };
  if (webDecision) decision.webDecision = webDecision;
  return decision;
}

module.exports = { routeMessage, ROUTE };
