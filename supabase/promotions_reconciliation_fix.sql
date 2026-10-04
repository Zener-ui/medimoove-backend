-- ============================================================
-- Fidelx Promotions Step 6 — Paystack / Budget Reconciliation
-- ============================================================
-- This migration is read-only for normal operation. It adds:
--   1) a unique guard for Paystack funding deposits
--   2) a reconciliation function that compares real funding records,
--      promotion ledger entries, and the singleton budget totals.
--   3) a safer completion function that cannot create a duplicate
--      funding deposit ledger entry on retries.
--
-- It does NOT move money, alter platform_accounts, vendor/rider
-- balances, orders, refunds, withdrawals, or normal Paystack payments.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_promotions_funding_deposit
ON promotions_ledger_entries(reference, type)
WHERE type = 'DEPOSIT' AND reference IS NOT NULL;

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
  -- On a retry, only make sure its deposit ledger row exists; never add
  -- the budget again.
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

  -- Credit the real promotions pool exactly once.
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
  )
  ON CONFLICT (reference, type)
  WHERE type = 'DEPOSIT' AND reference IS NOT NULL
  DO NOTHING;

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

-- ============================================================
-- Reconciliation report
-- ============================================================
-- Returns a JSON report. It intentionally does NOT repair balances
-- automatically: a discrepancy involving real money must be visible
-- before anything is adjusted.
CREATE OR REPLACE FUNCTION reconcile_promotions_budget()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_budget promotions_budget%ROWTYPE;
  v_successful_funding NUMERIC := 0;
  v_successful_count INTEGER := 0;
  v_deposit_ledger NUMERIC := 0;
  v_coupon_spend NUMERIC := 0;
  v_referral_spend NUMERIC := 0;
  v_adjustments NUMERIC := 0;
  v_ledger_net NUMERIC := 0;
  v_expected_balance NUMERIC := 0;
  v_pending_old_count INTEGER := 0;
  v_missing_deposits INTEGER := 0;
  v_mismatched_deposits INTEGER := 0;
BEGIN
  SELECT * INTO v_budget
  FROM promotions_budget
  WHERE id = '00000000-0000-0000-0000-000000000002';

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'status', 'BUDGET_ROW_MISSING',
      'message', 'The promotions budget singleton row does not exist.'
    );
  END IF;

  SELECT
    COALESCE(SUM(amount), 0),
    COUNT(*)
  INTO v_successful_funding, v_successful_count
  FROM promotions_funding_transactions
  WHERE status = 'successful';

  SELECT COALESCE(SUM(amount), 0)
  INTO v_deposit_ledger
  FROM promotions_ledger_entries
  WHERE type = 'DEPOSIT';

  SELECT COALESCE(SUM(-amount), 0)
  INTO v_coupon_spend
  FROM promotions_ledger_entries
  WHERE type = 'COUPON_DISCOUNT';

  SELECT COALESCE(SUM(-amount), 0)
  INTO v_referral_spend
  FROM promotions_ledger_entries
  WHERE type = 'REFERRAL_REWARD';

  SELECT COALESCE(SUM(amount), 0)
  INTO v_adjustments
  FROM promotions_ledger_entries
  WHERE type = 'ADJUSTMENT';

  v_ledger_net := v_deposit_ledger - v_coupon_spend - v_referral_spend + v_adjustments;
  v_expected_balance := v_ledger_net;

  -- Successful Paystack funding must have exactly one matching deposit
  -- ledger row with the same amount.
  SELECT COUNT(*)
  INTO v_missing_deposits
  FROM promotions_funding_transactions f
  WHERE f.status = 'successful'
    AND NOT EXISTS (
      SELECT 1
      FROM promotions_ledger_entries l
      WHERE l.reference = f.id
        AND l.type = 'DEPOSIT'
    );

  SELECT COUNT(*)
  INTO v_mismatched_deposits
  FROM promotions_funding_transactions f
  JOIN promotions_ledger_entries l
    ON l.reference = f.id
   AND l.type = 'DEPOSIT'
  WHERE f.status = 'successful'
    AND l.amount <> f.amount;

  -- Old pending attempts are not automatically called fraud; they are
  -- simply funding attempts that deserve attention/re-verification.
  SELECT COUNT(*)
  INTO v_pending_old_count
  FROM promotions_funding_transactions
  WHERE status = 'pending'
    AND created_at < NOW() - INTERVAL '30 minutes';

  RETURN jsonb_build_object(
    'ok', (
      ROUND(v_budget.balance, 2) = ROUND(v_expected_balance, 2)
      AND ROUND(v_budget.total_deposited, 2) = ROUND(v_deposit_ledger, 2)
      AND ROUND(v_budget.total_spent, 2) = ROUND(v_coupon_spend + v_referral_spend, 2)
      AND v_missing_deposits = 0
      AND v_mismatched_deposits = 0
    ),
    'status', CASE
      WHEN ROUND(v_budget.balance, 2) <> ROUND(v_expected_balance, 2) THEN 'BALANCE_MISMATCH'
      WHEN ROUND(v_budget.total_deposited, 2) <> ROUND(v_deposit_ledger, 2) THEN 'DEPOSIT_TOTAL_MISMATCH'
      WHEN ROUND(v_budget.total_spent, 2) <> ROUND(v_coupon_spend + v_referral_spend, 2) THEN 'SPEND_TOTAL_MISMATCH'
      WHEN v_missing_deposits > 0 THEN 'MISSING_FUNDING_LEDGER'
      WHEN v_mismatched_deposits > 0 THEN 'FUNDING_AMOUNT_MISMATCH'
      ELSE 'OK'
    END,
    'budget', jsonb_build_object(
      'balance', v_budget.balance,
      'total_deposited', v_budget.total_deposited,
      'total_spent', v_budget.total_spent
    ),
    'ledger', jsonb_build_object(
      'deposit_total', v_deposit_ledger,
      'coupon_spend', v_coupon_spend,
      'referral_spend', v_referral_spend,
      'adjustments', v_adjustments,
      'net', v_ledger_net
    ),
    'paystack_funding', jsonb_build_object(
      'successful_count', v_successful_count,
      'successful_total', v_successful_funding,
      'missing_deposit_ledgers', v_missing_deposits,
      'mismatched_deposit_amounts', v_mismatched_deposits,
      'old_pending_count', v_pending_old_count
    ),
    'expected_balance', v_expected_balance,
    'balance_difference', ROUND(v_budget.balance - v_expected_balance, 2),
    'deposit_difference', ROUND(v_budget.total_deposited - v_deposit_ledger, 2),
    'spend_difference', ROUND(v_budget.total_spent - (v_coupon_spend + v_referral_spend), 2),
    'checked_at', NOW()
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
