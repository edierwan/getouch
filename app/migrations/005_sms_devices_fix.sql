-- ────────────────────────────────────────────────────────────
-- Getouch · Migration 005 — SMS Devices Fix
--
-- Adds pairing_token_hash + pairing_token_last4 columns,
-- backfills from existing device_token values, and adds
-- a CHECK constraint ensuring shared_pool ↔ null tenant.
--
-- Apply: psql $DATABASE_URL -f migrations/005_sms_devices_fix.sql
-- ────────────────────────────────────────────────────────────

BEGIN;

-- 1. Add hash columns (idempotent)
ALTER TABLE sms_devices
  ADD COLUMN IF NOT EXISTS pairing_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS pairing_token_last4 VARCHAR(4);

-- 2. Backfill from plaintext device_token
UPDATE sms_devices
SET pairing_token_hash = encode(sha256(device_token::bytea), 'hex'),
    pairing_token_last4 = RIGHT(device_token, 4)
WHERE pairing_token_hash IS NULL
  AND device_token IS NOT NULL;

-- 3. Make hash columns NOT NULL with a safe default for future rows
ALTER TABLE sms_devices
  ALTER COLUMN pairing_token_hash SET NOT NULL,
  ALTER COLUMN pairing_token_last4 SET NOT NULL;

-- 4. Unique index on hash for lookups
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_devices_token_hash
  ON sms_devices (pairing_token_hash);

-- 5. Add constraint: shared_pool devices must NOT have a tenant
--    (skip if constraint already exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_sms_shared_pool_no_tenant'
  ) THEN
    -- First, fix any existing rows that violate the rule
    UPDATE sms_devices
    SET tenant_id = NULL
    WHERE is_shared_pool = true AND tenant_id IS NOT NULL;

    ALTER TABLE sms_devices
      ADD CONSTRAINT chk_sms_shared_pool_no_tenant
      CHECK (NOT (is_shared_pool = true AND tenant_id IS NOT NULL));
  END IF;
END $$;

COMMIT;
