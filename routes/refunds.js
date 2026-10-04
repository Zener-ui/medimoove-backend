const express = require("express");
const router = express.Router();
const { processRefund, getRefundRules } = require("../controllers/operationalController");
const { reconcileStuckRefunds } = require("../controllers/reconciliationController");
const { protect } = require("../middleware/auth");
const { roles } = require("../middleware/roles");

router.get("/rules", getRefundRules);
router.post("/", protect, roles("admin"), processRefund);

// Called by pg_cron on a schedule (see reconcile_stuck_refunds_migration.sql)
// — safety net for a missed/delayed Paystack refund.processed webhook.
// Guarded by the same shared secret as /api/payments/reconcile-internal.
router.post("/reconcile-internal", async (req, res) => {
  const secret = req.headers["x-internal-webhook-secret"];
  if (!secret || secret !== process.env.INTERNAL_WEBHOOK_SECRET) {
    return res.status(401).json({ success: false });
  }
  try {
    const result = await reconcileStuckRefunds();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("[reconcile-refunds] Failed:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
