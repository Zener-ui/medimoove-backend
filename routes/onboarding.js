const express = require("express");
const router = express.Router();
const { getOnboardingStatus, markStepComplete, reapplyVendor, reapplyRider } = require("../controllers/onboardingController");
const { protect } = require("../middleware/auth");
const { roles } = require("../middleware/roles");

router.get("/status", protect, getOnboardingStatus);
router.put("/step", protect, markStepComplete);
router.post("/vendor/reapply", protect, roles("vendor"), reapplyVendor);
router.post("/rider/reapply", protect, roles("rider"), reapplyRider);

module.exports = router;
