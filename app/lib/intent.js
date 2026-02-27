/**
 * Intent Classifier — fast, rule-based classification of user messages
 *
 * Returns one of: SMALLTALK, TASK, QUESTION, GENERAL_CHAT, WEB_RESEARCH, DOCUMENT, IMAGE_EDIT, IMAGE_GEN
 *
 * Considers attachments, keywords, and patterns.
 * No LLM call — purely keyword + heuristic based for speed.
 */

/* ── Intent types ────────────────────────────────────────── */
const INTENT = {
  SMALLTALK:    'SMALLTALK',
  TASK:         'TASK',
  QUESTION:     'QUESTION',
  GENERAL_CHAT: 'GENERAL_CHAT',
  WEB_RESEARCH: 'WEB_RESEARCH',
  DOCUMENT:     'DOCUMENT',
  IMAGE_EDIT:   'IMAGE_EDIT',
  IMAGE_GEN:    'IMAGE_GEN',
};

/* ── Greeting / smalltalk tokens ─────────────────────────── */
const GREETING_TOKENS = [
  // English
  'hi', 'hello', 'hey', 'yo', 'sup', 'good morning', 'good afternoon',
  'good evening', 'good night', 'morning', 'howdy', 'what\'s up', 'whats up',
  // Malay standard
  'assalamualaikum', 'salam', 'selamat pagi', 'selamat petang',
  'selamat malam', 'selamat tengahari', 'apa khabar', 'hai', 'helo',
  // Malay Utara / informal / dialects
  'weh', 'hang', 'hampa', 'apa habaq', 'habaq', 'dok mana', 'makan ka',
  'sat', 'mai', 'noh', 'cemana', 'macam mana', 'lama dah',
  'haq', 'awat', 'pasaipa', 'depa', 'watpa', 'pa habaq', 'pa khabar',
  // Casual closings / acknowledgements
  'bye', 'bye bye', 'tata', 'jumpa lagi', 'thanks', 'terima kasih',
  'thank you', 'ok', 'okay', 'baik', 'tq', 'thx',
];

/* ── Task verb tokens ────────────────────────────────────── */
const TASK_VERBS = [
  // English
  'generate', 'create', 'build', 'install', 'setup', 'configure',
  'edit', 'convert', 'fix', 'deploy', 'write', 'code', 'implement',
  'translate', 'compare', 'analyze', 'calculate', 'format',
  'summarize', 'summarise', 'list', 'sort', 'filter', 'extract',
  'debug', 'optimize', 'refactor', 'design', 'plan', 'draft',
  'explain step', 'show me how',
  // Malay
  'buat', 'buatkan', 'tolong buat', 'ringkaskan', 'susun', 'tukar',
  'hasilkan', 'cipta', 'tulis', 'kira', 'ubah', 'betulkan',
  'terjemah', 'terjemahkan', 'senaraikan', 'bandingkan',
  'jelaskan langkah', 'carikan', 'tolong', 'boleh buat',
];

/* ── Document keywords ───────────────────────────────────── */
const DOCUMENT_KEYWORDS = [
  'ringkaskan', 'summarize', 'summarise', 'summary', 'ringkasan',
  'semak dokumen', 'review document', 'analyze document', 'analisa dokumen',
  'baca dokumen', 'read document', 'extract from', 'apa kandungan',
  'what does this say', 'what is this about', 'explain this document',
];

/* ── Image edit keywords ─────────────────────────────────── */
const IMAGE_EDIT_KEYWORDS = [
  'edit gambar', 'edit image', 'ubah gambar', 'modify image',
  'change background', 'tukar background', 'crop', 'resize',
  'remove background', 'buang background', 'enhance', 'upscale',
];

/* ── Image generation keywords ───────────────────────────── */
const IMAGE_GEN_KEYWORDS = [
  'generate image', 'buat gambar', 'hasilkan gambar', 'create image',
  'draw', 'lukis', 'illustration', 'ilustrasi', 'design poster',
  'buat poster', 'generate art', 'buat seni',
];

/* ── Web research keywords (overlap with web-research.js) ── */
const WEB_KEYWORDS = [
  'cari web', 'search web', 'browse web', 'web search',
  'harga pasaran', 'latest news', 'terkini', 'current price',
  'cari harga', 'find price', 'reddit', 'google',
];

/* ── Question indicators ─────────────────────────────────── */
const QUESTION_WORDS = [
  'what', 'how', 'why', 'when', 'where', 'which', 'who',
  'apa', 'bagaimana', 'kenapa', 'mengapa', 'bila', 'di mana',
  'siapa', 'berapa', 'adakah', 'bolehkah',
  'macam mana', 'cemana', 'pasaipa', 'awat', 'sapa',
];

/**
 * Classify user message intent.
 *
 * @param {string} message
 * @param {object} [context] - { hasImage, hasDoc, docName }
 * @returns {{ intent: string, confidence: number, reason: string, reasons: string[] }}
 */
function classifyIntent(message, context = {}) {
  const { hasImage = false, hasDoc = false } = context;
  const reasons = [];

  if (!message || typeof message !== 'string') {
    // Attachment-only
    if (hasDoc) return { intent: INTENT.DOCUMENT, confidence: 1, reason: 'doc_attachment', reasons: ['doc_attachment'] };
    if (hasImage) return { intent: INTENT.IMAGE_EDIT, confidence: 0.7, reason: 'image_attachment', reasons: ['image_attachment'] };
    return { intent: INTENT.GENERAL_CHAT, confidence: 0, reason: 'empty', reasons: ['empty'] };
  }

  const raw = message.trim();
  const lower = raw.toLowerCase();
  const words = lower.split(/\s+/);
  const len = raw.length;

  // 0. If document attached — intent is DOCUMENT unless specifically requesting image edit
  if (hasDoc) {
    for (const kw of IMAGE_EDIT_KEYWORDS) {
      if (lower.includes(kw)) {
        return { intent: INTENT.IMAGE_EDIT, confidence: 0.9, reason: `image_edit_with_doc:${kw}`, reasons: [`image_edit:${kw}`, 'has_doc'] };
      }
    }
    return { intent: INTENT.DOCUMENT, confidence: 1, reason: 'doc_attachment', reasons: ['doc_attachment'] };
  }

  // 0b. Image attachment + text
  if (hasImage) {
    for (const kw of IMAGE_EDIT_KEYWORDS) {
      if (lower.includes(kw)) {
        return { intent: INTENT.IMAGE_EDIT, confidence: 0.95, reason: `image_edit:${kw}`, reasons: [`image_edit:${kw}`, 'has_image'] };
      }
    }
    reasons.push('has_image');
  }

  // 1. Check document keywords (text-only, user might be referring to a previous doc)
  for (const kw of DOCUMENT_KEYWORDS) {
    if (lower.includes(kw)) {
      reasons.push(`doc_keyword:${kw}`);
      return { intent: INTENT.DOCUMENT, confidence: 0.85, reason: `doc_keyword:${kw}`, reasons };
    }
  }

  // 2. Check image gen keywords
  for (const kw of IMAGE_GEN_KEYWORDS) {
    if (lower.includes(kw)) {
      reasons.push(`image_gen:${kw}`);
      return { intent: INTENT.IMAGE_GEN, confidence: 0.9, reason: `image_gen:${kw}`, reasons };
    }
  }

  // 3. Check image edit keywords (no attachment)
  for (const kw of IMAGE_EDIT_KEYWORDS) {
    if (lower.includes(kw)) {
      reasons.push(`image_edit:${kw}`);
      return { intent: INTENT.IMAGE_EDIT, confidence: 0.85, reason: `image_edit:${kw}`, reasons };
    }
  }

  // 4. Check web research keywords
  for (const kw of WEB_KEYWORDS) {
    if (lower.includes(kw)) {
      reasons.push(`web:${kw}`);
      return { intent: INTENT.WEB_RESEARCH, confidence: 0.9, reason: `web_keyword:${kw}`, reasons };
    }
  }

  // 5. Check for task verbs — these override smalltalk
  for (const verb of TASK_VERBS) {
    if (verb.includes(' ')) {
      if (lower.includes(verb)) {
        reasons.push(`task_verb:${verb}`);
        return { intent: INTENT.TASK, confidence: 0.9, reason: `task_verb:${verb}`, reasons };
      }
    } else {
      if (words.includes(verb) || new RegExp(`\\b${verb}\\b`, 'i').test(lower)) {
        reasons.push(`task_verb:${verb}`);
        return { intent: INTENT.TASK, confidence: 0.85, reason: `task_verb:${verb}`, reasons };
      }
    }
  }

  // 6. Short message + greeting tokens → SMALLTALK
  if (len < 80) {
    for (const token of GREETING_TOKENS) {
      if (token.includes(' ')) {
        if (lower.includes(token)) {
          reasons.push(`greeting:${token}`);
          return { intent: INTENT.SMALLTALK, confidence: 0.9, reason: `greeting:${token}`, reasons };
        }
      } else {
        if (words.includes(token)) {
          reasons.push(`greeting:${token}`);
          return { intent: INTENT.SMALLTALK, confidence: 0.85, reason: `greeting:${token}`, reasons };
        }
      }
    }
  }

  // 7. Question patterns
  const hasQuestionMark = raw.includes('?');
  const hasQuestionWord = QUESTION_WORDS.some(qw => {
    if (qw.includes(' ')) return lower.includes(qw);
    return words.includes(qw) || new RegExp(`\\b${qw}\\b`, 'i').test(lower);
  });

  if (hasQuestionMark || hasQuestionWord) {
    reasons.push('question_pattern');
    return { intent: INTENT.QUESTION, confidence: hasQuestionMark ? 0.8 : 0.7, reason: 'question_pattern', reasons };
  }

  // 8. Very short message with no intent → likely smalltalk
  if (len < 40) {
    reasons.push('short_message');
    return { intent: INTENT.SMALLTALK, confidence: 0.5, reason: 'short_message', reasons };
  }

  // 9. If image attached but no clear edit intent → general image analysis
  if (hasImage) {
    return { intent: INTENT.TASK, confidence: 0.7, reason: 'image_analysis', reasons: [...reasons, 'image_analysis'] };
  }

  // 10. Default
  reasons.push('default');
  return { intent: INTENT.GENERAL_CHAT, confidence: 0.5, reason: 'default', reasons };
}

module.exports = { classifyIntent, INTENT };
