const express = require("express");
const router = express.Router();
const { getPolicies, getPolicyByType, getPolicyAcceptanceStatus, updatePolicy, acceptPolicy } = require("../controllers/pilotAndOpsController");
const { protect } = require("../middleware/auth");
const { roles } = require("../middleware/roles");

router.get("/", getPolicies);
router.get("/:type/status", protect, getPolicyAcceptanceStatus);
router.get("/:type", getPolicyByType);
router.post("/accept", protect, acceptPolicy);
router.put("/admin/:type", protect, roles("admin"), updatePolicy);

module.exports = router;
