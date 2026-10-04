-- ============================================================
-- TOTP 2FA (admin accounts)
-- ============================================================
-- totp_secret:        base32 secret, set as soon as /2fa/setup is
--                      called but not "live" until totp_enabled=true
--                      (setup can be abandoned without locking anyone out)
-- totp_enabled:        whether login actually requires a code
-- totp_backup_codes:   bcrypt-hashed one-time recovery codes; each is
--                      removed from the array the moment it's used
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS totp_secret TEXT,
  ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS totp_backup_codes TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN users.totp_secret IS
  'Base32 TOTP secret. Written at /2fa/setup; only enforced once totp_enabled=true.';
COMMENT ON COLUMN users.totp_backup_codes IS
  'bcrypt-hashed single-use recovery codes, shown to the admin once at /2fa/enable.';
