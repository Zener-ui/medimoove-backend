const express = require("express");
const router = express.Router();
const { estimateDeliveryFee, toggleRainSurcharge, setManualOverride, getAllDeliverySettings } = require("../controllers/deliveryController");
const { protect } = require("../middleware/auth");
const { roles } = require("../middleware/roles");

router.get("/estimate", protect, estimateDeliveryFee);
router.get("/admin/settings", protect, roles("admin"), getAllDeliverySettings);
router.put("/admin/toggle-rain-surcharge", protect, roles("admin"), toggleRainSurcharge);
router.put("/admin/override", protect, roles("admin"), setManualOverride);

module.exports = router;
