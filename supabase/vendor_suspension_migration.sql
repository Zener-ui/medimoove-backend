-- ============================================================
-- Vendor suspension
-- ============================================================
-- vendors.status already includes 'suspended' in its CHECK constraint
-- (see schema.sql), and vendors.strike_count already exists too —
-- the schema was built with this in mind, but no controller action
-- ever actually set either. This adds a dedicated reason column
-- (separate from rejection_reason, which is specifically about a
-- rejected application, not an account suspended after approval —
-- reusing that column would show a vendor a confusing "rejection
-- reason" for something that was never a rejection).
-- ============================================================

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS suspension_reason TEXT,
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_by UUID REFERENCES users(id);
