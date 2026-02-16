-- ────────────────────────────────────────────────────────────
-- Getouch · Migration 002 — Dual Environment (prod / dev)
--
-- Adds `environment` column to key tables and creates
-- validation constraints for environment routing.
--
-- Apply: psql $DATABASE_URL -f migrations/002_dual_environment.sql
-- ────────────────────────────────────────────────────────────

BEGIN;

-- ═══ 1. Add environment column to api_keys ═══════════════

DO $$ BEGIN
  ALTER TABLE api_keys ADD COLUMN environment VARCHAR(4) NOT NULL DEFAULT 'prod';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE api_keys ADD CONSTRAINT chk_api_keys_environment
    CHECK (environment IN ('prod', 'dev'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_api_keys_environment ON api_keys (environment);

-- ═══ 2. Add environment column to chat_messages ══════════

DO $$ BEGIN
  ALTER TABLE chat_messages ADD COLUMN environment VARCHAR(4) NOT NULL DEFAULT 'prod';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE chat_messages ADD CONSTRAINT chk_chat_messages_environment
    CHECK (environment IN ('prod', 'dev'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_chat_messages_environment ON chat_messages (environment);

-- ═══ 3. Add environment column to images ═════════════════

DO $$ BEGIN
  ALTER TABLE images ADD COLUMN environment VARCHAR(4) NOT NULL DEFAULT 'prod';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE images ADD CONSTRAINT chk_images_environment
    CHECK (environment IN ('prod', 'dev'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_images_environment ON images (environment);

-- ═══ 4. Add environment column to image_usage ════════════

DO $$ BEGIN
  ALTER TABLE image_usage ADD COLUMN environment VARCHAR(4) NOT NULL DEFAULT 'prod';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE image_usage ADD CONSTRAINT chk_image_usage_environment
    CHECK (environment IN ('prod', 'dev'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Drop old PK and create new composite PK with environment
-- (only if the old PK exists without environment)
DO $$ BEGIN
  -- Re-create PK to include environment
  ALTER TABLE image_usage DROP CONSTRAINT IF EXISTS image_usage_pkey;
  ALTER TABLE image_usage ADD PRIMARY KEY (day, actor, environment);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ═══ 5. Add environment column to api_key_usage_log ══════

DO $$ BEGIN
  ALTER TABLE api_key_usage_log ADD COLUMN environment VARCHAR(4) NOT NULL DEFAULT 'prod';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_usage_log_environment ON api_key_usage_log (environment);

-- ═══ 6. Seed environment quotas in settings ══════════════

INSERT INTO settings (key, value) VALUES
  ('ai.image.max_per_day_free.prod', '10'),
  ('ai.image.max_per_day_free.dev', '50'),
  ('rate_limit.chat.prod', '15'),
  ('rate_limit.chat.dev', '60'),
  ('rate_limit.image.prod', '5'),
  ('rate_limit.image.dev', '20')
ON CONFLICT (key) DO NOTHING;

COMMIT;
