-- ============================================================
-- FIX #13 — ATOMIC REFUND RESERVATION + IDEMPOTENCY
--
-- Closes the race where two concurrent requests with the same
-- idempotency_key could both reserve refund capacity before one lost
-- the unique-key INSERT race.
-- ============================================================

CREATE OR REPLACE FUNCTION create_refund_reservation(
  p_payment_id UUID,
  p_order_id UUID,
  p_sub_order_id UUID,
  p_customer_id UUID,
  p_requested_amount NUMERIC,
  p_reason TEXT,
  p_evidence_urls TEXT[] DEFAULT '{}',
  p_fault_party TEXT DEFAULT NULL,
  p_refund_type TEXT DEFAULT 'full',
  p_admin_reviewer_id UUID DEFAULT NULL,
  p_refund_stage TEXT DEFAULT 'post_delivery',
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_existing refunds%ROWTYPE;
  v_payment_amount NUMERIC;
  v_before NUMERIC;
  v_room NUMERIC;
  v_claim NUMERIC;
  v_refund_id UUID;
BEGIN
  IF p_requested_amount IS NULL OR p_requested_amount <= 0 THEN
    RAISE EXCEPTION 'Refund amount must be greater than zero.';
  END IF;

  -- Lock the parent payment BEFORE checking the idempotency key. This is
  -- the serialization point for all refund reservations against this
  -- Paystack transaction: a concurrent retry cannot perform its check
  -- until the first transaction has committed its refund row.
  SELECT amount, total_refunded
  INTO v_payment_amount, v_before
  FROM payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF v_payment_amount IS NULL THEN
    RAISE EXCEPTION 'Payment not found.';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing
    FROM refunds
    WHERE idempotency_key = p_idempotency_key
    LIMIT 1;

    IF v_existing.id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'refund_id', v_existing.id,
        'amount', v_existing.amount,
        'already_existed', true
      );
    END IF;
  END IF;

  v_room := v_payment_amount - COALESCE(v_before, 0);
  IF v_room <= 0 THEN
    RAISE EXCEPTION 'This refund would exceed the amount originally paid — nothing left to refund on this transaction.';
  END IF;

  v_claim := LEAST(p_requested_amount, v_room);
  v_refund_id := gen_random_uuid();

  UPDATE payments
  SET total_refunded = COALESCE(total_refunded, 0) + v_claim
  WHERE id = p_payment_id;

  INSERT INTO refunds (
    id, order_id, sub_order_id, payment_id, customer_id, amount, reason,
    evidence_urls, fault_party, refund_type, partial_amount, deducted_from,
    admin_reviewer_id, status, refund_stage, idempotency_key
  ) VALUES (
    v_refund_id, p_order_id, p_sub_order_id, p_payment_id, p_customer_id,
    v_claim, p_reason, COALESCE(p_evidence_urls, '{}'), p_fault_party,
    p_refund_type, CASE WHEN p_refund_type = 'partial' THEN v_claim ELSE NULL END,
    CASE p_fault_party
      WHEN 'vendor' THEN 'vendor_balance'
      WHEN 'rider' THEN 'rider_balance'
      WHEN 'platform' THEN 'platform_revenue'
      ELSE NULL
    END,
    p_admin_reviewer_id, 'pending', p_refund_stage, p_idempotency_key
  );

  RETURN jsonb_build_object(
    'refund_id', v_refund_id,
    'amount', v_claim,
    'already_existed', false
  );
END;
$$;
