-- ============================================================
-- FIX #41 — CLOSE DIRECT WITHDRAWAL INSERT BYPASS
--
-- The backend is the only legitimate path that creates withdrawal
-- requests. It validates the requester role/approval, withdrawal PIN,
-- available balance, fee calculation, bank verification, and atomically
-- deducts the balance before inserting the withdrawal row.
--
-- The old RLS policy allowed any authenticated user to INSERT a
-- withdrawal row directly through PostgREST as long as requester_id was
-- their own user id. That bypassed all of those backend checks and also
-- allowed arbitrary gross_amount/net_payout/status/bank details/vendor_id
-- or rider_id values to be written into the withdrawal queue.
--
-- Remove the direct INSERT policy. The Node backend uses service_role and
-- therefore continues to work. Users can still SELECT their own
-- withdrawals through withdrawals_select_own.
-- ============================================================

DROP POLICY IF EXISTS "withdrawals_insert_own" ON withdrawals;
