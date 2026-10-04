-- ============================================================
-- FIDELX FIX #15: ATOMIC VENDOR/RIDER WITHDRAWAL FAILURE
--
-- A Paystack transfer can fail after the user's balance was already
-- reserved at withdrawal request time. Failure handling must therefore
-- mark the withdrawal FAILED and restore that balance in ONE PostgreSQL
-- transaction.
--
-- The old controller did these as two separate operations:
--   1. PROCESSING -> FAILED
--   2. restore available_balance
-- A crash between them left the balance permanently deducted, while a
-- retry could no longer restore it because the row was already FAILED.
--
-- This function atomically claims PROCESSING -> FAILED and restores the
-- full gross amount. Duplicate webhook/reconciliation attempts return
-- FALSE and do not restore the balance a second time.
-- ============================================================

CREATE OR REPLACE FUNCTION fail_vendor_rider_withdrawal(
  p_withdrawal_id UUID,
  p_paystack_status TEXT DEFAULT NULL,
  p_failure_reason TEXT DEFAULT NULL
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
  -- Atomic state claim. Only the first failure handler that still sees
  -- PROCESSING can enter the financial restore below.
  UPDATE withdrawals
  SET status = 'FAILED',
      paystack_status = COALESCE(p_paystack_status, paystack_status),
      failure_reason = p_failure_reason
  WHERE id = p_withdrawal_id
    AND status = 'PROCESSING'
  RETURNING requester_id, gross_amount
    INTO v_requester_id, v_gross_amount;

  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    RETURN FALSE;
  END IF;

  -- Same transaction as the status change above. If this update fails,
  -- PostgreSQL rolls the FAILED status change back too, so reconciliation
  -- can safely retry instead of leaving an unrecoverable state.
  UPDATE balances
  SET available_balance = available_balance + v_gross_amount,
      updated_at = NOW()
  WHERE user_id = v_requester_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Balance row missing for failed withdrawal %', p_withdrawal_id;
  END IF;

  RETURN TRUE;
END;
$$;
