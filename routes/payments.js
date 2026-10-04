const express = require("express");
const router = express.Router();
const { initializePayment, verifyPayment, paystackWebhook } = require("../controllers/paymentController");
const { reconcileStalePayments, reconcileIncompletePaymentProcessing } = require("../controllers/reconciliationController");
const { protect } = require("../middleware/auth");
const { paymentLimiter } = require("../middleware/security");

router.post("/initialize", paymentLimiter, protect, initializePayment);
router.get("/verify/:reference", paymentLimiter, protect, verifyPayment);
router.post("/webhook", paystackWebhook); // No auth — Paystack calls this

// Called by the database trigger (see reconciliation_job_migration.sql)
// on a schedule, not by any user-facing request — guarded by a shared
// secret instead of a user JWT, same pattern as /api/push/dispatch-internal.
router.post("/reconcile-internal", async (req, res) => {
  const secret = req.headers["x-internal-webhook-secret"];
  if (!secret || secret !== process.env.INTERNAL_WEBHOOK_SECRET) {
    return res.status(401).json({ success: false });
  }
  try {
    const result = await reconcileStalePayments();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("[reconcile-internal] Failed:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Resumes any payment left stuck "successful" with unfinished side
// effects by a mid-sequence crash (audit item 9). Same shared-secret
// pattern as above; scheduled via reconcile_financial_safety_migration.sql.
router.post("/reconcile-processing-internal", async (req, res) => {
  const secret = req.headers["x-internal-webhook-secret"];
  if (!secret || secret !== process.env.INTERNAL_WEBHOOK_SECRET) {
    return res.status(401).json({ success: false });
  }
  try {
    const result = await reconcileIncompletePaymentProcessing();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("[reconcile-processing-internal] Failed:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
