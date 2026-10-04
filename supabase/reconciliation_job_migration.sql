-- ============================================================
-- CLOSE THE DOUBLE-WITHDRAWAL RACE + WIRE UP PAYMENT RECONCILIATION
-- Run this in Supabase SQL Editor.
-- ============================================================

-- Both already enabled by earlier migrations (settlement_hold_migration.sql,
-- push_notifications_migration.sql) — repeated here so this file doesn't
-- silently depend on run order. Both are idempotent.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 1. DOUBLE-WITHDRAWAL RACE
-- requestWithdrawal's "already have a pending withdrawal" check was
-- app-level only (SELECT then INSERT, not atomic) — two rapid
-- double-taps on a bad connection could both pass the check before
-- either INSERT lands. This partial unique index closes it at the
-- database level regardless of timing. The application code
-- (withdrawalController.js) now also correctly handles the resulting
-- 23505 unique_violation by rolling back the balance deduction that
-- atomic_withdraw_balance() already made before this insert — without
-- that fix, closing the race here alone would have caused the SECOND
-- request to lose its deducted balance with no withdrawal row to
-- account for it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_pending_withdrawal_per_user
ON withdrawals(requester_id)
WHERE status = 'PENDING';

-- 2. PAYMENT RECONCILIATION JOB
-- Runs backend/controllers/reconciliationController.js's
-- reconcileStalePayments() on a schedule via the same pg_net webhook
-- pattern already used for push notifications and balance releases —
-- pg_cron fires, calls a secured internal backend endpoint, the actual
-- Paystack-calling logic runs in Node (needed for the deliberately
-- throttled sequential API calls — pg_net's fire-and-forget model can't
-- do that kind of sequenced work itself).
--
-- Runs every 10 minutes — matches MIN_CHECK_AGE_MINUTES in the job
-- itself, so nothing sits meaningfully longer than one extra cycle
-- before its first check.
--
-- timeout_milliseconds is set higher than pg_net's 5000ms default
-- specifically to tolerate a Render free-tier cold start on the first
-- call after a period of inactivity — if it still times out, that's
-- fine, the next scheduled run 10 minutes later picks it up.
SELECT cron.schedule(
  'reconcile-stale-payments',
  '*/10 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://fidelx-backend.onrender.com/api/payments/reconcile-internal',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Internal-Webhook-Secret', current_setting('app.settings.internal_webhook_secret', true)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

-- To confirm it's actually running (same caveat as the balance-release
-- job — pg_net silently failing is a known real-world occurrence):
--   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 5;
--   SELECT * FROM net._http_response ORDER BY created DESC LIMIT 5;
