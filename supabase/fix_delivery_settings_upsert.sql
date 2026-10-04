-- ============================================================
-- Fix: delivery_settings writes were silent no-ops
-- ============================================================
-- toggleRainSurcharge and setManualOverride both do a plain UPDATE
-- keyed on region_id. Nothing anywhere ever INSERTs a delivery_settings
-- row for a region in the first place, so every region has zero rows
-- right now — meaning both of those admin actions have been matching
-- zero rows and reporting success while actually changing nothing.
--
-- Fix has two parts: a real unique constraint on region_id so an
-- upsert has something to conflict on, and a one-time backfill so
-- existing regions get a real row today instead of only ever existing
-- as computed defaults.
-- ============================================================

ALTER TABLE delivery_settings
  ADD CONSTRAINT uq_delivery_settings_region_id UNIQUE (region_id);

INSERT INTO delivery_settings (region_id)
SELECT r.id FROM regions r
WHERE NOT EXISTS (
  SELECT 1 FROM delivery_settings ds WHERE ds.region_id = r.id
);
