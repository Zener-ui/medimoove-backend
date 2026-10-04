const express = require("express");
const router = express.Router();
const { getMyReferralStats } = require("../controllers/customerReferralController");
const { protect } = require("../middleware/auth");

router.get("/me", protect, getMyReferralStats);

module.exports = router;
