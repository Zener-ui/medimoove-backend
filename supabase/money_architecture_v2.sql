-- ============================================================
-- FIDELX MONEY ARCHITECTURE V2
--
-- Run AFTER platform_revenue.sql, financial_safety_migration.sql,
-- withdrawal_fee_revenue_migration.sql and settlement_hold_migration.sql.
--
-- Goals:
--   1. Paystack customer refunds are funded by the platform cash account.
--   2. Vendor/rider fault creates an explicit recoverable liability instead
--      of reversing unrelated parties' payouts.
--   3. Insufficient balance never blocks the customer refund; the remainder
--      becomes outstanding and is recovered from future earnings.
--   4. Refund financial finalization is ONE database transaction. If it
--      fails, balance_debited remains FALSE and reconciliation can retry.
--   5. Platform-fault refunds reduce earned revenue; fault-party refunds are
--      recoverable advances and therefore do not falsely reduce earned revenue.
--   6. Platform withdrawals are atomically claimed before any Paystack call.
-- ============================================================

ALTER TABLE platform_accounts
  ADD COLUMN IF NOT EXISTS recoverable_refunds NUMERIC(14,2) NOT NULL DEFAULT 0;

ALTER TABLE platform_withdrawals
  ADD COLUMN IF NOT EXISTS paystack_reference TEXT;

ALTER TABLE platform_withdrawals
  DROP CONSTRAINT IF EXISTS platform_withdrawals_status_check;
ALTER TABLE platform_withdrawals
  ADD CONSTRAINT platform_withdrawals_status_check
  CHECK (status IN ('PENDING','CLAIMED','PROCESSING','COMPLETED','FAILED','REJECTED'));

ALTER TABLE refunds
  ADD COLUMN IF NOT EXISTS financial_finalized_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS refund_liabilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id UUID NOT NULL UNIQUE REFERENCES refunds(id),
  responsible_type TEXT NOT NULL CHECK (responsible_type IN ('vendor','rider')),
  responsible_user_id UUID NOT NULL REFERENCES users(id),
  original_amount NUMERIC(14,2) NOT NULL CHECK (original_amount > 0),
  recovered_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (recovered_amount >= 0),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PARTIALLY_RECOVERED','RECOVERED','WAIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refund_liabilities_user_status
  ON refund_liabilities(responsible_user_id, status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_refund_event
  ON platform_ledger_entries(reference, source_type)
  WHERE source_type IN ('PLATFORM_REFUND','PLATFORM_REFUND_FRONTED');

CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_refund_recovery
  ON platform_ledger_entries(reference, source_type)
  WHERE source_type = 'REFUND_RECOVERY';

-- Recover outstanding vendor/rider refund liabilities from available balance.
-- This function never touches total_earned: the rider/vendor still earned the
-- money; the separate liability explains why it is no longer withdrawable.
CREATE OR REPLACE FUNCTION recover_refund_liabilities(
  p_user_id UUID,
  p_max_amount NUMERIC
) RETURNS NUMERIC
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_remaining NUMERIC := GREATEST(COALESCE(p_max_amount,0),0);
  v_recovered NUMERIC := 0;
  li RECORD;
  v_take NUMERIC;
BEGIN
  IF v_remaining <= 0 THEN RETURN 0; END IF;

  FOR li IN
    SELECT * FROM refund_liabilities
    WHERE responsible_user_id = p_user_id
      AND status IN ('OPEN','PARTIALLY_RECOVERED')
      AND recovered_amount < original_amount
    ORDER BY created_at ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := LEAST(v_remaining, li.original_amount - li.recovered_amount);
    IF v_take <= 0 THEN CONTINUE; END IF;

    UPDATE balances
    SET available_balance = available_balance - v_take,
        updated_at = NOW()
    WHERE user_id = p_user_id
      AND available_balance >= v_take;
    IF NOT FOUND THEN EXIT; END IF;

    UPDATE refund_liabilities
    SET recovered_amount = recovered_amount + v_take,
        status = CASE WHEN recovered_amount + v_take >= original_amount THEN 'RECOVERED' ELSE 'PARTIALLY_RECOVERED' END,
        updated_at = NOW()
    WHERE id = li.id;

    UPDATE platform_accounts
    SET available_balance = available_balance + v_take,
        recoverable_refunds = GREATEST(recoverable_refunds - v_take, 0),
        updated_at = NOW()
    WHERE id = '00000000-0000-0000-0000-000000000001';

    INSERT INTO platform_ledger_entries(reference, source_type, amount, description, actor_id)
    VALUES (li.id, 'REFUND_RECOVERY', v_take,
            'Recovery of refund fronted by Fidelx from responsible ' || li.responsible_type,
            NULL)
    ON CONFLICT (reference, source_type) WHERE source_type = 'REFUND_RECOVERY' DO UPDATE
      SET amount = platform_ledger_entries.amount + EXCLUDED.amount;

    v_remaining := v_remaining - v_take;
    v_recovered := v_recovered + v_take;
  END LOOP;

  RETURN v_recovered;
END;
$$;

-- Credit delivery payout and immediately consume any existing liability.
CREATE OR REPLACE FUNCTION credit_delivery_payout(
  p_sub_order_id UUID, p_role TEXT, p_user_id UUID, p_amount NUMERIC
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_recovery NUMERIC := 0;
BEGIN
  IF COALESCE(p_amount, 0) <= 0 THEN RETURN FALSE; END IF;

  INSERT INTO sub_order_payouts (sub_order_id, role, user_id, amount)
  VALUES (p_sub_order_id, p_role, p_user_id, p_amount)
  ON CONFLICT (sub_order_id, role) DO NOTHING;

  IF NOT FOUND THEN RETURN FALSE; END IF;

  IF p_role IN ('vendor','rider') THEN
    INSERT INTO balances (id, user_id, pending_balance, total_earned)
    VALUES (gen_random_uuid(), p_user_id, p_amount, p_amount)
    ON CONFLICT (user_id) DO UPDATE
    SET pending_balance = balances.pending_balance + p_amount,
        total_earned = balances.total_earned + p_amount,
        updated_at = NOW();

    -- Pending earnings can be reserved against a liability immediately.
    -- They remain non-withdrawable until the liability is satisfied.
    FOR v_recovery IN SELECT LEAST(p_amount, COALESCE(b.pending_balance,0))
      FROM balances b WHERE b.user_id = p_user_id FOR UPDATE
    LOOP
      EXIT WHEN v_recovery <= 0;
    END LOOP;

    IF v_recovery > 0 THEN
      -- Reuse the liability ordering, but pending balance needs its own
      -- recovery path because available_balance is not yet withdrawable.
      DECLARE
        li RECORD;
        v_left NUMERIC := v_recovery;
        v_take NUMERIC;
      BEGIN
        FOR li IN SELECT * FROM refund_liabilities
          WHERE responsible_user_id = p_user_id
            AND status IN ('OPEN','PARTIALLY_RECOVERED')
            AND recovered_amount < original_amount
          ORDER BY created_at ASC FOR UPDATE
        LOOP
          EXIT WHEN v_left <= 0;
          v_take := LEAST(v_left, li.original_amount - li.recovered_amount);
          EXIT WHEN v_take <= 0;
          UPDATE balances SET pending_balance = pending_balance - v_take, updated_at = NOW() WHERE user_id = p_user_id;
          UPDATE refund_liabilities SET recovered_amount = recovered_amount + v_take,
            status = CASE WHEN recovered_amount + v_take >= original_amount THEN 'RECOVERED' ELSE 'PARTIALLY_RECOVERED' END,
            updated_at = NOW() WHERE id = li.id;
          UPDATE platform_accounts SET available_balance = available_balance + v_take,
            recoverable_refunds = GREATEST(recoverable_refunds - v_take,0), updated_at = NOW()
            WHERE id='00000000-0000-0000-0000-000000000001';
          INSERT INTO platform_ledger_entries(reference,source_type,amount,description)
          VALUES(li.id,'REFUND_RECOVERY',v_take,'Recovery of refund fronted by Fidelx from future ' || li.responsible_type || ' earnings')
          ON CONFLICT (reference, source_type) WHERE source_type = 'REFUND_RECOVERY' DO UPDATE SET amount = platform_ledger_entries.amount + EXCLUDED.amount;
          v_left := v_left - v_take;
        END LOOP;
      END;
    END IF;
  END IF;

  RETURN TRUE;
END;
$$;

-- Release matured balances using actual sub_order_payouts, not the payout
-- columns as an implicit second source of truth.
CREATE OR REPLACE FUNCTION release_matured_sub_order_balances()
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  so RECORD;
  p RECORD;
  released_count INT := 0;
BEGIN
  FOR so IN
    SELECT id FROM sub_orders
    WHERE status='DELIVERED'
      AND withdrawal_available_at IS NOT NULL
      AND withdrawal_available_at <= NOW()
      AND balance_released_at IS NULL
    FOR UPDATE
  LOOP
    FOR p IN SELECT * FROM sub_order_payouts WHERE sub_order_id=so.id AND role IN ('vendor','rider') FOR UPDATE LOOP
      IF p.user_id IS NOT NULL AND p.amount > 0 THEN
        UPDATE balances
        SET pending_balance = GREATEST(pending_balance - p.amount,0),
            available_balance = available_balance + p.amount,
            updated_at = NOW()
        WHERE user_id=p.user_id;
        -- Existing liability is recovered only from the now-available portion.
        PERFORM recover_refund_liabilities(p.user_id, p.amount);
      END IF;
    END LOOP;
    UPDATE sub_orders SET balance_released_at=NOW() WHERE id=so.id;
    released_count := released_count + 1;
  END LOOP;
  RETURN released_count;
END;
$$;

-- The single financial transaction for a confirmed Paystack refund.
CREATE OR REPLACE FUNCTION apply_refund_financials(p_refund_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  r refunds%ROWTYPE;
  v_responsible_type TEXT;
  v_user_id UUID;
  v_recovered NUMERIC := 0;
  v_liability_id UUID;
  v_platform_before NUMERIC;
BEGIN
  SELECT * INTO r FROM refunds WHERE id=p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Refund record not found'; END IF;

  IF r.balance_debited IS TRUE THEN
    RETURN jsonb_build_object('already_finalized',true,'refund_id',p_refund_id);
  END IF;

  -- Every confirmed customer refund is a real cash outflow from Fidelx.
  -- The source of economic cost is then classified separately.
  IF r.fault_party = 'vendor' THEN
    v_responsible_type := 'vendor';
    SELECT v.user_id INTO v_user_id FROM sub_orders s JOIN vendors v ON v.id=s.vendor_id WHERE s.id=r.sub_order_id;
  ELSIF r.fault_party = 'rider' THEN
    v_responsible_type := 'rider';
    SELECT rd.user_id INTO v_user_id FROM sub_orders s JOIN riders rd ON rd.id=s.rider_id WHERE s.id=r.sub_order_id;
  END IF;

  SELECT available_balance INTO v_platform_before FROM platform_accounts
  WHERE id='00000000-0000-0000-0000-000000000001' FOR UPDATE;

  -- Paystack has already confirmed the customer received/was issued the
  -- refund. Internal accounting must therefore reflect the cash outflow
  -- even if the platform account is temporarily below zero due to a prior
  -- withdrawal or another unreconciled cash event. A negative available
  -- balance is an explicit deficit, not money we silently lose.
  UPDATE platform_accounts
  SET available_balance = available_balance - r.amount,
      total_earned = CASE WHEN v_responsible_type IS NULL THEN total_earned - r.amount ELSE total_earned END,
      recoverable_refunds = CASE WHEN v_responsible_type IS NOT NULL THEN recoverable_refunds + r.amount ELSE recoverable_refunds END,
      updated_at=NOW()
  WHERE id='00000000-0000-0000-0000-000000000001';

  INSERT INTO platform_ledger_entries(reference, source_type, amount, description, actor_id)
  VALUES (
    r.id,
    CASE WHEN v_responsible_type IS NULL THEN 'PLATFORM_REFUND' ELSE 'PLATFORM_REFUND_FRONTED' END,
    -r.amount,
    CASE WHEN v_responsible_type IS NULL THEN 'Platform-funded customer refund' ELSE 'Refund fronted by Fidelx; recoverable from responsible ' || v_responsible_type END,
    r.admin_reviewer_id
  )
  ON CONFLICT (reference, source_type) WHERE source_type IN ('PLATFORM_REFUND','PLATFORM_REFUND_FRONTED') DO NOTHING;

  IF v_responsible_type IS NOT NULL AND v_user_id IS NOT NULL THEN
    INSERT INTO refund_liabilities(refund_id,responsible_type,responsible_user_id,original_amount)
    VALUES(r.id,v_responsible_type,v_user_id,r.amount)
    ON CONFLICT (refund_id) DO NOTHING
    RETURNING id INTO v_liability_id;

    IF v_liability_id IS NULL THEN
      SELECT id INTO v_liability_id FROM refund_liabilities WHERE refund_id=r.id;
    END IF;

    -- First recover whatever is already available.
    v_recovered := recover_refund_liabilities(v_user_id, r.amount);
  END IF;

  INSERT INTO ledger_entries(id,reference,type,amount,fee,net,source,destination,actor_id,description)
  VALUES(gen_random_uuid(),r.id,'REFUND_PROCESSED',r.amount,0,-r.amount,
    CASE WHEN v_responsible_type IS NULL THEN 'platform_revenue' ELSE 'platform_refund_fronted' END,
    'customer_refund',r.admin_reviewer_id,
    'Customer refund confirmed by Paystack; cost classification: ' || COALESCE(v_responsible_type,'platform') ||
    CASE WHEN v_responsible_type IS NOT NULL THEN ', recovered immediately: ₦' || v_recovered ELSE '' END)
  ON CONFLICT (reference,type) WHERE reference IS NOT NULL DO NOTHING;

  UPDATE refunds SET balance_debited=TRUE, financial_finalized_at=NOW(), status='processed', processed_at=COALESCE(processed_at,NOW()), paystack_status='processed'
  WHERE id=r.id;

  RETURN jsonb_build_object(
    'already_finalized',false,
    'refund_id',r.id,
    'amount',r.amount,
    'responsible_type',v_responsible_type,
    'responsible_user_id',v_user_id,
    'recovered_now',v_recovered,
    'outstanding',CASE WHEN v_responsible_type IS NULL THEN 0 ELSE r.amount-v_recovered END
  );
END;
$$;

-- Platform withdrawal approval lock.
CREATE OR REPLACE FUNCTION claim_platform_withdrawal_for_approval(p_withdrawal_id UUID,p_admin_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_count INT;
BEGIN
  UPDATE platform_withdrawals
  SET status='CLAIMED', admin_reviewer_id=p_admin_id, reviewed_at=NOW()
  WHERE id=p_withdrawal_id AND status='PENDING';
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count=1;
END;
$$;

-- Keep platform completion idempotent.
CREATE OR REPLACE FUNCTION complete_platform_withdrawal(p_withdrawal_id UUID,p_admin_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_amount NUMERIC;
BEGIN
  UPDATE platform_withdrawals
  SET status='COMPLETED', admin_reviewer_id=COALESCE(p_admin_id,admin_reviewer_id), completed_at=NOW()
  WHERE id=p_withdrawal_id AND status IN ('CLAIMED','PROCESSING')
  RETURNING amount INTO v_amount;
  IF v_amount IS NULL THEN RETURN FALSE; END IF;
  UPDATE platform_accounts SET total_withdrawn=total_withdrawn+v_amount, updated_at=NOW()
  WHERE id='00000000-0000-0000-0000-000000000001';
  RETURN TRUE;
END;
$$;

-- Make the original platform refund helper use the same cash/revenue rules.
CREATE OR REPLACE FUNCTION debit_platform_refund(p_reference UUID,p_amount NUMERIC,p_actor_id UUID,p_reason TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF COALESCE(p_amount,0) <= 0 THEN RETURN FALSE; END IF;
  IF EXISTS (SELECT 1 FROM platform_ledger_entries WHERE reference=p_reference AND source_type='PLATFORM_REFUND') THEN RETURN TRUE; END IF;
  UPDATE platform_accounts
  SET available_balance=available_balance-p_amount,
      total_earned=total_earned-p_amount,
      updated_at=NOW()
  WHERE id='00000000-0000-0000-0000-000000000001' AND available_balance>=p_amount;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  INSERT INTO platform_ledger_entries(reference,source_type,amount,description,actor_id)
  VALUES(p_reference,'PLATFORM_REFUND',-p_amount,COALESCE(p_reason,'Platform-funded refund'),p_actor_id)
  ON CONFLICT (reference,source_type) WHERE source_type IN ('PLATFORM_REFUND','PLATFORM_REFUND_FRONTED') DO NOTHING;
  RETURN TRUE;
END;
$$;
