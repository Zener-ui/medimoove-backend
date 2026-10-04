-- ============================================================
-- LOCK PROTECTED COLUMNS ON SELF-UPDATE — MIGRATION
-- Run this in Supabase SQL Editor.
--
-- WHY THIS MATTERS (this is a real, exploitable gap, not a
-- theoretical one): "users_update_own", "vendors_update_own", and
-- "riders_update_own" in rls_policies.sql all use
--   FOR UPDATE USING (user_id = auth.uid())
-- with no WITH CHECK clause. That only restricts WHICH ROW a user
-- can touch — not WHICH COLUMNS. Since Postgres RLS has no built-in
-- column-level restriction, any authenticated user can currently
-- open a raw Supabase client (project URL + public anon key — both
-- necessarily public, same as any Supabase app) and PATCH their own
-- row directly, setting ANY column to ANY value, completely
-- bypassing your Node backend and every check it does. Concretely,
-- right now, any user could:
--   - set users.role = 'admin' on their own account
--   - overwrite their own users.password_hash / withdrawal_pin_hash
--   - set vendors.status = 'approved' or vendors.is_verified = true
--     on themselves, skipping admin review entirely
--   - set vendors.plan = 'premium' for free
--   - reset vendors.strike_count / riders.strike_count to erase
--     violation history
--   - set riders.status = 'approved' or riders.nin_verified = true
--     without ever passing NIN verification
--   - inflate their own vendors.rating / riders.rating
-- The frontend never does this today (it goes through the backend
-- API), so nothing in the app currently exercises this — but it does
-- NOT depend on any frontend bug to exploit; it only requires the
-- publicly-known project URL and anon key, which every Supabase
-- project necessarily exposes.
--
-- FIX: BEFORE UPDATE triggers that force protected columns back to
-- their existing value whenever the request is NOT coming from the
-- service role (i.e. not your backend's adminClient). This is the
-- standard Supabase-recommended pattern for column-level protection,
-- since RLS policies alone can't express it. Every column the
-- backend's own self-update endpoints intentionally allow editing
-- (see vendorController.updateVendorProfile,
-- riderController equivalent) is left untouched — this only locks
-- down columns your own backend never lets a user touch directly
-- either.
-- ============================================================

-- USERS: lock role, password_hash, withdrawal_pin_hash
CREATE OR REPLACE FUNCTION protect_users_columns()
RETURNS TRIGGER AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    NEW.role := OLD.role;
    NEW.password_hash := OLD.password_hash;
    NEW.withdrawal_pin_hash := OLD.withdrawal_pin_hash;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_protect_users_columns ON users;
CREATE TRIGGER trg_protect_users_columns
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION protect_users_columns();

-- VENDORS: lock status, is_verified, plan, strike_count, rating,
-- cac_number, logo_url, id_document_url (none of these are in the
-- backend's own self-edit field list)
CREATE OR REPLACE FUNCTION protect_vendors_columns()
RETURNS TRIGGER AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    NEW.status := OLD.status;
    NEW.is_verified := OLD.is_verified;
    NEW.plan := OLD.plan;
    NEW.strike_count := OLD.strike_count;
    NEW.rating := OLD.rating;
    NEW.cac_number := OLD.cac_number;
    NEW.logo_url := OLD.logo_url;
    NEW.id_document_url := OLD.id_document_url;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_protect_vendors_columns ON vendors;
CREATE TRIGGER trg_protect_vendors_columns
  BEFORE UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION protect_vendors_columns();

-- RIDERS: lock status, nin_verified, nin, strike_count, rating
-- (nin changes only ever happen via riderController's own
-- rate-limited re-verification flow, through adminClient)
CREATE OR REPLACE FUNCTION protect_riders_columns()
RETURNS TRIGGER AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    NEW.status := OLD.status;
    NEW.nin_verified := OLD.nin_verified;
    NEW.nin := OLD.nin;
    NEW.strike_count := OLD.strike_count;
    NEW.rating := OLD.rating;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_protect_riders_columns ON riders;
CREATE TRIGGER trg_protect_riders_columns
  BEFORE UPDATE ON riders
  FOR EACH ROW EXECUTE FUNCTION protect_riders_columns();

-- ORDERS: the RLS policy comment says customers can update their own
-- orders "(cancel)", but the actual cancel flow (subOrderController /
-- orderController) always goes through adminClient — no legitimate
-- code path ever updates orders directly as the customer. Lock the
-- whole row: money fields (subtotal/platform_fee/delivery_fee/total/
-- discount_amount), payment_status, status, and the Paystack/
-- idempotency references, since none of these should ever move via
-- a direct client update. If you later want customers to trigger
-- cancellation via direct client update rather than an API call,
-- carve out a narrower WITH CHECK instead of removing this trigger.
CREATE OR REPLACE FUNCTION protect_orders_columns()
RETURNS TRIGGER AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    NEW.status := OLD.status;
    NEW.payment_status := OLD.payment_status;
    NEW.subtotal := OLD.subtotal;
    NEW.platform_fee := OLD.platform_fee;
    NEW.delivery_fee := OLD.delivery_fee;
    NEW.discount_amount := OLD.discount_amount;
    NEW.total := OLD.total;
    NEW.paystack_reference := OLD.paystack_reference;
    NEW.idempotency_key := OLD.idempotency_key;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_protect_orders_columns ON orders;
CREATE TRIGGER trg_protect_orders_columns
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION protect_orders_columns();

-- SUB_ORDERS: same reasoning — vendor/rider status transitions
-- (accept, picked up, delivered) all go through adminClient in
-- subOrderController, never a direct client update. Without this,
-- a vendor or rider could directly inflate their own
-- vendor_payout/rider_payout, or flip status to DELIVERED without
-- ever actually delivering.
CREATE OR REPLACE FUNCTION protect_sub_orders_columns()
RETURNS TRIGGER AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    NEW.status := OLD.status;
    NEW.subtotal := OLD.subtotal;
    NEW.platform_fee := OLD.platform_fee;
    NEW.delivery_fee := OLD.delivery_fee;
    NEW.delivery_margin := OLD.delivery_margin;
    NEW.vendor_payout := OLD.vendor_payout;
    NEW.rider_payout := OLD.rider_payout;
    NEW.withdrawal_available_at := OLD.withdrawal_available_at;
    NEW.delivered_at := OLD.delivered_at;
    NEW.cancelled_at := OLD.cancelled_at;
    NEW.rider_id := OLD.rider_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_protect_sub_orders_columns ON sub_orders;
CREATE TRIGGER trg_protect_sub_orders_columns
  BEFORE UPDATE ON sub_orders
  FOR EACH ROW EXECUTE FUNCTION protect_sub_orders_columns();
