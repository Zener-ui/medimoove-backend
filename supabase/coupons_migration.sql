-- ============================================================
-- COUPONS / PROMOTIONS — MIGRATION
-- Run this in Supabase SQL Editor AFTER schema.sql.
--
-- A general-purpose promo engine, not just "coupon codes" — the same
-- system powers a first-order discount ("WELCOME10"), a seasonal
-- push ("DECEMBER15"), a single vendor's own promo, or a free-
-- delivery campaign ("FREESHIP"), all through one table instead of
-- a new feature every time marketing wants something new.
--
-- IMPORTANT: this never touches platform fee logic. The discount is
-- subtracted only from the final customer-facing order total in
-- subOrderController.createOrderWithSubOrders — platform_fee and
-- vendor_payout are still computed on the undiscounted subtotal
-- exactly as before. The platform absorbs the discount as a
-- marketing cost; nothing about how fees/payouts are calculated
-- changes.
-- ============================================================

CREATE TABLE IF NOT EXISTS coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('percentage', 'fixed', 'free_delivery')),
  value NUMERIC,                    -- percentage (0-100) or fixed naira amount; unused for free_delivery
  max_discount_amount NUMERIC,      -- caps a percentage discount in naira; null = uncapped
  min_order_amount NUMERIC DEFAULT 0,
  vendor_id UUID REFERENCES vendors(id),  -- null = platform-wide; set = one store's own promo
  usage_limit INT,                  -- total redemptions allowed platform-wide; null = unlimited
  usage_limit_per_customer INT DEFAULT 1,
  times_used INT DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  starts_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Case-insensitive uniqueness — "WELCOME10" and "welcome10" are the same code.
CREATE UNIQUE INDEX IF NOT EXISTS coupons_code_uidx ON coupons (UPPER(code));

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id UUID REFERENCES coupons(id),
  customer_id UUID REFERENCES users(id),
  order_id UUID REFERENCES orders(id),
  discount_amount NUMERIC NOT NULL,
  redeemed_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_id UUID REFERENCES coupons(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC DEFAULT 0;
