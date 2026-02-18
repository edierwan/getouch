-- Migration 004: WhatsApp Gateway — Multi-tenant schema
-- Mirrors SMS Gateway pattern but adapted for WhatsApp via Baileys

BEGIN;

-- ────────────────────────────────────────────────────
-- 1. wa_tenants — one row per WhatsApp-enabled company
-- ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_tenants (
  id            SERIAL PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'free'
                  CHECK (plan IN ('free','starter','pro','enterprise')),
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended','archived')),
  daily_limit   INT NOT NULL DEFAULT 100,
  monthly_limit INT NOT NULL DEFAULT 1000,
  webhook_url   TEXT,
  webhook_secret TEXT,
  metadata      JSONB DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────────────
-- 2. wa_api_keys — per-tenant API keys for WA endpoints
-- ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_api_keys (
  id           SERIAL PRIMARY KEY,
  tenant_id    INT NOT NULL REFERENCES wa_tenants(id),
  key_prefix   TEXT NOT NULL,
  key_hash     TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT 'default',
  scopes       TEXT[] NOT NULL DEFAULT ARRAY['wa:read','wa:write'],
  rate_limit   INT NOT NULL DEFAULT 60,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_api_keys_tenant   ON wa_api_keys(tenant_id);
CREATE INDEX IF NOT EXISTS idx_wa_api_keys_prefix   ON wa_api_keys(key_prefix);

-- ────────────────────────────────────────────────────
-- 3. wa_sessions — Baileys session metadata per tenant
-- ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_sessions (
  id            SERIAL PRIMARY KEY,
  tenant_id     INT NOT NULL REFERENCES wa_tenants(id),
  phone_number  TEXT,
  status        TEXT NOT NULL DEFAULT 'disconnected'
                  CHECK (status IN ('disconnected','qr_pending','connecting','connected','failed')),
  jid           TEXT,
  push_name     TEXT,
  platform      TEXT,
  last_seen_at  TIMESTAMPTZ,
  qr_data       TEXT,
  qr_expires_at TIMESTAMPTZ,
  error_message TEXT,
  metadata      JSONB DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id)
);

-- ────────────────────────────────────────────────────
-- 4. wa_session_events — audit trail for session changes
-- ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_session_events (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   INT NOT NULL REFERENCES wa_tenants(id),
  event_type  TEXT NOT NULL,
  detail      JSONB DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_session_events_tenant ON wa_session_events(tenant_id, created_at DESC);

-- ────────────────────────────────────────────────────
-- 5. wa_messages — outbound + inbound message log
-- ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_messages (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     INT NOT NULL REFERENCES wa_tenants(id),
  direction     TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  wa_jid        TEXT NOT NULL,
  to_e164       TEXT,
  body          TEXT,
  media_url     TEXT,
  media_type    TEXT,
  wa_message_id TEXT,
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','sending','sent','delivered','read','failed')),
  error_message TEXT,
  metadata      JSONB DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_messages_tenant    ON wa_messages(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_messages_status    ON wa_messages(status) WHERE status IN ('queued','sending');
CREATE INDEX IF NOT EXISTS idx_wa_messages_wa_msg_id ON wa_messages(wa_message_id);

-- ────────────────────────────────────────────────────
-- 6. wa_rate_limits — sliding window counters
-- ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_rate_limits (
  id          SERIAL PRIMARY KEY,
  tenant_id   INT NOT NULL REFERENCES wa_tenants(id),
  window_type TEXT NOT NULL CHECK (window_type IN ('daily','monthly')),
  window_key  TEXT NOT NULL,
  counter     INT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, window_type, window_key)
);

-- ────────────────────────────────────────────────────
-- 7. wa_audit_logs — admin actions
-- ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   INT REFERENCES wa_tenants(id),
  actor       TEXT NOT NULL DEFAULT 'system',
  action      TEXT NOT NULL,
  detail      JSONB DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_audit_logs_tenant ON wa_audit_logs(tenant_id, created_at DESC);

-- ────────────────────────────────────────────────────
-- Seed: default tenant (matches DEFAULT_TENANT_ID = 1)
-- ────────────────────────────────────────────────────
INSERT INTO wa_tenants (slug, name, plan, status, daily_limit, monthly_limit)
VALUES ('default', 'Default Tenant', 'enterprise', 'active', 10000, 100000)
ON CONFLICT (slug) DO NOTHING;

-- Record migration
-- INSERT INTO schema_migrations (version, name) VALUES (4, '004_wa_gateway');

COMMIT;
