const express = require("express");
const router = express.Router();
const { getMyNotifications, markAsRead, markAllAsRead, getActiveNotices } = require("../controllers/notificationController");
const { protect } = require("../middleware/auth");

router.get("/", protect, getMyNotifications);
router.get("/urgent-notices", protect, getActiveNotices);
router.put("/read-all", protect, markAllAsRead);
router.put("/:id/read", protect, markAsRead);

module.exports = router;
