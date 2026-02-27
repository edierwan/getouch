/**
 * Conversation Context Builder — tracks recent turns + session preferences
 *
 * Provides the router and LLM with conversation history so that:
 *   - Multi-turn context is preserved (follow-up questions, pronoun resolution)
 *   - Language/dialect preference is STICKY across turns
 *   - The router can see what route was used last turn
 *   - Smalltalk gate can distinguish first greeting from follow-up
 *   - Document follow-up questions reference the right context
 *
 * Session preferences (language, dialect, intensity):
 *   - Set by explicit user requests ("kace klate boleh?", "speak english")
 *   - Persist until explicitly changed or session expires
 *   - Priority: explicit request > session preference > per-message detection
 *
 * In-memory store with TTL-based cleanup. Key = visitorId or sessionId.
 *
 * Max 8 turns kept (4 user + 4 assistant), oldest evicted first.
 * Each session auto-expires after 30 minutes of inactivity.
 */

const MAX_TURNS    = 8;   // total messages kept (user + assistant interleaved)
const SESSION_TTL  = 30 * 60 * 1000; // 30 minutes
const PREF_TTL     = 60 * 60 * 1000; // 60 minutes for preferences
const CLEANUP_FREQ = 5 * 60 * 1000;  // 5 minutes

/** @type {Map<string, ConversationSession>} */
const sessions = new Map();

/**
 * @typedef {object} ConversationTurn
 * @property {'user' | 'assistant'} role
 * @property {string} content      - message text (truncated to 2000 chars)
 * @property {string} [route]      - route type used for this turn
 * @property {string} [lang]       - detected language
 * @property {string} [dialect]    - detected dialect
 * @property {string} [intent]     - classified intent
 * @property {string} [docId]      - if a document was referenced
 * @property {number} ts           - timestamp
 */

/**
 * @typedef {object} ConversationSession
 * @property {ConversationTurn[]} turns
 * @property {number} lastActive
 * @property {string} [dominantLang]    - most frequent language across turns
 * @property {string} [dominantDialect] - most frequent dialect
 * @property {string} [lastRoute]       - last route type used
 * @property {string} [activeDocId]     - currently active document ID
 * @property {SessionPreferences} pref  - sticky language/dialect preferences
 */

/**
 * @typedef {object} SessionPreferences
 * @property {string} language       - 'auto' | 'ms' | 'en'
 * @property {string} dialect        - 'none' | 'utara' | 'klate'
 * @property {number} dialectIntensity - 0.0 to 1.0 (default 0.25)
 * @property {number} updatedAt      - when pref was last changed
 */

/**
 * Get or create a session for the given key.
 * @param {string} sessionKey - visitorId or `user:${userId}`
 * @returns {ConversationSession}
 */
function getSession(sessionKey) {
  if (!sessionKey) return createEmpty();
  let sess = sessions.get(sessionKey);
  if (sess) {
    sess.lastActive = Date.now();
    return sess;
  }
  sess = createEmpty();
  sessions.set(sessionKey, sess);
  return sess;
}

/** @returns {ConversationSession} */
function createEmpty() {
  return {
    turns: [],
    lastActive: Date.now(),
    dominantLang: null,
    dominantDialect: null,
    lastRoute: null,
    activeDocId: null,
    pref: {
      language: 'auto',       // 'auto' | 'ms' | 'en'
      dialect: 'none',        // 'none' | 'utara' | 'klate'
      dialectIntensity: 0.25, // 0.0 to 1.0
      updatedAt: 0,
    },
  };
}

/**
 * Add a user turn to the session.
 *
 * @param {string} sessionKey
 * @param {string} content
 * @param {object} [meta] - { route, lang, dialect, intent, docId }
 */
function addUserTurn(sessionKey, content, meta = {}) {
  if (!sessionKey) return;
  const sess = getSession(sessionKey);
  sess.turns.push({
    role: 'user',
    content: (content || '').slice(0, 2000),
    route: meta.route || null,
    lang: meta.lang || null,
    dialect: meta.dialect || null,
    intent: meta.intent || null,
    docId: meta.docId || null,
    ts: Date.now(),
  });
  // Evict oldest if over limit
  while (sess.turns.length > MAX_TURNS) sess.turns.shift();
  // Update aggregates
  recalcAggregates(sess);
  if (meta.route) sess.lastRoute = meta.route;
  if (meta.docId) sess.activeDocId = meta.docId;
}

/**
 * Add an assistant turn to the session.
 *
 * @param {string} sessionKey
 * @param {string} content
 * @param {object} [meta] - { route }
 */
function addAssistantTurn(sessionKey, content, meta = {}) {
  if (!sessionKey) return;
  const sess = getSession(sessionKey);
  sess.turns.push({
    role: 'assistant',
    content: (content || '').slice(0, 2000),
    route: meta.route || null,
    ts: Date.now(),
  });
  while (sess.turns.length > MAX_TURNS) sess.turns.shift();
}

/**
 * Build the context summary for the router — lightweight, no full text.
 *
 * @param {string} sessionKey
 * @returns {object} context for routeMessage()
 */
function getRouterContext(sessionKey) {
  if (!sessionKey) return emptyContext();
  const sess = sessions.get(sessionKey);
  if (!sess || sess.turns.length === 0) return emptyContext();

  const userTurns = sess.turns.filter(t => t.role === 'user');
  const turnCount = sess.turns.length;
  const isFirstTurn = turnCount === 0;

  // Check if preferences are still valid (within PREF_TTL)
  const prefValid = sess.pref.updatedAt > 0 && (Date.now() - sess.pref.updatedAt) < PREF_TTL;

  return {
    turnCount,
    isFirstTurn,
    lastRoute: sess.lastRoute,
    dominantLang: sess.dominantLang,
    dominantDialect: sess.dominantDialect,
    activeDocId: sess.activeDocId,
    recentIntents: userTurns.slice(-3).map(t => t.intent).filter(Boolean),
    lastUserMessage: userTurns.length > 0 ? userTurns[userTurns.length - 1].content.slice(0, 200) : null,
    pref: prefValid ? { ...sess.pref } : { language: 'auto', dialect: 'none', dialectIntensity: 0.25, updatedAt: 0 },
  };
}

/**
 * Set a session preference (language, dialect, or intensity).
 *
 * @param {string} sessionKey
 * @param {string} field - 'language' | 'dialect' | 'dialectIntensity'
 * @param {string|number} value
 */
function setPreference(sessionKey, field, value) {
  if (!sessionKey) return;
  const sess = getSession(sessionKey);
  if (['language', 'dialect', 'dialectIntensity'].includes(field)) {
    sess.pref[field] = value;
    sess.pref.updatedAt = Date.now();
  }
}

/**
 * Get current session preferences.
 *
 * @param {string} sessionKey
 * @returns {SessionPreferences}
 */
function getPreferences(sessionKey) {
  if (!sessionKey) return { language: 'auto', dialect: 'none', dialectIntensity: 0.25, updatedAt: 0 };
  const sess = sessions.get(sessionKey);
  if (!sess) return { language: 'auto', dialect: 'none', dialectIntensity: 0.25, updatedAt: 0 };
  const prefValid = sess.pref.updatedAt > 0 && (Date.now() - sess.pref.updatedAt) < PREF_TTL;
  return prefValid ? { ...sess.pref } : { language: 'auto', dialect: 'none', dialectIntensity: 0.25, updatedAt: 0 };
}

/**
 * Apply an explicit dialect/language request to session preferences.
 * Called from the router when detectExplicitRequest returns requested=true.
 *
 * @param {string} sessionKey
 * @param {{ requested: boolean, lang: string|null, dialect: string|null }} explicitReq
 */
function applyExplicitRequest(sessionKey, explicitReq) {
  if (!sessionKey || !explicitReq || !explicitReq.requested) return;

  if (explicitReq.lang) {
    setPreference(sessionKey, 'language', explicitReq.lang);
  }
  if (explicitReq.dialect !== undefined && explicitReq.dialect !== null) {
    // Map dialect name to preference key
    const dialectMap = { 'KELANTAN': 'klate', 'UTARA': 'utara', 'STANDARD': 'none' };
    setPreference(sessionKey, 'dialect', dialectMap[explicitReq.dialect] || 'none');
    // Explicit request bumps intensity slightly
    if (explicitReq.dialect !== 'STANDARD') {
      setPreference(sessionKey, 'dialectIntensity', 0.35);
    } else {
      setPreference(sessionKey, 'dialectIntensity', 0);
    }
  }
}

/**
 * Build Ollama-compatible messages array from session history.
 *
 * Used in chat-stream to provide multi-turn context to the LLM.
 * Returns last N turns as [{role, content}] suitable for Ollama messages array.
 *
 * @param {string} sessionKey
 * @param {number} [maxTurns=6] - how many recent turns to include
 * @returns {Array<{role: string, content: string}>}
 */
function getHistoryMessages(sessionKey, maxTurns = 6) {
  if (!sessionKey) return [];
  const sess = sessions.get(sessionKey);
  if (!sess || sess.turns.length === 0) return [];

  // Take last N turns, skip the very latest user turn (caller will add it themselves)
  const recent = sess.turns.slice(-(maxTurns + 1), -1);
  return recent.map(t => ({
    role: t.role,
    content: t.content,
  }));
}

/**
 * Check if a user's recent context suggests they are following up on a document.
 *
 * @param {string} sessionKey
 * @returns {{ isFollowUp: boolean, docId: string|null }}
 */
function isDocFollowUp(sessionKey) {
  if (!sessionKey) return { isFollowUp: false, docId: null };
  const sess = sessions.get(sessionKey);
  if (!sess) return { isFollowUp: false, docId: null };

  // Check if last 2 turns involved a document
  const recentUser = sess.turns
    .filter(t => t.role === 'user')
    .slice(-2);

  const lastDocTurn = recentUser.find(t => t.route === 'DOCUMENT_ANALYSIS' || t.docId);
  if (lastDocTurn) {
    return { isFollowUp: true, docId: lastDocTurn.docId || sess.activeDocId };
  }

  return { isFollowUp: false, docId: sess.activeDocId || null };
}

/** @returns {object} */
function emptyContext() {
  return {
    turnCount: 0,
    isFirstTurn: true,
    lastRoute: null,
    dominantLang: null,
    dominantDialect: null,
    activeDocId: null,
    recentIntents: [],
    lastUserMessage: null,
    pref: { language: 'auto', dialect: 'none', dialectIntensity: 0.25, updatedAt: 0 },
  };
}

/**
 * Recalculate dominant language and dialect from recent user turns.
 * @param {ConversationSession} sess
 */
function recalcAggregates(sess) {
  const userTurns = sess.turns.filter(t => t.role === 'user' && t.lang);
  if (userTurns.length === 0) return;

  // Count language frequencies
  const langCounts = {};
  const dialectCounts = {};
  for (const t of userTurns) {
    langCounts[t.lang] = (langCounts[t.lang] || 0) + 1;
    if (t.dialect) dialectCounts[t.dialect] = (dialectCounts[t.dialect] || 0) + 1;
  }

  sess.dominantLang = Object.entries(langCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  sess.dominantDialect = Object.entries(dialectCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

/**
 * Periodic cleanup of expired sessions.
 */
function cleanup() {
  const now = Date.now();
  for (const [key, sess] of sessions) {
    if (now - sess.lastActive > SESSION_TTL) {
      sessions.delete(key);
    }
  }
}
setInterval(cleanup, CLEANUP_FREQ).unref();

/**
 * Get stats (for admin/monitoring).
 */
function getStats() {
  return {
    activeSessions: sessions.size,
    totalTurns: Array.from(sessions.values()).reduce((sum, s) => sum + s.turns.length, 0),
  };
}

module.exports = {
  getSession,
  addUserTurn,
  addAssistantTurn,
  getRouterContext,
  getHistoryMessages,
  isDocFollowUp,
  getStats,
  setPreference,
  getPreferences,
  applyExplicitRequest,
};
