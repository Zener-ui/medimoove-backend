-- ============================================================
-- CARTMOOVE DATABASE SCHEMA v2
-- Paste into Supabase SQL Editor and run
-- ============================================================

-- USERS
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  withdrawal_pin_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('customer', 'vendor', 'rider', 'admin')),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- REGIONS (no hardcoding — Otukpo is just a row)
CREATE TABLE regions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- DELIVERY SETTINGS PER REGION
CREATE TABLE delivery_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id UUID REFERENCES regions(id),
  base_fee NUMERIC DEFAULT 300,
  rate_per_km NUMERIC DEFAULT 100,
  fuel_multiplier NUMERIC DEFAULT 1.1,
  minimum_delivery_fee NUMERIC DEFAULT 300,
  maximum_delivery_radius NUMERIC DEFAULT 30,
  delivery_margin NUMERIC DEFAULT 100,
  large_package_fee NUMERIC DEFAULT 200,
  rush_fee NUMERIC DEFAULT 150,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- FEE SETTINGS (platform fee, withdrawal fee)
CREATE TABLE fee_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_fee_percentage NUMERIC DEFAULT 5,
  withdrawal_fee_percentage NUMERIC DEFAULT 1,
  withdrawal_fee_cap NUMERIC DEFAULT 2000,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- VENDORS
CREATE TABLE vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  region_id UUID REFERENCES regions(id),
  business_name TEXT NOT NULL,
  category TEXT NOT NULL,
  location TEXT NOT NULL,
  address TEXT NOT NULL,
  description TEXT,
  delivery_radius_km NUMERIC,
  location_lat NUMERIC,
  location_lng NUMERIC,
  phone TEXT NOT NULL,
  whatsapp TEXT,
  cac_number TEXT,
  logo_url TEXT,
  id_document_url TEXT,
  is_verified BOOLEAN DEFAULT FALSE,
  plan TEXT DEFAULT 'basic' CHECK (plan IN ('basic', 'standard', 'premium')),
  rating NUMERIC(3,1) DEFAULT 0,
  strike_count INT DEFAULT 0,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- COUPONS / PROMOTIONS
CREATE TABLE coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('percentage', 'fixed', 'free_delivery')),
  value NUMERIC,
  max_discount_amount NUMERIC,
  min_order_amount NUMERIC DEFAULT 0,
  vendor_id UUID REFERENCES vendors(id),
  usage_limit INT,
  usage_limit_per_customer INT DEFAULT 1,
  times_used INT DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  starts_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX coupons_code_uidx ON coupons (UPPER(code));

-- coupon_redemptions references orders(id) — that table doesn't exist
-- yet at this point in the script, so its creation is deferred to
-- right after MAIN ORDERS below (see "COUPON REDEMPTIONS" further
-- down). The coupons table itself has no such ordering constraint —
-- it only needs vendors and users, both already defined above.

-- RIDERS
CREATE TABLE riders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  region_id UUID REFERENCES regions(id),
  phone TEXT NOT NULL,
  nin TEXT NOT NULL,
  nin_verified BOOLEAN DEFAULT FALSE,
  vehicle_type TEXT DEFAULT 'motorcycle',
  photo_url TEXT,
  is_active BOOLEAN DEFAULT FALSE,
  rating NUMERIC(3,1) DEFAULT 0,
  strike_count INT DEFAULT 0,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'suspended')),
  location_lat NUMERIC,
  location_lng NUMERIC,
  last_seen TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- PRODUCTS
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID REFERENCES vendors(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC NOT NULL,
  category TEXT NOT NULL,
  images TEXT[] DEFAULT '{}',
  stock_quantity INT DEFAULT 0,
  reserved_quantity INT DEFAULT 0,
  is_available BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- PRODUCT VARIANTS
CREATE TABLE product_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  price_adjustment NUMERIC DEFAULT 0,
  stock_quantity INT DEFAULT 0,
  reserved_quantity INT DEFAULT 0
);

-- INVENTORY RESERVATIONS (prevent overselling)
CREATE TABLE inventory_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID REFERENCES products(id),
  variant_id UUID REFERENCES product_variants(id),
  order_id UUID,
  quantity INT NOT NULL,
  status TEXT DEFAULT 'reserved' CHECK (status IN ('reserved', 'confirmed', 'released')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- MAIN ORDERS (one per checkout)
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES users(id),
  region_id UUID REFERENCES regions(id),
  status TEXT DEFAULT 'PENDING_PAYMENT',
  subtotal NUMERIC NOT NULL,
  platform_fee NUMERIC NOT NULL,
  delivery_fee NUMERIC DEFAULT 0,
  coupon_id UUID REFERENCES coupons(id),
  discount_amount NUMERIC DEFAULT 0,
  total NUMERIC NOT NULL,
  payment_status TEXT DEFAULT 'pending' CHECK (payment_status IN ('pending', 'successful', 'failed', 'refunded')),
  paystack_reference TEXT UNIQUE,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- COUPON REDEMPTIONS (references orders — must come after it)
CREATE TABLE coupon_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id UUID REFERENCES coupons(id),
  customer_id UUID REFERENCES users(id),
  order_id UUID REFERENCES orders(id),
  discount_amount NUMERIC NOT NULL,
  redeemed_at TIMESTAMPTZ DEFAULT NOW()
);

-- SUB ORDERS (one per vendor inside an order)
CREATE TABLE sub_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  vendor_id UUID REFERENCES vendors(id),
  rider_id UUID REFERENCES riders(id),
  status TEXT DEFAULT 'PENDING_PAYMENT',
  delivery_type TEXT NOT NULL CHECK (delivery_type IN ('delivery', 'pickup')),
  delivery_address TEXT,
  delivery_lat NUMERIC,
  delivery_lng NUMERIC,
  subtotal NUMERIC NOT NULL,
  platform_fee NUMERIC NOT NULL,
  delivery_fee NUMERIC DEFAULT 0,
  delivery_margin NUMERIC DEFAULT 0,
  vendor_payout NUMERIC NOT NULL,
  rider_payout NUMERIC DEFAULT 0,
  withdrawal_available_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ORDER ITEMS (linked to sub_orders)
CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES orders(id),
  sub_order_id UUID REFERENCES sub_orders(id),
  product_id UUID REFERENCES products(id),
  variant_id UUID REFERENCES product_variants(id),
  quantity INT NOT NULL,
  price NUMERIC NOT NULL
);

-- PAYMENTS
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES orders(id),
  amount NUMERIC NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'successful', 'failed', 'refunded')),
  paystack_reference TEXT UNIQUE,
  idempotency_key TEXT UNIQUE,
  gateway_response JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- BALANCES (single source of truth per user)
CREATE TABLE balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) UNIQUE,
  available_balance NUMERIC DEFAULT 0,
  pending_balance NUMERIC DEFAULT 0,
  total_earned NUMERIC DEFAULT 0,
  total_withdrawn NUMERIC DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- WITHDRAWALS
CREATE TABLE withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID REFERENCES users(id),
  requester_type TEXT CHECK (requester_type IN ('vendor', 'rider')),
  vendor_id UUID REFERENCES vendors(id),
  rider_id UUID REFERENCES riders(id),
  gross_amount NUMERIC NOT NULL,
  withdrawal_fee NUMERIC NOT NULL,
  net_payout NUMERIC NOT NULL,
  fee_percentage NUMERIC NOT NULL,
  fee_cap NUMERIC NOT NULL,
  fee_was_capped BOOLEAN DEFAULT FALSE,
  bank_account TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  status TEXT DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','PROCESSING','COMPLETED','FAILED')),
  admin_reviewer_id UUID REFERENCES users(id),
  rejection_reason TEXT,
  proof_of_payout TEXT,
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- LEDGER ENTRIES (immutable — append only, never edit)
CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference UUID,
  type TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  fee NUMERIC DEFAULT 0,
  net NUMERIC,
  source TEXT,
  destination TEXT,
  actor_id TEXT,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- REFUNDS
CREATE TABLE refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES orders(id),
  sub_order_id UUID REFERENCES sub_orders(id),
  customer_id UUID REFERENCES users(id),
  amount NUMERIC NOT NULL,
  reason TEXT NOT NULL,
  evidence_urls TEXT[] DEFAULT '{}',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'processed')),
  admin_reviewer_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RECEIPTS
CREATE TABLE receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('ORDER', 'WITHDRAWAL', 'REFUND', 'VENDOR_SALE', 'RIDER_EARNING')),
  user_id UUID REFERENCES users(id),
  reference_id TEXT,
  metadata JSONB,
  html_content TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- REVIEWS
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_order_id UUID REFERENCES sub_orders(id) UNIQUE,
  customer_id UUID REFERENCES users(id),
  vendor_id UUID REFERENCES vendors(id),
  rider_id UUID REFERENCES riders(id),
  vendor_rating INT CHECK (vendor_rating BETWEEN 1 AND 5),
  rider_rating INT CHECK (rider_rating BETWEEN 1 AND 5),
  title TEXT,
  comment TEXT,
  photo_urls TEXT[],
  helpful_count INT DEFAULT 0,
  vendor_reply TEXT,
  vendor_reply_at TIMESTAMPTZ,
  is_flagged BOOLEAN DEFAULT FALSE,
  is_removed BOOLEAN DEFAULT FALSE,
  removed_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

-- One row per (review, user) — the UNIQUE constraint is what actually
-- enforces one "helpful" vote per person, not application code alone.
CREATE TABLE review_helpful_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID REFERENCES reviews(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(review_id, user_id)
);

-- REVIEW HELPFUL VOTES (dedup — one vote per user per review)
CREATE TABLE review_helpful_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID REFERENCES reviews(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (review_id, user_id)
);

-- DISPUTES
CREATE TABLE disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES orders(id),
  sub_order_id UUID REFERENCES sub_orders(id),
  customer_id UUID REFERENCES users(id),
  reason TEXT NOT NULL,
  evidence_urls TEXT[] DEFAULT '{}',
  additional_evidence TEXT[],
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'appealed', 'closed')),
  decision TEXT CHECK (decision IN ('approved', 'rejected')),
  resolution_note TEXT,
  appeal_count INT DEFAULT 0,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- NOTIFICATIONS
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT DEFAULT 'in_app' CHECK (type IN ('in_app', 'email', 'push')),
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- SUPPORT TICKETS
CREATE TABLE support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  role TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  messages JSONB DEFAULT '[]',
  status TEXT DEFAULT 'OPEN' CHECK (status IN ('OPEN','ASSIGNED','IN_PROGRESS','WAITING_USER','RESOLVED','CLOSED')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- FAQ ENTRIES
CREATE TABLE faq_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  category TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- AUDIT LOGS
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL,
  actor_id TEXT,
  target_id TEXT,
  target_type TEXT,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SEED: Insert Otukpo as the launch region
-- ============================================================
INSERT INTO regions (id, name, state, is_active)
VALUES (gen_random_uuid(), 'Otukpo', 'Benue', TRUE);

-- ============================================================
-- SEED: Default fee settings
-- ============================================================
INSERT INTO fee_settings (id, platform_fee_percentage, withdrawal_fee_percentage, withdrawal_fee_cap)
VALUES (gen_random_uuid(), 5, 1, 2000);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_products_vendor ON products(vendor_id);
CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_sub_orders_order ON sub_orders(order_id);
CREATE INDEX idx_sub_orders_vendor ON sub_orders(vendor_id);
CREATE INDEX idx_sub_orders_rider ON sub_orders(rider_id);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_reviews_vendor ON reviews(vendor_id);
CREATE INDEX idx_withdrawals_requester ON withdrawals(requester_id);
CREATE INDEX idx_withdrawals_status ON withdrawals(status);
CREATE INDEX idx_inventory_reservations_product ON inventory_reservations(product_id);
CREATE INDEX idx_ledger_reference ON ledger_entries(reference);
CREATE INDEX idx_receipts_user ON receipts(user_id);

-- ============================================================
-- DELIVERY SETTINGS — additional columns for v2
-- ============================================================
ALTER TABLE delivery_settings
  ADD COLUMN IF NOT EXISTS peak_hour_multiplier NUMERIC DEFAULT 1.2,
  ADD COLUMN IF NOT EXISTS rain_surcharge NUMERIC DEFAULT 100,
  ADD COLUMN IF NOT EXISTS peak_hours_enabled BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS rain_surcharge_enabled BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS manual_override_fee NUMERIC DEFAULT NULL;

-- Support tickets — add priority and order reference
ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'NORMAL'
    CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'CRITICAL')),
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES orders(id);

-- Add UNIQUE constraints. Postgres has no "ADD CONSTRAINT IF NOT EXISTS" —
-- these DO blocks are the standard equivalent, safe to re-run.
DO $$ BEGIN
  ALTER TABLE payments ADD CONSTRAINT unique_paystack_reference UNIQUE (paystack_reference);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE receipts ADD CONSTRAINT unique_receipt_id UNIQUE (receipt_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT unique_idempotency_key UNIQUE (idempotency_key);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Soft delete support on key tables
ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Use NUMERIC(12,2) for all financial columns (more precise)
ALTER TABLE orders ALTER COLUMN subtotal TYPE NUMERIC(12,2);
ALTER TABLE orders ALTER COLUMN platform_fee TYPE NUMERIC(12,2);
ALTER TABLE orders ALTER COLUMN delivery_fee TYPE NUMERIC(12,2);
ALTER TABLE orders ALTER COLUMN total TYPE NUMERIC(12,2);
ALTER TABLE withdrawals ALTER COLUMN gross_amount TYPE NUMERIC(12,2);
ALTER TABLE withdrawals ALTER COLUMN withdrawal_fee TYPE NUMERIC(12,2);
ALTER TABLE withdrawals ALTER COLUMN net_payout TYPE NUMERIC(12,2);
ALTER TABLE balances ALTER COLUMN available_balance TYPE NUMERIC(12,2);
ALTER TABLE balances ALTER COLUMN total_earned TYPE NUMERIC(12,2);
ALTER TABLE balances ALTER COLUMN total_withdrawn TYPE NUMERIC(12,2);
