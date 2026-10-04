-- ============================================================
-- VENDOR CATEGORY NORMALIZATION
-- product_categories already exists (see operational_migrations.sql —
-- it's used for products.category_id). Vendors, however, still store
-- category as a free-text field, which is what actually broke
-- customer-facing filtering ("Food" vs "food" vs "Foood"). This
-- migration does NOT create a new categories table or seed a
-- competing list — it normalizes existing vendor rows against the
-- categories that already exist, and adds the constraint the backend
-- now enforces going forward.
-- ============================================================

-- Best-effort normalization: match existing free-text vendor category
-- values to an existing product_categories name, case/whitespace
-- insensitive. Anything that doesn't match is left untouched — it
-- does NOT get forced into "other" automatically, since that would
-- silently misclassify a vendor rather than surface it for review.
UPDATE vendors v
SET category = pc.slug
FROM product_categories pc
WHERE pc.is_active = true
  AND lower(trim(v.category)) = lower(trim(pc.name))
  AND v.category IS DISTINCT FROM pc.slug;

-- After running this, check for vendors whose category didn't match
-- any canonical name — those need manual review or a one-off fix,
-- e.g.:
--   SELECT id, business_name, category FROM vendors
--   WHERE category NOT IN (SELECT slug FROM product_categories);
