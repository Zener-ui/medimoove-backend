-- ============================================================
-- FIX #21: DELIVERED FINANCIAL SIDE-EFFECT RECOVERY
--
-- A sub-order status transition is claimed atomically before the old
-- controller credited vendor, rider, platform and ledger entries in
-- separate calls. A crash between those calls could leave a DELIVERED
-- sub-order only partially paid, while a retry of the status transition
-- would be ignored because the status was already DELIVERED.
--
-- This function is deliberately idempotent and repairs missing pieces.
-- Vendor/rider credits use credit_delivery_payout(), which itself records
-- the payout row atomically with the balance credit. Platform revenue uses
-- its own unique source key, and the delivery ledger has a unique
-- (reference,type) index.
-- ============================================================

CREATE OR REPLACE FUNCTION repair_delivered_sub_order_financials(
  p_sub_order_id UUID,
  p_actor_id TEXT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_sub_order RECORD;
  v_vendor_user UUID;
  v_rider_user UUID;
  v_platform_margin NUMERIC;
  v_ledger_amount NUMERIC;
BEGIN
  SELECT * INTO v_sub_order
  FROM sub_orders
  WHERE id = p_sub_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sub-order % not found', p_sub_order_id;
  END IF;

  IF UPPER(COALESCE(v_sub_order.status, '')) NOT IN ('DELIVERED', 'COMPLETED') THEN
    RETURN FALSE;
  END IF;

  SELECT user_id INTO v_vendor_user
  FROM vendors
  WHERE id = v_sub_order.vendor_id;

  IF v_vendor_user IS NULL THEN
    RAISE EXCEPTION 'Vendor user missing for sub-order %', p_sub_order_id;
  END IF;

  -- Idempotent: only the first successful call credits each role.
  PERFORM credit_delivery_payout(
    p_sub_order_id, 'vendor', v_vendor_user, COALESCE(v_sub_order.vendor_payout, 0)
  );

  IF v_sub_order.rider_id IS NOT NULL THEN
    SELECT user_id INTO v_rider_user
    FROM riders
    WHERE id = v_sub_order.rider_id;

    IF v_rider_user IS NULL THEN
      RAISE EXCEPTION 'Rider user missing for sub-order %', p_sub_order_id;
    END IF;

    PERFORM credit_delivery_payout(
      p_sub_order_id, 'rider', v_rider_user, COALESCE(v_sub_order.rider_payout, 0)
    );
  END IF;

  v_platform_margin := COALESCE(v_sub_order.delivery_margin, 0);

  IF v_platform_margin > 0 THEN
    -- This is independently idempotent by (reference, source_type).
    PERFORM credit_platform_revenue(
      p_sub_order_id, 0, v_platform_margin, p_actor_id::UUID
    );

    -- Record that the platform margin was finalized for this sub-order.
    INSERT INTO sub_order_payouts (sub_order_id, role, user_id, amount)
    VALUES (p_sub_order_id, 'platform_margin', NULL, v_platform_margin)
    ON CONFLICT (sub_order_id, role) DO NOTHING;
  END IF;

  v_ledger_amount := COALESCE(v_sub_order.vendor_payout, 0)
    + COALESCE(v_sub_order.rider_payout, 0)
    + v_platform_margin;

  -- The ledger row is audit/accounting evidence, not a second balance
  -- credit. Its unique (reference,type) key makes recovery idempotent.
  INSERT INTO ledger_entries (
    id, reference, type, amount, fee, net, source, destination, actor_id, description
  )
  VALUES (
    gen_random_uuid(),
    p_sub_order_id,
    'DELIVERY_CONFIRMED',
    v_ledger_amount,
    0,
    v_ledger_amount,
    'platform_held',
    'vendor_rider_and_platform_balances',
    p_actor_id,
    'Sub-order delivered. Vendor: ₦' || COALESCE(v_sub_order.vendor_payout, 0)
      || ', Rider: ₦' || COALESCE(v_sub_order.rider_payout, 0)
      || ', Platform: ₦' || v_platform_margin
  )
  ON CONFLICT (reference, type) WHERE reference IS NOT NULL DO NOTHING;

  RETURN TRUE;
END;
$$;

-- Recovery sweep: repair any delivered/completed sub-order whose payout
-- records or delivery ledger row are incomplete. Safe to run repeatedly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.schedule(
      'repair-delivered-financials',
      '*/5 * * * *',
      $job$
        DO $inner$
        DECLARE r RECORD;
        BEGIN
          FOR r IN
            SELECT so.id
            FROM sub_orders so
            WHERE UPPER(COALESCE(so.status, '')) IN ('DELIVERED', 'COMPLETED')
              AND (
                NOT EXISTS (SELECT 1 FROM sub_order_payouts p WHERE p.sub_order_id = so.id AND p.role = 'vendor')
                OR (so.rider_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sub_order_payouts p WHERE p.sub_order_id = so.id AND p.role = 'rider'))
                OR (COALESCE(so.delivery_margin, 0) > 0 AND NOT EXISTS (SELECT 1 FROM sub_order_payouts p WHERE p.sub_order_id = so.id AND p.role = 'platform_margin'))
                OR NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.reference = so.id AND l.type = 'DELIVERY_CONFIRMED')
              )
          LOOP
            PERFORM repair_delivered_sub_order_financials(r.id, NULL);
          END LOOP;
        END;
        $inner$;
      $job$
    );
  END IF;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;
