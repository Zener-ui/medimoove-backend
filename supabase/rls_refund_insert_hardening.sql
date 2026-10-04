-- Fix #42 — Prevent direct customer refund-row creation
--
-- Refund creation is intentionally backend-only. The backend validates the
-- order/payment, refund amount, fault party, refund stage, idempotency key,
-- refund capacity, and Paystack interaction before creating/processing a
-- refund. A customer must not be able to create an arbitrary refunds row via
-- the Supabase REST API.
--
-- This only removes the customer INSERT policy. Customer SELECT access and
-- admin access remain unchanged. The backend uses service_role and is not
-- affected by this RLS change.

DROP POLICY IF EXISTS "refunds_insert_customer" ON public.refunds;
