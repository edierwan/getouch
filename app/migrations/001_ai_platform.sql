-- ─────────────────────────────────────────────────────────
-- Getouch AI Platform — Migration: Settings + Image Tables
-- Apply with: psql $DATABASE_URL -f migrations/001_ai_platform.sql
-- ─────────────────────────────────────────────────────────

BEGIN;

-- ═══ 1. Platform Settings (key-value with JSONB) ═══════

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT        PRIMARY KEY,
  value       JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Seed defaults (idempotent — skip if key already exists)
INSERT INTO settings (key, value) VALUES
  ('ai.default_text_model', '"llama3.1:8b"'),
  ('ai.enable_image',       'true'),
  ('ai.image.max_per_day_free', '5')
ON CONFLICT (key) DO NOTHING;


-- ═══ 2. Image Generation Records ══════════════════════════

CREATE TABLE IF NOT EXISTS images (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor       TEXT        NOT NULL,
  prompt      TEXT        NOT NULL,
  params      JSONB       DEFAULT '{}',
  file_path   TEXT,
  seed        BIGINT,
  status      TEXT        DEFAULT 'pending',  -- pending | processing | done | error
  error_msg   TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_images_actor     ON images (actor);
CREATE INDEX IF NOT EXISTS idx_images_created_at ON images (created_at DESC);


-- ═══ 3. Image Usage Quota Tracking ════════════════════════

CREATE TABLE IF NOT EXISTS image_usage (
  day    DATE   NOT NULL,
  actor  TEXT   NOT NULL,
  count  INT    NOT NULL DEFAULT 0,
  PRIMARY KEY (day, actor)
);


-- ═══ 4. Chat History (optional, for analytics) ═══════════

CREATE TABLE IF NOT EXISTS chat_messages (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor       TEXT        NOT NULL,
  role        TEXT        NOT NULL,   -- 'user' or 'assistant'
  content     TEXT        NOT NULL,
  model       TEXT,
  tokens_in   INT,
  tokens_out  INT,
  latency_ms  INT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_actor ON chat_messages (actor);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages (created_at DESC);

COMMIT;
