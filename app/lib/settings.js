/**
 * Settings cache — loads from PostgreSQL with 30-second TTL
 */
const { query } = require('./db');

let cache = {};
let cacheTime = 0;
const CACHE_TTL = 30_000; // 30 seconds

/**
 * Get all settings (cached)
 */
async function getAllSettings() {
  const now = Date.now();
  if (now - cacheTime < CACHE_TTL && Object.keys(cache).length > 0) {
    return cache;
  }
  try {
    const res = await query('SELECT key, value FROM settings');
    const fresh = {};
    for (const row of res.rows) {
      fresh[row.key] = row.value;
    }
    cache = fresh;
    cacheTime = now;
    return cache;
  } catch (err) {
    console.error('[settings] Failed to load:', err.message);
    return cache; // return stale cache on error
  }
}

/**
 * Get a single setting value
 */
async function getSetting(key, defaultValue = null) {
  const all = await getAllSettings();
  return all[key] !== undefined ? all[key] : defaultValue;
}

/**
 * Update a setting
 */
async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
  // Invalidate cache immediately
  cache[key] = value;
  cacheTime = Date.now();
}

/**
 * Force cache refresh
 */
function invalidateCache() {
  cacheTime = 0;
}

module.exports = { getAllSettings, getSetting, setSetting, invalidateCache };
