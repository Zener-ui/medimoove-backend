-- Fidelx Coupon Multi-Vendor Eligibility Fix (STEP 3)
--
-- Scope: vendor-specific coupon eligibility only.
-- This migration does NOT modify orders, payments, balances, Paystack,
-- inventory, refunds, promotions funding, vendors, riders, or coupon usage
-- concurrency rules from STEP 2.
--
-- The authoritative enforcement is in controllers/subOrderController.js:
-- a vendor-specific coupon must match one of the actual vendor groups in
-- the cart, and its discount is calculated only against that vendor's
-- subtotal/delivery portion. Platform-wide coupons still use the full order.
--
-- The SQL below only adds a defensive database constraint so a coupon's
-- vendor_id, when present, always references a real vendor.

DO $$
BEGIN
  IF to_regclass('public.coupons') IS NOT NULL
     AND to_regclass('public.vendors') IS NOT NULL THEN
    BEGIN
      ALTER TABLE public.coupons
        ADD CONSTRAINT coupons_vendor_id_fkey
        FOREIGN KEY (vendor_id) REFERENCES public.vendors(id)
        ON DELETE SET NULL;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
      WHEN duplicate_table THEN NULL;
    END;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
