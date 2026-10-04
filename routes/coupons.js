const express = require("express");
const router = express.Router();
const { validateCoupon, createCoupon, getAllCoupons, toggleCoupon } = require("../controllers/couponController");
const { protect } = require("../middleware/auth");
const { roles } = require("../middleware/roles");

router.post("/validate", protect, roles("customer"), validateCoupon);

router.post("/", protect, roles("admin"), createCoupon);
router.get("/", protect, roles("admin"), getAllCoupons);
router.put("/:id/toggle", protect, roles("admin"), toggleCoupon);

module.exports = router;
