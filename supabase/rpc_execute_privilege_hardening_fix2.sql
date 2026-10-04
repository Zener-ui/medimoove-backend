-- Fidelx RPC execution hardening — follow-up
--
-- Fix #25 hardened the main financial RPC set, but three older SECURITY
-- DEFINER primitives remained directly executable through PostgREST's
-- public schema.  They are backend/internal primitives and must not be
-- callable by anon/authenticated clients.
--
-- The functions are deliberately handled by name/signature lookup so this
-- migration remains safe if the exact argument list differs between an
-- existing installation and the bundled migrations.

DO $$
DECLARE
  fn TEXT;
  r RECORD;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'deposit_promotions_budget',
    'debit_platform_refund',
    'recover_refund_liabilities'
  ] LOOP
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
