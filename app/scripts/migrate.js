#!/usr/bin/env node

/**
 * Database Migration Script for Getouch
 * Run: node scripts/migrate.js
 *
 * Creates all required tables for auth, sessions, and API key management.
 * Safe to run multiple times (uses CREATE IF NOT EXISTS).
 */

require('dotenv').config();

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set. Check your .env file.');
  process.exit(1);
}

async function migrate() {
  const pool = new Pool({ connectionString: DATABASE_URL });

  console.log('[migrate] Connecting to database...');

  const client = await pool.connect();
  try {
    console.log('[migrate] Running migrations...');
    await client.query('BEGIN');

    // 1. Enable extensions
    await client.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);
    console.log('[migrate] ✓ pgcrypto extension');

    // 2. Sessions table (connect-pg-simple)
    await client.query(`
      CREATE TABLE IF NOT EXISTS session (
        sid VARCHAR NOT NULL PRIMARY KEY,
        sess JSON NOT NULL,
        expire TIMESTAMP(6) NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_expire ON session (expire);
    `);
    console.log('[migrate] ✓ session table');

    // 3. Users table
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
    console.log('[migrate] ✓ users table');

    // 4. API Keys table
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
    console.log('[migrate] ✓ api_keys table');

    // 5. API Key usage log
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
      CREATE INDEX IF NOT EXISTS idx_usage_log_key ON api_key_usage_log (api_key_id);
      CREATE INDEX IF NOT EXISTS idx_usage_log_created ON api_key_usage_log (created_at);
    `);
    console.log('[migrate] ✓ api_key_usage_log table');

    await client.query('COMMIT');
    console.log('[migrate] ✅ All migrations complete!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate] ❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
