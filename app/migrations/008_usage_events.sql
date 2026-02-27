-- Migration 008: Usage events tracking + guest limits
-- Tracks all AI usage (chat, image) for analytics and guest rate limiting

-- ── Usage events table ─────────────────────────────────
CREATE TABLE IF NOT EXISTS usage_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id  TEXT NOT NULL,
  user_id     UUID,
  event_type  TEXT NOT NULL,        -- 'chat' | 'image'
  mode        TEXT,                 -- 'text' | 'vision' | 'sdxl' | 'flux'
  model       TEXT,                 -- model name used
  status      TEXT DEFAULT 'ok',    -- 'ok' | 'error' | 'rate_limited'
  latency_ms  INTEGER,
  input_len   INTEGER,              -- message length or prompt length
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  environment TEXT DEFAULT 'prod',
  meta        JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for reporting queries
CREATE INDEX IF NOT EXISTS idx_usage_events_created    ON usage_events (created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_visitor    ON usage_events (visitor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_user       ON usage_events (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_type       ON usage_events (event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_type_env   ON usage_events (event_type, environment, created_at);

-- ── Guest limit default settings ───────────────────────
INSERT INTO settings (key, value) VALUES
  ('guest.chat_per_hour',         '20'),
  ('guest.images_per_day',        '3'),
  ('guest.soft_gate_after_chats', '5'),
  ('guest.soft_gate_after_images','2')
ON CONFLICT (key) DO NOTHING;
