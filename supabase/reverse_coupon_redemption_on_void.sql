-- ============================================================
-- Reverse a coupon redemption for a voided order
-- ============================================================
-- Used exactly where an order is being marked as never-happened:
--   - EXPIRED (no payment ever succeeded)
--   - FAILED_BUT_CHARGED, fully auto-refunded (paid too late, voided)
--
-- Both of those already release inventory for the same reason; this
-- is the promotions-side equivalent, closing three linked leaks that
-- share one root cause (nothing ever undid the coupon side-effects
-- that happen at order-creation time when the order later turns out
-- to never be a real sale):
--   1. promotions_budget spend was never refunded
--   2. coupons.times_used was never decremented
--   3. the coupon_redemptions row was never removed — meaning a
--      customer whose payment never went through could be
--      permanently blocked from ever using that coupon again
--
-- Deliberately scoped to whole-order voids only. Does NOT run for
-- disputes/partial refunds (the sale genuinely happened) or
-- multi-vendor partial cancellations (ambiguous — see conversation
-- notes; a real business-policy call, not a bug fix).
-- ============================================================

CREATE OR REPLACE FUNCTION reverse_coupon_redemption(p_order_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_redemption RECORD;
BEGIN
  SELECT cr.id, cr.coupon_id, cr.discount_amount
  INTO v_redemption
  FROM coupon_redemptions cr
  WHERE cr.order_id = p_order_id;

  -- No redemption row for this order — either no coupon was ever
  -- applied, or it was already reversed. Either way, nothing to do,
  -- and this makes the function itself safely re-callable.
  IF NOT FOUND THEN RETURN FALSE; END IF;

  -- Row-lock the coupon itself, same as the concurrency fix does at
  -- redemption time, so this can never race with a real simultaneous
  -- redemption of the same coupon.
  UPDATE coupons
  SET times_used = GREATEST(COALESCE(times_used, 0) - 1, 0)
  WHERE id = v_redemption.coupon_id;

  DELETE FROM coupon_redemptions WHERE id = v_redemption.id;

  RETURN TRUE;
END;
$$;
