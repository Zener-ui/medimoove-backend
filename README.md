Fix #49 — Paystack transfer reconciliation endpoint correction

Issue found:
The stuck withdrawal reconciliation code attempted to verify transfers by calling GET /transfer/{reference}. Paystack's Fetch Transfer endpoint accepts a transfer ID or transfer code, not a transfer reference. Paystack provides GET /transfer/verify/{reference} specifically for reference-based verification.

This affected both vendor/rider withdrawals and platform withdrawals. A real transfer could therefore be treated as nonexistent after a 404, causing Fidelx to reset the withdrawal to PENDING and potentially permit a duplicate transfer attempt.

Fix:
Use /transfer/verify/{reference} for deterministic reference-based recovery in both reconciliation paths. No withdrawal accounting logic was changed.

Validation:
- node --check passed for reconciliationController.js
