-- Fix #44: prevent direct Supabase writes to vendor catalog tables.
-- Catalog mutations must go through the authenticated backend, which enforces
-- approved-vendor status and the product/category validation rules.

DROP POLICY IF EXISTS "products_insert_own" ON public.products;
DROP POLICY IF EXISTS "products_update_own" ON public.products;
DROP POLICY IF EXISTS "products_delete_own" ON public.products;

DROP POLICY IF EXISTS "variants_vendor_all" ON public.product_variants;
DROP POLICY IF EXISTS "product_variants_vendor_all" ON public.product_variants;

-- No customer/vendor direct INSERT/UPDATE/DELETE policies are recreated here.
-- The backend uses service_role for legitimate catalog mutations.
