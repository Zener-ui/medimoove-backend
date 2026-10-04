-- ============================================================
-- CARTMOOVE ATOMIC INVENTORY FUNCTIONS
-- Paste into Supabase SQL Editor and run
-- These prevent overselling under concurrent requests
-- ============================================================

-- ============================================================
-- ATOMIC RESERVE PRODUCT STOCK
-- Returns true if reservation succeeded, false if not enough stock
-- ============================================================
CREATE OR REPLACE FUNCTION atomic_reserve_stock(
  p_product_id UUID,
  p_quantity INT
)
RETURNS BOOLEAN AS $$
DECLARE
  rows_updated INT;
BEGIN
  UPDATE products
  SET reserved_quantity = reserved_quantity + p_quantity
  WHERE id = p_product_id
    AND (stock_quantity - reserved_quantity) >= p_quantity
    AND is_available = true;

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- ATOMIC RESERVE VARIANT STOCK
-- ============================================================
CREATE OR REPLACE FUNCTION atomic_reserve_variant_stock(
  p_variant_id UUID,
  p_quantity INT
)
RETURNS BOOLEAN AS $$
DECLARE
  rows_updated INT;
BEGIN
  UPDATE product_variants
  SET reserved_quantity = reserved_quantity + p_quantity
  WHERE id = p_variant_id
    AND (stock_quantity - reserved_quantity) >= p_quantity;

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- RELEASE PRODUCT STOCK (on cancellation)
-- ============================================================
CREATE OR REPLACE FUNCTION release_product_stock(
  p_product_id UUID,
  p_quantity INT
)
RETURNS VOID AS $$
BEGIN
  UPDATE products
  SET reserved_quantity = GREATEST(0, reserved_quantity - p_quantity)
  WHERE id = p_product_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- RELEASE VARIANT STOCK
-- ============================================================
CREATE OR REPLACE FUNCTION release_variant_stock(
  p_variant_id UUID,
  p_quantity INT
)
RETURNS VOID AS $$
BEGIN
  UPDATE product_variants
  SET reserved_quantity = GREATEST(0, reserved_quantity - p_quantity)
  WHERE id = p_variant_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- CONFIRM PRODUCT STOCK (after payment — deduct real stock)
-- ============================================================
CREATE OR REPLACE FUNCTION confirm_product_stock(
  p_product_id UUID,
  p_quantity INT
)
RETURNS VOID AS $$
BEGIN
  UPDATE products
  SET
    stock_quantity = GREATEST(0, stock_quantity - p_quantity),
    reserved_quantity = GREATEST(0, reserved_quantity - p_quantity)
  WHERE id = p_product_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- CONFIRM VARIANT STOCK
-- ============================================================
CREATE OR REPLACE FUNCTION confirm_variant_stock(
  p_variant_id UUID,
  p_quantity INT
)
RETURNS VOID AS $$
BEGIN
  UPDATE product_variants
  SET
    stock_quantity = GREATEST(0, stock_quantity - p_quantity),
    reserved_quantity = GREATEST(0, reserved_quantity - p_quantity)
  WHERE id = p_variant_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- ATOMIC WITHDRAWAL BALANCE LOCK
-- Deducts balance atomically — prevents double spending
-- Returns true if deduction succeeded
-- ============================================================
CREATE OR REPLACE FUNCTION atomic_withdraw_balance(
  p_user_id UUID,
  p_amount NUMERIC
)
RETURNS BOOLEAN AS $$
DECLARE
  rows_updated INT;
BEGIN
  UPDATE balances
  SET
    available_balance = available_balance - p_amount,
    updated_at = NOW()
  WHERE user_id = p_user_id
    AND available_balance >= p_amount;

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- BALANCE RECONCILIATION CHECK
-- Compares balances.total_earned against the authoritative
-- sub_order_payouts records for vendor/rider earnings.
--
-- FIX: ledger_entries cannot safely be used for this check because
-- delivery ledger rows bundle vendor + rider + platform amounts into
-- one row and use actor_id for the person who performed the action,
-- not the recipient. That made a ledger-based per-user reconciliation
-- produce false mismatches.
--
-- sub_order_payouts records the actual recipient and amount for each
-- vendor/rider delivery payout and has a reversal marker. Therefore
-- the reconciliation compares total_earned against non-reversed
-- payout records, which matches the balance-crediting source of truth.
-- ============================================================
CREATE OR REPLACE FUNCTION reconcile_balances()
RETURNS TABLE(
  user_id UUID,
  balance_table_amount NUMERIC,
  payout_sum NUMERIC,
  drift NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    b.user_id,
    b.total_earned AS balance_table_amount,
    COALESCE(SUM(
      CASE
        WHEN sop.reversed_at IS NULL THEN sop.amount
        ELSE 0
      END
    ), 0) AS payout_sum,
    b.total_earned - COALESCE(SUM(
      CASE
        WHEN sop.reversed_at IS NULL THEN sop.amount
        ELSE 0
      END
    ), 0) AS drift
  FROM balances b
  LEFT JOIN sub_order_payouts sop
    ON sop.user_id = b.user_id
   AND sop.role IN ('vendor', 'rider')
  GROUP BY b.user_id, b.total_earned
  HAVING ABS(
    b.total_earned - COALESCE(SUM(
      CASE
        WHEN sop.reversed_at IS NULL THEN sop.amount
        ELSE 0
      END
    ), 0)
  ) > 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- RECORD COMPLETED WITHDRAWAL
-- Only called after Paystack transfer.success has atomically claimed
-- the withdrawal. Keeps total_withdrawn as a completed-withdrawal
-- metric rather than counting requests that later fail.
-- ============================================================
CREATE OR REPLACE FUNCTION record_completed_withdrawal(
  p_user_id UUID,
  p_amount NUMERIC
)
RETURNS VOID AS $$
BEGIN
  UPDATE balances
  SET total_withdrawn = total_withdrawn + p_amount,
      updated_at = NOW()
  WHERE user_id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- RESTORE BALANCE AFTER WITHDRAWAL REJECTION
-- ============================================================
CREATE OR REPLACE FUNCTION restore_balance_after_rejection(
  p_user_id UUID,
  p_amount NUMERIC
)
RETURNS VOID AS $$
BEGIN
  UPDATE balances
  SET
    available_balance = available_balance + p_amount,
    updated_at = NOW()
  WHERE user_id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- INCREMENT PRODUCT VIEW COUNT (batch)
-- ============================================================
CREATE OR REPLACE FUNCTION increment_product_views(product_ids UUID[])
RETURNS VOID AS $$
BEGIN
  UPDATE products
  SET view_count = view_count + 1
  WHERE id = ANY(product_ids);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
