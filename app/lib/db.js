/**
 * Database connection pools for Getouch
 * Dual-pool: prod (NVMe) + dev (SATA SSD)
 *
 * • pool / query()         — default (prod), used by session store & schema init
 * • poolFor(env)           — returns the correct pool for 'prod' | 'dev'
 * • queryFor(env, text, p) — run query on environment-specific pool
 */

const { Pool } = require('pg');

/* ── Pool factory ──────────────────────────────────────── */
function createPool(url, label) {
  const p = new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  p.on('error', (err) => {
    console.error(`[db:${label}] Unexpected pool error:`, err.message);
  });
  return p;
}

/* ── Primary pool (prod) — always available ────────────── */
const DATABASE_URL_PROD = process.env.DATABASE_URL_PROD || process.env.DATABASE_URL;
const pool = createPool(DATABASE_URL_PROD, 'prod');

/* ── Dev pool — only created when DATABASE_URL_DEV is set ─ */
const DATABASE_URL_DEV = process.env.DATABASE_URL_DEV;
const poolDev = DATABASE_URL_DEV ? createPool(DATABASE_URL_DEV, 'dev') : null;

if (poolDev) {
  console.log('[db] Dual-pool mode: prod + dev');
} else {
  console.log('[db] Single-pool mode: prod only (set DATABASE_URL_DEV for dual)');
}

/**
 * Return the pool for a given environment.
 * Falls back to prod if dev pool is unavailable.
 * @param {'prod'|'dev'} env
 */
function poolFor(env) {
  if (env === 'dev' && poolDev) return poolDev;
  return pool;
}

/**
 * Run a SQL query (default: prod pool)
 * @param {string} text - SQL query
 * @param {any[]} params - Query parameters
 */
async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.NODE_ENV === 'development' && duration > 100) {
    console.log(`[db:prod] slow query (${duration}ms):`, text.substring(0, 80));
  }
  return res;
}

/**
 * Run a SQL query on a specific environment pool
 * @param {'prod'|'dev'} env
 * @param {string} text - SQL query
 * @param {any[]} params
 */
async function queryFor(env, text, params) {
  const p = poolFor(env);
  const start = Date.now();
  const res = await p.query(text, params);
  const duration = Date.now() - start;
  if (process.env.NODE_ENV === 'development' && duration > 100) {
    console.log(`[db:${env}] slow query (${duration}ms):`, text.substring(0, 80));
  }
  return res;
}

/**
 * Get a client from the pool (for transactions)
 * @param {'prod'|'dev'} [env='prod']
 */
async function getClient(env = 'prod') {
  return poolFor(env).connect();
}

/**
 * Initialize database schema
 * Creates tables if they don't exist
 */
async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Sessions table (for connect-pg-simple)
    await client.query(`
      CREATE TABLE IF NOT EXISTS session (
        sid VARCHAR NOT NULL PRIMARY KEY,
        sess JSON NOT NULL,
        expire TIMESTAMP(6) NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_expire ON session (expire);
    `);

    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) NOT NULL UNIQUE,
        name VARCHAR(255),
        password_hash VARCHAR(255),
        is_active BOOLEAN DEFAULT true,
        email_verified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
    `);

    // API Keys table
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        key_prefix VARCHAR(12) NOT NULL,
        key_hash VARCHAR(255) NOT NULL,
        scopes TEXT[] DEFAULT ARRAY['wa:read', 'wa:write'],
        is_active BOOLEAN DEFAULT true,
        last_used_at TIMESTAMPTZ,
        last_used_ip VARCHAR(45),
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        revoked_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys (user_id);
      CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys (key_prefix);
    `);

    // API Key audit log
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_key_usage_log (
        id BIGSERIAL PRIMARY KEY,
        api_key_id UUID REFERENCES api_keys(id),
        user_id UUID REFERENCES users(id),
        endpoint VARCHAR(255),
        method VARCHAR(10),
        status_code INT,
        ip_address VARCHAR(45),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // OAuth linked accounts
    await client.query(`
      CREATE TABLE IF NOT EXISTS oauth_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider VARCHAR(32) NOT NULL,
        provider_account_id VARCHAR(255) NOT NULL,
        provider_email VARCHAR(255),
        provider_name VARCHAR(255),
        access_token TEXT,
        refresh_token TEXT,
        token_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (provider, provider_account_id)
      );
      CREATE INDEX IF NOT EXISTS idx_oauth_provider_acct
        ON oauth_accounts (provider, provider_account_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_user_id
        ON oauth_accounts (user_id);
    `);

    // Add avatar_url column to users if not present (for OAuth profile pics)
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);

    await client.query('COMMIT');
    console.log('[db] Schema initialized');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[db] Schema init failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Gracefully close all pools
 */
async function endAll() {
  await pool.end();
  if (poolDev) await poolDev.end();
}

module.exports = { pool, poolDev, poolFor, query, queryFor, getClient, initSchema, endAll };
