-- Migration 009: Web research cache + default settings
-- Supports the web browsing / research feature

-- ── Web cache table ────────────────────────────────────
CREATE TABLE IF NOT EXISTS web_cache (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key   TEXT NOT NULL UNIQUE,       -- hash(normalizedQuery + urls)
  query       TEXT NOT NULL,
  urls        TEXT[],
  results     JSONB NOT NULL,             -- [{url, title, text}]
  provider    TEXT,                        -- 'searxng' | 'tavily' | 'serpapi'
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_web_cache_key     ON web_cache (cache_key);
CREATE INDEX IF NOT EXISTS idx_web_cache_expires ON web_cache (expires_at);

-- ── Default settings for web research ──────────────────
INSERT INTO settings (key, value) VALUES
  ('web_research.enabled',           'false'),
  ('web_research.search_provider',   '"searxng"'),
  ('web_research.searxng_url',       '"http://searxng:8080"'),
  ('web_research.max_sources',       '4'),
  ('web_research.max_fetch',         '4'),
  ('web_research.allowed_domains',   '""'),
  ('web_research.blocked_domains',   '"localhost,127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"'),
  ('web_research.cache_ttl_minutes', '30'),
  ('web_research.timeout_seconds',   '8')
ON CONFLICT (key) DO NOTHING;
