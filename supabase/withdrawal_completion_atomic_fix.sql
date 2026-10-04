-- ============================================================
-- ATOMIC VENDOR/RIDER WITHDRAWAL COMPLETION
--
-- Completes the withdrawal AND all money-side accounting in one
-- PostgreSQL transaction. If any statement fails, the whole transaction
-- rolls back, so a later reconciliation/webhook retry can safely retry.
-- ============================================================

CREATE OR REPLACE FUNCTION complete_vendor_rider_withdrawal(
  p_withdrawal_id UUID,
  p_paystack_status TEXT DEFAULT 'success'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_requester_id UUID;
  v_gross_amount NUMERIC;
  v_withdrawal_fee NUMERIC;
  v_net_payout NUMERIC;
  v_account_name TEXT;
  v_claimed INT;
BEGIN
  -- Atomic claim. Only one webhook/reconciliation worker can complete it.
  UPDATE withdrawals
  SET status = 'COMPLETED',
      paystack_status = p_paystack_status,
      completed_at = NOW()
  WHERE id = p_withdrawal_id
    AND status = 'PROCESSING'
  RETURNING requester_id, gross_amount, withdrawal_fee, net_payout, account_name
    INTO v_requester_id, v_gross_amount, v_withdrawal_fee, v_net_payout, v_account_name;

  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    RETURN FALSE;
  END IF;

  -- This now happens in the same transaction as the status claim.
  UPDATE balances
  SET total_withdrawn = total_withdrawn + v_gross_amount,
      updated_at = NOW()
  WHERE user_id = v_requester_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Balance row missing for completed withdrawal %', p_withdrawal_id;
  END IF;

  -- One completion ledger row per withdrawal. The unique reference/type
  -- index makes this safe if an old/manual row already exists.
  INSERT INTO ledger_entries
    (id, reference, type, amount, fee, net, source, destination, actor_id, description)
  VALUES
    (gen_random_uuid(), p_withdrawal_id, 'WITHDRAWAL_COMPLETED',
     v_gross_amount, v_withdrawal_fee, v_net_payout,
     'withdrawal_queue', 'bank_account', NULL,
     'Withdrawal paid to ' || COALESCE(v_account_name, 'bank account'))
  ON CONFLICT (reference, type) DO NOTHING;

  -- Idempotent platform fee revenue. FALSE means it was already booked;
  -- that is not an error and must not roll back the successful withdrawal.
  IF COALESCE(v_withdrawal_fee, 0) > 0 THEN
    PERFORM credit_withdrawal_fee_revenue(
      p_withdrawal_id, v_withdrawal_fee, NULL
    );
  END IF;

  RETURN TRUE;
END;
$$;
