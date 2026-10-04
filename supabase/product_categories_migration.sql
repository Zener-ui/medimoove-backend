-- ============================================================
-- PRODUCT CATEGORIES — canonical vendor/product category list
--
-- This table is already referenced by:
--   - searchController.getCategories (select id, name, slug, icon)
--   - vendorController.validateVendorCategory (rejects any category
--     slug not present here — this is the actual backend enforcement,
--     independent of whatever the frontend dropdown sends)
--   - RegisterPage.jsx's vendor category dropdown
-- but the table itself was never created — this migration is that
-- missing piece. Seed list is a starting point; add/deactivate rows
-- as the catalog needs, don't hardcode categories in application code.
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

INSERT INTO product_categories (name, slug, icon, sort_order) VALUES
  ('Food & Drinks',        'food',        'utensils',   10),
  ('Groceries',            'groceries',   'shopping-basket', 20),
  ('Pharmacy & Health',    'pharmacy',    'pill',       30),
  ('Electronics',          'electronics', 'smartphone', 40),
  ('Fashion',              'fashion',     'shirt',      50),
  ('Beauty & Personal Care','beauty',     'sparkles',   60),
  ('Home & Household',     'home',        'home',       70),
  ('Services',             'services',    'wrench',     80),
  ('Other',                'other',       'package',    999)
ON CONFLICT (slug) DO NOTHING;
