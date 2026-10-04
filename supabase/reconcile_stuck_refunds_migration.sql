-- ============================================================
-- STUCK REFUND RECONCILIATION JOB
-- Run this in Supabase SQL Editor.
--
-- Safety net for refunds whose Paystack refund.processed webhook was
-- dropped, delayed, or never delivered — without this, a refund
-- Paystack actually completed could sit "pending" in our own
-- refunds table forever, and the responsible vendor/rider's balance
-- would never actually get debited.
--
-- Same pg_cron -> pg_net -> internal secured endpoint pattern as
-- reconcile_stale_payments (reconciliation_job_migration.sql) —
-- update the URL below if your Render backend URL differs.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule(
  'reconcile-stuck-refunds',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://fidelx-backend.onrender.com/api/refunds/reconcile-internal',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Internal-Webhook-Secret', current_setting('app.settings.internal_webhook_secret', true)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

-- To confirm it's actually running:
--   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 5;
--   SELECT * FROM net._http_response ORDER BY created DESC LIMIT 5;
