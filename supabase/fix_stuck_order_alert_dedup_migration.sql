-- ============================================================
-- FIX: DUPLICATE "Stuck Orders Detected" ALERTS — MIGRATION
-- Run this in Supabase SQL Editor. Safe to run any time.
--
-- WHY: cron.schedule('detect-stuck-orders', ...) in
-- background_jobs.sql runs every 30 minutes and previously inserted
-- a new admin_alerts row EVERY run for as long as any sub-order
-- remained stuck — flooding the admin with duplicate notifications
-- for the same underlying condition instead of one alert per
-- genuinely new episode.
--
-- This re-schedules the SAME job name ('detect-stuck-orders'), which
-- pg_cron treats as an update-in-place — no need to unschedule first.
-- The per-sub-order insert into `stuck_orders` was already correctly
-- deduplicated; only the `admin_alerts` insert needed the guard.
-- ============================================================

SELECT cron.schedule(
  'detect-stuck-orders',
  '*/30 * * * *',
  $$
    INSERT INTO stuck_orders (id, order_id, sub_order_id, reason)
    SELECT
      gen_random_uuid(),
      so.order_id,
      so.id,
      'Order stuck in status: ' || so.status || ' for over 2 hours'
    FROM sub_orders so
    WHERE so.status IN ('PAYMENT_CONFIRMED', 'PREPARING', 'WAITING_RIDER', 'RIDER_ASSIGNED', 'PICKED_UP')
    AND so.updated_at < NOW() - INTERVAL '2 hours'
    AND so.id NOT IN (SELECT sub_order_id FROM stuck_orders WHERE resolved = false);

    INSERT INTO admin_alerts (id, type, severity, title, description)
    SELECT
      gen_random_uuid(),
      'STUCK_ORDER',
      'high',
      'Stuck Orders Detected',
      COUNT(*)::text || ' order(s) have been stuck for over 2 hours.'
    FROM sub_orders
    WHERE status IN ('PAYMENT_CONFIRMED', 'PREPARING', 'WAITING_RIDER', 'RIDER_ASSIGNED', 'PICKED_UP')
    AND updated_at < NOW() - INTERVAL '2 hours'
    AND NOT EXISTS (
      SELECT 1 FROM admin_alerts
      WHERE type = 'STUCK_ORDER' AND is_resolved = false
    )
    HAVING COUNT(*) > 0;
  $$
);
