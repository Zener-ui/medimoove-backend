const express = require("express");
const router = express.Router();
const { getFeeSettings } = require("../controllers/feeController");

// Fee percentages are public because customers need to see the exact
// platform fee before checkout. Admin/service-role remains the source of truth.
router.get("/settings", getFeeSettings);

module.exports = router;
