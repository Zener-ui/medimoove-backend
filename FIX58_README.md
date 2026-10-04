# Fidelx Backend Fix #58 — Automatic reconciliation refund recovery

## Genuine issue found
The late-payment reconciliation path could successfully create a Paystack refund but fail to persist the returned `paystack_refund_id`/status. The normal refund reconciliation job only picked up refunds that already had `paystack_refund_id`, so a lost webhook or process crash could leave the refund stuck locally and leave financial finalization incomplete.

There was also a second accounting problem in the same path: if the Paystack refund request itself failed, the reserved refund amount was not released, which could consume refund capacity even though no refund was created.

## What changed
- Added an idempotency lookup before creating an automatic reconciliation refund, preventing a second Paystack refund for the same payment.
- Persist the Paystack refund ID/status immediately after Paystack accepts the refund.
- If the Paystack request itself fails, mark the local refund failed and release the reserved refund amount.
- If Paystack accepts the refund but the local DB update fails, do **not** release the claim or issue another refund; the refund remains recoverable.
- Added reconciliation for older automatic refunds that have no local Paystack refund ID. It verifies the original transaction, lists Paystack refunds for that transaction, and matches the refund by amount plus Fidelx's unique merchant-note marker.
- If no matching Paystack refund can be found, the system does **not** guess or automatically issue another refund; it alerts admins for manual verification.

## Database
No new migration is required. This uses existing `refunds.paystack_refund_id`, `paystack_status`, `paystack_transaction_reference`, `idempotency_key`, and existing refund accounting functions.

## Validation
- `node --check controllers/reconciliationController.js` passed.
- All backend `.js` files passed `node --check`.
