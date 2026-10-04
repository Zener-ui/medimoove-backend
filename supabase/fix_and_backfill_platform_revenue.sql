-- ============================================================
-- FIDELX PLATFORM REVENUE FIX V2
-- ============================================================
-- Fixes the revenue-credit failure caused by the partial unique
-- index / ON CONFLICT target mismatch.
--
-- Also safely backfills already-successful / already-delivered
-- records that have no corresponding platform revenue entry.
-- Safe to re-run: revenue entries are unique per
-- (reference, source_type).
-- ============================================================

-- 1. Ensure the platform ledger/account infrastructure exists.
CREATE TABLE IF NOT EXISTS platform_accounts (
  id UUID PRIMARY KEY,
  available_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  pending_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_earned NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_withdrawn NUMERIC(14,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO platform_accounts (id)
VALUES ('00000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference UUID,
  source_type TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  description TEXT,
  actor_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Rebuild the revenue uniqueness index with the exact set of
-- revenue source types used by the credit functions.
DROP INDEX IF EXISTS uq_platform_revenue_source;

CREATE UNIQUE INDEX uq_platform_revenue_source
ON platform_ledger_entries(reference, source_type)
WHERE source_type IN (
  'PLATFORM_FEE_EARNED',
  'DELIVERY_MARGIN_EARNED',
  'WITHDRAWAL_FEE_EARNED'
);

-- 3. Correct, idempotent platform revenue credit function.
-- The ON CONFLICT predicate MUST exactly match the partial index.
CREATE OR REPLACE FUNCTION credit_platform_revenue(
  p_reference UUID,
  p_platform_fee NUMERIC,
  p_delivery_margin NUMERIC,
  p_actor_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_total NUMERIC := 0;
BEGIN
  IF p_reference IS NULL THEN
    RAISE EXCEPTION 'Platform revenue reference cannot be NULL';
  END IF;

  IF COALESCE(p_platform_fee, 0) > 0 THEN
    INSERT INTO platform_ledger_entries
      (reference, source_type, amount, description, actor_id)
    VALUES
      (
        p_reference,
        'PLATFORM_FEE_EARNED',
        p_platform_fee,
        'Platform fee earned',
        p_actor_id
      )
    ON CONFLICT (reference, source_type)
      WHERE source_type IN (
        'PLATFORM_FEE_EARNED',
        'DELIVERY_MARGIN_EARNED',
        'WITHDRAWAL_FEE_EARNED'
      )
    DO NOTHING;

    IF FOUND THEN
      v_total := v_total + p_platform_fee;
    END IF;
  END IF;

  IF COALESCE(p_delivery_margin, 0) > 0 THEN
    INSERT INTO platform_ledger_entries
      (reference, source_type, amount, description, actor_id)
    VALUES
      (
        p_reference,
        'DELIVERY_MARGIN_EARNED',
        p_delivery_margin,
        'Delivery margin earned',
        p_actor_id
      )
    ON CONFLICT (reference, source_type)
      WHERE source_type IN (
        'PLATFORM_FEE_EARNED',
        'DELIVERY_MARGIN_EARNED',
        'WITHDRAWAL_FEE_EARNED'
      )
    DO NOTHING;

    IF FOUND THEN
      v_total := v_total + p_delivery_margin;
    END IF;
  END IF;

  IF v_total > 0 THEN
    UPDATE platform_accounts
    SET
      available_balance = available_balance + v_total,
      total_earned = total_earned + v_total,
      updated_at = NOW()
    WHERE id = '00000000-0000-0000-0000-000000000001';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Platform account singleton is missing';
    END IF;
  END IF;

  RETURN v_total > 0;
END;
$$;

-- 4. Correct withdrawal-fee revenue function too, since it uses the
-- same platform revenue index.
CREATE OR REPLACE FUNCTION credit_withdrawal_fee_revenue(
  p_reference UUID,
  p_amount NUMERIC,
  p_actor_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_reference IS NULL OR COALESCE(p_amount, 0) <= 0 THEN
    RETURN FALSE;
  END IF;

  INSERT INTO platform_ledger_entries
    (reference, source_type, amount, description, actor_id)
  VALUES
    (
      p_reference,
      'WITHDRAWAL_FEE_EARNED',
      p_amount,
      'Withdrawal fee earned',
      p_actor_id
    )
  ON CONFLICT (reference, source_type)
    WHERE source_type IN (
      'PLATFORM_FEE_EARNED',
      'DELIVERY_MARGIN_EARNED',
      'WITHDRAWAL_FEE_EARNED'
    )
  DO NOTHING;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  UPDATE platform_accounts
  SET
    available_balance = available_balance + p_amount,
    total_earned = total_earned + p_amount,
    updated_at = NOW()
  WHERE id = '00000000-0000-0000-0000-000000000001';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Platform account singleton is missing';
  END IF;

  RETURN TRUE;
END;
$$;

-- 5. Platform fees are intentionally NOT backfilled from payment success.
-- Revenue is recognized only after the entire order completes.

-- 6. Backfill missing delivery-margin entries for delivered/completed
-- sub-orders. This is the exact missing path from the live QA test.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT
      so.id,
      COALESCE(so.delivery_margin, 0)::NUMERIC AS delivery_margin,
      so.vendor_id
    FROM sub_orders so
    WHERE UPPER(COALESCE(so.status, '')) IN ('DELIVERED', 'COMPLETED')
      AND COALESCE(so.delivery_margin, 0) > 0
      AND NOT EXISTS (
        SELECT 1
        FROM platform_ledger_entries ple
        WHERE ple.reference = so.id
          AND ple.source_type = 'DELIVERY_MARGIN_EARNED'
      )
  LOOP
    PERFORM credit_platform_revenue(
      r.id,
      0,
      r.delivery_margin,
      NULL
    );
  END LOOP;
END;
$$;

-- 7. Verification: show platform totals and revenue entries.
SELECT
  pa.available_balance,
  pa.total_earned,
  pa.total_withdrawn,
  COUNT(ple.id) FILTER (
    WHERE ple.source_type IN ('PLATFORM_FEE_EARNED', 'DELIVERY_MARGIN_EARNED')
  ) AS revenue_entries,
  COALESCE(SUM(ple.amount) FILTER (
    WHERE ple.source_type IN ('PLATFORM_FEE_EARNED', 'DELIVERY_MARGIN_EARNED')
  ), 0) AS ledger_revenue
FROM platform_accounts pa
LEFT JOIN platform_ledger_entries ple ON TRUE
WHERE pa.id = '00000000-0000-0000-0000-000000000001'
GROUP BY pa.id, pa.available_balance, pa.total_earned, pa.total_withdrawn;
