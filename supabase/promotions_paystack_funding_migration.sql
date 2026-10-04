-- Promotions funding via Paystack
-- Step 1: real-money funding only. This does NOT touch platform_accounts,
-- orders, payments, refunds, vendor/rider balances, or existing ledgers.

CREATE TABLE IF NOT EXISTS promotions_funding_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL UNIQUE,
  admin_id UUID NOT NULL REFERENCES users(id),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','successful','failed')),
  paystack_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
  paystack_status TEXT,
  authorization_url TEXT,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promotions_funding_admin_created
ON promotions_funding_transactions(admin_id, created_at DESC);

CREATE OR REPLACE FUNCTION complete_promotions_funding(
  p_reference TEXT,
  p_paystack_fee NUMERIC DEFAULT 0
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_funding promotions_funding_transactions%ROWTYPE;
BEGIN
  SELECT * INTO v_funding
  FROM promotions_funding_transactions
  WHERE reference = p_reference
  FOR UPDATE;

  IF NOT FOUND THEN RETURN FALSE; END IF;
  IF v_funding.status = 'successful' THEN RETURN TRUE; END IF;
  IF v_funding.status <> 'pending' THEN RETURN FALSE; END IF;

  UPDATE promotions_budget
  SET balance = balance + v_funding.amount,
      total_deposited = total_deposited + v_funding.amount,
      updated_at = NOW()
  WHERE id = '00000000-0000-0000-0000-000000000002';

  IF NOT FOUND THEN RETURN FALSE; END IF;

  INSERT INTO promotions_ledger_entries (
    reference, type, amount, description, actor_id
  ) VALUES (
    v_funding.id,
    'DEPOSIT',
    v_funding.amount,
    COALESCE(v_funding.description, 'Paystack promotions funding'),
    v_funding.admin_id
  );

  UPDATE promotions_funding_transactions
  SET status = 'successful',
      paystack_fee = COALESCE(p_paystack_fee, 0),
      paystack_status = 'success',
      paid_at = NOW(),
      updated_at = NOW()
  WHERE id = v_funding.id;

  RETURN TRUE;
END;
$$;

NOTIFY pgrst, 'reload schema';
