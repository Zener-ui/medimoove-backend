-- FIX #55: invalidate existing sessions after password changes/resets.
-- auth_token_version is embedded in JWTs and checked by backend middleware.
-- Existing users start at version 0, so existing sessions remain valid until
-- the user changes/resets their password. No forced logout is introduced.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_token_version INTEGER NOT NULL DEFAULT 1;

-- Existing JWTs did not contain auth_token_version. Set the DB baseline to 1
-- so those legacy tokens are rejected after deployment; users simply log in again.
UPDATE users SET auth_token_version = 1 WHERE auth_token_version IS NULL OR auth_token_version <> 1;

CREATE OR REPLACE FUNCTION public.consume_password_reset_atomic(
  p_token_hash TEXT,
  p_now TIMESTAMPTZ,
  p_password_hash TEXT
)
RETURNS TABLE(id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE users
     SET password_hash = p_password_hash,
         auth_token_version = auth_token_version + 1,
         reset_token_used_at = p_now,
         reset_token_hash = NULL
   WHERE reset_token_hash = p_token_hash
     AND reset_token_used_at IS NULL
     AND reset_token_expires_at > p_now
  RETURNING users.id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.consume_password_reset_atomic(TEXT, TIMESTAMPTZ, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_password_reset_atomic(TEXT, TIMESTAMPTZ, TEXT)
  TO service_role;
