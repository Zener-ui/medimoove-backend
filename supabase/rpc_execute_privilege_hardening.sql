-- Fidelx RPC execution hardening
--
-- The Express backend is the only caller of these financial/state-changing
-- RPCs and it uses the Supabase service_role key. SECURITY DEFINER functions
-- must not be directly callable by anon/authenticated clients through
-- PostgREST, because that would bypass the API's role/ownership checks.
--
-- Revoke the default PUBLIC execute privilege, then explicitly allow only
-- service_role. Internal SQL functions/triggers are unaffected by EXECUTE
-- privileges.

DO $$
DECLARE
  fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'atomic_reserve_stock',
    'atomic_reserve_variant_stock',
    'reserve_inventory_item',
    'release_product_stock',
    'release_variant_stock',
    'release_inventory_reservation',
    'confirm_product_stock',
    'confirm_variant_stock',
    'confirm_inventory_reservation',
    'claim_reservation',
    'atomic_withdraw_balance',
    'record_completed_withdrawal',
    'restore_balance_after_rejection',
    'claim_withdrawal_for_approval',
    'complete_vendor_rider_withdrawal',
    'fail_vendor_rider_withdrawal',
    'reject_vendor_rider_withdrawal',
    'credit_delivery_payout',
    'credit_pending_balance',
    'credit_platform_revenue',
    'credit_withdrawal_fee_revenue',
    'atomic_platform_withdrawal',
    'create_platform_withdrawal_atomic',
    'claim_platform_withdrawal_for_approval',
    'complete_platform_withdrawal',
    'fail_platform_withdrawal',
    'restore_platform_balance',
    'create_refund_reservation',
    'claim_refund_amount',
    'release_refund_claim',
    'claim_refund_finalization',
    'apply_refund_financials',
    'reverse_coupon_redemption',
    'spend_promotions_budget',
    'refund_promotions_budget',
    'complete_promotions_funding',
    'reconcile_promotions_budget',
    'credit_customer_referral',
    'repair_delivered_sub_order_financials',
    'reconcile_balances',
    'create_order_with_sub_orders',
    'claim_sub_order_transition',
    'release_matured_sub_order_balances',
    'reverse_sub_order_payouts',
    'claim_dispute_for_resolution',
    'mark_review_helpful_atomic'
  ] LOOP
    -- Function signatures differ, so alter every overload with this name.
    -- This is intentionally done through pg_proc rather than hard-coding
    -- argument lists, making the migration safe across existing variants.
    FOR r IN
      SELECT n.nspname AS schema_name,
             p.oid::regprocedure AS regproc
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = fn
    LOOP
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.regproc);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.regproc);
    END LOOP;
  END LOOP;
END $$;

-- Keep the migration itself explicit: the backend service_role is the only
-- intended direct RPC caller for financial/state-changing functions.
