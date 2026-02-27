/**
 * Input Normalizer — clean, normalize, and preserve user messages
 *
 * Steps:
 *   1. Trim whitespace
 *   2. Normalize unicode (NFC)
 *   3. Remove zero-width characters
 *   4. Collapse repeated whitespace (preserve newlines)
 *   5. Basic XSS prevention (strip HTML tags)
 *
 * Keeps original for logs; creates normalized version for processing.
 */

/* ── Zero-width and invisible chars to strip ─────────────── */
const INVISIBLE_RE = /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00AD\u2060\u2061\u2062\u2063\u2064\u206A-\u206F]/g;

/* ── HTML tag stripper (XSS prevention for display) ──────── */
const HTML_TAG_RE = /<\/?[^>]+(>|$)/g;

/**
 * Normalize a user message for processing.
 *
 * @param {string} raw - original user message
 * @returns {{ original: string, normalized: string, meta: { trimmed: boolean, hadInvisible: boolean, hadHtml: boolean, charDelta: number } }}
 */
function normalizeInput(raw) {
  if (!raw || typeof raw !== 'string') {
    return {
      original: '',
      normalized: '',
      meta: { trimmed: false, hadInvisible: false, hadHtml: false, charDelta: 0 },
    };
  }

  const original = raw;
  let text = raw;

  // 1. Unicode NFC normalization
  text = text.normalize('NFC');

  // 2. Remove zero-width / invisible chars
  const hadInvisible = INVISIBLE_RE.test(text);
  text = text.replace(INVISIBLE_RE, '');

  // 3. Strip HTML tags (basic XSS)
  const hadHtml = HTML_TAG_RE.test(text);
  text = text.replace(HTML_TAG_RE, '');

  // 4. Trim
  const trimmed = text !== text.trim();
  text = text.trim();

  // 5. Collapse whitespace (keep newlines)
  text = text.replace(/[^\S\n]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');

  return {
    original,
    normalized: text,
    meta: {
      trimmed,
      hadInvisible,
      hadHtml,
      charDelta: original.length - text.length,
    },
  };
}

/**
 * Sanitize output for safe rendering (strip potential XSS in AI output)
 * Allows markdown but strips raw HTML script/event handlers.
 */
function sanitizeOutput(text) {
  if (!text) return '';
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?>/gi, '');
}

module.exports = { normalizeInput, sanitizeOutput };
