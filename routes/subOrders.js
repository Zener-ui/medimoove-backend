const express = require("express");
const router = express.Router();
const {
  createOrderWithSubOrders,
  getOrderWithSubOrders,
  updateSubOrderStatus,
  cancelSubOrder,
  getVendorSubOrders,
  getRiderSubOrders,
  riderAcceptSubOrder,
} = require("../controllers/subOrderController");
const { protect } = require("../middleware/auth");
const { roles } = require("../middleware/roles");
const { requireApprovedVendor, requireApprovedRider } = require("../middleware/approval");

// Customer
router.post("/create", protect, roles("customer"), createOrderWithSubOrders);
router.get("/order/:orderId", protect, roles("customer"), getOrderWithSubOrders);
router.post("/:subOrderId/cancel", protect, roles("customer"), cancelSubOrder);

// Vendor
router.get("/vendor", protect, roles("vendor"), requireApprovedVendor, getVendorSubOrders);

// Rider
router.get("/rider", protect, roles("rider"), requireApprovedRider, getRiderSubOrders);
router.post("/:subOrderId/accept", protect, roles("rider"), requireApprovedRider, riderAcceptSubOrder);

// Shared — status updates (vendor marks ready, rider marks picked up/delivered, admin overrides)
router.put("/:subOrderId/status", protect, updateSubOrderStatus);

module.exports = router;
