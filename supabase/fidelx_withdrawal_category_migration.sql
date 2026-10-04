-- Fidelx: Paystack vendor/rider withdrawal + canonical category migration
-- Run AFTER the existing schema/atomic_functions.sql.

ALTER TABLE withdrawals
  ADD COLUMN IF NOT EXISTS bank_code TEXT,
  ADD COLUMN IF NOT EXISTS paystack_transfer_id TEXT,
  ADD COLUMN IF NOT EXISTS paystack_transfer_reference TEXT,
  ADD COLUMN IF NOT EXISTS paystack_transfer_code TEXT,
  ADD COLUMN IF NOT EXISTS paystack_status TEXT,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_paystack_transfer_id_uidx
  ON withdrawals(paystack_transfer_id)
  WHERE paystack_transfer_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_paystack_transfer_reference_uidx
  ON withdrawals(paystack_transfer_reference)
  WHERE paystack_transfer_reference IS NOT NULL;

-- Existing test/legacy rows can remain NULL. New application requests
-- populate bank_code and Paystack transfer fields.
