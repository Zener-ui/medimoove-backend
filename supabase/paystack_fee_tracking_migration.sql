-- ============================================================
-- PAYSTACK REAL FEE TRACKING — MIGRATION
--
-- WHY: platform_fee (your 5%) was being credited to platform_accounts
-- at its full nominal value, with zero awareness of what Paystack
-- actually deducted per transaction (~1.5% + ₦100). That meant your
-- recorded platform revenue permanently overstated real settled cash
-- by the sum of every Paystack fee ever charged — not a timing gap
-- that catches up, a number that's simply wrong and grows forever.
-- Storing the real fee per order makes this auditable and lets the
-- platform's own credit be reduced by the real cost, not the
-- vendor's or rider's payout (both stay exactly as they are today).
-- ============================================================

ALTER TABLE orders ADD COLUMN IF NOT EXISTS paystack_fee NUMERIC DEFAULT 0;
