-- ============================================================
-- Customer referral program
-- ============================================================
-- A customer refers other customers via their personal link. A
-- referral only counts once the REFERRED customer completes their
-- first paid order — not at signup — specifically to make the
-- program harder to game with throwaway accounts that never buy
-- anything. Crossing an admin-configured threshold (e.g. every 5
-- credited referrals) surfaces a milestone for admin to review and
-- manually reward with a coupon — no automatic payout, so there's a
-- human in the loop before any money/discount actually goes out.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS referred_by_customer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Set true the moment this specific referral is credited (this
  -- user's first paid order completes) — the single guard that makes
  -- crediting idempotent no matter how many times the payment hook
  -- fires for related reasons.
  ADD COLUMN IF NOT EXISTS referral_credited BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_users_referred_by_customer_id ON users(referred_by_customer_id);

-- Singleton settings row — mirrors the promotions_budget pattern of a
-- single fixed-id row rather than a key/value settings table.
CREATE TABLE IF NOT EXISTS referral_settings (
  id UUID PRIMARY KEY,
  threshold INT NOT NULL DEFAULT 5 CHECK (threshold > 0),
  -- Turning this off stops new milestones from firing and tells
  -- customers on their own referral screen that rewards are paused —
  -- it does NOT stop attribution/counting, so nothing is lost by
  -- pausing and later turning it back on.
  rewards_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO referral_settings (id) VALUES
('00000000-0000-0000-0000-000000000003')
ON CONFLICT (id) DO NOTHING;

-- One row per threshold crossing per referrer (5, 10, 15, ...) — this
-- is what makes a milestone fire exactly once instead of re-alerting
-- on every single referral once someone's past their first threshold.
CREATE TABLE IF NOT EXISTS referral_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id UUID NOT NULL REFERENCES users(id),
  milestone_count INT NOT NULL,
  reached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reward_sent BOOLEAN NOT NULL DEFAULT FALSE,
  reward_sent_at TIMESTAMPTZ,
  reward_sent_by UUID REFERENCES users(id),
  coupon_id UUID REFERENCES coupons(id),
  UNIQUE (referrer_id, milestone_count)
);

CREATE INDEX IF NOT EXISTS idx_referral_milestones_pending
ON referral_milestones(reward_sent, reached_at DESC);

-- ============================================================
-- Credits a referral once its referred customer's first paid order
-- is fully completed/delivered, and reports back whether that crossing landed on a
-- fresh threshold multiple. Row-locks the referred user's own row
-- (not the referrer's) as the concurrency guard — the exact event
-- this fires on, "this order's payment just succeeded," can only
-- happen once per order by construction, so this is naturally
-- idempotent rather than needing a busier lock.
-- ============================================================
CREATE OR REPLACE FUNCTION credit_customer_referral(p_referred_user_id UUID)
RETURNS TABLE(milestone_reached BOOLEAN, referrer_id UUID, milestone_count INT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_referrer_id UUID;
  v_already_credited BOOLEAN;
  v_total_credited INT;
  v_threshold INT;
  v_rewards_enabled BOOLEAN;
BEGIN
  SELECT referred_by_customer_id, referral_credited
  INTO v_referrer_id, v_already_credited
  FROM users
  WHERE id = p_referred_user_id
  FOR UPDATE;

  -- No referrer at all, or this specific referral was already
  -- credited on an earlier order (shouldn't happen — this only ever
  -- fires on a "first order" check upstream — but staying idempotent
  -- costs nothing and protects against that upstream check ever
  -- having a bug of its own).
  IF v_referrer_id IS NULL OR v_already_credited THEN
    RETURN QUERY SELECT FALSE, NULL::UUID, NULL::INT;
    RETURN;
  END IF;

  UPDATE users SET referral_credited = TRUE WHERE id = p_referred_user_id;

  SELECT COUNT(*) INTO v_total_credited
  FROM users
  WHERE referred_by_customer_id = v_referrer_id AND referral_credited = TRUE;

  SELECT threshold, rewards_enabled
  INTO v_threshold, v_rewards_enabled
  FROM referral_settings
  WHERE id = '00000000-0000-0000-0000-000000000003';

  -- Landed exactly on a fresh multiple of the threshold, and no
  -- milestone row for this exact count exists yet (the UNIQUE
  -- constraint is the real guarantee against double-firing; this
  -- check is what lets the function report "yes, this is new" back
  -- to the caller in the same round-trip).
  IF COALESCE(v_rewards_enabled, TRUE) AND v_threshold > 0 AND v_total_credited % v_threshold = 0 THEN
    INSERT INTO referral_milestones (referrer_id, milestone_count)
    VALUES (v_referrer_id, v_total_credited)
    ON CONFLICT (referrer_id, milestone_count) DO NOTHING;

    IF FOUND THEN
      RETURN QUERY SELECT TRUE, v_referrer_id, v_total_credited;
      RETURN;
    END IF;
  END IF;

  RETURN QUERY SELECT FALSE, v_referrer_id, v_total_credited;
END;
$$;
