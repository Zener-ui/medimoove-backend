const { adminClient } = require("../config/db");

// ============================================================
// This file previously also contained createOrder, updateOrderStatus,
// cancelOrder, and confirmDelivery — leftover from an early single-
// vendor MVP iteration. Confirmed dead code: the frontend uses
// /api/sub-orders/* for ALL order creation and mutation (see
// subOrderController.js), and a full codebase + frontend search
// found zero remaining callers of any of those four functions.
// Removed rather than kept as broken dead weight.
//
// The two functions below (read-only) ARE actually used by the
// frontend, but had the same "column doesn't exist" bug found
// throughout this session: orders has no vendor_id/rider_id column
// (only sub_orders does, since one order can span multiple
// vendors) — the old code tried to filter/join on those directly.
// Fixed to query through sub_orders correctly.
// ============================================================

// @route GET /api/orders
const getMyOrders = async (req, res) => {
  try {
    let orderIds = null;

    if (req.user.role === "vendor") {
      const { data: vendor } = await adminClient.from("vendors").select("id").eq("user_id", req.user.id).single();
      if (!vendor) return res.json({ success: true, orders: [] });
      const { data: subOrders } = await adminClient.from("sub_orders").select("order_id").eq("vendor_id", vendor.id);
      orderIds = [...new Set((subOrders || []).map((s) => s.order_id))];
    } else if (req.user.role === "rider") {
      const { data: rider } = await adminClient.from("riders").select("id").eq("user_id", req.user.id).single();
      if (!rider) return res.json({ success: true, orders: [] });
      const { data: subOrders } = await adminClient.from("sub_orders").select("order_id").eq("rider_id", rider.id);
      orderIds = [...new Set((subOrders || []).map((s) => s.order_id))];
    }

    let query = adminClient.from("orders").select("*").order("created_at", { ascending: false });

    if (req.user.role === "customer") {
      query = query.eq("customer_id", req.user.id);
    } else if (orderIds !== null) {
      if (orderIds.length === 0) return res.json({ success: true, orders: [] });
      query = query.in("id", orderIds);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, orders: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/orders/:id
const getOrderById = async (req, res) => {
  try {
    const { data: order, error } = await adminClient
      .from("orders")
      .select("*, order_items(*, products(name, images)), sub_orders(id, vendor_id, rider_id, status, delivery_type, vendors(business_name, address, phone))")
      .eq("id", req.params.id)
      .single();

    if (error || !order) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    // Ownership check — this previously had none, so any authenticated
    // user could fetch any order by guessing/obtaining its ID.
    if (req.user.role === "customer") {
      if (order.customer_id !== req.user.id) {
        return res.status(403).json({ success: false, message: "Not authorized." });
      }
    } else if (req.user.role === "vendor") {
      const { data: vendor } = await adminClient.from("vendors").select("id").eq("user_id", req.user.id).single();
      const owns = vendor && order.sub_orders?.some((so) => so.vendor_id === vendor.id);
      if (!owns) return res.status(403).json({ success: false, message: "Not authorized." });
    } else if (req.user.role === "rider") {
      const { data: rider } = await adminClient.from("riders").select("id").eq("user_id", req.user.id).single();
      const owns = rider && order.sub_orders?.some((so) => so.rider_id === rider.id);
      if (!owns) return res.status(403).json({ success: false, message: "Not authorized." });
    } else if (req.user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Not authorized." });
    }

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { getMyOrders, getOrderById };
