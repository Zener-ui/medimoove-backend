-- Fix #54: password reset token consumption is atomic.
--
-- The application now consumes the token with one conditional UPDATE:
--   matching hash + unused + unexpired -> set password + mark used + clear hash
-- PostgreSQL guarantees that concurrent UPDATEs serialize on the same row,
-- so only one request can consume a given reset token.
--
-- No schema change is required. This migration is intentionally a documented
-- deployment marker for the password-reset concurrency fix.

COMMENT ON COLUMN users.reset_token_used_at IS
  'Set atomically with password_hash and reset_token_hash clearing when a reset token is consumed; token is single-use under concurrent requests.';
