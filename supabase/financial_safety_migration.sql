-- ============================================================
-- FINANCIAL SAFETY MIGRATION — implements the audit fixes
-- Run this BEFORE deploying the updated backend code.
-- Every statement is defensive (IF NOT EXISTS / dynamic constraint
-- drop-and-recreate) so it is safe to run against a live database
-- regardless of exactly which prior migrations were applied.
-- ============================================================

-- ----------------------------------------------------------------
-- 1. NEW COLUMNS
-- ----------------------------------------------------------------

-- Atomic cumulative refund cap against the parent Paystack transaction.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS total_refunded NUMERIC NOT NULL DEFAULT 0;

-- Payment-processing recoverability: set only once every side effect of
-- processSuccessfulPayment has genuinely completed. A payment stuck
-- 'successful' with this NULL for too long is exactly what the
-- reconciliation job below looks for.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS processing_completed_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS paystack_fee NUMERIC;

-- Refund idempotency + the fields the current code already relies on
-- that aren't in the original schema.sql (added defensively in case
-- an earlier migration didn't already add them).
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS payment_id UUID REFERENCES payments(id);
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS refund_type TEXT DEFAULT 'full';
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS fault_party TEXT;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS deducted_from TEXT;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS balance_debited BOOLEAN DEFAULT FALSE;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS paystack_refund_id TEXT;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS paystack_status TEXT;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS paystack_transaction_reference TEXT;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS admin_reviewer_id UUID REFERENCES users(id);
-- NEW: distinguishes "cancelled before anyone was ever paid" from
-- "disputed after vendor/rider/platform already received their share"
-- — the two cases need different accounting (see debit_refund_shares
-- below) and the audit's requested "do not reuse post-delivery dispute
-- logic for pre-delivery cancellation" requirement.
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS refund_stage TEXT DEFAULT 'post_delivery';

CREATE UNIQUE INDEX IF NOT EXISTS uq_refunds_idempotency_key
ON refunds(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Widen the refunds status CHECK to match every status the code
-- actually writes (pending/processing/needs_attention/failed/processed)
-- — the original schema.sql only allowed pending/approved/rejected/
-- processed. Whether or not this was already widened by an earlier
-- migration, this makes the current, real set of values explicit.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'refunds' AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE refunds DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE refunds ADD CONSTRAINT refunds_status_check
  CHECK (status IN ('pending','processing','needs_attention','failed','processed','approved','rejected'));

-- Withdrawals: add a CLAIMED state — the withdrawal is atomically
-- locked to one approval attempt BEFORE any Paystack call is made,
-- closing the double-transfer race at its root instead of only
-- detecting it after the fact.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'withdrawals' AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE withdrawals DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_status_check
  CHECK (status IN ('PENDING','CLAIMED','APPROVED','REJECTED','PROCESSING','COMPLETED','FAILED'));

ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS paystack_transfer_id TEXT;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS paystack_transfer_code TEXT;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS paystack_reference TEXT;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS paystack_status TEXT;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS paystack_recipient_code TEXT;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
-- Withdrawal-fee revenue is now only booked once the transfer is
-- confirmed successful (item 6) — this flag makes that booking
-- idempotent the same way balance_debited does for refunds.
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS fee_revenue_credited BOOLEAN DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_withdrawals_paystack_reference
ON withdrawals(paystack_reference) WHERE paystack_reference IS NOT NULL;

-- Disputes: add a 'processing' state so two admins resolving the same
-- dispute concurrently can't both initiate a refund.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'disputes' AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE disputes DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE disputes ADD CONSTRAINT disputes_status_check
  CHECK (status IN ('open','processing','resolved','appealed','closed'));

-- Ledger consistency (item 12): every real financial event gets a
-- deterministic (reference, type) pair, and repeated processing can no
-- longer silently create a duplicate row for the same event. Historical
-- rows are untouched — this only guards new inserts going forward.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_entries_reference_type
ON ledger_entries(reference, type) WHERE reference IS NOT NULL;

-- Order-creation atomicity support: track when inventory was actually
-- confirmed (real stock deducted) so a resumed/retried payment-
-- processing run never double-deducts real stock.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS inventory_confirmed_at TIMESTAMPTZ;

-- ----------------------------------------------------------------
-- 2. IDEMPOTENT PER-SUB-ORDER PAYOUT TRACKING (item 4, and the
--    reversal accounting for items 1-3)
--
-- One row per (sub_order_id, role) that was ever actually credited.
-- This is the single source of truth for "who was paid what for this
-- sub-order, and how much" — both the DELIVERED credit path and every
-- refund/cancellation reversal path read and write through this table
-- instead of trusting sub_orders.vendor_payout/rider_payout directly,
-- which by itself can't tell you whether the credit already happened.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sub_order_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_order_id UUID NOT NULL REFERENCES sub_orders(id),
  role TEXT NOT NULL CHECK (role IN ('vendor','rider','platform_fee','platform_margin')),
  user_id UUID, -- NULL for platform_fee/platform_margin rows
  amount NUMERIC NOT NULL,
  credited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reversed_at TIMESTAMPTZ,
  reversal_reference UUID, -- the refund.id that reversed this credit
  UNIQUE (sub_order_id, role)
);

-- ----------------------------------------------------------------
-- 3. DELIVERY CREDIT — replaces the old plain credit_pending_balance
--    call site for delivery specifically. Idempotent per
--    (sub_order_id, role): a duplicate call for the same delivery is
--    a guaranteed no-op on the second attempt, verified atomically via
--    the sub_order_payouts UNIQUE constraint (INSERT ... ON CONFLICT).
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION credit_delivery_payout(
  p_sub_order_id UUID, p_role TEXT, p_user_id UUID, p_amount NUMERIC
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF COALESCE(p_amount, 0) <= 0 THEN RETURN FALSE; END IF;

  INSERT INTO sub_order_payouts (sub_order_id, role, user_id, amount)
  VALUES (p_sub_order_id, p_role, p_user_id, p_amount)
  ON CONFLICT (sub_order_id, role) DO NOTHING;

  -- FOUND is only true if the INSERT actually landed a new row — a
  -- retried/duplicate call for the same sub-order+role hits the
  -- UNIQUE constraint, ON CONFLICT DO NOTHING silently no-ops it, and
  -- FOUND is false, so the balance credit below never fires twice.
  IF NOT FOUND THEN RETURN FALSE; END IF;

  IF p_role IN ('vendor','rider') THEN
    INSERT INTO balances (id, user_id, pending_balance, total_earned)
    VALUES (gen_random_uuid(), p_user_id, p_amount, p_amount)
    ON CONFLICT (user_id) DO UPDATE
    SET pending_balance = balances.pending_balance + p_amount,
        total_earned = balances.total_earned + p_amount,
        updated_at = NOW();
  END IF;

  RETURN TRUE;
END;
$$;

-- ----------------------------------------------------------------
-- 4. CLAIM AN ATOMIC SLICE OF THE PARENT PAYMENT FOR REFUND
--    (items 1, 2, 3, 9's "single Paystack transaction" problem)
--
-- A single conditional UPDATE with a row-level lock is what makes
-- this safe under concurrency — Postgres serializes concurrent
-- UPDATEs to the same row, so two simultaneous refund requests against
-- the same payment cannot both read a stale total_refunded and both
-- pass the cap check; the second one's UPDATE simply sees the first
-- one's already-committed total_refunded and is evaluated against it.
-- Returns the amount actually reserved (0 if nothing could be
-- reserved — cap already reached).
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_refund_amount(
  p_payment_id UUID, p_requested_amount NUMERIC
) RETURNS NUMERIC
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_payment_amount NUMERIC;
  v_before NUMERIC;
  v_room NUMERIC;
  v_claim NUMERIC;
BEGIN
  IF p_requested_amount IS NULL OR p_requested_amount <= 0 THEN RETURN 0; END IF;

  SELECT amount, total_refunded INTO v_payment_amount, v_before
  FROM payments WHERE id = p_payment_id FOR UPDATE;

  IF v_payment_amount IS NULL THEN RETURN 0; END IF;

  v_room := v_payment_amount - v_before;
  IF v_room <= 0 THEN RETURN 0; END IF;

  -- Never claim more than either what was requested or what's left —
  -- this is the guard that makes "refund B and C from the same
  -- ₦17,500 parent" always sum to at most ₦17,500 no matter what
  -- order the requests arrive in or how they overlap in time.
  v_claim := LEAST(p_requested_amount, v_room);

  UPDATE payments SET total_refunded = total_refunded + v_claim WHERE id = p_payment_id;

  RETURN v_claim;
END;
$$;

-- Release a previously-claimed amount back (used when the Paystack
-- call itself fails after the amount was reserved, or when a refund
-- is later voided) — the exact inverse of claim_refund_amount.
CREATE OR REPLACE FUNCTION release_refund_claim(
  p_payment_id UUID, p_amount NUMERIC
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF COALESCE(p_amount, 0) <= 0 THEN RETURN; END IF;
  UPDATE payments
  SET total_refunded = GREATEST(0, total_refunded - p_amount)
  WHERE id = p_payment_id;
END;
$$;

-- ----------------------------------------------------------------
-- 5. FINALIZE A CONFIRMED REFUND — atomic claim + correct reversal
--    accounting (items 3, 7)
--
-- Atomically claims the refund with an UPDATE ... WHERE
-- balance_debited = FALSE — a duplicate refund.processed webhook (or
-- a duplicate call from any caller) hits this same guard and the
-- second call's UPDATE matches zero rows, so it returns FALSE and the
-- caller does nothing further. This is the same proven pattern
-- already used for payments.status and withdrawals.status elsewhere
-- in this codebase, applied to the one place that was missing it.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_refund_finalization(p_refund_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_claimed INT;
BEGIN
  UPDATE refunds SET balance_debited = TRUE
  WHERE id = p_refund_id AND balance_debited = FALSE;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  RETURN v_claimed > 0;
END;
$$;

-- Reverses exactly what sub_order_payouts says was actually paid out
-- for this sub-order, per party, and marks each reversed row so a
-- second call (should the atomic claim above somehow be bypassed) is
-- still a hard no-op per party. This is what makes the accounting
-- match the real Paystack-refunded amount instead of an
-- under-counted "just the vendor's subtotal" figure — see the audit's
-- Example 6. fault_party still controls strike/suspension only (see
-- operationalController.js) — the money reversal itself is symmetric
-- and reverses every party that was actually paid, since Paystack
-- takes the money back from all of them collectively regardless of
-- whose fault it was.
CREATE OR REPLACE FUNCTION reverse_sub_order_payouts(p_sub_order_id UUID, p_refund_id UUID, p_roles TEXT[] DEFAULT NULL)
RETURNS TABLE(role TEXT, user_id UUID, amount NUMERIC) AS $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM sub_order_payouts
    WHERE sub_order_id = p_sub_order_id AND reversed_at IS NULL
      AND (p_roles IS NULL OR sub_order_payouts.role = ANY(p_roles))
    FOR UPDATE
  LOOP
    IF r.role IN ('vendor','rider') THEN
      -- Reverse from wherever the money currently sits — still
      -- pending (not yet released past the settlement hold) or
      -- already available. Never lets either go below what's needed
      -- to fully claw back this specific credit; balances are allowed
      -- to go negative by design (documented existing business rule).
      UPDATE balances
      SET pending_balance = pending_balance - LEAST(r.amount, GREATEST(pending_balance,0)),
          available_balance = available_balance - (r.amount - LEAST(r.amount, GREATEST(pending_balance,0))),
          updated_at = NOW()
      WHERE user_id = r.user_id;
    ELSIF r.role IN ('platform_fee','platform_margin') THEN
      UPDATE platform_accounts
      SET available_balance = available_balance - r.amount,
          total_earned = total_earned - r.amount,
          updated_at = NOW()
      WHERE id = '00000000-0000-0000-0000-000000000001';
    END IF;

    UPDATE sub_order_payouts SET reversed_at = NOW(), reversal_reference = p_refund_id WHERE id = r.id;

    role := r.role; user_id := r.user_id; amount := r.amount;
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ----------------------------------------------------------------
-- 6. WITHDRAWAL-FEE REVENUE timing (item 6)
-- credit_withdrawal_fee_revenue() already exists (see
-- withdrawal_fee_revenue_migration.sql) and is already idempotent via
-- the platform_ledger_entries unique index — no new function needed.
-- What changes is WHEN withdrawalController.js calls it: moved from
-- "on approval" to "on confirmed transfer success" (see code comments
-- there). withdrawals.fee_revenue_credited above is a cheap pre-check
-- so a duplicate transfer.success webhook doesn't even attempt the RPC
-- a second time, though the RPC's own unique index would catch it
-- regardless.
-- ----------------------------------------------------------------

-- ----------------------------------------------------------------
-- 7. WITHDRAWAL CLAIM BEFORE ANY PAYSTACK CALL (item 5)
--    PENDING -> CLAIMED is the lock; only the winner proceeds to call
--    Paystack at all.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_withdrawal_for_approval(p_withdrawal_id UUID, p_admin_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_claimed INT;
BEGIN
  UPDATE withdrawals
  SET status = 'CLAIMED', admin_reviewer_id = p_admin_id, claimed_at = NOW()
  WHERE id = p_withdrawal_id AND status = 'PENDING';
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  RETURN v_claimed > 0;
END;
$$;

-- ----------------------------------------------------------------
-- 8. DISPUTE CLAIM BEFORE REFUND (item 8)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_dispute_for_resolution(p_dispute_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_claimed INT;
BEGIN
  UPDATE disputes SET status = 'processing'
  WHERE id = p_dispute_id AND status IN ('open','appealed');
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  RETURN v_claimed > 0;
END;
$$;

-- ----------------------------------------------------------------
-- 9. SUB-ORDER STATUS CLAIM (item 4) — generic atomic transition
--    claim, used specifically for DELIVERED and CANCELLED (the two
--    transitions with real financial/inventory side effects).
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_sub_order_transition(
  p_sub_order_id UUID, p_expected_status TEXT, p_new_status TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_claimed INT;
BEGIN
  UPDATE sub_orders SET status = p_new_status
  WHERE id = p_sub_order_id AND status = p_expected_status;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  RETURN v_claimed > 0;
END;
$$;

-- ----------------------------------------------------------------
-- 10. PLATFORM WITHDRAWAL DOUBLE-COUNT FIX (item 11)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION complete_platform_withdrawal(
  p_withdrawal_id UUID, p_admin_id UUID
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_amount NUMERIC; v_claimed INT;
BEGIN
  -- Atomic claim FIRST — the UPDATE's own WHERE clause is the guard,
  -- not a separate SELECT-then-UPDATE. A duplicate transfer.success
  -- webhook for the same platform withdrawal now hits zero matching
  -- rows on its second attempt and does nothing further.
  UPDATE platform_withdrawals
  SET status = 'COMPLETED', admin_reviewer_id = p_admin_id, completed_at = NOW()
  WHERE id = p_withdrawal_id AND status = 'PROCESSING'
  RETURNING amount INTO v_amount;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;

  IF v_claimed = 0 THEN RETURN FALSE; END IF;

  UPDATE platform_accounts
  SET total_withdrawn = total_withdrawn + v_amount, updated_at = NOW()
  WHERE id = '00000000-0000-0000-0000-000000000001';

  RETURN TRUE;
END;
$$;

-- ----------------------------------------------------------------
-- 11. IDEMPOTENT PER-RESERVATION INVENTORY CLAIM (hardens item 4's
--     "database-level protection" requirement for the confirm/release
--     inventory helpers, which were vulnerable to the same
--     read-then-write race as everything else here even though their
--     end state looked safe on a sequential retry).
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_reservation(p_reservation_id UUID, p_new_status TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_claimed INT;
BEGIN
  UPDATE inventory_reservations SET status = p_new_status
  WHERE id = p_reservation_id AND status = 'reserved';
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  RETURN v_claimed > 0;
END;
$$;

-- ----------------------------------------------------------------
-- 12. ATOMIC ORDER CREATION (item 10) — the entire order + sub-orders
--     + order_items insert sequence in ONE transaction. If anything
--     inside fails, Postgres rolls back everything automatically —
--     no partial order can ever be left behind. Inventory reservation
--     itself still happens in the application layer beforehand (it
--     already has its own atomic per-item guard via
--     atomic_reserve_stock) since it needs to run before we know the
--     final order shape is valid; this function is what used to be
--     ~5 separate round trips after that point.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_order_with_sub_orders(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_order_id UUID := (p_payload->>'order_id')::UUID;
  v_group JSONB;
  v_sub_order_id UUID;
  v_item JSONB;
BEGIN
  INSERT INTO orders (
    id, customer_id, region_id, status, subtotal, platform_fee, delivery_fee,
    coupon_id, discount_amount, total, payment_status, idempotency_key
  )
  SELECT
    v_order_id, (p_payload->>'customer_id')::UUID, (p_payload->>'region_id')::UUID,
    p_payload->>'status', (p_payload->>'subtotal')::NUMERIC, (p_payload->>'platform_fee')::NUMERIC,
    (p_payload->>'delivery_fee')::NUMERIC, NULLIF(p_payload->>'coupon_id','')::UUID,
    (p_payload->>'discount_amount')::NUMERIC, (p_payload->>'total')::NUMERIC,
    p_payload->>'payment_status', p_payload->>'idempotency_key';

  IF jsonb_typeof(p_payload->'coupon_redemption') = 'object' THEN
    INSERT INTO coupon_redemptions (id, coupon_id, customer_id, order_id, discount_amount)
    SELECT gen_random_uuid(), (p_payload->'coupon_redemption'->>'coupon_id')::UUID,
           (p_payload->>'customer_id')::UUID, v_order_id,
           (p_payload->'coupon_redemption'->>'discount_amount')::NUMERIC;

    UPDATE coupons SET times_used = COALESCE(times_used,0) + 1
    WHERE id = (p_payload->'coupon_redemption'->>'coupon_id')::UUID;
  END IF;

  FOR v_group IN SELECT * FROM jsonb_array_elements(p_payload->'vendor_groups')
  LOOP
    v_sub_order_id := (v_group->>'id')::UUID;

    INSERT INTO sub_orders (
      id, order_id, vendor_id, status, delivery_type, delivery_address,
      delivery_lat, delivery_lng, delivery_description, delivery_voice_note_url,
      subtotal, platform_fee, delivery_fee, delivery_margin, vendor_payout,
      rider_payout, withdrawal_available_at
    )
    SELECT
      v_sub_order_id, v_order_id, (v_group->>'vendor_id')::UUID, v_group->>'status',
      v_group->>'delivery_type', v_group->>'delivery_address',
      NULLIF(v_group->>'delivery_lat','')::NUMERIC, NULLIF(v_group->>'delivery_lng','')::NUMERIC,
      v_group->>'delivery_description', v_group->>'delivery_voice_note_url',
      (v_group->>'subtotal')::NUMERIC, (v_group->>'platform_fee')::NUMERIC,
      (v_group->>'delivery_fee')::NUMERIC, (v_group->>'delivery_margin')::NUMERIC,
      (v_group->>'vendor_payout')::NUMERIC, (v_group->>'rider_payout')::NUMERIC,
      (v_group->>'withdrawal_available_at')::TIMESTAMPTZ;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_group->'items')
    LOOP
      INSERT INTO order_items (id, order_id, sub_order_id, product_id, variant_id, quantity, price)
      SELECT gen_random_uuid(), v_order_id, v_sub_order_id,
             (v_item->>'product_id')::UUID, NULLIF(v_item->>'variant_id','')::UUID,
             (v_item->>'quantity')::INT, (v_item->>'price')::NUMERIC;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('order_id', v_order_id);
END;
$$;

-- ----------------------------------------------------------------
-- 13. PLATFORM FEE — 3% for all transactions (explicit request,
--     overrides the fallback default going forward).
-- ----------------------------------------------------------------
UPDATE fee_settings SET platform_fee_percentage = 3;
-- In case fee_settings has no row yet on this environment:
INSERT INTO fee_settings (id, platform_fee_percentage)
SELECT gen_random_uuid(), 3
WHERE NOT EXISTS (SELECT 1 FROM fee_settings);
