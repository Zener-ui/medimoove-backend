-- Fix #53: atomically consume a one-time admin TOTP backup code.
--
-- The bcrypt comparison happens in Node, because PostgreSQL does not need to
-- know the plaintext code. The database receives the exact backup-code array
-- that Node verified and performs a compare-and-swap update. If two login
-- requests race, only the first update can match the expected array; the
-- second returns false and cannot mint another session from the same code.

CREATE OR REPLACE FUNCTION public.consume_admin_backup_code_atomic(
  p_user_id UUID,
  p_expected_codes TEXT[],
  p_remaining_codes TEXT[]
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE public.users
     SET totp_backup_codes = p_remaining_codes
   WHERE id = p_user_id
     AND totp_backup_codes = p_expected_codes;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count = 1;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.consume_admin_backup_code_atomic(UUID, TEXT[], TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_admin_backup_code_atomic(UUID, TEXT[], TEXT[]) TO service_role;
