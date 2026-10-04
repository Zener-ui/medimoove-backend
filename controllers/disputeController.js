const { adminClient } = require("../config/db");
const { getDisputeEvidenceUrls } = require("./uploadController");
const { v4: uuidv4 } = require("uuid");
const { notifyAdmins } = require("../utils/notifyAdmins");
const createDispute = async (req, res) => {
  try {
    const { order_id, reason, evidence_urls } = req.body;

    const { data: order } = await adminClient
      .from("orders")
      .select("id, status, customer_id")
      .eq("id", order_id)
      .single();

    if (!order) return res.status(404).json({ success: false, message: "Order not found." });
    if (order.customer_id !== req.user.id) return res.status(403).json({ success: false, message: "Not authorized." });
    if (order.status !== "DELIVERED") return res.status(400).json({ success: false, message: "Order not delivered yet." });

    // orders has no delivered_at column — only sub_orders does. Since
    // orders.status only flips to DELIVERED once every sub-order in it
    // has been delivered, use the LATEST delivered_at across this
    // order's sub-orders as when the 24-hour dispute window starts.
    const { data: subOrders } = await adminClient
      .from("sub_orders")
      .select("delivered_at")
      .eq("order_id", order_id)
      .not("delivered_at", "is", null);

    const latestDeliveredAt = subOrders?.length
      ? new Date(Math.max(...subOrders.map((so) => new Date(so.delivered_at).getTime())))
      : null;

    if (!latestDeliveredAt) {
      return res.status(400).json({ success: false, message: "Delivery time could not be determined." });
    }

    // 24-hour dispute window
    const now = new Date();
    const hoursSinceDelivery = (now - latestDeliveredAt) / (1000 * 60 * 60);

    if (hoursSinceDelivery > 24) {
      return res.status(400).json({ success: false, message: "Dispute window has closed. You have 24 hours after delivery." });
    }

    if (!evidence_urls || evidence_urls.length === 0) {
      return res.status(400).json({ success: false, message: "Photo evidence is required to open a dispute." });
    }

    const evidence = Array.isArray(evidence_urls) ? evidence_urls.map(String) : [];
    const ownStoragePrefix = `storage://dispute-evidence/${req.user.id}/`;
    const invalidPrivateReference = evidence.some(
      (ref) => ref.startsWith("storage://dispute-evidence/") && !ref.startsWith(ownStoragePrefix)
    );
    if (invalidPrivateReference) {
      return res.status(403).json({ success: false, message: "Invalid evidence reference." });
    }

    const { data: dispute, error } = await adminClient
      .from("disputes")
      .insert({
        id: uuidv4(),
        order_id,
        customer_id: req.user.id,
        reason,
        evidence_urls: evidence,
        status: "open",
      })
      .select()
      .single();

    if (error) throw error;

    // Notify admin
    await notifyAdmins(
      "New Dispute Filed",
      `Dispute opened for order #${order_id.slice(0, 8)}. Review required.`,
      {
        emailSubject: "New dispute filed — review required",
        emailHtml: `<p>A new dispute was opened for order <strong>#${order_id.slice(0, 8)}</strong> and needs review.</p><p>Open the Admin Dashboard to see the details.</p>`,
      }
    );

    res.status(201).json({ success: true, dispute });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/disputes/my
const getMyDisputes = async (req, res) => {
  try {
    const { data, error } = await adminClient
      .from("disputes")
      .select("*, orders(id, total)")
      .eq("customer_id", req.user.id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const disputes = await Promise.all((data || []).map(async (dispute) => ({
      ...dispute,
      evidence_urls: await getDisputeEvidenceUrls(dispute.evidence_urls || []),
      additional_evidence: await getDisputeEvidenceUrls(dispute.additional_evidence || []),
    })));
    res.json({ success: true, disputes });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/disputes/:id/appeal (customer)
const appealDispute = async (req, res) => {
  try {
    const { additional_evidence } = req.body;

    const { data: dispute } = await adminClient
      .from("disputes")
      .select("id, status, customer_id, appeal_count")
      .eq("id", req.params.id)
      .single();

    if (!dispute) return res.status(404).json({ success: false, message: "Dispute not found." });
    if (dispute.customer_id !== req.user.id) return res.status(403).json({ success: false, message: "Not authorized." });
    if (dispute.status !== "resolved") return res.status(400).json({ success: false, message: "Dispute not resolved yet." });
    if (dispute.appeal_count >= 1) return res.status(400).json({ success: false, message: "You have already used your one appeal." });

    await adminClient.from("disputes").update({
      status: "appealed",
      additional_evidence,
      appeal_count: 1,
    }).eq("id", req.params.id);

    res.json({ success: true, message: "Appeal submitted. Admin will review within 48 hours." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { createDispute, getMyDisputes, appealDispute };
