const express = require("express");
const router = express.Router();
const { getPilotSettings, updatePilotSettings, generateInviteCode, validateInviteCode, useInviteCode } = require("../controllers/pilotAndOpsController");
const { protect } = require("../middleware/auth");
const { roles } = require("../middleware/roles");

router.get("/settings", getPilotSettings);
router.post("/validate-invite", validateInviteCode);
router.post("/use-invite", protect, useInviteCode);
router.put("/admin/settings", protect, roles("admin"), updatePilotSettings);
router.post("/admin/invite-codes/generate", protect, roles("admin"), generateInviteCode);

module.exports = router;
