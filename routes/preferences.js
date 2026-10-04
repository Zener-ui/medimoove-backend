const express = require("express");
const router = express.Router();
const { getNotificationPreferences, updateNotificationPreferences } = require("../controllers/operationalController");
const { protect } = require("../middleware/auth");

router.get("/notifications", protect, getNotificationPreferences);
router.put("/notifications", protect, updateNotificationPreferences);

module.exports = router;
