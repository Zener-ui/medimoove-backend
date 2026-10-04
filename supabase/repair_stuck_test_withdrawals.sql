-- ============================================================
-- ONE-TIME REPAIR — stuck PENDING withdrawals from before the
-- approveWithdrawal fix.
--
-- WHY YOU NEED THIS: before the fix, if approving a withdrawal failed
-- on the Paystack side (e.g. below Paystack's minimum), the request's
-- balance had already been deducted at REQUEST time but was never
-- restored on failure. The withdrawal row was left sitting at
-- PENDING forever, with no working way to withdraw again (a PENDING
-- row blocks new requests) and no way to see the money again ("the
-- vendor has the balance" per your mental model / dashboard totals,
-- but available_balance was actually already reduced by these stuck
-- rows). This is almost certainly why requestWithdrawal has been
-- telling you "insufficient balance" during testing.
--
-- Run step 1 first to see exactly what this will touch before
-- running step 2. Safe to run multiple times — step 2 only ever
-- touches rows still at status = 'PENDING'.
-- ============================================================

-- STEP 1 — inspect what's stuck (read-only, run this first)
SELECT id, requester_id, requester_type, gross_amount, withdrawal_fee,
       net_payout, status, requested_at
FROM withdrawals
WHERE status = 'PENDING'
ORDER BY requested_at ASC;

-- STEP 2 — restore balance + mark FAILED for every row still stuck at
-- PENDING. Uses the same restore_balance_after_rejection RPC that
-- rejectWithdrawal already calls, so it's the same trusted path.
DO $$
DECLARE
  w RECORD;
BEGIN
  FOR w IN SELECT id, requester_id, gross_amount FROM withdrawals WHERE status = 'PENDING' LOOP
    PERFORM restore_balance_after_rejection(w.requester_id, w.gross_amount);

    UPDATE withdrawals
    SET status = 'FAILED',
        rejection_reason = 'Repaired: stuck from testing before the approveWithdrawal rollback fix.',
        reviewed_at = NOW()
    WHERE id = w.id;
  END LOOP;
END $$;

-- STEP 3 — confirm balances now look right
SELECT user_id, available_balance, total_earned, total_withdrawn
FROM balances
ORDER BY updated_at DESC;
