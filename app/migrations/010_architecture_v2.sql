-- Migration 010: Architecture V2 — Router, Intent, Dialect, Personality
-- Adds route_type tracking to usage_events metadata and new config settings

-- Add router-related default settings
INSERT INTO settings (key, value) VALUES
  ('ai.personality_enabled', '"true"')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('ai.dialect_mirroring', '"true"')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('ai.smalltalk_max_tokens', '256')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('ai.task_max_tokens', '2048')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('ai.general_max_tokens', '1024')
ON CONFLICT (key) DO NOTHING;

-- Performance guard defaults
INSERT INTO settings (key, value) VALUES
  ('limits.max_upload_mb', '20')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('limits.max_pdf_pages', '5')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('limits.max_sheets', '3')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('limits.max_rows_per_sheet', '50')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('limits.max_web_sources', '4')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('limits.max_context_chars', '120000')
ON CONFLICT (key) DO NOTHING;
