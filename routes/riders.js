const express = require("express");
const router = express.Router();
const {
  registerRider, retryNinVerification, getMyRiderProfile, updateRiderLocation,
  toggleAvailability, getAvailableOrders, acceptOrder, getRiderEarnings,
} = require("../controllers/riderController");
const { protect } = require("../middleware/auth");
const { roles } = require("../middleware/roles");
const { requireApprovedRider } = require("../middleware/approval");

// NOTE: /register, /verify-nin/retry, and /me deliberately stay
// ungated — a pending/rejected rider still needs these to complete
// or retry verification and to read their own status. Everything
// that constitutes actual delivery activity is gated below.
router.post("/register", protect, roles("rider"), registerRider);
router.post("/verify-nin/retry", protect, roles("rider"), retryNinVerification);
router.get("/me", protect, roles("rider"), getMyRiderProfile);
router.get("/me/earnings", protect, roles("rider"), requireApprovedRider, getRiderEarnings);
router.get("/available-orders", protect, roles("rider"), requireApprovedRider, getAvailableOrders);
router.put("/location", protect, roles("rider"), requireApprovedRider, updateRiderLocation);
router.put("/availability", protect, roles("rider"), requireApprovedRider, toggleAvailability);
router.post("/accept-order/:orderId", protect, roles("rider"), requireApprovedRider, acceptOrder);

module.exports = router;
