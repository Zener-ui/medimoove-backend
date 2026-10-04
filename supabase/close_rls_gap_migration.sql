-- ============================================================
-- CLOSE RLS GAP — MIGRATION
-- Run this in Supabase SQL Editor.
--
-- WHY THIS MATTERS: Supabase auto-exposes every table over a public
-- REST API (PostgREST). Row Level Security is the ONLY thing that
-- stops someone with your public anon key (which sits in your
-- frontend .env / bundle — anyone can see it in browser dev tools)
-- from reading or writing a table directly, bypassing your backend
-- entirely. A table with RLS enabled but zero policies defaults to
-- deny-all for anon/authenticated roles — which is exactly what we
-- want here, since every one of these six tables is, in the actual
-- code, only ever touched by the backend's service-role adminClient
-- (which bypasses RLS by design). Enabling RLS with no policies
-- closes the direct-access hole without changing app behavior at all.
--
-- Found missing RLS on:
--   coupons, coupon_redemptions, review_helpful_votes   (schema.sql)
--   platform_accounts, platform_ledger_entries, platform_withdrawals
--     (platform_revenue.sql — added when platform revenue was built,
--      RLS step was never added for these three)
-- ============================================================

ALTER TABLE coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupon_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_helpful_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_withdrawals ENABLE ROW LEVEL SECURITY;

-- No policies added on purpose — see note above. If you later want
-- customers to read active coupons directly from the frontend
-- without a backend round-trip, add a scoped SELECT policy for that
-- one case rather than opening the whole table.
