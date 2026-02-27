-- Migration 011: Production Pipeline Enhancement
-- Adds new settings for comprehensive pipeline, tool registry, and enhanced analytics
-- All operations are idempotent (ON CONFLICT DO NOTHING)

-- ═══════════════════════════════════════════════════════════
-- New settings for enhanced pipeline
-- ═══════════════════════════════════════════════════════════

-- Smalltalk stabilizer (prevents dialect overcompensation)
INSERT INTO settings (key, value) VALUES
  ('ai.smalltalk_stabilizer', 'true')
ON CONFLICT (key) DO NOTHING;

-- Dialect mirroring level: 'off', 'light', 'medium'
INSERT INTO settings (key, value) VALUES
  ('ai.dialect_mirroring_level', '"light"')
ON CONFLICT (key) DO NOTHING;

-- Document pipeline limits (configurable per guest/registered)
INSERT INTO settings (key, value) VALUES
  ('limits.max_file_size_mb', '20')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('limits.max_pdf_pages_guest', '15')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('limits.max_pdf_pages_registered', '50')
ON CONFLICT (key) DO NOTHING;

-- Guest limits (daily)
INSERT INTO settings (key, value) VALUES
  ('guest.chat_per_day', '50')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('guest.doc_per_day', '5')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('guest.image_per_day', '3')
ON CONFLICT (key) DO NOTHING;

-- 2nd visit push register toggle
INSERT INTO settings (key, value) VALUES
  ('guest.require_register_after_n', '5')
ON CONFLICT (key) DO NOTHING;

-- Tool toggles (all disabled by default)
INSERT INTO settings (key, value) VALUES
  ('tool.order_lookup.enabled', 'false')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('tool.points_lookup.enabled', 'false')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('tool.qr_verify.enabled', 'false')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('tool.db_read.enabled', 'false')
ON CONFLICT (key) DO NOTHING;

-- ═══════════════════════════════════════════════════════════
-- Enhanced usage_events: add route_type column if not exists
-- ═══════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'usage_events' AND column_name = 'route_type'
  ) THEN
    ALTER TABLE usage_events ADD COLUMN route_type VARCHAR(50);
  END IF;
END $$;

-- Add index for route_type analytics
CREATE INDEX IF NOT EXISTS idx_usage_events_route_type
  ON usage_events (route_type) WHERE route_type IS NOT NULL;

-- Add index for daily reporting
CREATE INDEX IF NOT EXISTS idx_usage_events_created_date
  ON usage_events (created_at DESC, event_type);

-- Composite index for guest limit queries
CREATE INDEX IF NOT EXISTS idx_usage_events_visitor_daily
  ON usage_events (visitor_id, event_type, created_at DESC)
  WHERE status = 'ok';

-- ═══════════════════════════════════════════════════════════
-- Pipeline audit log table (for detailed routing decisions)
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pipeline_audit (
  id            BIGSERIAL PRIMARY KEY,
  request_id    UUID NOT NULL,
  visitor_id    VARCHAR(64),
  user_id       INTEGER,
  route_type    VARCHAR(50) NOT NULL,
  intent        VARCHAR(50),
  language      VARCHAR(10),
  dialect       VARCHAR(20),
  formality     VARCHAR(20),
  model_used    VARCHAR(100),
  duration_ms   INTEGER,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  status        VARCHAR(20) DEFAULT 'ok',
  error_message TEXT,
  meta          JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_audit_created
  ON pipeline_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_audit_route
  ON pipeline_audit (route_type, created_at DESC);

-- ═══════════════════════════════════════════════════════════
-- Update limits.max_pdf_pages default from 5 to 15
-- ═══════════════════════════════════════════════════════════

UPDATE settings SET value = '15'
WHERE key = 'limits.max_pdf_pages' AND value = '5';
