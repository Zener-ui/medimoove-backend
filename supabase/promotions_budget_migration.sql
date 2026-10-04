-- ============================================================
-- Promotions budget
-- ============================================================
-- A single, bounded, admin-funded pool that ANY promotional spend
-- draws from — coupon discounts today, referral rewards later,
-- anything else that costs the platform money to acquire/retain a
-- customer. Deliberately mirrors the existing platform_accounts /
-- platform_ledger_entries pattern (same singleton-row + ledger-trail
-- shape) rather than inventing a new convention.
--
-- Why this exists: previously, a coupon discount just reduced what
-- the customer paid via Paystack, with nothing else in the system
-- accounting for that gap — platform_fee was still credited in full,
-- vendor was still paid in full, and the shortfall silently came out
-- of the platform's real cash position with no visible trail and no
-- cap. This table makes that spend explicit, bounded, and auditable:
-- if the budget is empty, the discount/reward simply can't be
-- applied — it doesn't quietly happen anyway.
-- ============================================================

CREATE TABLE IF NOT EXISTS promotions_budget (
  id UUID PRIMARY KEY,
  balance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  total_deposited NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_spent NUMERIC(14,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO promotions_budget (id) VALUES
('00000000-0000-0000-0000-000000000002')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS promotions_ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable: a manual admin deposit has no order/referral to point at.
  reference UUID,
  type TEXT NOT NULL CHECK (type IN ('DEPOSIT', 'COUPON_DISCOUNT', 'REFERRAL_REWARD', 'ADJUSTMENT')),
  -- Signed: positive for money going into the pool (DEPOSIT), negative
  -- for money going out (COUPON_DISCOUNT, REFERRAL_REWARD) — same
  -- convention as platform_ledger_entries.
  amount NUMERIC(14,2) NOT NULL,
  description TEXT,
  actor_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promotions_ledger_created_at
ON promotions_ledger_entries(created_at DESC);

-- Prevents double-spending the same order/referral if a request is
-- retried after a transient failure (matches the exact pattern
-- platform_ledger_entries already uses for PLATFORM_FEE_EARNED).
CREATE UNIQUE INDEX IF NOT EXISTS uq_promotions_spend_reference
ON promotions_ledger_entries(reference, type)
WHERE type IN ('COUPON_DISCOUNT', 'REFERRAL_REWARD');

-- ============================================================
-- Admin funds the pool. No cap on this side — it's real money an
-- admin is deliberately choosing to set aside for promotions.
-- ============================================================
CREATE OR REPLACE FUNCTION deposit_promotions_budget(
  p_amount NUMERIC, p_actor_id UUID, p_description TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN FALSE; END IF;

  UPDATE promotions_budget
  SET balance = balance + p_amount,
      total_deposited = total_deposited + p_amount,
      updated_at = NOW()
  WHERE id = '00000000-0000-0000-0000-000000000002';

  INSERT INTO promotions_ledger_entries (reference, type, amount, description, actor_id)
  VALUES (NULL, 'DEPOSIT', p_amount, COALESCE(p_description, 'Admin deposit'), p_actor_id);

  RETURN TRUE;
END;
$$;

-- ============================================================
-- Atomic spend — this is the actual enforcement mechanism. The
-- balance check and the deduction happen as one guarded UPDATE, so
-- two near-simultaneous spends can't both succeed against the last
-- bit of a nearly-empty pool (same race-condition fix already
-- applied to invite_codes elsewhere in this codebase).
-- Returns FALSE (caller must reject the discount/reward) if the
-- pool doesn't have enough left — it never partially applies one.
-- ============================================================
CREATE OR REPLACE FUNCTION spend_promotions_budget(
  p_reference UUID, p_type TEXT, p_amount NUMERIC, p_actor_id UUID, p_description TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN FALSE; END IF;

  -- Idempotent retry: if this exact (reference, type) already spent
  -- successfully, report success again without spending twice.
  IF EXISTS (
    SELECT 1 FROM promotions_ledger_entries
    WHERE reference = p_reference AND type = p_type
  ) THEN RETURN TRUE; END IF;

  UPDATE promotions_budget
  SET balance = balance - p_amount,
      total_spent = total_spent + p_amount,
      updated_at = NOW()
  WHERE id = '00000000-0000-0000-0000-000000000002'
    AND balance >= p_amount;

  IF NOT FOUND THEN RETURN FALSE; END IF;

  INSERT INTO promotions_ledger_entries (reference, type, amount, description, actor_id)
  VALUES (p_reference, p_type, -p_amount, p_description, p_actor_id);

  RETURN TRUE;
END;
$$;

-- ============================================================
-- Compensating reversal — used when a spend succeeded here but the
-- larger operation it was part of then failed/rolled back (e.g. an
-- order that spent budget for its coupon, then failed to actually
-- create). Deletes the ledger entry rather than just crediting the
-- amount back, so a genuine subsequent retry with the same reference
-- can spend again instead of being blocked by the dedup check above.
-- ============================================================
CREATE OR REPLACE FUNCTION refund_promotions_budget(
  p_reference UUID, p_type TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_amount NUMERIC;
BEGIN
  -- Atomically claim the original spend by deleting its ledger row first.
  -- Two concurrent retries can therefore never both read the same spend and
  -- both credit the budget back. The DELETE is rolled back automatically if
  -- anything later in this transaction fails.
  DELETE FROM promotions_ledger_entries
  WHERE reference = p_reference AND type = p_type
  RETURNING -amount INTO v_amount;

  IF v_amount IS NULL THEN RETURN FALSE; END IF;

  UPDATE promotions_budget
  SET balance = balance + v_amount,
      total_spent = GREATEST(total_spent - v_amount, 0),
      updated_at = NOW()
  WHERE id = '00000000-0000-0000-0000-000000000002';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Promotions budget singleton row is missing';
  END IF;

  RETURN TRUE;
END;
$$;
