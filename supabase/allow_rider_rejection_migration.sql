-- ============================================================
-- ALLOW RIDER REJECTION — MIGRATION
-- Run this in Supabase SQL Editor after all prior migrations.
--
-- The riders table's status CHECK constraint only allowed
-- ('pending', 'approved', 'suspended') — there was no way for a
-- rider to ever be in a 'rejected' state, even though the vendor
-- table already supports rejection and the onboarding controller
-- already has a reapplyRider endpoint that checks for exactly
-- this status. Without this, that endpoint was permanently
-- unreachable, since no rider could legitimately ever be in a
-- status that didn't exist.
-- ============================================================

ALTER TABLE riders DROP CONSTRAINT IF EXISTS riders_status_check;

ALTER TABLE riders
  ADD CONSTRAINT riders_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'suspended'));
