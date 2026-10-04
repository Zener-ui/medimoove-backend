-- ============================================================
-- Urgent notices — admin-created popups, distinct from the regular
-- notifications inbox (broadcastNotification in adminController.js).
-- A regular broadcast lands quietly in someone's notification list;
-- an urgent notice interrupts them with a popup the moment they open
-- the app, optionally carrying a custom image, and stays queued until
-- they actually dismiss it (not just until they read their inbox).
-- ============================================================

CREATE TABLE IF NOT EXISTS urgent_notices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  image_url TEXT,
  category TEXT NOT NULL CHECK (category IN ('customer', 'vendor', 'rider', 'all')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_urgent_notices_active_category
ON urgent_notices(is_active, category, created_at DESC);
