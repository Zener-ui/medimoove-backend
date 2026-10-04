const express = require("express");
const router = express.Router();
const { createDispute, getMyDisputes, appealDispute } = require("../controllers/disputeController");
const { protect } = require("../middleware/auth");

router.post("/", protect, createDispute);
router.get("/my", protect, getMyDisputes);
router.put("/:id/appeal", protect, appealDispute);

module.exports = router;
