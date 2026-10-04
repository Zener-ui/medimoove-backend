Fidelx Promotions Step 6 — Paystack / Budget Reconciliation

What this fixes:
- Prevents duplicate Paystack funding DEPOSIT ledger rows.
- Makes repeated successful funding completion safe.
- Adds a read-only reconciliation report comparing:
  * successful Paystack promotions funding
  * promotions DEPOSIT ledger entries
  * coupon/referral spend
  * promotions_budget.balance
  * promotions_budget.total_deposited
  * promotions_budget.total_spent
- Flags old pending funding attempts (>30 minutes).

SQL to run once:
supabase/promotions_reconciliation_fix.sql

Admin endpoint after deployment:
GET /api/promotions/budget/reconcile

The endpoint is admin-protected and READ-ONLY. It does not automatically
move money or alter the balance when it finds a discrepancy.

No changes to:
- platform_accounts
- vendor/rider balances
- orders/payments
- refunds
- withdrawals
- normal Paystack customer payments
