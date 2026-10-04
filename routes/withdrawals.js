const express = require("express");
const router = express.Router();
const {
  getBanks,
  resolveAccount,
  requestVendorWithdrawal,
  requestRiderWithdrawal,
  getMyWithdrawals,
  getAllWithdrawals,
  approveWithdrawal,
  rejectWithdrawal,
  updateFeeSettings,
  getFeePreview,
  getPinStatus,
  setWithdrawalPin,
} = require("../controllers/withdrawalController");
const { protect } = require("../middleware/auth");
const { roles } = require("../middleware/roles");
const { requireApprovedVendor, requireApprovedRider } = require("../middleware/approval");
const { withdrawalLimiter } = require("../middleware/security");

router.get("/banks", protect, getBanks);
router.post("/resolve-account", protect, resolveAccount);
router.get("/fee-preview", protect, getFeePreview);
router.get("/my", protect, getMyWithdrawals);
router.get("/pin/status", protect, getPinStatus);
router.post("/pin/set", protect, setWithdrawalPin);
router.post("/vendor", protect, withdrawalLimiter, roles("vendor"), requireApprovedVendor, requestVendorWithdrawal);
router.post("/rider", protect, withdrawalLimiter, roles("rider"), requireApprovedRider, requestRiderWithdrawal);

// Admin routes
router.get("/admin/all", protect, roles("admin"), getAllWithdrawals);
router.put("/admin/:id/approve", protect, roles("admin"), approveWithdrawal);
router.put("/admin/:id/reject", protect, roles("admin"), rejectWithdrawal);
router.put("/admin/fee-settings", protect, roles("admin"), updateFeeSettings);

// Called by pg_cron on a schedule (see financial_safety_migration.sql /
// reconcile_financial_safety_migration.sql) — resolves any withdrawal
// left stuck CLAIMED by a crash between Paystack accepting a transfer
// and the local DB being updated. Same shared-secret pattern as the
// other internal reconcile endpoints.
router.post("/reconcile-internal", async (req, res) => {
  const secret = req.headers["x-internal-webhook-secret"];
  if (!secret || secret !== process.env.INTERNAL_WEBHOOK_SECRET) {
    return res.status(401).json({ success: false });
  }
  try {
    const { reconcileStuckWithdrawalClaims } = require("../controllers/reconciliationController");
    const result = await reconcileStuckWithdrawalClaims();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("[withdrawals reconcile-internal] Failed:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
