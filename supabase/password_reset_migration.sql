-- ============================================================
-- PASSWORD RESET — MIGRATION
-- Stores only a hash of the reset token (never the raw token —
-- the raw value only ever exists in the emailed link and in
-- memory for the moment it's checked). Single-use via
-- reset_token_used_at; expiry enforced in application code
-- against reset_token_expires_at.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS reset_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reset_token_used_at TIMESTAMPTZ;

-- Fast lookup when verifying a submitted token's hash
CREATE INDEX IF NOT EXISTS idx_users_reset_token_hash ON users(reset_token_hash) WHERE reset_token_hash IS NOT NULL;
