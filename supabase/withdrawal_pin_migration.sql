-- ============================================================
-- WITHDRAWAL PIN — MIGRATION
-- Run this in Supabase SQL Editor AFTER schema.sql.
--
-- WHY: vendors and riders must set a 4-digit withdrawal PIN and
-- enter it on every withdrawal request, as an extra confirmation
-- step before money moves. Stored as a bcrypt hash, same pattern as
-- users.password_hash — never the raw PIN.
--
-- On users rather than vendors/riders separately, since
-- withdrawals.requester_id already references users.id directly for
-- both requester types (see withdrawalController.requestWithdrawal).
--
-- Safe: purely additive, nullable column. No data touched.
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS withdrawal_pin_hash TEXT;
