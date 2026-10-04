-- Fidelx Fix #9: make platform withdrawal failure handling atomic.
-- Run this migration AFTER the existing financial/platform revenue migrations.
-- A failure/reversal can be delivered more than once; only the first call
-- transitions CLAIMED/PROCESSING -> FAILED and restores the reserved balance.

CREATE OR REPLACE FUNCTION fail_platform_withdrawal(
  p_withdrawal_id UUID,
  p_failure_reason TEXT DEFAULT NULL,
  p_paystack_status TEXT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_amount NUMERIC;
  v_claimed INT;
BEGIN
  UPDATE platform_withdrawals
  SET status = 'FAILED',
      paystack_status = COALESCE(p_paystack_status, paystack_status),
      failure_reason = p_failure_reason,
      reviewed_at = COALESCE(reviewed_at, NOW())
  WHERE id = p_withdrawal_id
    AND status IN ('CLAIMED', 'PROCESSING')
  RETURNING amount INTO v_amount;

  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN RETURN FALSE; END IF;

  UPDATE platform_accounts
  SET available_balance = available_balance + v_amount,
      updated_at = NOW()
  WHERE id = '00000000-0000-0000-0000-000000000001';

  RETURN TRUE;
END;
$$;
