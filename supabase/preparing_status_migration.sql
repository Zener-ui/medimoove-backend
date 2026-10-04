-- ============================================================
-- ADD "PREPARING" ORDER STATUS — STUCK-ORDER DETECTION UPDATE
-- Run this in Supabase SQL Editor AFTER fix_stuck_order_alert_dedup_migration.sql
-- (this re-schedules the same cron job again, one more time).
--
-- WHY: a new PREPARING status was introduced between PAYMENT_CONFIRMED
-- and READY_FOR_PICKUP/WAITING_RIDER (see config/orderStateMachine.js)
-- to close the cancellation-trap bug — customers could previously
-- cancel for free even after a vendor had already cooked and
-- packaged an order. sub_orders.status is a plain TEXT column with
-- no CHECK constraint, so the new value needs no schema change — but
-- the stuck-order detection job explicitly lists which statuses count
-- as "in progress," and needs PREPARING added or an order stuck
-- there forever (a vendor who accepts but never marks it ready) would
-- never get flagged.
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
