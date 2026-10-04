-- Fix #39: prevent more than one pending payment transaction per order.
-- The backend also reuses the stored Paystack authorization URL.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS authorization_url TEXT;

-- Existing installations should not normally have duplicate pending rows.
-- Do not silently rewrite them here: if duplicates exist, surface that data
-- condition before enabling the invariant so no live Paystack transaction is
-- arbitrarily discarded by a migration.
DO $$
DECLARE
  duplicate_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO duplicate_count
  FROM (
    SELECT order_id
    FROM payments
    WHERE status = 'pending'
    GROUP BY order_id
    HAVING COUNT(*) > 1
  ) d;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'Fix #39 stopped: % order(s) have multiple pending payment rows. Resolve those rows before creating the unique pending-payment index.',
      duplicate_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_one_pending_per_order
  ON payments (order_id)
  WHERE status = 'pending';
