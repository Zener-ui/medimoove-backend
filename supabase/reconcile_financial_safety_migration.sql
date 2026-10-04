-- ============================================================
-- SCHEDULE THE NEW RECONCILIATION JOBS
-- Run this AFTER financial_safety_migration.sql and after redeploying
-- the backend (these call routes that only exist in the new code).
-- Same pg_cron -> pg_net -> internal secured endpoint pattern as the
-- existing reconcile-stale-payments / reconcile-stuck-refunds jobs —
-- update the URL below if your Render backend URL differs.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Item 9: resume payments stuck "successful" with unfinished side effects.
SELECT cron.schedule(
  'reconcile-payment-processing',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://fidelx-backend.onrender.com/api/payments/reconcile-processing-internal',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Internal-Webhook-Secret', current_setting('app.settings.internal_webhook_secret', true)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

-- Item 5: resolve withdrawals stuck CLAIMED by a crash mid-approval.
SELECT cron.schedule(
  'reconcile-withdrawal-claims',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://fidelx-backend.onrender.com/api/withdrawals/reconcile-internal',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Internal-Webhook-Secret', current_setting('app.settings.internal_webhook_secret', true)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

-- To confirm both are actually running:
--   SELECT * FROM cron.job WHERE jobname IN ('reconcile-payment-processing','reconcile-withdrawal-claims');
--   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;
