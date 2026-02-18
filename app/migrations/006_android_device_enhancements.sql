-- Migration 006: Android Device Enhancements
-- Adds device_info storage and improves metadata handling for Android SMS Gateway clients.
-- Ensures metadata column has a non-null default and adds an index for online device lookups.

-- Ensure metadata has a default
ALTER TABLE sms_devices ALTER COLUMN metadata SET DEFAULT '{}'::jsonb;
UPDATE sms_devices SET metadata = '{}'::jsonb WHERE metadata IS NULL;
ALTER TABLE sms_devices ALTER COLUMN metadata SET NOT NULL;

-- Add index for fast online device lookups (used by heartbeat + pull-outbound)
CREATE INDEX IF NOT EXISTS idx_sms_devices_status_enabled
  ON sms_devices (status, is_enabled)
  WHERE is_enabled = true;

-- Add index for device_token lookups (used by pair/heartbeat/pull)
CREATE INDEX IF NOT EXISTS idx_sms_devices_token
  ON sms_devices (device_token)
  WHERE device_token IS NOT NULL;

-- Add index for queued outbound message polling (critical for pull-outbound performance)
CREATE INDEX IF NOT EXISTS idx_sms_outbound_queued
  ON sms_outbound_messages (status, next_retry_at)
  WHERE status = 'queued';
