-- Migration 007: One-time pairing codes
-- Secure, time-limited pairing links that never expose device_token in URLs.
-- Admin mints a code → short URL/QR → Android app opens deep link → redeems code → gets device_token server-side.

-- ── Table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sms_pair_codes (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash     TEXT         NOT NULL UNIQUE,          -- SHA-256 of the random code
  code_prefix   VARCHAR(6)   NOT NULL,                 -- first 6 chars for admin display
  device_id     UUID         NOT NULL REFERENCES sms_devices(id) ON DELETE CASCADE,
  created_by    TEXT,                                   -- admin email / actor
  expires_at    TIMESTAMPTZ  NOT NULL,
  used_at       TIMESTAMPTZ,                            -- NULL until redeemed
  used_by_ip    INET,                                   -- IP of the device that redeemed
  metadata      JSONB        NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Indexes ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sms_pair_codes_device
  ON sms_pair_codes(device_id);

CREATE INDEX IF NOT EXISTS idx_sms_pair_codes_expires
  ON sms_pair_codes(expires_at)
  WHERE used_at IS NULL;

-- ── Housekeeping: auto-delete expired+used codes after 30 days ─
-- (run via periodic job or manual cleanup)
