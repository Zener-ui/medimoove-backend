-- ============================================================
-- FIX #31 — Prevent direct client review creation
-- ============================================================
-- The Express API is the source of truth for review creation. It
-- verifies that the caller owns the sub-order and that the sub-order
-- is DELIVERED before inserting the review, then derives vendor_id,
-- rider_id and customer_id from trusted database records.
--
-- The old RLS policy only checked customer_id = auth.uid(). That was
-- not enough: a customer could bypass the API and insert a review for
-- an arbitrary sub_order_id, choose vendor/rider IDs, and affect the
-- public review/rating data directly through Supabase.
--
-- Remove the direct INSERT policy. The backend uses service_role and
-- therefore remains able to create legitimate reviews.
-- ============================================================

DROP POLICY IF EXISTS "reviews_insert_customer" ON reviews;
