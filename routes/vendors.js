const express = require("express");
const router = express.Router();
const {
  registerVendor, getAllVendors, getVendorById,
  getMyVendorProfile, updateVendorProfile, getVendorEarnings, getReferralStats,
} = require("../controllers/vendorController");
const { updateVendorAvailability } = require("../controllers/operationalController");
const { protect, optionalAuth } = require("../middleware/auth");
const { roles } = require("../middleware/roles");
const { requireApprovedVendor } = require("../middleware/approval");

// NOTE: /me, /register, and the profile PUT deliberately stay
// ungated by requireApprovedVendor — a pending/rejected vendor still
// needs to read their own status and edit their application details.
// Everything that constitutes actual dashboard/selling activity is
// gated below.
router.get("/", getAllVendors);
router.get("/me", protect, roles("vendor"), getMyVendorProfile);
router.get("/me/earnings", protect, roles("vendor"), requireApprovedVendor, getVendorEarnings);
router.get("/me/referrals", protect, roles("vendor"), requireApprovedVendor, getReferralStats);
router.get("/:id", optionalAuth, getVendorById);
router.post("/register", protect, roles("vendor"), registerVendor);
router.put("/me", protect, roles("vendor"), updateVendorProfile);
router.put("/me/availability", protect, roles("vendor"), requireApprovedVendor, updateVendorAvailability);

module.exports = router;
