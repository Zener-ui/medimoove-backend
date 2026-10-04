const express = require("express");
const router = express.Router();
const { getPromotionsBudget, depositToBudget, verifyPromotionsFunding, reconcilePromotionsBudget } = require("../controllers/promotionsController");
const { protect } = require("../middleware/auth");
const { roles } = require("../middleware/roles");

router.get("/budget", protect, roles("admin"), getPromotionsBudget);
router.get("/budget/reconcile", protect, roles("admin"), reconcilePromotionsBudget);
router.post("/budget/deposit", protect, roles("admin"), depositToBudget);
router.get("/budget/funding/verify/:reference", protect, roles("admin"), verifyPromotionsFunding);

module.exports = router;
