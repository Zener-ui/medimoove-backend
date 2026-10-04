-- Revenue recognition invariant:
-- PAYMENT != REVENUE.
-- Fidelx platform revenue is recognized only after the entire order completes.

CREATE OR REPLACE FUNCTION public.credit_platform_revenue(
  p_reference uuid,
  p_platform_fee numeric,
  p_delivery_margin numeric,
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_total NUMERIC := 0;
  v_order_completed BOOLEAN := FALSE;
  v_sub_order_completed BOOLEAN := FALSE;
BEGIN
  IF p_reference IS NULL THEN
    RAISE EXCEPTION 'Platform revenue reference cannot be NULL';
  END IF;

  IF COALESCE(p_platform_fee, 0) < 0 OR COALESCE(p_delivery_margin, 0) < 0 THEN
    RAISE EXCEPTION 'Platform revenue amounts cannot be negative';
  END IF;

  IF COALESCE(p_platform_fee, 0) > 0 THEN
    SELECT EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = p_reference
        AND UPPER(COALESCE(o.status, '')) IN ('DELIVERED', 'COMPLETED')
    ) INTO v_order_completed;

    IF NOT v_order_completed THEN
      RAISE EXCEPTION 'Platform fee revenue can only be recognized after the order is completed.';
    END IF;
  END IF;

  IF COALESCE(p_delivery_margin, 0) > 0 THEN
    SELECT EXISTS (
      SELECT 1 FROM public.sub_orders so
      WHERE so.id = p_reference
        AND UPPER(COALESCE(so.status, '')) IN ('DELIVERED', 'COMPLETED')
    ) INTO v_sub_order_completed;

    IF NOT v_sub_order_completed THEN
      RAISE EXCEPTION 'Delivery margin revenue can only be recognized after the sub-order is completed.';
    END IF;
  END IF;

  IF COALESCE(p_platform_fee, 0) > 0 THEN
    INSERT INTO public.platform_ledger_entries
      (reference, source_type, amount, description, actor_id)
    VALUES
      (p_reference, 'PLATFORM_FEE_EARNED', p_platform_fee,
       'Platform fee earned after order completion', p_actor_id)
    ON CONFLICT (reference, source_type)
      WHERE source_type IN ('PLATFORM_FEE_EARNED','DELIVERY_MARGIN_EARNED','WITHDRAWAL_FEE_EARNED')
    DO NOTHING;

    IF FOUND THEN
      v_total := v_total + p_platform_fee;
    END IF;
  END IF;

  IF COALESCE(p_delivery_margin, 0) > 0 THEN
    INSERT INTO public.platform_ledger_entries
      (reference, source_type, amount, description, actor_id)
    VALUES
      (p_reference, 'DELIVERY_MARGIN_EARNED', p_delivery_margin,
       'Delivery margin earned after sub-order completion', p_actor_id)
    ON CONFLICT (reference, source_type)
      WHERE source_type IN ('PLATFORM_FEE_EARNED','DELIVERY_MARGIN_EARNED','WITHDRAWAL_FEE_EARNED')
    DO NOTHING;

    IF FOUND THEN
      v_total := v_total + p_delivery_margin;
    END IF;
  END IF;

  IF v_total > 0 THEN
    UPDATE public.platform_accounts
    SET available_balance = available_balance + v_total,
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

REVOKE ALL ON FUNCTION public.credit_platform_revenue(uuid,numeric,numeric,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_platform_revenue(uuid,numeric,numeric,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.repair_delivered_sub_order_financials(
  p_sub_order_id uuid,
  p_actor_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_sub_order RECORD;
  v_vendor_user UUID;
  v_rider_user UUID;
  v_platform_margin NUMERIC;
  v_order_platform_fee NUMERIC;
  v_order_customer UUID;
  v_all_delivered BOOLEAN;
BEGIN
  SELECT * INTO v_sub_order
  FROM public.sub_orders
  WHERE id = p_sub_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sub-order % not found', p_sub_order_id;
  END IF;

  IF UPPER(COALESCE(v_sub_order.status, '')) NOT IN ('DELIVERED', 'COMPLETED') THEN
    RETURN FALSE;
  END IF;

  SELECT user_id INTO v_vendor_user
  FROM public.vendors
  WHERE id = v_sub_order.vendor_id;

  IF v_vendor_user IS NULL THEN
    RAISE EXCEPTION 'Vendor user missing for sub-order %', p_sub_order_id;
  END IF;

  PERFORM public.credit_delivery_payout(
    p_sub_order_id, 'vendor', v_vendor_user, COALESCE(v_sub_order.vendor_payout, 0)
  );

  IF v_sub_order.rider_id IS NOT NULL THEN
    SELECT user_id INTO v_rider_user
    FROM public.riders
    WHERE id = v_sub_order.rider_id;

    IF v_rider_user IS NULL THEN
      RAISE EXCEPTION 'Rider user missing for sub-order %', p_sub_order_id;
    END IF;

    PERFORM public.credit_delivery_payout(
      p_sub_order_id, 'rider', v_rider_user, COALESCE(v_sub_order.rider_payout, 0)
    );
  END IF;

  v_platform_margin := COALESCE(v_sub_order.delivery_margin, 0);

  IF v_platform_margin > 0 THEN
    PERFORM public.credit_platform_revenue(
      p_sub_order_id, 0, v_platform_margin, p_actor_id
    );

    INSERT INTO public.sub_order_payouts (sub_order_id, role, user_id, amount)
    VALUES (p_sub_order_id, 'platform_margin', NULL, v_platform_margin)
    ON CONFLICT (sub_order_id, role) DO NOTHING;
  END IF;

  -- Platform fee is order-level revenue and is recognized exactly once,
  -- only when every sub-order in the order has completed successfully.
  SELECT NOT EXISTS (
    SELECT 1 FROM public.sub_orders so
    WHERE so.order_id = v_sub_order.order_id
      AND UPPER(COALESCE(so.status, '')) NOT IN ('DELIVERED', 'COMPLETED')
  ) INTO v_all_delivered;

  IF v_all_delivered THEN
    SELECT o.platform_fee, o.customer_id
    INTO v_order_platform_fee, v_order_customer
    FROM public.orders o
    WHERE o.id = v_sub_order.order_id
    FOR UPDATE;

    IF COALESCE(v_order_platform_fee, 0) > 0 THEN
      PERFORM public.credit_platform_revenue(
        v_sub_order.order_id,
        v_order_platform_fee,
        0,
        COALESCE(p_actor_id, v_order_customer)
      );
    END IF;
  END IF;

  INSERT INTO public.ledger_entries (
    id, reference, type, amount, fee, net, source, destination, actor_id, description
  )
  VALUES (
    gen_random_uuid(),
    p_sub_order_id,
    'DELIVERY_CONFIRMED',
    COALESCE(v_sub_order.vendor_payout,0) + COALESCE(v_sub_order.rider_payout,0) + v_platform_margin,
    0,
    COALESCE(v_sub_order.vendor_payout,0) + COALESCE(v_sub_order.rider_payout,0) + v_platform_margin,
    'platform_held',
    'vendor_rider_and_platform_balances',
    p_actor_id,
    'Sub-order completed. Vendor: ₦' || COALESCE(v_sub_order.vendor_payout,0)
      || ', Rider: ₦' || COALESCE(v_sub_order.rider_payout,0)
      || ', Delivery margin: ₦' || v_platform_margin
  )
  ON CONFLICT (reference, type) WHERE reference IS NOT NULL DO NOTHING;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.repair_delivered_sub_order_financials(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.repair_delivered_sub_order_financials(uuid,uuid) TO service_role;
