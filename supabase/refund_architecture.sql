-- Cartmoove refund architecture migration
-- Run this ONCE in Supabase SQL Editor after deploying the patched backend.
-- This migration is additive and does not delete existing refund records.

ALTER TABLE refunds
  ADD COLUMN IF NOT EXISTS payment_id UUID REFERENCES payments(id),
  ADD COLUMN IF NOT EXISTS fault_party TEXT,
  ADD COLUMN IF NOT EXISTS refund_type TEXT DEFAULT 'full',
  ADD COLUMN IF NOT EXISTS partial_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS deducted_from TEXT,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS paystack_refund_id TEXT,
  ADD COLUMN IF NOT EXISTS paystack_status TEXT,
  ADD COLUMN IF NOT EXISTS paystack_transaction_reference TEXT,
  ADD COLUMN IF NOT EXISTS balance_debited BOOLEAN DEFAULT FALSE;

ALTER TABLE refunds
  DROP CONSTRAINT IF EXISTS refunds_status_check;

ALTER TABLE refunds
  ADD CONSTRAINT refunds_status_check
  CHECK (status IN ('pending', 'processing', 'needs_attention', 'processed', 'approved', 'rejected', 'failed'));

ALTER TABLE refunds
  ADD CONSTRAINT refunds_fault_party_check
  CHECK (fault_party IS NULL OR fault_party IN ('vendor', 'rider', 'platform', 'customer'));

ALTER TABLE refunds
  ADD CONSTRAINT refunds_type_check
  CHECK (refund_type IS NULL OR refund_type IN ('full', 'partial'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_paystack_refund_id
  ON refunds(paystack_refund_id)
  WHERE paystack_refund_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_refunds_payment_id ON refunds(payment_id);
CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status);
CREATE INDEX IF NOT EXISTS idx_refunds_transaction_reference ON refunds(paystack_transaction_reference);
