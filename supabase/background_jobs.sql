-- ============================================================
-- CARTMOOVE BACKGROUND JOBS
-- Run in Supabase SQL Editor AFTER schema.sql and rls_policies.sql
-- Requires pg_cron extension (enabled in Supabase by default)
-- ============================================================

-- Enable pg_cron
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ============================================================
-- JOB 1: RELEASE EXPIRED INVENTORY RESERVATIONS
-- Runs every 5 minutes
-- Releases stock held by unpaid orders older than 15 minutes
-- ============================================================
SELECT cron.schedule(
  'release-expired-reservations',
  '*/5 * * * *',
  $$
    DO $$
    DECLARE
      res RECORD;
    BEGIN
      FOR res IN
        SELECT * FROM inventory_reservations
        WHERE status = 'reserved'
        AND expires_at < NOW()
      LOOP
        -- Release the reservation row and reserved stock atomically.
        -- Concurrent cancellation/payment processing can therefore not
        -- release the same reservation twice or leave stock stuck.
        PERFORM release_inventory_reservation(res.id);

        -- Cancel the order if it is still pending payment
        UPDATE orders
        SET status = 'CANCELLED'
        WHERE id = res.order_id
        AND status = 'PENDING_PAYMENT';

        -- Cancel related sub-orders
        UPDATE sub_orders
        SET status = 'CANCELLED', cancelled_at = NOW()
        WHERE order_id = res.order_id
        AND status = 'PENDING_PAYMENT';

      END LOOP;
    END;
    $$;
  $$
);

-- ============================================================
-- JOB 2: AUTO-CONFIRM DELIVERY AFTER 24 HOURS
-- Runs every hour
-- If customer has not disputed within 24hrs of delivery,
-- release vendor funds automatically
-- ============================================================
SELECT cron.schedule(
  'auto-confirm-delivery',
  '0 * * * *',
  $$
    -- Find delivered sub-orders past their withdrawal window
    -- that have not been disputed
    UPDATE sub_orders
    SET status = 'DELIVERED'
    WHERE status = 'DELIVERED'
    AND withdrawal_available_at < NOW()
    AND id NOT IN (
      SELECT sub_order_id FROM disputes
      WHERE status IN ('open', 'appealed')
    );

    -- Release vendor balance for sub-orders past window
    -- This is a signal to the backend that funds are unlocked
    -- Actual payout happens via withdrawal request
    UPDATE orders
    SET status = 'DELIVERED'
    WHERE status != 'DELIVERED'
    AND id IN (
      SELECT order_id FROM sub_orders
      WHERE status = 'DELIVERED'
      GROUP BY order_id
      HAVING COUNT(*) = COUNT(CASE WHEN status = 'DELIVERED' THEN 1 END)
    );
  $$
);

-- ============================================================
-- JOB 3: MARK INACTIVE RIDERS
-- Runs every day at midnight
-- Riders inactive for 30+ days get paused
-- ============================================================
SELECT cron.schedule(
  'mark-inactive-riders',
  '0 0 * * *',
  $$
    -- Pause riders inactive for 30 days
    UPDATE riders
    SET is_active = false
    WHERE is_active = true
    AND (last_seen IS NULL OR last_seen < NOW() - INTERVAL '30 days')
    AND status = 'approved';

    -- Suspend riders inactive for 60 days
    UPDATE riders
    SET status = 'suspended', is_active = false
    WHERE status = 'approved'
    AND (last_seen IS NULL OR last_seen < NOW() - INTERVAL '60 days');
  $$
);

-- ============================================================
-- JOB 4: FLAG LOW STOCK PRODUCTS
-- Runs every day at 8am
-- Notifies vendors when any product has 3 or fewer items left
-- ============================================================
SELECT cron.schedule(
  'low-stock-alerts',
  '0 8 * * *',
  $$
    INSERT INTO notifications (id, user_id, title, body, is_read)
    SELECT
      gen_random_uuid(),
      v.user_id::text,
      'Low Stock Alert ⚠️',
      'Your product "' || p.name || '" has only ' || p.stock_quantity || ' unit(s) left.',
      false
    FROM products p
    JOIN vendors v ON p.vendor_id = v.id
    WHERE p.stock_quantity <= 3
    AND p.stock_quantity > 0
    AND p.is_available = true;
  $$
);

-- ============================================================
-- JOB 5: CLEANUP OLD NOTIFICATIONS
-- Runs every Sunday at 2am
-- Deletes read notifications older than 60 days
-- ============================================================
SELECT cron.schedule(
  'cleanup-old-notifications',
  '0 2 * * 0',
  $$
    DELETE FROM notifications
    WHERE is_read = true
    AND created_at < NOW() - INTERVAL '60 days';
  $$
);

-- ============================================================
-- VIEW SCHEDULED JOBS (run this to verify)
-- ============================================================
-- SELECT * FROM cron.job;

-- ============================================================
-- REMOVE A JOB (if needed)
-- ============================================================
-- SELECT cron.unschedule('job-name-here');

-- ============================================================
-- JOB 6: DAILY BALANCE RECONCILIATION
-- Runs every day at 3am
-- Compares balances table against ledger sums
-- Creates admin alert if mismatch detected
-- ============================================================
SELECT cron.schedule(
  'daily-balance-reconciliation',
  '0 3 * * *',
  $$
    DO $$
    DECLARE
      mismatch RECORD;
      mismatch_count INT := 0;
    BEGIN
      FOR mismatch IN SELECT * FROM reconcile_balances()
      LOOP
        mismatch_count := mismatch_count + 1;

        INSERT INTO notifications (id, user_id, title, body, is_read)
        VALUES (
          gen_random_uuid(),
          'admin',
          '⚠️ Balance Drift Detected',
          'User ' || mismatch.user_id || ' has a balance drift of ₦' || ABS(mismatch.drift) || '. Manual review required.',
          false
        );

        INSERT INTO audit_logs (id, action, actor_id, target_id, target_type, details)
        VALUES (
          gen_random_uuid(),
          'BALANCE_DRIFT_DETECTED',
          'system',
          mismatch.user_id::text,
          'balance',
          jsonb_build_object(
            'balance_table', mismatch.balance_table_amount,
            'ledger_sum', mismatch.ledger_sum,
            'drift', mismatch.drift
          )
        );
      END LOOP;

      IF mismatch_count > 0 THEN
        RAISE NOTICE '% balance mismatch(es) detected and logged.', mismatch_count;
      END IF;
    END;
    $$;
  $$
);

-- ============================================================
-- JOB 7: DETECT STUCK ORDERS
-- Runs every 30 minutes
-- Flags orders that haven't moved status in 2+ hours
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
    -- Without this, every run of this job (every 30 minutes) inserted
    -- another "Stuck Orders Detected" alert for the SAME underlying
    -- condition, for as long as it remained unresolved — flooding the
    -- admin with duplicates instead of one alert per genuinely new
    -- stuck-order episode. Skip creating a new alert while an
    -- unresolved one already exists; once an admin resolves it (see
    -- resolveAlert in pilotAndOpsController.js), the next run is free
    -- to raise a fresh one if the condition still holds.
    AND NOT EXISTS (
      SELECT 1 FROM admin_alerts
      WHERE type = 'STUCK_ORDER' AND is_resolved = false
    )
    HAVING COUNT(*) > 0;
  $$
);

-- ============================================================
-- JOB 8: DETECT PAYMENT FAILURES
-- Runs every hour
-- Flags pending payments older than 1 hour
-- ============================================================
SELECT cron.schedule(
  'detect-payment-failures',
  '0 * * * *',
  $$
    INSERT INTO admin_alerts (id, type, severity, title, description, reference_id, reference_type)
    SELECT
      gen_random_uuid(),
      'PAYMENT_FAILURE',
      'medium',
      'Abandoned Payment Detected',
      'Order has been pending payment for over 1 hour.',
      o.id::text,
      'order'
    FROM orders o
    WHERE o.status = 'PENDING_PAYMENT'
    AND o.created_at < NOW() - INTERVAL '1 hour'
    AND o.id NOT IN (
      SELECT reference_id::uuid FROM admin_alerts
      WHERE type = 'PAYMENT_FAILURE'
      AND created_at > NOW() - INTERVAL '1 day'
    );
  $$
);

-- ============================================================
-- JOB 9: SLA BREACH DETECTION
-- Runs every 15 minutes
-- Alerts admin when support tickets breach SLA
-- ============================================================
SELECT cron.schedule(
  'detect-sla-breaches',
  '*/15 * * * *',
  $$
    INSERT INTO admin_alerts (id, type, severity, title, description, reference_id, reference_type)
    SELECT
      gen_random_uuid(),
      'SLA_BREACH',
      'high',
      'SLA Breach: ' || st.priority || ' ticket',
      'Ticket "' || st.subject || '" has breached SLA. No first response yet.',
      st.id::text,
      'support_ticket'
    FROM support_tickets st
    WHERE st.status IN ('OPEN', 'ASSIGNED')
    AND st.first_response_at IS NULL
    AND st.sla_deadline IS NOT NULL
    AND st.sla_deadline < NOW()
    AND st.id NOT IN (
      SELECT reference_id::uuid FROM admin_alerts
      WHERE type = 'SLA_BREACH'
      AND created_at > NOW() - INTERVAL '1 hour'
    );
  $$
);
