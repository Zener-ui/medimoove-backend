-- ============================================================
-- DISPUTE RLS HARDENING
--
-- Disputes are created/updated by the Fidelx backend (service_role),
-- which performs the order-ownership, DELIVERED-state, 24-hour-window,
-- evidence-reference, and appeal checks. Allowing direct authenticated
-- INSERT/UPDATE through PostgREST bypasses those checks.
--
-- In particular, a customer could otherwise update their own dispute's
-- status/decision/resolution fields directly, or create a dispute row
-- for an unrelated order. This is data-integrity/authorization bypass,
-- not merely a duplicate of the API validation.
--
-- Keep SELECT policies so customers/vendors can read disputes they are
-- entitled to see. The backend remains the only writer.
-- ============================================================

DROP POLICY IF EXISTS "disputes_insert_customer" ON disputes;
DROP POLICY IF EXISTS "disputes_update_own_customer" ON disputes;
