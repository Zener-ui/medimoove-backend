-- ============================================================
-- MAX DELIVERY RADIUS 20km -> 30km — MIGRATION
-- Run this in Supabase SQL Editor AFTER schema.sql.
--
-- WHY: the column default and the code fallback in
-- deliveryController.getDeliverySettings() only apply when a region
-- has no delivery_settings row at all. Any region that already has an
-- explicit row (created via the old default of 20) needs its stored
-- value bumped too, or it will keep enforcing the old 20km limit
-- regardless of the code/default change.
--
-- Safe: only updates rows still sitting at the old default (20).
-- A region an admin deliberately configured to a custom radius other
-- than 20 (e.g. 15 for a dense urban area) is left untouched.
-- ============================================================

ALTER TABLE delivery_settings ALTER COLUMN maximum_delivery_radius SET DEFAULT 30;

UPDATE delivery_settings
SET maximum_delivery_radius = 30
WHERE maximum_delivery_radius = 20;

-- ============================================================
-- VENDOR DELIVERY RADIUS OVERRIDE
--
-- WHY: vendors had no way to set their own delivery radius — the
-- store profile page showed a "Delivery Radius" figure, but it was
-- always just the per-region default above, read-only, nothing a
-- vendor could actually change. That's what made it look like it was
-- "resetting to 30km every time": there was never a save path, just
-- a constant being displayed.
--
-- This adds a real, persisted, vendor-specific override — capped at
-- (never exceeding) the region's own maximum, so an individual
-- vendor can choose to deliver a SMALLER radius than the platform
-- allows (e.g. a small kitchen with one bike), but never a larger
-- one. NULL means "use the region default", same as before.
-- ============================================================

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS delivery_radius_km NUMERIC;
