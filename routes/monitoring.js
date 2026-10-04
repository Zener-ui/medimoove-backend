const express = require("express");
const router = express.Router();
const {
  getAdminAlerts, resolveAlert,
  getStuckOrders, resolveStuckOrder, getFailedWebhooks,
  markCustomerUnreachable, logManualIntervention,
} = require("../controllers/pilotAndOpsController");
const { protect } = require("../middleware/auth");
const { roles } = require("../middleware/roles");

router.use(protect, roles("admin"));

router.get("/alerts", getAdminAlerts);
router.put("/alerts/:id/resolve", resolveAlert);
router.get("/stuck-orders", getStuckOrders);
router.put("/stuck-orders/:id/resolve", resolveStuckOrder);
router.get("/failed-webhooks", getFailedWebhooks);
router.post("/customer-unreachable/:subOrderId", markCustomerUnreachable);
router.post("/manual-intervention", logManualIntervention);

module.exports = router;
