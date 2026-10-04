-- ============================================================
-- RIDER NIN VERIFICATION — MIGRATION
-- Run this in Supabase SQL Editor AFTER schema.sql, rls_policies.sql,
-- atomic_functions.sql, operational_migrations.sql, and background_jobs.sql
-- have already been run.
-- ============================================================

-- Track verification detail beyond the existing boolean, so admins
-- can see *why* a rider failed verification without digging into logs.
ALTER TABLE riders
  ADD COLUMN IF NOT EXISTS nin_verification_status TEXT
    DEFAULT 'not_submitted'
    CHECK (nin_verification_status IN ('not_submitted', 'pending', 'verified', 'failed', 'manual_override')),
  ADD COLUMN IF NOT EXISTS nin_verification_message TEXT,
  ADD COLUMN IF NOT EXISTS nin_verification_reference TEXT,
  ADD COLUMN IF NOT EXISTS nin_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS nin_verification_attempts INT DEFAULT 0;

-- Full audit trail of every verification attempt (not just the latest).
-- Useful for support disputes ("I verified, why does it say failed?")
-- and for spotting repeated fraud attempts on the same NIN.
CREATE TABLE IF NOT EXISTS rider_verification_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id UUID REFERENCES riders(id) ON DELETE CASCADE,
  attempted_at TIMESTAMPTZ DEFAULT NOW(),
  verified BOOLEAN NOT NULL,
  name_match BOOLEAN,
  provider_reference TEXT,
  error_message TEXT,
  raw_response JSONB
);

CREATE INDEX IF NOT EXISTS idx_rider_verification_logs_rider_id
  ON rider_verification_logs(rider_id);

-- RLS: riders can see their own verification logs; admins can see all.
ALTER TABLE rider_verification_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Riders can view their own verification logs"
  ON rider_verification_logs FOR SELECT
  USING (
    rider_id IN (SELECT id FROM riders WHERE user_id = auth.uid())
  );

-- Admin access goes through the service_role client (adminClient in
-- config/db.js), which bypasses RLS entirely — no admin-specific
-- policy is needed here, consistent with the rest of this project's
-- RLS approach in rls_policies.sql.
