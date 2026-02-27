/**
 * Dialect & Language Detection — lightweight, rule-based
 *
 * Detects:
 *   language: 'ms' | 'en' | 'mixed'
 *   dialect:  'UTARA' | 'KELANTAN' | 'STANDARD' | null
 *   formality: 'casual' | 'formal' | 'neutral'
 *   tone:     'greeting' | 'neutral' | 'formal'
 *
 * Includes:
 *   - SMALLTALK_STABILIZER for natural dialect handling
 *   - Explicit dialect/language request detection
 *   - Dialect post-processor (light-touch transforms, intensity limiter)
 *
 * No external API calls — purely token-based for speed.
 */

/* ── Northern Malay (Utara / Kedah-Penang-Perlis) dialect tokens ── */
/* EXCLUSIVE Utara tokens — NOT shared with Kelantan */
const UTARA_TOKENS = [
  'hang', 'hampa', 'depa', 'pi', 'mai', 'dok', 'sat',
  'pasaipa', 'awat', 'habaq', 'haq', 'macam tu', 'macamtu',
  'noh', 'la ni', 'lani', 'teman', 'mu', 'kome', 'ceq',
  'watpa', 'buleh', 'weh', 'cemana', 'cokia', 'denge',
  'tak leh', 'boleh dak', 'pa habaq', 'pa khabar',
  'dak', 'tok', 'toksey', 'ghoyak', 'ekau',
  'cheq', 'loqlaq', 'pey', 'puloq', 'kecek',
];

/* ── Kelantan tokens (Klate) — EXCLUSIVE, not shared with Utara ── */
const KELANTAN_TOKENS = [
  'guano', 'guane', 'ambo', 'demo', 'gapo', 'mung', 'kawe',
  'getek', 'nnapok', 'nampok', 'sokmo', 'pitih', 'lagu mano',
  'ore', 'hok', 'ttube', 'tube', 'bui', 'maghih', 'nok',
  'blako', 'rhoyak', 'kito', 'sapa', 'aghe', 'abe',
  'oghe', 'mugo', 'ghinek', 'toksah', 'bakpo', 'klate',
  'kelate', 'mace', 'kace', 'kelik', 'nate', 'nnaik',
  'droh', 'ghalik', 'nnate', 'jjual', 'bbeli', 'ggetek',
];

/* ── Shared tokens that appear in BOTH dialects — low discriminative value ── */
const SHARED_DIALECT_TOKENS = ['make', 'nok', 'weh'];

/* ── Malay indicators (standard + informal) ──────────────── */
const MALAY_TOKENS = [
  'apa', 'ini', 'itu', 'saya', 'anda', 'boleh', 'tidak', 'ada',
  'dan', 'yang', 'untuk', 'dengan', 'dalam', 'dari', 'ke',
  'sudah', 'akan', 'masih', 'juga', 'atau', 'tetapi', 'kerana',
  'bagaimana', 'kenapa', 'mengapa', 'apabila', 'supaya',
  'selamat', 'terima kasih', 'pagi', 'petang', 'malam',
  'buat', 'tolong', 'boleh', 'nak', 'mau', 'tak',
  'macam', 'kalau', 'sebab', 'pasal', 'kena', 'tengah',
  'dah', 'belum', 'lagi', 'je', 'ja', 'kot', 'kan',
  'awak', 'kamu', 'dia', 'mereka', 'kami', 'kita',
];

/* ── English indicators ──────────────────────────────────── */
const ENGLISH_TOKENS = [
  'the', 'is', 'are', 'was', 'were', 'have', 'has', 'been',
  'will', 'would', 'could', 'should', 'can', 'this', 'that',
  'with', 'from', 'about', 'what', 'how', 'why', 'when',
  'please', 'thank', 'where', 'which', 'because', 'however',
];

/* ── Formality indicators ────────────────────────────────── */
const CASUAL_MARKERS = [
  'weh', 'lah', 'la', 'doh', 'bro', 'sis', 'wei', 'heh', 'haha',
  'lol', 'btw', 'nah', 'yo', 'oi', 'eh', 'hmm', 'uhh', 'bruh',
  'je', 'ja', 'kot', 'kan', 'tau', 'tahu tak', 'mcm', 'nk', 'nak',
  'x', 'xde', 'xda', 'tkde', 'dh', 'dah', 'gak', 'sih',
];

const FORMAL_MARKERS = [
  'encik', 'puan', 'tuan', 'cik', 'yang berhormat', 'saudara',
  'dear', 'regards', 'sincerely', 'respectfully',
  'dengan hormatnya', 'sila', 'dimaklumkan',
];

/* ── Greeting/Smalltalk patterns (for stabilizer) ────────── */
const GREETING_PATTERNS = [
  /^(hi+|hello|hey|yo+|sup|howdy)\b/i,
  /^(assalamualaikum|salam|hai|helo)\b/i,
  /^(selamat (pagi|petang|malam|tengahari))/i,
  /^(good (morning|afternoon|evening|night))/i,
  /^(apa (khabar|habaq|cerita))/i,
  /^(pa (habaq|khabar))/i,
  /^(hang pa habaq|habaq baik|cemana|macam mana)/i,
  /^(weh|wei|eh)\b/i,
  /^(bye|tata|jumpa lagi|thanks|terima kasih|ok(ay)?|baik)\b/i,
];

/* ── Explicit dialect/language request patterns ──────────── */
const DIALECT_REQUEST_PATTERNS = [
  // English requests
  { pattern: /\b(speak|talk|reply|respond|use)\s+(in\s+)?(english|eng)\b/i, lang: 'en', dialect: null },
  { pattern: /\b(can you|boleh)\s+(speak|cakap|reply|respond)\s+(in\s+)?(english|eng)\b/i, lang: 'en', dialect: null },
  { pattern: /\bin english\s+(please|pls)?\b/i, lang: 'en', dialect: null },

  // Standard BM / reset dialect
  { pattern: /\b(standard|biasa)\s+(bm|bahasa|melayu)\s*(je|ja|sahaja|saja)?\b/i, lang: 'ms', dialect: 'STANDARD' },
  { pattern: /\bjangan\s+(loghat|dialect|dialek)\b/i, lang: 'ms', dialect: 'STANDARD' },
  { pattern: /\b(cakap|balas)\s+(bm|melayu)\s+(biasa|standard)\b/i, lang: 'ms', dialect: 'STANDARD' },

  // Kelantan / Klate explicit
  { pattern: /\b(kace|kase|guna|pakai|cakap|balas|reply)\s+(klate|kelate|kelantan|kelantanese)\b/i, lang: 'ms', dialect: 'KELANTAN' },
  { pattern: /\b(loghat|dialect|dialek)\s+(klate|kelate|kelantan)\b/i, lang: 'ms', dialect: 'KELANTAN' },
  { pattern: /\bklate\s+(boleh|buleh)\b/i, lang: 'ms', dialect: 'KELANTAN' },
  { pattern: /\bkalau\s+(kace|kase|guna)\s+(klate|kelate|kelantan)\b/i, lang: 'ms', dialect: 'KELANTAN' },
  { pattern: /\b(boleh|buleh)\s+(tak|x)?\s*(cakap|kace|kase|guna)\s+(klate|kelate|kelantan)\b/i, lang: 'ms', dialect: 'KELANTAN' },

  // Utara explicit
  { pattern: /\b(kace|kase|guna|pakai|cakap|balas|reply)\s+(utara|kedah|penang|perlis)\b/i, lang: 'ms', dialect: 'UTARA' },
  { pattern: /\b(loghat|dialect|dialek)\s+(utara|kedah|penang|perlis)\b/i, lang: 'ms', dialect: 'UTARA' },
];

/**
 * Detect if user is explicitly requesting a language or dialect change.
 *
 * @param {string} message
 * @returns {{ requested: boolean, lang: string|null, dialect: string|null }}
 */
function detectExplicitRequest(message) {
  if (!message) return { requested: false, lang: null, dialect: null };
  const lower = message.toLowerCase().trim();
  for (const { pattern, lang, dialect } of DIALECT_REQUEST_PATTERNS) {
    if (pattern.test(lower)) {
      return { requested: true, lang, dialect };
    }
  }
  return { requested: false, lang: null, dialect: null };
}

/**
 * Detect user's tone for tone-mirroring.
 */
function detectTone(words, lower) {
  for (const pat of GREETING_PATTERNS) {
    if (pat.test(lower)) return 'greeting';
  }
  for (const m of FORMAL_MARKERS) {
    if (m.includes(' ') ? lower.includes(m) : words.includes(m)) return 'formal';
  }
  return 'neutral';
}

/**
 * Detect language, dialect, formality, tone, and explicit requests.
 *
 * @param {string} message
 * @returns {{
 *   language: 'ms' | 'en' | 'mixed',
 *   dialect: 'UTARA' | 'KELANTAN' | 'STANDARD' | null,
 *   formality: 'casual' | 'formal' | 'neutral',
 *   tone: 'greeting' | 'formal' | 'neutral',
 *   confidence: number,
 *   dialectTokensFound: string[],
 *   explicitRequest: { requested: boolean, lang: string|null, dialect: string|null },
 *   utaraScore: number,
 *   kelantanScore: number,
 * }}
 */
function detectLanguageAndDialect(message) {
  if (!message || typeof message !== 'string') {
    return { language: 'en', dialect: null, formality: 'neutral', tone: 'neutral', confidence: 0,
             dialectTokensFound: [], explicitRequest: { requested: false, lang: null, dialect: null },
             utaraScore: 0, kelantanScore: 0 };
  }

  const lower = message.toLowerCase().trim();
  const words = lower.split(/\s+/);

  // Check for explicit dialect/language requests first
  const explicitRequest = detectExplicitRequest(message);

  // Count token matches
  let msScore = 0, enScore = 0, utaraScore = 0, kelantanScore = 0;
  let casualScore = 0, formalScore = 0;
  const dialectTokensFound = [];
  const utaraTokensFound = [];
  const kelantanTokensFound = [];

  for (const w of words) {
    if (MALAY_TOKENS.includes(w)) msScore++;
    if (ENGLISH_TOKENS.includes(w)) enScore++;
  }

  // Utara check — multi-word aware
  for (const tok of UTARA_TOKENS) {
    if (tok.includes(' ')) {
      if (lower.includes(tok)) { utaraScore += 2; msScore += 2; utaraTokensFound.push(tok); dialectTokensFound.push(tok); }
    } else {
      if (words.includes(tok)) { utaraScore += 2; msScore++; utaraTokensFound.push(tok); dialectTokensFound.push(tok); }
    }
  }

  // Kelantan check — multi-word aware
  for (const tok of KELANTAN_TOKENS) {
    if (tok.includes(' ')) {
      if (lower.includes(tok)) { kelantanScore += 2; msScore += 2; kelantanTokensFound.push(tok); dialectTokensFound.push(tok); }
    } else {
      if (words.includes(tok)) { kelantanScore += 2; msScore++; kelantanTokensFound.push(tok); dialectTokensFound.push(tok); }
    }
  }

  // Casual / formal
  for (const tok of CASUAL_MARKERS) {
    if (words.includes(tok) || (tok.length > 2 && lower.includes(tok))) casualScore++;
  }
  for (const tok of FORMAL_MARKERS) {
    if (tok.includes(' ') ? lower.includes(tok) : words.includes(tok)) formalScore++;
  }

  // Language decision
  const totalTokens = words.length || 1;
  const msRatio = msScore / totalTokens;
  const enRatio = enScore / totalTokens;

  let language;
  if (msScore === 0 && enScore === 0) {
    language = /[a-z]/.test(lower) ? 'en' : 'en';
    if (/\b(apa|macam|boleh|tak|dah|hang|depa|dok)\b/.test(lower)) language = 'ms';
  } else if (msScore > 0 && enScore > 0) {
    language = msRatio > enRatio ? 'ms' : (enRatio > msRatio ? 'en' : 'mixed');
    if (Math.abs(msRatio - enRatio) < 0.15) language = 'mixed';
  } else {
    language = msScore > enScore ? 'ms' : 'en';
  }

  // Force ms if dialect markers present
  if (utaraScore > 0 || kelantanScore > 0) language = 'ms';

  // Dialect — STRICT class separation: must win by clear margin
  let dialect = null;
  if (language === 'ms' || language === 'mixed') {
    if (kelantanScore > 0 && kelantanScore > utaraScore) {
      dialect = 'KELANTAN';
    } else if (utaraScore > 0 && utaraScore > kelantanScore) {
      dialect = 'UTARA';
    } else if (kelantanScore > 0 && kelantanScore === utaraScore) {
      // Tie: check which has more exclusive tokens
      dialect = kelantanTokensFound.length >= utaraTokensFound.length ? 'KELANTAN' : 'UTARA';
    } else {
      dialect = 'STANDARD';
    }
  }

  // If user explicitly requested a dialect, override detection
  if (explicitRequest.requested && explicitRequest.dialect) {
    dialect = explicitRequest.dialect;
    if (explicitRequest.lang) language = explicitRequest.lang;
  } else if (explicitRequest.requested && explicitRequest.lang) {
    language = explicitRequest.lang;
    if (explicitRequest.lang === 'en') dialect = null;
  }

  // Formality
  let formality;
  if (formalScore > 0) formality = 'formal';
  else if (casualScore >= 2 || utaraScore >= 2 || kelantanScore >= 2) formality = 'casual';
  else if (message.length < 50) formality = 'casual';
  else formality = 'neutral';

  // Tone
  const tone = detectTone(words, lower);

  const confidence = Math.min(1, (msScore + enScore + utaraScore + kelantanScore) / Math.max(totalTokens * 0.5, 1));

  return { language, dialect, formality, tone, confidence, dialectTokensFound,
           explicitRequest, utaraScore, kelantanScore };
}

/* ═══════════════════════════════════════════════════════════
   SMALLTALK STABILIZER
   
   Prevents over-compensation in dialect replies.
   Rules:
   - Mirror max 1–2 dialect tokens from the user's message
   - Reply must be <= 2 sentences, <= 20 words
   - Pattern: greet/status + return question (for greetings)
   - Do NOT ask clarifying questions for smalltalk
   ═══════════════════════════════════════════════════════════ */

/**
 * Build stabilizer constraints for the system prompt based on detected dialect.
 *
 * @param {object}  langResult  - output from detectLanguageAndDialect
 * @param {string}  dialectLevel - 'off' | 'light' | 'medium' (from admin settings)
 * @returns {{ instructions: string, maxWords: number, maxSentences: number, dialectTokenLimit: number }}
 */
function buildSmalltalkStabilizer(langResult, dialectLevel = 'light') {
  if (dialectLevel === 'off' || !langResult) {
    return {
      instructions: '',
      maxWords: 20,
      maxSentences: 2,
      dialectTokenLimit: 0,
    };
  }

  const dialectTokenLimit = dialectLevel === 'medium' ? 3 : 2; // light = max 2, medium = max 3 dialect words
  const maxWords = 20;
  const maxSentences = 2;

  // Pick which tokens to mirror (up to limit)
  const tokensToMirror = (langResult.dialectTokensFound || []).slice(0, dialectTokenLimit);

  let instructions = '';

  if (langResult.dialect === 'UTARA' && langResult.tone === 'greeting') {
    instructions = [
      `SMALLTALK STABILIZER (ACTIVE):`,
      `- This is a casual greeting. Reply naturally as a friend would.`,
      `- Maximum ${maxSentences} sentences, maximum ${maxWords} words total.`,
      `- Mirror at most ${dialectTokenLimit} Utara dialect words from the user's message.`,
      tokensToMirror.length > 0
        ? `- You may use these dialect tokens: ${tokensToMirror.join(', ')}. Do NOT add extra dialect words beyond these.`
        : `- The user used Utara style. Reply in casual Malay with light Utara flavor (e.g., "hang", "ja").`,
      `- Follow pattern: [greeting/status response] + [return question to user]`,
      `- Example: User: "hang pa habaq" → Reply: "Habaq baik ja. Hang pulak macam mana?"`,
      `- Example: User: "weh apa cerita" → Reply: "Okay ja ni. Hang cemana?"`,
      `- Do NOT over-do dialect. Do NOT use archaic/obscure Utara words.`,
      `- Do NOT ask clarifying questions. Do NOT offer help unprompted.`,
      `- Do NOT say "Awat mai ni?" or similar unnatural phrasing.`,
    ].join('\n');
  } else if (langResult.dialect === 'UTARA') {
    instructions = [
      `DIALECT MIRRORING (LIGHT):`,
      `- The user speaks Northern Malay (Utara/Kedah-Penang style).`,
      `- Reply in Malay with light Utara flavor. Use at most ${dialectTokenLimit} dialect words per reply.`,
      tokensToMirror.length > 0
        ? `- Mirror these tokens naturally: ${tokensToMirror.join(', ')}`
        : `- Use casual Utara like "hang", "mai", "ja", "dak" naturally.`,
      `- Keep replies readable. Do NOT make every word dialect.`,
      `- Treat their language as normal speech — never correct or comment on dialect.`,
    ].join('\n');
  } else if (langResult.dialect === 'KELANTAN' && langResult.tone === 'greeting') {
    instructions = [
      `SMALLTALK STABILIZER (ACTIVE):`,
      `- This is a casual greeting from a Kelantanese speaker. Reply naturally.`,
      `- Maximum ${maxSentences} sentences, maximum ${maxWords} words total.`,
      `- Mirror at most ${dialectTokenLimit} Kelantan dialect words from the user's message.`,
      tokensToMirror.length > 0
        ? `- You may use these dialect tokens: ${tokensToMirror.join(', ')}. Do NOT add extra dialect words beyond these.`
        : `- The user used Kelantan style. Reply in casual Malay with light Kelantan flavor (e.g., "demo", "gapo", "ore").`,
      `- Follow pattern: [greeting/status response] + [return question to user]`,
      `- Example: User: "gapo khabar" → Reply: "Alhamdulillah baik. Demo pulak macam mano?"`,
      `- Example: User: "ambo nok tanyo" → Reply: "Boleh, tanyo je. Gapo demo nok tau?"`,
      `- Do NOT over-do dialect. Do NOT use full Kelantanese sentences.`,
      `- Do NOT use Utara words like "hang", "hampa", "habaq" — those are WRONG dialect.`,
      `- Do NOT ask clarifying questions. Do NOT offer help unprompted.`,
    ].join('\n');
  } else if (langResult.dialect === 'KELANTAN') {
    instructions = [
      `DIALECT MIRRORING (LIGHT KELANTAN):`,
      `- The user speaks Kelantanese Malay (Klate).`,
      `- Reply in Malay with light Kelantan flavor. Use at most ${dialectTokenLimit} Kelantan dialect words per reply.`,
      tokensToMirror.length > 0
        ? `- Mirror these tokens naturally: ${tokensToMirror.join(', ')}`
        : `- Use casual Kelantan like "demo", "ore", "gapo" naturally (NOT Utara words like "hang").`,
      `- Keep replies readable. Do NOT make every word dialect.`,
      `- CRITICAL: Do NOT use Northern/Utara dialect words (hang, hampa, habaq, depa) — these are WRONG for Kelantan users.`,
      `- Treat their language as normal speech — never correct or comment on dialect.`,
    ].join('\n');
  } else if (langResult.tone === 'greeting') {
    // Standard Malay or English greeting
    instructions = [
      `SMALLTALK STABILIZER (ACTIVE):`,
      `- This is a casual greeting. Reply warmly and briefly.`,
      `- Maximum ${maxSentences} sentences.`,
      `- Follow pattern: [greeting back] + [return question]`,
      `- Do NOT ask clarifying questions. Do NOT offer help unprompted.`,
    ].join('\n');
  }

  return {
    instructions,
    maxWords,
    maxSentences,
    dialectTokenLimit,
  };
}

/**
 * Conservative spell correction — only fixes obvious typos.
 * NEVER "corrects" dialect tokens. Preserves them.
 *
 * @param {string} text - normalized user message
 * @param {string[]} dialectTokensFound - dialect tokens to preserve
 * @returns {{ corrected: string, corrections: Array<{from: string, to: string}> }}
 */
function conservativeSpellCorrect(text, dialectTokensFound = []) {
  if (!text) return { corrected: text, corrections: [] };

  const corrections = [];
  let corrected = text;

  // Common Malay typos only (very conservative)
  const typoMap = {
    'terimakasih': 'terima kasih',
    'terimakaseh': 'terima kasih',
    'asslamualaikum': 'assalamualaikum',
    'aslmkm': 'assalamualaikum',
    'mkcm': 'macam',
    'blh': 'boleh',
    'tlg': 'tolong',
    'sbnrnya': 'sebenarnya',
    'prsn': 'perasan',
    'mcm mana': 'macam mana',
  };

  const dialectSet = new Set(dialectTokensFound.map(t => t.toLowerCase()));

  for (const [wrong, right] of Object.entries(typoMap)) {
    // Skip if it's a dialect token
    if (dialectSet.has(wrong)) continue;
    const re = new RegExp(`\\b${wrong}\\b`, 'gi');
    if (re.test(corrected)) {
      corrections.push({ from: wrong, to: right });
      corrected = corrected.replace(re, right);
    }
  }

  return { corrected, corrections };
}

module.exports = {
  detectLanguageAndDialect,
  detectExplicitRequest,
  buildSmalltalkStabilizer,
  conservativeSpellCorrect,
  applyDialectPostProcess,
  UTARA_TOKENS,
  KELANTAN_TOKENS,
  GREETING_PATTERNS,
  DIALECT_REQUEST_PATTERNS,
};

/* ═══════════════════════════════════════════════════════════
   DIALECT POST-PROCESSOR
   
   Light-touch transforms for dialect flavor.
   Rules:
   - Pronouns & particles ONLY — never sentence structure
   - Max 2 dialect tokens per sentence
   - Max ~10% token ratio
   - If confidence < 0.6 and not explicitly requested → no transforms
   ═══════════════════════════════════════════════════════════ */

/* Safe pronoun/particle transforms per dialect */
const KELANTAN_TRANSFORMS = [
  { from: /\bawak\b/gi,    to: 'demo' },
  { from: /\bkamu\b/gi,    to: 'demo' },
  { from: /\bsaya\b/gi,    to: 'ambo' },
  { from: /\bkenapa\b/gi,  to: 'gapo' },
  { from: /\borang\b/gi,   to: 'ore' },
  { from: /\bmereka\b/gi,  to: 'demo' },
  { from: /\bkita\b/gi,    to: 'kito' },
  { from: /\bbagaimana\b/gi, to: 'guano' },
  { from: /\bmacam mana\b/gi, to: 'guano' },
];

const UTARA_TRANSFORMS = [
  { from: /\bawak\b/gi,    to: 'hang' },
  { from: /\bkamu\b/gi,    to: 'hang' },
  { from: /\bmereka\b/gi,  to: 'depa' },
  { from: /\bkenapa\b/gi,  to: 'awat' },
  { from: /\bbagaimana\b/gi, to: 'cemana' },
  { from: /\bmacam mana\b/gi, to: 'cemana' },
  { from: /\bberitahu\b/gi, to: 'habaq' },
  { from: /\bya\b/gi,      to: 'ja' },
];

/**
 * Apply light-touch dialect post-processing to an LLM response.
 *
 * @param {string} text       - LLM response text
 * @param {string} dialect    - 'UTARA' | 'KELANTAN' | 'STANDARD' | null
 * @param {object} [opts]
 * @param {number} [opts.intensity=0.25]   - 0.0 to 1.0 (0 = no transform, 1 = max)
 * @param {boolean} [opts.explicit=false]  - was this explicitly requested by user?
 * @param {number} [opts.confidence=0]     - detection confidence
 * @returns {string}
 */
function applyDialectPostProcess(text, dialect, opts = {}) {
  const { intensity = 0.25, explicit = false, confidence = 0 } = opts;

  // Skip if no dialect or intensity is off
  if (!dialect || dialect === 'STANDARD' || !text || intensity <= 0) return text;
  // Skip if low confidence and not explicitly requested
  if (confidence < 0.6 && !explicit) return text;

  const transforms = dialect === 'KELANTAN' ? KELANTAN_TRANSFORMS : UTARA_TRANSFORMS;
  if (!transforms || transforms.length === 0) return text;

  // Process sentence by sentence to enforce per-sentence limit
  const sentences = text.split(/(?<=[.!?।\n])\s*/);
  const maxPerSentence = intensity >= 0.5 ? 3 : 2;

  const result = sentences.map(sentence => {
    const words = sentence.split(/\s+/);
    const maxTransforms = Math.max(1, Math.min(maxPerSentence, Math.floor(words.length * intensity)));
    let applied = 0;

    let out = sentence;
    for (const { from, to } of transforms) {
      if (applied >= maxTransforms) break;
      if (from.test(out)) {
        // Only replace first occurrence per sentence
        out = out.replace(from, (match) => {
          applied++;
          // Preserve capitalization
          if (match[0] === match[0].toUpperCase()) return to[0].toUpperCase() + to.slice(1);
          return to;
        });
        // Reset regex lastIndex
        from.lastIndex = 0;
        if (applied >= maxTransforms) break;
      }
    }
    return out;
  });

  return result.join(' ');
}
