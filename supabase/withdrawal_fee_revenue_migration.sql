-- ============================================================
-- WITHDRAWAL FEE -> PLATFORM REVENUE — MIGRATION
-- Run this in Supabase SQL Editor AFTER platform_revenue.sql.
--
-- WHY: requestWithdrawal deducts the FULL gross_amount from the
-- requester's balance, but approveWithdrawal only ever sent
-- net_payout (gross_amount - withdrawal_fee) to Paystack. The
-- withdrawal_fee difference was never credited anywhere — it left
-- the vendor/rider's balance but never landed in platform_accounts,
-- so it just vanished from every ledger. This was a real, ongoing
-- revenue leak, separate from (and in addition to) platform_fee only
-- being credited at delivery instead of at payment.
--
-- Extends the existing uq_platform_revenue_source partial unique
-- index so WITHDRAWAL_FEE_EARNED gets the same idempotency guarantee
-- (safe against retries/double-approval) as PLATFORM_FEE_EARNED and
-- DELIVERY_MARGIN_EARNED already have.
-- ============================================================

DROP INDEX IF EXISTS uq_platform_revenue_source;

CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_revenue_source
ON platform_ledger_entries(reference, source_type)
WHERE source_type IN ('PLATFORM_FEE_EARNED', 'DELIVERY_MARGIN_EARNED', 'WITHDRAWAL_FEE_EARNED');

CREATE OR REPLACE FUNCTION credit_withdrawal_fee_revenue(
  p_reference UUID,
  p_amount NUMERIC,
  p_actor_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF COALESCE(p_amount, 0) <= 0 THEN
    RETURN FALSE;
  END IF;

  INSERT INTO platform_ledger_entries(reference, source_type, amount, description, actor_id)
  VALUES (p_reference, 'WITHDRAWAL_FEE_EARNED', p_amount,
    'Withdrawal fee earned on processed withdrawal', p_actor_id)
  -- Same fix as credit_platform_revenue — the ON CONFLICT clause must
  -- repeat the partial index's WHERE predicate or Postgres can't use
  -- it as a conflict target at all (42P10), regardless of whether the
  -- index itself exists.
  ON CONFLICT (reference, source_type) WHERE source_type IN ('PLATFORM_FEE_EARNED','DELIVERY_MARGIN_EARNED','WITHDRAWAL_FEE_EARNED')
  DO NOTHING;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  UPDATE platform_accounts
  SET available_balance = available_balance + p_amount,
      total_earned = total_earned + p_amount,
      updated_at = NOW()
  WHERE id = '00000000-0000-0000-0000-000000000001';

  RETURN TRUE;
END;
$$;
