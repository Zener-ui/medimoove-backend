-- CARTMOOVE PLATFORM REVENUE
-- Idempotent migration. Run once in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS platform_accounts (
  id UUID PRIMARY KEY,
  available_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  pending_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_earned NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_withdrawn NUMERIC(14,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO platform_accounts (id) VALUES
('00000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference UUID,
  source_type TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  description TEXT,
  actor_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_ledger_created_at
ON platform_ledger_entries(created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_revenue_source
ON platform_ledger_entries(reference, source_type)
WHERE source_type IN ('PLATFORM_FEE_EARNED','DELIVERY_MARGIN_EARNED');

CREATE TABLE IF NOT EXISTS platform_withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by UUID REFERENCES users(id),
  admin_reviewer_id UUID REFERENCES users(id),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  bank_account TEXT NOT NULL,
  bank_code TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PROCESSING','COMPLETED','FAILED','REJECTED')),
  paystack_transfer_id TEXT,
  paystack_transfer_code TEXT,
  paystack_status TEXT,
  failure_reason TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_platform_withdrawals_status
ON platform_withdrawals(status);

CREATE OR REPLACE FUNCTION credit_platform_revenue(
  p_reference UUID,
  p_platform_fee NUMERIC,
  p_delivery_margin NUMERIC,
  p_actor_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_total NUMERIC := 0;
BEGIN
  IF COALESCE(p_platform_fee,0) > 0 THEN
    INSERT INTO platform_ledger_entries(reference,source_type,amount,description,actor_id)
    VALUES (p_reference,'PLATFORM_FEE_EARNED',p_platform_fee,
      'Platform fee earned on delivered sub-order',p_actor_id)
    -- Postgres requires the ON CONFLICT clause to repeat the exact WHERE
    -- predicate of a partial unique index for it to be usable as a
    -- conflict target — omitting it (as this originally did) makes
    -- Postgres unable to match the index at all, throwing 42P10 on
    -- every single call. This insert has never once succeeded because
    -- of this, regardless of whether the index itself existed.
    ON CONFLICT (reference,source_type) WHERE source_type IN ('PLATFORM_FEE_EARNED','DELIVERY_MARGIN_EARNED','WITHDRAWAL_FEE_EARNED')
    DO NOTHING;
    IF FOUND THEN v_total := v_total + p_platform_fee; END IF;
  END IF;

  IF COALESCE(p_delivery_margin,0) > 0 THEN
    INSERT INTO platform_ledger_entries(reference,source_type,amount,description,actor_id)
    VALUES (p_reference,'DELIVERY_MARGIN_EARNED',p_delivery_margin,
      'Delivery margin earned on delivered sub-order',p_actor_id)
    ON CONFLICT (reference,source_type) WHERE source_type IN ('PLATFORM_FEE_EARNED','DELIVERY_MARGIN_EARNED','WITHDRAWAL_FEE_EARNED')
    DO NOTHING;
    IF FOUND THEN v_total := v_total + p_delivery_margin; END IF;
  END IF;

  IF v_total > 0 THEN
    UPDATE platform_accounts
    SET available_balance = available_balance + v_total,
        total_earned = total_earned + v_total,
        updated_at = NOW()
    WHERE id='00000000-0000-0000-0000-000000000001';
  END IF;

  RETURN v_total > 0;
END;
$$;

CREATE OR REPLACE FUNCTION atomic_platform_withdrawal(p_amount NUMERIC)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN FALSE; END IF;
  UPDATE platform_accounts
  SET available_balance = available_balance - p_amount, updated_at=NOW()
  WHERE id='00000000-0000-0000-0000-000000000001'
    AND available_balance >= p_amount;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION restore_platform_balance(p_amount NUMERIC)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN FALSE; END IF;
  UPDATE platform_accounts
  SET available_balance = available_balance + p_amount, updated_at=NOW()
  WHERE id='00000000-0000-0000-0000-000000000001';
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION debit_platform_refund(
  p_reference UUID,p_amount NUMERIC,p_actor_id UUID,p_reason TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN FALSE; END IF;

  IF EXISTS (
    SELECT 1 FROM platform_ledger_entries
    WHERE reference=p_reference AND source_type='PLATFORM_REFUND'
  ) THEN RETURN TRUE; END IF;

  UPDATE platform_accounts
  SET available_balance=available_balance-p_amount,
      total_earned=total_earned-p_amount, updated_at=NOW()
  WHERE id='00000000-0000-0000-0000-000000000001'
    AND available_balance >= p_amount;

  IF NOT FOUND THEN RETURN FALSE; END IF;

  INSERT INTO platform_ledger_entries(reference,source_type,amount,description,actor_id)
  VALUES(p_reference,'PLATFORM_REFUND',-p_amount,
         COALESCE(p_reason,'Platform-funded refund'),p_actor_id);
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION complete_platform_withdrawal(
  p_withdrawal_id UUID,p_admin_id UUID
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_amount NUMERIC;
BEGIN
  SELECT amount INTO v_amount FROM platform_withdrawals
  WHERE id=p_withdrawal_id AND status='PROCESSING';

  IF v_amount IS NULL THEN RETURN FALSE; END IF;

  UPDATE platform_accounts
  SET total_withdrawn=total_withdrawn+v_amount, updated_at=NOW()
  WHERE id='00000000-0000-0000-0000-000000000001';

  UPDATE platform_withdrawals
  SET status='COMPLETED', admin_reviewer_id=p_admin_id, completed_at=NOW()
  WHERE id=p_withdrawal_id;

  RETURN TRUE;
END;
$$;
