-- ────────────────────────────────────────────────────────────
-- Getouch · Migration 003 — SMS Gateway (Multi-tenant SaaS)
--
-- Complete schema for SMS gateway with android-sms-gateway
-- integration. Designed for DB: sms.getouch.co
--
-- Apply: psql $DATABASE_URL -f migrations/003_sms_gateway.sql
-- ────────────────────────────────────────────────────────────

BEGIN;

-- ═══ 1. SMS Tenants ═══════════════════════════════════════
CREATE TABLE IF NOT EXISTS sms_tenants (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255) NOT NULL,
  slug          VARCHAR(100) NOT NULL UNIQUE,
  plan          VARCHAR(50)  NOT NULL DEFAULT 'free',
  status        VARCHAR(20)  NOT NULL DEFAULT 'active',
  settings      JSONB        DEFAULT '{}',
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW(),
  suspended_at  TIMESTAMPTZ,
  CONSTRAINT chk_sms_tenant_status CHECK (status IN ('active', 'suspended', 'disabled')),
  CONSTRAINT chk_sms_tenant_plan   CHECK (plan IN ('free', 'starter', 'business', 'enterprise'))
);

CREATE INDEX IF NOT EXISTS idx_sms_tenants_slug   ON sms_tenants (slug);
CREATE INDEX IF NOT EXISTS idx_sms_tenants_status ON sms_tenants (status);

-- Seed default tenant
INSERT INTO sms_tenants (name, slug, plan, status)
VALUES ('Getouch', 'getouch', 'enterprise', 'active')
ON CONFLICT (slug) DO NOTHING;

-- ═══ 2. SMS API Keys ═════════════════════════════════════
CREATE TABLE IF NOT EXISTS sms_api_keys (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID        NOT NULL REFERENCES sms_tenants(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  key_hash      VARCHAR(255) NOT NULL,
  key_last4     VARCHAR(4)   NOT NULL,
  scopes        TEXT[]       NOT NULL DEFAULT ARRAY['sms:send', 'sms:read'],
  rate_limit_rpm INT         DEFAULT 60,
  is_active     BOOLEAN      DEFAULT true,
  last_used_at  TIMESTAMPTZ,
  last_used_ip  VARCHAR(45),
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  revoked_at    TIMESTAMPTZ,
  CONSTRAINT chk_sms_key_scopes CHECK (
    scopes <@ ARRAY['sms:send', 'sms:read', 'sms:inbox', 'sms:webhooks:manage', 'sms:admin']::TEXT[]
  )
);

CREATE INDEX IF NOT EXISTS idx_sms_api_keys_tenant  ON sms_api_keys (tenant_id);
CREATE INDEX IF NOT EXISTS idx_sms_api_keys_hash    ON sms_api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_sms_api_keys_active  ON sms_api_keys (is_active) WHERE is_active = true;

-- ═══ 3. SMS Devices ══════════════════════════════════════
CREATE TABLE IF NOT EXISTS sms_devices (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        REFERENCES sms_tenants(id) ON DELETE SET NULL,
  name            VARCHAR(255) NOT NULL,
  phone_number    VARCHAR(20),
  device_token    VARCHAR(255) NOT NULL UNIQUE,
  status          VARCHAR(20)  NOT NULL DEFAULT 'offline',
  is_shared_pool  BOOLEAN      DEFAULT false,
  is_enabled      BOOLEAN      DEFAULT true,
  last_seen_at    TIMESTAMPTZ,
  metadata        JSONB        DEFAULT '{}',
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  DEFAULT NOW(),
  CONSTRAINT chk_sms_device_status CHECK (status IN ('online', 'offline', 'degraded', 'disabled'))
);

CREATE INDEX IF NOT EXISTS idx_sms_devices_tenant  ON sms_devices (tenant_id);
CREATE INDEX IF NOT EXISTS idx_sms_devices_status  ON sms_devices (status);
CREATE INDEX IF NOT EXISTS idx_sms_devices_token   ON sms_devices (device_token);
CREATE INDEX IF NOT EXISTS idx_sms_devices_pool    ON sms_devices (is_shared_pool, status) WHERE is_enabled = true;

-- ═══ 4. SMS Device Events ════════════════════════════════
CREATE TABLE IF NOT EXISTS sms_device_events (
  id          BIGSERIAL   PRIMARY KEY,
  device_id   UUID        NOT NULL REFERENCES sms_devices(id) ON DELETE CASCADE,
  event_type  VARCHAR(50) NOT NULL,
  details     JSONB       DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_device_events_device ON sms_device_events (device_id, created_at DESC);

-- ═══ 5. SMS Outbound Messages ════════════════════════════
CREATE TABLE IF NOT EXISTS sms_outbound_messages (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL REFERENCES sms_tenants(id) ON DELETE CASCADE,
  idempotency_key   VARCHAR(255),
  to_number         VARCHAR(20)  NOT NULL,
  from_device_id    UUID        REFERENCES sms_devices(id) ON DELETE SET NULL,
  sender_device_id  UUID        REFERENCES sms_devices(id) ON DELETE SET NULL,
  message_body      TEXT         NOT NULL,
  status            VARCHAR(30)  NOT NULL DEFAULT 'queued',
  attempts          INT          DEFAULT 0,
  max_attempts      INT          DEFAULT 3,
  next_retry_at     TIMESTAMPTZ  DEFAULT NOW(),
  last_error        TEXT,
  error_code        VARCHAR(50),
  external_id       VARCHAR(255),
  metadata          JSONB        DEFAULT '{}',
  created_at        TIMESTAMPTZ  DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  DEFAULT NOW(),
  delivered_at      TIMESTAMPTZ,
  failed_at         TIMESTAMPTZ,
  CONSTRAINT chk_sms_outbound_status CHECK (
    status IN ('queued', 'processing', 'sent', 'delivered', 'failed', 'cancelled')
  ),
  CONSTRAINT uq_sms_outbound_idempotency UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_sms_outbound_tenant   ON sms_outbound_messages (tenant_id);
CREATE INDEX IF NOT EXISTS idx_sms_outbound_status   ON sms_outbound_messages (status, next_retry_at)
  WHERE status IN ('queued', 'processing');
CREATE INDEX IF NOT EXISTS idx_sms_outbound_created  ON sms_outbound_messages (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_outbound_to       ON sms_outbound_messages (to_number);

-- ═══ 6. SMS Inbound Messages ═════════════════════════════
CREATE TABLE IF NOT EXISTS sms_inbound_messages (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID        NOT NULL REFERENCES sms_tenants(id) ON DELETE CASCADE,
  device_id     UUID        REFERENCES sms_devices(id) ON DELETE SET NULL,
  from_number   VARCHAR(20)  NOT NULL,
  to_number     VARCHAR(20),
  message_body  TEXT         NOT NULL,
  received_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  external_id   VARCHAR(255),
  metadata      JSONB        DEFAULT '{}',
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_inbound_tenant   ON sms_inbound_messages (tenant_id);
CREATE INDEX IF NOT EXISTS idx_sms_inbound_device   ON sms_inbound_messages (device_id);
CREATE INDEX IF NOT EXISTS idx_sms_inbound_from     ON sms_inbound_messages (from_number);
CREATE INDEX IF NOT EXISTS idx_sms_inbound_created  ON sms_inbound_messages (created_at DESC);

-- ═══ 7. SMS Message Status Events (timeline) ═════════════
CREATE TABLE IF NOT EXISTS sms_message_status_events (
  id          BIGSERIAL   PRIMARY KEY,
  message_id  UUID        NOT NULL,
  direction   VARCHAR(10) NOT NULL DEFAULT 'outbound',
  status      VARCHAR(30) NOT NULL,
  details     JSONB       DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_sms_status_direction CHECK (direction IN ('outbound', 'inbound'))
);

CREATE INDEX IF NOT EXISTS idx_sms_status_events_msg ON sms_message_status_events (message_id, created_at);

-- ═══ 8. SMS Webhooks ═════════════════════════════════════
CREATE TABLE IF NOT EXISTS sms_webhooks (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL REFERENCES sms_tenants(id) ON DELETE CASCADE,
  event_type      VARCHAR(50) NOT NULL,
  url             TEXT        NOT NULL,
  signing_secret  VARCHAR(255) NOT NULL,
  is_active       BOOLEAN     DEFAULT true,
  retry_policy    JSONB       DEFAULT '{"max_retries": 3, "backoff_ms": 1000}',
  last_triggered  TIMESTAMPTZ,
  last_status     INT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_sms_webhook_event CHECK (
    event_type IN ('sms.sent', 'sms.delivered', 'sms.failed', 'sms.inbound', 'device.status')
  )
);

CREATE INDEX IF NOT EXISTS idx_sms_webhooks_tenant ON sms_webhooks (tenant_id);
CREATE INDEX IF NOT EXISTS idx_sms_webhooks_event  ON sms_webhooks (event_type, is_active);

-- ═══ 9. SMS Audit Logs ══════════════════════════════════
CREATE TABLE IF NOT EXISTS sms_audit_logs (
  id          BIGSERIAL   PRIMARY KEY,
  tenant_id   UUID        REFERENCES sms_tenants(id) ON DELETE SET NULL,
  actor       VARCHAR(255) NOT NULL,
  action      VARCHAR(100) NOT NULL,
  resource    VARCHAR(100),
  resource_id VARCHAR(255),
  details     JSONB        DEFAULT '{}',
  ip_address  VARCHAR(45),
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_audit_tenant  ON sms_audit_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_audit_action  ON sms_audit_logs (action);

-- ═══ 10. SMS Rate Limits ════════════════════════════════
CREATE TABLE IF NOT EXISTS sms_rate_limits (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES sms_tenants(id) ON DELETE CASCADE,
  api_key_id  UUID        REFERENCES sms_api_keys(id) ON DELETE CASCADE,
  window_ms   INT         NOT NULL DEFAULT 60000,
  max_requests INT        NOT NULL DEFAULT 60,
  scope       VARCHAR(50) NOT NULL DEFAULT 'global',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_sms_rate_scope CHECK (scope IN ('global', 'sms:send', 'sms:read'))
);

CREATE INDEX IF NOT EXISTS idx_sms_rate_limits_tenant ON sms_rate_limits (tenant_id);

-- ═══ 11. SMS Worker Health ══════════════════════════════
CREATE TABLE IF NOT EXISTS sms_worker_health (
  id              VARCHAR(50) PRIMARY KEY DEFAULT 'main',
  last_heartbeat  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  messages_processed INT     DEFAULT 0,
  status          VARCHAR(20) DEFAULT 'running',
  metadata        JSONB      DEFAULT '{}'
);

INSERT INTO sms_worker_health (id, last_heartbeat, status)
VALUES ('main', NOW(), 'stopped')
ON CONFLICT (id) DO NOTHING;

COMMIT;
