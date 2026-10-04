-- ============================================================
-- Fidelx Coupon Concurrency Fix (STEP 2)
--
-- Scope: coupon usage-limit enforcement only.
-- This does NOT change orders, payments, balances, Paystack,
-- inventory, refunds, vendors, riders, or promotions budget.
--
-- Problem fixed:
-- Two simultaneous checkouts could both see a coupon as available
-- before either request incremented coupons.times_used. That could
-- allow a coupon to exceed its platform-wide or per-customer limit.
--
-- Fix:
-- create_order_with_sub_orders() now locks the coupon row FOR UPDATE
-- before recording the redemption. While one checkout is processing
-- a given coupon, another checkout using that same coupon must wait,
-- then re-check the limits against the latest committed counts.
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_order_with_sub_orders(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id UUID := (p_payload->>'order_id')::UUID;
  v_group JSONB;
  v_sub_order_id UUID;
  v_item JSONB;
  v_coupon_id UUID;
  v_customer_id UUID := (p_payload->>'customer_id')::UUID;
  v_coupon RECORD;
  v_customer_redemptions INTEGER;
BEGIN
  v_coupon_id := NULLIF(p_payload->'coupon_redemption'->>'coupon_id', '')::UUID;

  -- ------------------------------------------------------------
  -- Lock and re-check coupon usage limits inside the SAME DB
  -- transaction that records the order and redemption.
  -- ------------------------------------------------------------
  IF jsonb_typeof(p_payload->'coupon_redemption') = 'object'
     AND v_coupon_id IS NOT NULL THEN

    SELECT id,
           usage_limit,
           usage_limit_per_customer,
           times_used,
           is_active,
           starts_at,
           expires_at
    INTO v_coupon
    FROM public.coupons
    WHERE id = v_coupon_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Coupon is no longer available.'
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT v_coupon.is_active THEN
      RAISE EXCEPTION 'This coupon is no longer active.'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_coupon.starts_at IS NOT NULL AND v_coupon.starts_at > NOW() THEN
      RAISE EXCEPTION 'This coupon is not active yet.'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_coupon.expires_at IS NOT NULL AND v_coupon.expires_at < NOW() THEN
      RAISE EXCEPTION 'This coupon has expired.'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_coupon.usage_limit IS NOT NULL
       AND COALESCE(v_coupon.times_used, 0) >= v_coupon.usage_limit THEN
      RAISE EXCEPTION 'This coupon has reached its usage limit.'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT COUNT(*)::INTEGER
    INTO v_customer_redemptions
    FROM public.coupon_redemptions
    WHERE coupon_id = v_coupon_id
      AND customer_id = v_customer_id;

    IF v_customer_redemptions >= COALESCE(v_coupon.usage_limit_per_customer, 1) THEN
      RAISE EXCEPTION 'You have reached this coupon''s usage limit.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Main order insert.
  INSERT INTO public.orders (
    id, customer_id, region_id, status, subtotal, platform_fee, delivery_fee,
    coupon_id, discount_amount, total, payment_status, idempotency_key
  )
  SELECT
    v_order_id, (p_payload->>'customer_id')::UUID, (p_payload->>'region_id')::UUID,
    p_payload->>'status', (p_payload->>'subtotal')::NUMERIC, (p_payload->>'platform_fee')::NUMERIC,
    (p_payload->>'delivery_fee')::NUMERIC, NULLIF(p_payload->>'coupon_id','')::UUID,
    (p_payload->>'discount_amount')::NUMERIC, (p_payload->>'total')::NUMERIC,
    p_payload->>'payment_status', p_payload->>'idempotency_key';

  -- Coupon redemption + usage counter are in the same transaction
  -- and protected by the row lock above.
  IF jsonb_typeof(p_payload->'coupon_redemption') = 'object'
     AND v_coupon_id IS NOT NULL THEN
    INSERT INTO public.coupon_redemptions (
      id, coupon_id, customer_id, order_id, discount_amount
    )
    VALUES (
      gen_random_uuid(),
      v_coupon_id,
      v_customer_id,
      v_order_id,
      (p_payload->'coupon_redemption'->>'discount_amount')::NUMERIC
    );

    UPDATE public.coupons
    SET times_used = COALESCE(times_used, 0) + 1
    WHERE id = v_coupon_id;
  END IF;

  -- Vendor sub-orders + order items remain exactly as before.
  FOR v_group IN SELECT * FROM jsonb_array_elements(p_payload->'vendor_groups')
  LOOP
    v_sub_order_id := (v_group->>'id')::UUID;

    INSERT INTO public.sub_orders (
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
      INSERT INTO public.order_items (
        id, order_id, sub_order_id, product_id, variant_id, quantity, price
      )
      SELECT gen_random_uuid(), v_order_id, v_sub_order_id,
             (v_item->>'product_id')::UUID, NULLIF(v_item->>'variant_id','')::UUID,
             (v_item->>'quantity')::INT, (v_item->>'price')::NUMERIC;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('order_id', v_order_id);
END;
$$;

NOTIFY pgrst, 'reload schema';
