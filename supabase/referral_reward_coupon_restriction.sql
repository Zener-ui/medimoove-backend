-- ============================================================
-- Referral reward coupon restriction
-- ============================================================
-- Makes manually-issued referral reward coupons technically redeemable
-- only by the customer who earned them. This does not change discount
-- amounts, platform fees, vendor payouts, balances, or Paystack logic.
-- ============================================================

ALTER TABLE coupons
  ADD COLUMN IF NOT EXISTS restricted_customer_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_coupons_restricted_customer_id
  ON coupons(restricted_customer_id);
