-- Fix #43: prevent direct customer writes to the parent orders table.
--
-- Orders are created and mutated by the backend/service_role because the
-- order lifecycle also coordinates sub-orders, inventory reservations,
-- promotions, payment state, refunds, and financial records.
--
-- The old customer INSERT/UPDATE policies only checked customer_id = auth.uid(),
-- which allowed an authenticated customer to bypass those backend checks and
-- write arbitrary order fields/statuses directly through PostgREST.

DROP POLICY IF EXISTS "orders_insert_customer" ON public.orders;
DROP POLICY IF EXISTS "orders_update_own_customer" ON public.orders;

-- Customers retain SELECT access through the existing policy.
-- Admin/service_role access is unchanged.
