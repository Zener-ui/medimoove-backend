-- ============================================================
-- CARTMOOVE OPERATIONAL MIGRATIONS v3
-- Paste into Supabase SQL Editor AFTER schema.sql
-- ============================================================

-- ============================================================
-- SECTION 1: ACCOUNT STATES
-- Add missing fields to vendors, riders, users
-- ============================================================

-- Vendors: add rejection reason, reapplication support, admin notes
ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS admin_review_notes TEXT,
  ADD COLUMN IF NOT EXISTS reapplication_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reapplied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspension_reason TEXT;

-- Riders: same fields
ALTER TABLE riders
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS admin_review_notes TEXT,
  ADD COLUMN IF NOT EXISTS reapplication_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reapplied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspension_reason TEXT;

-- Customers: add account state (most customers just stay active)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS account_status TEXT DEFAULT 'active'
    CHECK (account_status IN ('active', 'suspended', 'banned', 'pending_verification')),
  ADD COLUMN IF NOT EXISTS suspension_reason TEXT,
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_by UUID;

-- ============================================================
-- SECTION 2: ONBOARDING TRACKING
-- ============================================================

CREATE TABLE IF NOT EXISTS onboarding_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  role TEXT NOT NULL,

  -- Customer steps
  profile_completed BOOLEAN DEFAULT FALSE,
  address_added BOOLEAN DEFAULT FALSE,

  -- Vendor steps
  business_profile_completed BOOLEAN DEFAULT FALSE,
  documents_uploaded BOOLEAN DEFAULT FALSE,
  verification_submitted BOOLEAN DEFAULT FALSE,
  first_product_added BOOLEAN DEFAULT FALSE,

  -- Rider steps
  identity_submitted BOOLEAN DEFAULT FALSE,
  availability_set BOOLEAN DEFAULT FALSE,

  -- Shared
  onboarding_completed BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SECTION 3: SEARCH / DISCOVERY
-- Add indexes for fast search
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_products_search ON products USING gin(to_tsvector('english', name || ' ' || COALESCE(description, '')));
CREATE INDEX IF NOT EXISTS idx_vendors_search ON vendors USING gin(to_tsvector('english', business_name || ' ' || COALESCE(category, '')));
CREATE INDEX IF NOT EXISTS idx_products_price ON products(price);
CREATE INDEX IF NOT EXISTS idx_products_created ON products(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendors_rating ON vendors(rating DESC);
CREATE INDEX IF NOT EXISTS idx_vendors_plan ON vendors(plan);

-- Product categories table (structured, not freetext)
CREATE TABLE IF NOT EXISTS product_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  icon TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  sort_order INT DEFAULT 0
);

-- Seed default categories
INSERT INTO product_categories (id, name, slug, icon, sort_order) VALUES
  (gen_random_uuid(), 'Food & Groceries', 'food-groceries', '🍔', 1),
  (gen_random_uuid(), 'Fashion & Clothing', 'fashion-clothing', '👗', 2),
  (gen_random_uuid(), 'Electronics', 'electronics', '📱', 3),
  (gen_random_uuid(), 'Health & Beauty', 'health-beauty', '💄', 4),
  (gen_random_uuid(), 'Home & Living', 'home-living', '🏠', 5),
  (gen_random_uuid(), 'Sports & Fitness', 'sports-fitness', '⚽', 6),
  (gen_random_uuid(), 'Books & Stationery', 'books-stationery', '📚', 7),
  (gen_random_uuid(), 'Other', 'other', '📦', 99)
ON CONFLICT DO NOTHING;

-- Add category_id to products
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES product_categories(id),
  ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS view_count INT DEFAULT 0;

-- Add is_featured to vendors
ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT FALSE;

-- ============================================================
-- SECTION 4: PRODUCT IMAGE RULES
-- ============================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS image_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS moderation_flag BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS moderation_reason TEXT;

-- Image validation settings (admin configurable)
CREATE TABLE IF NOT EXISTS image_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  max_images_per_product INT DEFAULT 5,
  max_file_size_mb INT DEFAULT 5,
  allowed_formats TEXT[] DEFAULT ARRAY['jpg', 'jpeg', 'png', 'webp'],
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO image_settings (id, max_images_per_product, max_file_size_mb)
VALUES (gen_random_uuid(), 5, 5)
ON CONFLICT DO NOTHING;

-- ============================================================
-- SECTION 5: VENDOR AVAILABILITY
-- ============================================================

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS availability_status TEXT DEFAULT 'OPEN'
    CHECK (availability_status IN ('OPEN', 'BUSY', 'CLOSED', 'TEMPORARILY_UNAVAILABLE')),
  ADD COLUMN IF NOT EXISTS unavailable_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS unavailable_reason TEXT;

-- ============================================================
-- SECTION 6: NOTIFICATION PREFERENCES
-- ============================================================

CREATE TABLE IF NOT EXISTS notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  email_order_updates BOOLEAN DEFAULT TRUE,
  email_payment_updates BOOLEAN DEFAULT TRUE,
  email_withdrawal_updates BOOLEAN DEFAULT TRUE,
  email_dispute_updates BOOLEAN DEFAULT TRUE,
  email_account_updates BOOLEAN DEFAULT TRUE,
  email_marketing BOOLEAN DEFAULT FALSE,
  push_order_updates BOOLEAN DEFAULT TRUE,
  push_delivery_updates BOOLEAN DEFAULT TRUE,
  push_payment_updates BOOLEAN DEFAULT TRUE,
  push_marketing BOOLEAN DEFAULT FALSE,
  in_app_all BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SECTION 7: REFUND RESPONSIBILITY MATRIX
-- ============================================================

ALTER TABLE refunds
  ADD COLUMN IF NOT EXISTS fault_party TEXT
    CHECK (fault_party IN ('vendor', 'rider', 'customer', 'platform')),
  ADD COLUMN IF NOT EXISTS refund_type TEXT DEFAULT 'full'
    CHECK (refund_type IN ('full', 'partial')),
  ADD COLUMN IF NOT EXISTS partial_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS deducted_from TEXT,
  ADD COLUMN IF NOT EXISTS admin_reviewer_id UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- ============================================================
-- SECTION 8: SUPPORT OPERATIONS
-- ============================================================

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_deadline TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escalated BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ;

-- SLA targets per priority (minutes)
CREATE TABLE IF NOT EXISTS sla_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  priority TEXT NOT NULL UNIQUE,
  first_response_minutes INT NOT NULL,
  resolution_minutes INT NOT NULL,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO sla_settings (id, priority, first_response_minutes, resolution_minutes) VALUES
  (gen_random_uuid(), 'LOW', 1440, 4320),       -- 24h response, 72h resolution
  (gen_random_uuid(), 'NORMAL', 480, 1440),      -- 8h response, 24h resolution
  (gen_random_uuid(), 'HIGH', 120, 480),         -- 2h response, 8h resolution
  (gen_random_uuid(), 'CRITICAL', 30, 120)       -- 30min response, 2h resolution
ON CONFLICT DO NOTHING;

-- ============================================================
-- SECTION 9: MONITORING / ALERTS
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  severity TEXT DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  title TEXT NOT NULL,
  description TEXT,
  reference_id TEXT,
  reference_type TEXT,
  is_resolved BOOLEAN DEFAULT FALSE,
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_alerts_resolved ON admin_alerts(is_resolved);
CREATE INDEX IF NOT EXISTS idx_admin_alerts_severity ON admin_alerts(severity);

-- ============================================================
-- SECTION 10: LEGAL / POLICY SYSTEM
-- ============================================================

CREATE TABLE IF NOT EXISTS policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL UNIQUE CHECK (type IN (
    'terms_of_service', 'privacy_policy', 'refund_policy',
    'delivery_policy', 'acceptable_use_policy'
  )),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0',
  is_active BOOLEAN DEFAULT TRUE,
  published_by UUID REFERENCES users(id),
  published_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS policy_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  policy_id UUID REFERENCES policies(id),
  policy_version TEXT NOT NULL,
  accepted_at TIMESTAMPTZ DEFAULT NOW(),
  ip_address TEXT,
  UNIQUE(user_id, policy_id, policy_version)
);

-- Seed default policies (placeholder content)
INSERT INTO policies (id, type, title, content, version) VALUES
  (gen_random_uuid(), 'terms_of_service', 'Terms of Service', 'Terms of service content goes here.', '1.0'),
  (gen_random_uuid(), 'privacy_policy', 'Privacy Policy', 'Privacy policy content goes here.', '1.0'),
  (gen_random_uuid(), 'refund_policy', 'Refund Policy', 'Refund policy content goes here.', '1.0'),
  (gen_random_uuid(), 'delivery_policy', 'Delivery Policy', 'Delivery policy content goes here.', '1.0'),
  (gen_random_uuid(), 'acceptable_use_policy', 'Acceptable Use Policy', 'Acceptable use policy content goes here.', '1.0')
ON CONFLICT DO NOTHING;

-- ============================================================
-- SECTION 11: PILOT LAUNCH SUPPORT
-- ============================================================

CREATE TABLE IF NOT EXISTS pilot_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  is_pilot_mode BOOLEAN DEFAULT TRUE,
  vendor_invite_only BOOLEAN DEFAULT TRUE,
  rider_invite_only BOOLEAN DEFAULT TRUE,
  active_regions UUID[],
  max_vendors INT DEFAULT 30,
  max_riders INT DEFAULT 20,
  onboarding_paused BOOLEAN DEFAULT FALSE,
  maintenance_mode BOOLEAN DEFAULT FALSE,
  maintenance_message TEXT DEFAULT 'Cartmoove is currently undergoing maintenance. We will be back shortly.',
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default pilot settings with Otukpo region
INSERT INTO pilot_settings (id, is_pilot_mode, vendor_invite_only, rider_invite_only)
VALUES (gen_random_uuid(), TRUE, TRUE, TRUE)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS invite_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('vendor', 'rider')),
  region_id UUID REFERENCES regions(id),
  created_by UUID REFERENCES users(id),
  used_by UUID REFERENCES users(id),
  is_used BOOLEAN DEFAULT FALSE,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  used_at TIMESTAMPTZ
);

-- ============================================================
-- SECTION 12: FAILURE OPERATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS stuck_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES orders(id),
  sub_order_id UUID REFERENCES sub_orders(id),
  reason TEXT NOT NULL,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  resolved BOOLEAN DEFAULT FALSE,
  resolution_notes TEXT,
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS failed_webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT,
  payload JSONB,
  error_message TEXT,
  retry_count INT DEFAULT 0,
  resolved BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ADDITIONAL INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_onboarding_user ON onboarding_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_prefs_user ON notification_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code);
CREATE INDEX IF NOT EXISTS idx_policy_acceptances_user ON policy_acceptances(user_id);
CREATE INDEX IF NOT EXISTS idx_stuck_orders_resolved ON stuck_orders(resolved);
