/**
 * In-memory rate limiter (sliding window)
 * No external dependencies — suitable for single-instance deployments.
 */

const buckets = new Map();

/**
 * Check if an action is allowed for a given actor.
 * @param {string} actor - IP hash or user ID
 * @param {string} action - e.g. 'chat', 'image'
 * @param {number} maxRequests - max requests in window
 * @param {number} windowMs - window size in ms (default: 60s)
 * @returns {{ allowed: boolean, remaining: number, retryAfter?: number }}
 */
function checkRateLimit(actor, action, maxRequests, windowMs = 60_000) {
  const key = `${action}:${actor}`;
  const now = Date.now();

  if (!buckets.has(key)) {
    buckets.set(key, []);
  }

  const timestamps = buckets.get(key);

  // Remove expired entries
  while (timestamps.length > 0 && timestamps[0] <= now - windowMs) {
    timestamps.shift();
  }

  if (timestamps.length >= maxRequests) {
    const retryAfter = Math.ceil((timestamps[0] + windowMs - now) / 1000);
    return { allowed: false, remaining: 0, retryAfter };
  }

  timestamps.push(now);
  return { allowed: true, remaining: maxRequests - timestamps.length };
}

/**
 * Get actor identifier from request (user ID or hashed IP)
 */
function getActor(req) {
  if (req.session && req.session.userId) {
    return `user:${req.session.userId}`;
  }
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['cf-connecting-ip']
    || req.socket.remoteAddress
    || 'unknown';

  const crypto = require('crypto');
  return `ip:${crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16)}`;
}

// Cleanup old buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of buckets) {
    // Remove if no activity in last 10 minutes
    if (timestamps.length === 0 || timestamps[timestamps.length - 1] < now - 600_000) {
      buckets.delete(key);
    }
  }
}, 300_000);

module.exports = { checkRateLimit, getActor };
