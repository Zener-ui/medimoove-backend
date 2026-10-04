-- ============================================================
-- FIDELX FIX #16: ATOMIC VENDOR/RIDER WITHDRAWAL REJECTION
--
-- A withdrawal rejection must mark the withdrawal REJECTED and restore
-- the reserved balance in the same PostgreSQL transaction. Otherwise a
-- crash between those two operations can leave the withdrawal REJECTED
-- while the user's balance remains permanently deducted.
-- ============================================================

CREATE OR REPLACE FUNCTION reject_vendor_rider_withdrawal(
  p_withdrawal_id UUID,
  p_admin_id UUID,
  p_rejection_reason TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_requester_id UUID;
  v_gross_amount NUMERIC;
  v_claimed INT;
BEGIN
  UPDATE withdrawals
  SET status = 'REJECTED',
      rejection_reason = p_rejection_reason,
      admin_reviewer_id = p_admin_id,
      reviewed_at = NOW()
  WHERE id = p_withdrawal_id
    AND status = 'PENDING'
  RETURNING requester_id, gross_amount
    INTO v_requester_id, v_gross_amount;

  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    RETURN FALSE;
  END IF;

  UPDATE balances
  SET available_balance = available_balance + v_gross_amount,
      updated_at = NOW()
  WHERE user_id = v_requester_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Balance row missing for rejected withdrawal %', p_withdrawal_id;
  END IF;

  RETURN TRUE;
END;
$$;
