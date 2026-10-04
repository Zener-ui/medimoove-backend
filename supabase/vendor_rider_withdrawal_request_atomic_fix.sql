-- Fidelx Fix #47 — Vendor/rider withdrawal request atomicity
--
-- The old request path deducted balances, inserted the withdrawal row, and
-- inserted the WITHDRAWAL_REQUEST ledger entry as separate operations. A
-- failure/crash during the ledger step could therefore leave the balance,
-- withdrawal queue, and ledger out of sync. This function makes the whole
-- request one PostgreSQL transaction.

CREATE OR REPLACE FUNCTION create_vendor_rider_withdrawal_atomic(
  p_withdrawal_id UUID,
  p_requester_id UUID,
  p_requester_type TEXT,
  p_vendor_id UUID,
  p_rider_id UUID,
  p_gross_amount NUMERIC,
  p_withdrawal_fee NUMERIC,
  p_net_payout NUMERIC,
  p_fee_percentage NUMERIC,
  p_fee_cap NUMERIC,
  p_fee_was_capped BOOLEAN,
  p_bank_account TEXT,
  p_bank_code TEXT,
  p_bank_name TEXT,
  p_account_name TEXT
)
RETURNS withdrawals
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_balance NUMERIC;
  v_withdrawal withdrawals%ROWTYPE;
BEGIN
  IF p_requester_type NOT IN ('vendor', 'rider') THEN
    RAISE EXCEPTION 'Invalid withdrawal requester type';
  END IF;

  IF p_gross_amount <= 0 OR p_net_payout < 0 OR p_withdrawal_fee < 0 THEN
    RAISE EXCEPTION 'Invalid withdrawal amounts';
  END IF;

  IF p_requester_type = 'vendor' AND p_vendor_id IS NULL THEN
    RAISE EXCEPTION 'Vendor withdrawal requires vendor_id';
  END IF;
  IF p_requester_type = 'rider' AND p_rider_id IS NULL THEN
    RAISE EXCEPTION 'Rider withdrawal requires rider_id';
  END IF;

  -- Serialize withdrawal requests for this user through the balance row.
  SELECT available_balance INTO v_balance
  FROM balances
  WHERE user_id = p_requester_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Balance account not found';
  END IF;

  IF EXISTS (
    SELECT 1 FROM withdrawals
    WHERE requester_id = p_requester_id
      AND status = 'PENDING'
  ) THEN
    RAISE EXCEPTION 'You already have a pending withdrawal';
  END IF;

  IF v_balance < p_gross_amount THEN
    RAISE EXCEPTION 'Insufficient balance';
  END IF;

  UPDATE balances
  SET available_balance = available_balance - p_gross_amount,
      updated_at = NOW()
  WHERE user_id = p_requester_id;

  INSERT INTO withdrawals (
    id, requester_id, requester_type, vendor_id, rider_id,
    gross_amount, withdrawal_fee, net_payout, fee_percentage, fee_cap,
    fee_was_capped, bank_account, bank_code, bank_name, account_name,
    status, requested_at
  ) VALUES (
    p_withdrawal_id, p_requester_id, p_requester_type, p_vendor_id, p_rider_id,
    p_gross_amount, p_withdrawal_fee, p_net_payout, p_fee_percentage, p_fee_cap,
    p_fee_was_capped, p_bank_account, p_bank_code, p_bank_name, p_account_name,
    'PENDING', NOW()
  )
  RETURNING * INTO v_withdrawal;

  INSERT INTO ledger_entries (
    id, reference, type, amount, fee, net, source, destination, actor_id, description
  ) VALUES (
    gen_random_uuid(), p_withdrawal_id, 'WITHDRAWAL_REQUEST',
    p_gross_amount, p_withdrawal_fee, p_net_payout,
    p_requester_type || '_balance', 'withdrawal_queue', p_requester_id::TEXT,
    p_requester_type || ' withdrawal request of ₦' || p_gross_amount
  );

  RETURN v_withdrawal;
END;
$$;

REVOKE ALL ON FUNCTION create_vendor_rider_withdrawal_atomic(UUID, UUID, TEXT, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_vendor_rider_withdrawal_atomic(UUID, UUID, TEXT, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, TEXT, TEXT, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
