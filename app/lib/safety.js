/**
 * Safety Layer — input/output guardrails for the AI pipeline
 *
 * Responsibilities:
 *   - Prompt injection detection (basic heuristic)
 *   - Content moderation indicators
 *   - Output sanitization hooks
 *   - Secret/PII leak prevention in outputs
 *   - Request size budget enforcement
 */

/* ── Prompt injection patterns ───────────────────────────── */
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+(instructions?|prompts?)/i,
  /forget\s+(everything|all|your\s+instructions)/i,
  /you\s+are\s+now\s+(DAN|a\s+different|evil|unrestricted)/i,
  /system\s*:\s*(override|new\s+instructions)/i,
  /\bdo\s+anything\s+now\b/i,
  /\bjailbreak\b/i,
  /\bprompt\s+leak\b/i,
  /reveal\s+(your|the)\s+(system|initial)\s+prompt/i,
  /what\s+(is|are)\s+your\s+(system|initial|hidden)\s+(prompt|instructions)/i,
];

/**
 * Check message for prompt injection attempts
 * @param {string} message
 * @returns {{ safe: boolean, reason?: string, confidence: number }}
 */
function checkPromptInjection(message) {
  if (!message || typeof message !== 'string') return { safe: true, confidence: 1.0 };

  const lower = message.toLowerCase();
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        safe: false,
        reason: 'prompt_injection_detected',
        confidence: 0.8,
        pattern: pattern.source,
      };
    }
  }

  // Heuristic: excessive use of "system:" or role-play prompts
  const systemMentions = (lower.match(/system\s*:/g) || []).length;
  if (systemMentions >= 2) {
    return {
      safe: false,
      reason: 'excessive_system_references',
      confidence: 0.6,
    };
  }

  return { safe: true, confidence: 1.0 };
}

/* ── PII/secret leak detection in outputs ────────────────── */
const PII_PATTERNS = [
  { name: 'api_key',      pattern: /(?:sk[-_]|api[-_]?key[-_]?)[a-zA-Z0-9]{16,}/gi },
  { name: 'password',     pattern: /(?:password|passwd|pwd)\s*[:=]\s*\S{6,}/gi },
  { name: 'bearer_token', pattern: /Bearer\s+[a-zA-Z0-9._-]{20,}/g },
  { name: 'env_secret',   pattern: /(?:SECRET|TOKEN|KEY)\s*=\s*\S{10,}/g },
];

/**
 * Scan output text for potential secret/PII leaks
 * @param {string} text
 * @returns {{ clean: boolean, findings: Array }}
 */
function scanOutputForLeaks(text) {
  if (!text || typeof text !== 'string') return { clean: true, findings: [] };

  const findings = [];
  for (const { name, pattern } of PII_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      findings.push({ type: name, count: matches.length });
    }
  }

  return {
    clean: findings.length === 0,
    findings,
  };
}

/* ── Content size budget ─────────────────────────────────── */

/**
 * Estimate token count from character length (rough: 1 token ≈ 4 chars for English)
 * @param {string} text
 * @returns {number} estimated tokens
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Check if input fits within reasonable budget
 * @param {Object} params
 * @param {string} params.message
 * @param {string} params.docText - document text if any
 * @param {number} params.maxContextTokens - max total context tokens
 * @returns {{ ok: boolean, estimatedTokens: number, reason?: string }}
 */
function checkBudget({ message = '', docText = '', maxContextTokens = 32000 }) {
  const msgTokens = estimateTokens(message);
  const docTokens = estimateTokens(docText);
  const total = msgTokens + docTokens;

  if (total > maxContextTokens) {
    return {
      ok: false,
      estimatedTokens: total,
      reason: `Input too large: ~${total} tokens (max ${maxContextTokens})`,
    };
  }

  return { ok: true, estimatedTokens: total };
}

module.exports = {
  checkPromptInjection,
  scanOutputForLeaks,
  estimateTokens,
  checkBudget,
  INJECTION_PATTERNS,
};
