const express = require("express");
const router = express.Router();
const {
  getAllVendors, approveVendor, rejectVendor, suspendVendor, reactivateVendor,
  getAllRiders, approveRider, rejectRider, strikeRider,
  getAllOrders, getAllDisputes, resolveDispute,
  getAnalytics, getSupportTickets, replyToSupportTicket,
  reconcileBalances,
  reconcilePayments,
  getStuckCancellationRefunds,
  retryCancellationRefund,
  broadcastNotification,
  createNotice, getAllNotices, deactivateNotice,
} = require("../controllers/adminController");
const {
  getReferralSettings, updateReferralSettings, getReferralMilestones, sendReferralReward,
} = require("../controllers/customerReferralController");
const {
  getAllReviewsAdmin, flagReview, removeReview, restoreReview,
} = require("../controllers/reviewController");
const { protect } = require("../middleware/auth");
const { roles } = require("../middleware/roles");

// All admin routes require admin role
router.use(protect, roles("admin"));

router.get("/analytics", getAnalytics);

router.get("/reconcile-balances", reconcileBalances);
router.post("/reconcile-payments", reconcilePayments);
router.post("/notifications/broadcast", broadcastNotification);
router.post("/notices", createNotice);
router.get("/notices", getAllNotices);
router.put("/notices/:id/deactivate", deactivateNotice);
router.get("/referral-settings", getReferralSettings);
router.put("/referral-settings", updateReferralSettings);
router.get("/referral-milestones", getReferralMilestones);
router.post("/referral-milestones/:id/reward", sendReferralReward);

router.get("/vendors", getAllVendors);
router.put("/vendors/:id/approve", approveVendor);
router.put("/vendors/:id/reject", rejectVendor);
router.put("/vendors/:id/suspend", suspendVendor);
router.put("/vendors/:id/reactivate", reactivateVendor);

router.get("/riders", getAllRiders);
router.put("/riders/:id/approve", approveRider);
router.put("/riders/:id/reject", rejectRider);
router.put("/riders/:id/strike", strikeRider);

router.get("/orders", getAllOrders);

router.get("/disputes", getAllDisputes);
router.put("/disputes/:id/resolve", resolveDispute);

router.get("/cancellation-refunds", getStuckCancellationRefunds);
router.post("/cancellation-refunds/:subOrderId/retry", retryCancellationRefund);

router.get("/reviews", getAllReviewsAdmin);
router.put("/reviews/:id/flag", flagReview);
router.put("/reviews/:id/remove", removeReview);
router.put("/reviews/:id/restore", restoreReview);

router.get("/support-tickets", getSupportTickets);
router.put("/support-tickets/:id/reply", replyToSupportTicket);

module.exports = router;
