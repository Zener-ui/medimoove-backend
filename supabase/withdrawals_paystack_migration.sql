-- ============================================================
-- WITHDRAWALS — PAYSTACK BANK VERIFICATION + TRANSFER TRACKING
-- Adds the columns needed to move from a manually-typed bank name/
-- account/account-name to a Paystack-verified account, and to track
-- the real Paystack transfer this withdrawal corresponds to.
-- Run this before deploying the updated withdrawalController.js —
-- it references these columns directly.
-- ============================================================

ALTER TABLE withdrawals
  ADD COLUMN IF NOT EXISTS bank_code TEXT,
  ADD COLUMN IF NOT EXISTS paystack_recipient_code TEXT,
  ADD COLUMN IF NOT EXISTS paystack_transfer_id TEXT,
  ADD COLUMN IF NOT EXISTS paystack_transfer_code TEXT,
  ADD COLUMN IF NOT EXISTS paystack_reference TEXT,
  ADD COLUMN IF NOT EXISTS paystack_status TEXT,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_paystack_transfer_id_unique
  ON withdrawals(paystack_transfer_id)
  WHERE paystack_transfer_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_paystack_reference_unique
  ON withdrawals(paystack_reference)
  WHERE paystack_reference IS NOT NULL;

-- Existing withdrawals approved under the old flow have no bank_code
-- and were marked COMPLETED without a real transfer ever happening.
-- This migration does not touch their status or amounts — do not
-- assume they were actually paid; that needs manual reconciliation
-- against your actual Paystack transfer history, not a query.
