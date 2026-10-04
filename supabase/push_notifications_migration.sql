-- ============================================================
-- WEB PUSH NOTIFICATIONS — MIGRATION
-- Run this in Supabase SQL Editor after deploying the new backend.
--
-- ARCHITECTURE: rather than editing the ~20 existing places in the
-- backend that already insert into `notifications` (adminController,
-- paymentController, subOrderController, withdrawalController,
-- riderController, reviewController, operationalController), this adds
-- a database trigger that fires on EVERY insert into `notifications`,
-- calling a backend webhook that sends the actual push. This means:
--   - zero risk of missing one of the existing 20 call sites
--   - any FUTURE code that inserts a notification gets push for free,
--     automatically, with no extra work
-- ============================================================

-- 1. Where users' push subscriptions are stored (one browser/device = one row)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
-- No policies added — only ever touched by the backend's adminClient
-- (subscribe/unsubscribe both run through authenticated backend routes,
-- same reasoning as close_rls_gap_migration.sql).

-- 2. pg_net lets Postgres make an outbound HTTP call from a trigger.
-- Enabled by default on Supabase projects; this is a no-op if it
-- already is.
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 3. The trigger function. EDIT THE URL BELOW if your backend domain
-- ever changes — this is the only place it's hardcoded.
CREATE OR REPLACE FUNCTION trigger_push_on_notification()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM net.http_post(
    url := 'https://fidelx-backend.onrender.com/api/push/dispatch-internal',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Internal-Webhook-Secret', current_setting('app.settings.internal_webhook_secret', true)
    ),
    body := jsonb_build_object(
      'notification_id', NEW.id,
      'user_id', NEW.user_id,
      'title', NEW.title,
      'body', NEW.body
    )
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A push-delivery failure must never block the notification row
  -- itself from being created — the in-app notification (and the
  -- underlying business action, e.g. a withdrawal being marked
  -- FAILED) always succeeds regardless of whether the push send does.
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_push_on_notification ON notifications;
CREATE TRIGGER trg_push_on_notification
  AFTER INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION trigger_push_on_notification();

-- ============================================================
-- IF A PUSH DOESN'T ARRIVE: pg_net silently failing is a common
-- enough real-world issue that Supabase has an official debugging
-- guide for it. In order, check:
--
-- 1. Is the background worker even running?
--    SELECT net.worker_restart();
--    (should return without error — if it errors, the worker is down)
--
-- 2. Did the request actually get made, and what came back?
--    SELECT * FROM net._http_response ORDER BY created DESC LIMIT 5;
--    (responses are kept for 6 hours; all-NULL rows except id/error_msg
--    usually means a timeout, not a real failure)
--
-- 3. Does your backend's /api/push/dispatch-internal log show the
--    request arriving at all? If step 2 shows a request was sent but
--    your Render logs show nothing, check Render isn't blocking the
--    request or asleep (free-tier cold start).
-- ============================================================

-- 4. The shared secret the trigger sends and the backend checks, so
-- this webhook can't be spoofed by an outside caller. Generate your
-- own random value (any long random string) and set it in BOTH
-- places: here, and as INTERNAL_WEBHOOK_SECRET in your backend's env
-- vars on Render.
ALTER DATABASE postgres SET app.settings.internal_webhook_secret = 'dcd48011d9bba6904d7cc3615136c0bc1a01193dc9430136bed3f1b8f21b4d1c';
