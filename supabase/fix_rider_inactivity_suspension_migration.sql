-- ============================================================
-- FIX: RIDER AUTO-SUSPENSION ON NULL last_seen
--
-- WHY: riders.last_seen has no default and is only ever set once a
-- rider goes online and pings a location update (riderController.js).
-- A brand-new approved rider who hasn't gone online yet has
-- last_seen = NULL. The old "mark-inactive-riders" cron job treated
-- NULL identically to "stale for 30/60+ days", so any rider who
-- hadn't gone online yet was paused and then suspended on the very
-- next midnight run — not after any real inactivity at all.
--
-- FIX: fall back to created_at instead of treating NULL as stale.
-- A rider now gets a genuine 30/60-day grace period from account
-- creation before the inactivity clock can touch them, whether or
-- not they've ever gone online.
-- ============================================================

-- cron.schedule() with an existing job name updates that job in place
-- (pg_cron upserts by name) — no need to unschedule first.
SELECT cron.schedule(
  'mark-inactive-riders',
  '0 0 * * *',
  $$
    -- Pause riders inactive for 30 days
    UPDATE riders
    SET is_active = false
    WHERE is_active = true
    AND COALESCE(last_seen, created_at) < NOW() - INTERVAL '30 days'
    AND status = 'approved';

    -- Suspend riders inactive for 60 days
    UPDATE riders
    SET status = 'suspended', is_active = false
    WHERE status = 'approved'
    AND COALESCE(last_seen, created_at) < NOW() - INTERVAL '60 days';
  $$
);

-- ============================================================
-- REMEDIATION: restore riders wrongly suspended by the old bug
--
-- Only touches riders that match the bug's exact signature: never
-- had a real last_seen recorded, currently suspended/inactive. A
-- rider that WAS genuinely seen and then went quiet for 60+ real
-- days is untouched by this and stays suspended correctly.
-- Review the SELECT output before running the UPDATE if you want to
-- double check who this affects.
-- ============================================================

-- Preview affected riders first:
-- SELECT id, business_name, created_at, last_seen, status, is_active
-- FROM riders
-- WHERE last_seen IS NULL AND status = 'suspended';

UPDATE riders
SET status = 'approved', is_active = true
WHERE last_seen IS NULL
AND status = 'suspended';
