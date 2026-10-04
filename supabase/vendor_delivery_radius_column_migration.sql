-- ============================================================
-- VENDOR DELIVERY RADIUS COLUMN — URGENT FIX
-- Run this in Supabase SQL Editor immediately.
--
-- WHY: this single column was added by editing
-- max_delivery_radius_migration.sql, a file already run on the live
-- database — so the new column never actually got created there.
-- Order creation (and delivery estimate) now queries for this column
-- unconditionally, which breaks checkout entirely with:
--   "column vendors_1.delivery_radius_km does not exist"
--
-- Safe: single additive, nullable column. No data touched.
-- ============================================================

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS delivery_radius_km NUMERIC;
