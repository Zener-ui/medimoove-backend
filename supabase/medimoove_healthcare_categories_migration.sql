-- ============================================================
-- MEDIMOOVE — HEALTHCARE MARKETPLACE CATEGORIES
--
-- Converts the generic CartMoove catalog into a healthcare-only
-- catalog without changing order, payment, inventory, or delivery
-- mechanics.
--
-- Safe migration strategy:
--   1. Ensure the canonical category table/column exists.
--   2. Seed Medimoove healthcare categories.
--   3. Move legacy product/vendor categories to a sensible
--      healthcare category before deactivating generic categories.
--   4. Keep legacy rows in the table for historical references.
-- ============================================================

CREATE TABLE IF NOT EXISTS product_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  icon TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES product_categories(id);

INSERT INTO product_categories (name, slug, icon, sort_order, is_active) VALUES
  ('Medicines & Pharmacy',       'medicines-pharmacy',       'pill',         10, TRUE),
  ('Medical Supplies',           'medical-supplies',         'package',      20, TRUE),
  ('Diagnostic & Laboratory',    'diagnostic-laboratory',    'flask-conical',30, TRUE),
  ('Medical Equipment',          'medical-equipment',        'stethoscope',  40, TRUE),
  ('Surgical & Clinical',        'surgical-clinical',        'syringe',      50, TRUE),
  ('PPE & Infection Control',    'ppe-infection-control',    'shield-check', 60, TRUE),
  ('Healthcare Consumables',     'healthcare-consumables',   'boxes',        70, TRUE),
  ('Other Healthcare Supplies',  'other-healthcare',         'package',      999, TRUE)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  icon = EXCLUDED.icon,
  sort_order = EXCLUDED.sort_order,
  is_active = TRUE;

-- Products created under the old generic catalog are retained, but
-- reassigned to healthcare categories so they remain usable in the
-- Medimoove marketplace instead of becoming orphaned by deactivation.
UPDATE products p
SET category_id = pc.id,
    category = pc.name
FROM product_categories pc
WHERE pc.slug = CASE
  WHEN lower(trim(p.category)) IN ('pharmacy', 'pharmacy & health', 'medicines', 'medicine')
    THEN 'medicines-pharmacy'
  WHEN lower(trim(p.category)) IN ('electronics', 'home & living', 'phones & accessories')
    THEN 'medical-equipment'
  WHEN lower(trim(p.category)) IN ('beauty', 'groceries', 'food', 'fashion', 'services')
    THEN 'medical-supplies'
  ELSE 'other-healthcare'
END
AND (
  p.category_id IS NULL
  OR p.category NOT IN (
    'Medicines & Pharmacy', 'Medical Supplies', 'Diagnostic & Laboratory',
    'Medical Equipment', 'Surgical & Clinical', 'PPE & Infection Control',
    'Healthcare Consumables', 'Other Healthcare Supplies'
  )
);

-- Existing vendors also need to remain visible after generic categories
-- are retired. Keep already-valid healthcare categories unchanged.
UPDATE vendors v
SET category = CASE
  WHEN lower(trim(v.category)) IN ('pharmacy', 'pharmacy & health', 'medicines', 'medicine')
    THEN 'medicines-pharmacy'
  WHEN lower(trim(v.category)) IN ('medical supplies', 'surgical', 'surgical & clinical')
    THEN 'medical-supplies'
  WHEN lower(trim(v.category)) IN ('diagnostic & laboratory', 'laboratory', 'diagnostics')
    THEN 'diagnostic-laboratory'
  WHEN lower(trim(v.category)) IN ('medical equipment', 'equipment')
    THEN 'medical-equipment'
  WHEN lower(trim(v.category)) IN ('ppe', 'ppe & infection control')
    THEN 'ppe-infection-control'
  WHEN lower(trim(v.category)) IN ('healthcare consumables', 'consumables')
    THEN 'healthcare-consumables'
  WHEN lower(trim(v.category)) IN (
    'food', 'groceries', 'fashion', 'electronics', 'beauty',
    'home', 'home & living', 'phones & accessories', 'services', 'other'
  )
    THEN 'medical-supplies'
  ELSE v.category
END
WHERE lower(trim(v.category)) IN (
  'pharmacy', 'pharmacy & health', 'medicines', 'medicine',
  'medical supplies', 'surgical', 'surgical & clinical',
  'diagnostic & laboratory', 'laboratory', 'diagnostics',
  'medical equipment', 'equipment', 'ppe', 'ppe & infection control',
  'healthcare consumables', 'consumables', 'food', 'groceries', 'fashion',
  'electronics', 'beauty', 'home', 'home & living', 'phones & accessories',
  'services', 'other'
);

-- Keep legacy category rows for historical foreign-key references,
-- but hide them from new provider/pharmacy catalogues.
UPDATE product_categories
SET is_active = FALSE
WHERE slug IN (
  'food', 'groceries', 'pharmacy', 'electronics', 'fashion', 'beauty',
  'home', 'services', 'other'
)
AND slug NOT IN (
  'medicines-pharmacy', 'medical-supplies', 'diagnostic-laboratory',
  'medical-equipment', 'surgical-clinical', 'ppe-infection-control',
  'healthcare-consumables', 'other-healthcare'
);
