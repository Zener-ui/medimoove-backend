// reviews.js
const express = require("express");
const router = express.Router();
const {
  createReview,
  updateReview,
  getVendorReviews,
  getVendorRatingSummary,
  markReviewHelpful,
  replyToReview,
  getMyVendorReviews,
} = require("../controllers/reviewController");
const { protect } = require("../middleware/auth");
const { roles } = require("../middleware/roles");
const { requireApprovedVendor } = require("../middleware/approval");

router.post("/", protect, roles("customer"), createReview);
router.put("/:id", protect, roles("customer"), updateReview);
router.post("/:id/helpful", protect, markReviewHelpful);
router.put("/:id/reply", protect, roles("vendor"), requireApprovedVendor, replyToReview);

router.get("/vendor/me", protect, roles("vendor"), requireApprovedVendor, getMyVendorReviews);
router.get("/vendor/:vendorId/summary", getVendorRatingSummary);
router.get("/vendor/:vendorId", getVendorReviews);

module.exports = router;
