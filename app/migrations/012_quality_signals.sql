-- Migration 012: Conversation Context & Quality Signals
-- Adds quality_signals table for thumbs up/down feedback
-- Adds conversation context support columns

-- Quality signals table (thumbs up/down on bot responses)
CREATE TABLE IF NOT EXISTS quality_signals (
  id            SERIAL PRIMARY KEY,
  visitor_id    TEXT NOT NULL,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  rating        TEXT NOT NULL CHECK (rating IN ('up', 'down')),
  route_type    TEXT,
  model         TEXT,
  response_length INTEGER DEFAULT 0,
  environment   TEXT NOT NULL DEFAULT 'prod',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quality_signals_visitor ON quality_signals(visitor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quality_signals_route   ON quality_signals(route_type, rating);
CREATE INDEX IF NOT EXISTS idx_quality_signals_env     ON quality_signals(environment, created_at DESC);

-- Add conversation context columns to pipeline_audit if not exists
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pipeline_audit' AND column_name = 'turn_count'
  ) THEN
    ALTER TABLE pipeline_audit ADD COLUMN turn_count INTEGER DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pipeline_audit' AND column_name = 'decoding_config'
  ) THEN
    ALTER TABLE pipeline_audit ADD COLUMN decoding_config JSONB;
  END IF;
END $$;
