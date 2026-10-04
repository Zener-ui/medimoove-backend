-- ============================================================
-- SETTLEMENT HOLD ENFORCEMENT — MIGRATION
--
-- WHY: vendor/rider balances were credited straight to
-- available_balance the instant a delivery completed, with no
-- connection to withdrawal_available_at (set to delivered_at + 24h)
-- or to whether the underlying customer payment had actually settled
-- in Paystack yet. A withdrawal could be requested and approved
-- before the real money existed in your Paystack balance — safe now
-- (rolls back on failure) but still caused avoidable failed
-- withdrawals, especially after weekends (Paystack's T+1 settlement
-- doesn't clear over Sat/Sun).
--
-- pending_balance already existed as a column and was already
-- displayed on both the vendor and rider dashboards ("Releases after
-- delivery") — it was just never actually written to. This completes
-- that already-half-built feature rather than inventing a new one.
-- ============================================================

-- Tracks which sub-orders have already had their payout moved from
-- pending to available, so the release job never double-processes one.
ALTER TABLE sub_orders ADD COLUMN IF NOT EXISTS balance_released_at TIMESTAMPTZ;

-- Atomic credit into pending_balance (replaces the old upsertBalance
-- helper in subOrderController.js, which did a non-atomic
-- read-then-write in application code — a real race condition if two
-- deliveries for the same vendor completed close together).
CREATE OR REPLACE FUNCTION credit_pending_balance(p_user_id UUID, p_amount NUMERIC)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF COALESCE(p_amount, 0) <= 0 THEN RETURN; END IF;

  INSERT INTO balances (id, user_id, pending_balance, total_earned)
  VALUES (gen_random_uuid(), p_user_id, p_amount, p_amount)
  ON CONFLICT (user_id) DO UPDATE
  SET pending_balance = balances.pending_balance + p_amount,
      total_earned = balances.total_earned + p_amount,
      updated_at = NOW();
END;
$$;

-- Moves matured payouts from pending to available. Safe to run as
-- often as you like — balance_released_at guards against double-moving
-- the same sub-order's payout.
CREATE OR REPLACE FUNCTION release_matured_sub_order_balances()
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  so RECORD;
  released_count INT := 0;
BEGIN
  FOR so IN
    SELECT sub_orders.id, sub_orders.vendor_payout, sub_orders.rider_payout,
           vendors.user_id AS vendor_user_id, riders.user_id AS rider_user_id
    FROM sub_orders
    LEFT JOIN vendors ON vendors.id = sub_orders.vendor_id
    LEFT JOIN riders ON riders.id = sub_orders.rider_id
    WHERE sub_orders.status = 'DELIVERED'
      AND sub_orders.withdrawal_available_at IS NOT NULL
      AND sub_orders.withdrawal_available_at <= NOW()
      AND sub_orders.balance_released_at IS NULL
  LOOP
    IF so.vendor_user_id IS NOT NULL AND COALESCE(so.vendor_payout, 0) > 0 THEN
      UPDATE balances
      SET pending_balance = GREATEST(pending_balance - so.vendor_payout, 0),
          available_balance = available_balance + so.vendor_payout,
          updated_at = NOW()
      WHERE user_id = so.vendor_user_id;
    END IF;

    IF so.rider_user_id IS NOT NULL AND COALESCE(so.rider_payout, 0) > 0 THEN
      UPDATE balances
      SET pending_balance = GREATEST(pending_balance - so.rider_payout, 0),
          available_balance = available_balance + so.rider_payout,
          updated_at = NOW()
      WHERE user_id = so.rider_user_id;
    END IF;

    UPDATE sub_orders SET balance_released_at = NOW() WHERE id = so.id;
    released_count := released_count + 1;
  END LOOP;

  RETURN released_count;
END;
$$;

-- Run the release job every 10 minutes. pg_cron is enabled by default
-- on Supabase projects.
CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'release-matured-balances',
  '*/10 * * * *',
  $$SELECT release_matured_sub_order_balances();$$
);

-- To check it's actually running, after ~10 minutes:
--   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 5;
