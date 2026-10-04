-- ============================================================
-- Referral attribution
-- ============================================================
-- Records which vendor's shared storefront link (if any) a new
-- account came in through. Set once at signup, best-effort — a
-- missing or invalid referrer at registration time is silently
-- dropped (see authController.register) rather than blocking the
-- signup, so this column is nullable and never required.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS referred_by_vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_referred_by_vendor_id ON users(referred_by_vendor_id);

COMMENT ON COLUMN users.referred_by_vendor_id IS
  'Vendor whose shared storefront link (/s/:id) this user first arrived through, if any. Set once at signup.';
