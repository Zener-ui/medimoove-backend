-- ============================================================
-- FIX #28 — ATOMIC REGISTRATION + INVITE CONSUMPTION
--
-- A registration previously consumed an invite code in one request, then
-- created the user/onboarding records in later requests.  A DB/network
-- failure between those steps could burn a valid invite without creating
-- an account.  This function makes the account + default records + invite
-- consumption one PostgreSQL transaction.
-- ============================================================

CREATE OR REPLACE FUNCTION register_user_atomic(
  p_user_id UUID,
  p_email TEXT,
  p_phone TEXT,
  p_password_hash TEXT,
  p_role TEXT,
  p_full_name TEXT,
  p_invite_code_id UUID DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  email TEXT,
  phone TEXT,
  role TEXT,
  full_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invite_id UUID;
BEGIN
  IF p_role NOT IN ('customer', 'vendor', 'rider') THEN
    RAISE EXCEPTION 'Invalid role.' USING ERRCODE = '22023';
  END IF;

  -- Claim the invite inside this same transaction.  The conditional update
  -- is the race protection: only one concurrent registration can consume it.
  IF p_invite_code_id IS NOT NULL THEN
    UPDATE invite_codes
       SET is_used = TRUE,
           used_at = NOW(),
           used_by = p_user_id
     WHERE id = p_invite_code_id
       AND role = p_role
       AND is_used = FALSE
       AND (expires_at IS NULL OR expires_at >= NOW())
     RETURNING invite_codes.id INTO v_invite_id;

    IF v_invite_id IS NULL THEN
      RAISE EXCEPTION 'Invite code is unavailable.' USING ERRCODE = 'INVITE_UNAVAILABLE';
    END IF;
  END IF;

  INSERT INTO users (id, email, phone, password_hash, role, full_name, is_active)
  VALUES (p_user_id, p_email, p_phone, p_password_hash, p_role, p_full_name, TRUE);

  INSERT INTO onboarding_progress (id, user_id, role)
  VALUES (gen_random_uuid(), p_user_id, p_role);

  INSERT INTO notification_preferences (id, user_id)
  VALUES (gen_random_uuid(), p_user_id);

  RETURN QUERY
  SELECT u.id, u.email, u.phone, u.role, u.full_name
    FROM users u
   WHERE u.id = p_user_id;
END;
$$;

-- This is a backend-only registration primitive.  Do not expose it through
-- PostgREST to anon/authenticated clients; the Node backend calls it with
-- the Supabase service role client.
REVOKE EXECUTE ON FUNCTION register_user_atomic(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION register_user_atomic(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID)
  TO service_role;
