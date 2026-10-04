-- Fidelx Fix #46 — Promotions funding completion recovery
--
-- Prevents a stale/pending funding transaction whose DEPOSIT ledger row
-- already exists from crediting promotions_budget a second time.
--
-- This is a recovery guard: the ledger row is written in the same
-- transaction as the budget credit by the normal path, but an existing
-- ledger row can be present after older deployments or manual recovery.
-- In that state, the ledger is the evidence that the deposit was already
-- applied, so the function must not increment the budget again.

CREATE OR REPLACE FUNCTION complete_promotions_funding(
  p_reference TEXT,
  p_paystack_fee NUMERIC DEFAULT 0
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_funding promotions_funding_transactions%ROWTYPE;
  v_ledger_exists BOOLEAN;
BEGIN
  SELECT * INTO v_funding
  FROM promotions_funding_transactions
  WHERE reference = p_reference
  FOR UPDATE;

  IF NOT FOUND THEN RETURN FALSE; END IF;

  -- A successful funding transaction is already financially completed.
  -- On retries, repair only a missing ledger row; never credit the budget
  -- again.
  IF v_funding.status = 'successful' THEN
    SELECT EXISTS (
      SELECT 1
      FROM promotions_ledger_entries
      WHERE reference = v_funding.id
        AND type = 'DEPOSIT'
    ) INTO v_ledger_exists;

    IF NOT v_ledger_exists THEN
      INSERT INTO promotions_ledger_entries (
        reference, type, amount, description, actor_id
      ) VALUES (
        v_funding.id,
        'DEPOSIT',
        v_funding.amount,
        COALESCE(v_funding.description, 'Paystack promotions funding'),
        v_funding.admin_id
      );
    END IF;

    RETURN TRUE;
  END IF;

  IF v_funding.status <> 'pending' THEN RETURN FALSE; END IF;

  -- Recovery guard: if the deposit ledger already exists, the budget
  -- credit belongs to this funding transaction and must not be repeated.
  SELECT EXISTS (
    SELECT 1
    FROM promotions_ledger_entries
    WHERE reference = v_funding.id
      AND type = 'DEPOSIT'
  ) INTO v_ledger_exists;

  IF v_ledger_exists THEN
    UPDATE promotions_funding_transactions
    SET status = 'successful',
        paystack_fee = COALESCE(p_paystack_fee, paystack_fee, 0),
        paystack_status = 'success',
        paid_at = COALESCE(paid_at, NOW()),
        updated_at = NOW()
    WHERE id = v_funding.id
      AND status = 'pending';

    RETURN TRUE;
  END IF;

  -- No deposit ledger exists, so this transaction has not yet been
  -- financially completed. Credit the budget and create its ledger row
  -- in the same PostgreSQL transaction.
  UPDATE promotions_budget
  SET balance = balance + v_funding.amount,
      total_deposited = total_deposited + v_funding.amount,
      updated_at = NOW()
  WHERE id = '00000000-0000-0000-0000-000000000002';

  IF NOT FOUND THEN RETURN FALSE; END IF;

  INSERT INTO promotions_ledger_entries (
    reference, type, amount, description, actor_id
  ) VALUES (
    v_funding.id,
    'DEPOSIT',
    v_funding.amount,
    COALESCE(v_funding.description, 'Paystack promotions funding'),
    v_funding.admin_id
  );

  UPDATE promotions_funding_transactions
  SET status = 'successful',
      paystack_fee = COALESCE(p_paystack_fee, 0),
      paystack_status = 'success',
      paid_at = NOW(),
      updated_at = NOW()
  WHERE id = v_funding.id
    AND status = 'pending';

  RETURN TRUE;
END;
$$;

NOTIFY pgrst, 'reload schema';
