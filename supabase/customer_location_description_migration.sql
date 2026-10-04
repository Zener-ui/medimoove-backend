-- ============================================================
-- CUSTOMER LOCATION DESCRIPTION — MIGRATION
-- For low-literacy users: GPS coordinates alone often aren't enough
-- to find a specific spot in an area with few formal addresses.
-- These let the customer describe exactly where they are, in their
-- own words or their own voice, alongside the GPS pin.
-- ============================================================

ALTER TABLE sub_orders
  ADD COLUMN IF NOT EXISTS delivery_description TEXT,
  ADD COLUMN IF NOT EXISTS delivery_voice_note_url TEXT;
