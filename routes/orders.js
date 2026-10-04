const express = require("express");
const router = express.Router();
const { getMyOrders, getOrderById } = require("../controllers/orderController");
const { protect } = require("../middleware/auth");

// This file is READ-ONLY by design. All order creation and mutation
// (accept, status updates, cancellation) goes through /api/sub-orders/*
// in subOrderController.js — see the comment at the top of
// orderController.js for why the old mutation endpoints here were
// removed.
router.get("/", protect, getMyOrders);
router.get("/:id", protect, getOrderById);

module.exports = router;
