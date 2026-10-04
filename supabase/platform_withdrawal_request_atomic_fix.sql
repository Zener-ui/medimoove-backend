-- Fix #14: make platform-withdrawal creation atomic.
-- Prevents a balance deduction from succeeding without a withdrawal/ledger row,
-- and prevents two concurrent platform withdrawal requests from both passing
-- the application-level "pending" check.

CREATE OR REPLACE FUNCTION create_platform_withdrawal_atomic(
  p_withdrawal_id UUID,
  p_requested_by UUID,
  p_amount NUMERIC,
  p_bank_account TEXT,
  p_bank_code TEXT,
  p_bank_name TEXT,
  p_account_name TEXT
) RETURNS platform_withdrawals
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_withdrawal platform_withdrawals;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid withdrawal amount';
  END IF;

  -- Lock the single platform account row. This serializes platform
  -- withdrawal requests and the balance deduction with this transaction.
  PERFORM 1 FROM platform_accounts
  WHERE id = '00000000-0000-0000-0000-000000000001'
  FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM platform_withdrawals
    WHERE status IN ('PENDING','PROCESSING')
  ) THEN
    RAISE EXCEPTION 'A platform withdrawal is already pending or processing';
  END IF;

  UPDATE platform_accounts
  SET available_balance = available_balance - p_amount,
      updated_at = NOW()
  WHERE id = '00000000-0000-0000-0000-000000000001'
    AND available_balance >= p_amount;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient platform balance';
  END IF;

  INSERT INTO platform_withdrawals (
    id, requested_by, amount, bank_account, bank_code,
    bank_name, account_name, status
  ) VALUES (
    p_withdrawal_id, p_requested_by, p_amount,
    TRIM(p_bank_account), TRIM(p_bank_code),
    TRIM(p_bank_name), TRIM(p_account_name), 'PENDING'
  )
  RETURNING * INTO v_withdrawal;

  INSERT INTO platform_ledger_entries (
    id, reference, source_type, amount, description, actor_id
  ) VALUES (
    gen_random_uuid(), p_withdrawal_id, 'PLATFORM_WITHDRAWAL', -p_amount,
    'Platform withdrawal request of ₦' || TO_CHAR(p_amount, 'FM999999999990.00'),
    p_requested_by
  );

  RETURN v_withdrawal;
END;
$$;
