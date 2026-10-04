-- ============================================================
-- REVIEWS & STORE REPUTATION SYSTEM — MIGRATION
-- Run this in Supabase SQL Editor AFTER schema.sql.
--
-- Extends the EXISTING reviews table (sub_order_id UNIQUE already
-- enforces one review per completed order; createReview already
-- requires status = 'DELIVERED' and ownership, so "Verified
-- Purchase" is guaranteed for every row here — no new column needed
-- for that). Also adds vendors.description for the store profile
-- page. No new tables — reusing what's already there per the brief.
--
-- Safe: purely additive columns, sensible defaults, no data touched.
-- ============================================================

ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS helpful_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vendor_reply TEXT,
  ADD COLUMN IF NOT EXISTS vendor_reply_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_removed BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS removed_reason TEXT;

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS description TEXT;

-- Per-user "helpful" vote tracking — prevents the same customer from
-- clicking Helpful repeatedly to inflate a review's count. One row
-- per (review, user); the unique constraint is what actually enforces
-- one vote each, not application logic alone.
CREATE TABLE IF NOT EXISTS review_helpful_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID REFERENCES reviews(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(review_id, user_id)
);

-- ============================================================
-- REVIEW PHOTOS
-- Added after the sections above — customers may now attach up to
-- 4 photos to a review (see uploadController.uploadReviewPhotos).
-- ============================================================

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS photo_urls TEXT[];
