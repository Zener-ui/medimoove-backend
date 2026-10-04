-- ============================================================
-- DIAGNOSTIC — trace your most recent order through the whole
-- platform-fee chain. Run this as-is in Supabase SQL Editor.
-- Each row tells you exactly where it broke.
-- ============================================================

-- 1. Your most recent order — check payment_status and platform_fee
SELECT id, status, payment_status, platform_fee, total, created_at
FROM orders
ORDER BY created_at DESC
LIMIT 3;

-- 2. Copy the order id from above and paste it into the two queries
--    below in place of 'PASTE_ORDER_ID_HERE'.

-- Was the payment itself actually marked successful?
SELECT reference, status, amount, created_at
FROM payments
WHERE reference IN (
  SELECT paystack_reference FROM orders WHERE id = 'PASTE_ORDER_ID_HERE'
);

-- Did a platform_ledger_entries row ever get created for this order?
-- If this returns NOTHING, credit_platform_revenue either never ran,
-- or ran and hit the ON CONFLICT DO NOTHING guard (meaning something
-- already inserted a row with this reference/source_type before).
SELECT * FROM platform_ledger_entries WHERE reference = 'PASTE_ORDER_ID_HERE';

-- 3. Check the singleton platform_accounts row directly
SELECT * FROM platform_accounts WHERE id = '00000000-0000-0000-0000-000000000001';

-- 4. Check audit_logs for a PLATFORM_FEE_CREDIT_FAILED entry — this
--    will only show up once you've deployed the latest backend code
--    (the one that logs this instead of failing silently)
SELECT * FROM audit_logs
WHERE action = 'PLATFORM_FEE_CREDIT_FAILED'
ORDER BY created_at DESC
LIMIT 5;
