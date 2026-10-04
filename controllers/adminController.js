const { adminClient } = require("../config/db");
const { reconcileStalePayments } = require("./reconciliationController");
const { getDisputeEvidenceUrls } = require("./uploadController");
const { executeRefund, initiatePreDeliveryCancellationRefund } = require("./operationalController");

// @route GET /api/admin/vendors
const getAllVendors = async (req, res) => {
  try {
    const { status } = req.query;
    let query = adminClient.from("vendors").select("*, users!user_id(full_name, email, phone)").order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, vendors: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/admin/vendors/:id/approve
const approveVendor = async (req, res) => {
  try {
    const { data, error } = await adminClient
      .from("vendors")
      .update({ status: "approved" })
      .eq("id", req.params.id)
      .select("user_id")
      .single();

    if (error) throw error;

    await adminClient.from("notifications").insert({
      id: require("uuid").v4(),
      user_id: data.user_id,
      title: "Vendor Account Approved",
      body: "Your vendor account has been approved. You can now list products on Fidelx.",
      is_read: false,
    });

    res.json({ success: true, message: "Vendor approved." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/admin/vendors/:id/reject
const rejectVendor = async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: "Rejection reason is required." });

    const { data, error } = await adminClient
      .from("vendors")
      .update({ status: "rejected", rejection_reason: reason, reviewed_by: req.user.id, reviewed_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .select("user_id")
      .single();

    if (error) throw error;

    await adminClient.from("notifications").insert({
      id: require("uuid").v4(),
      user_id: data.user_id,
      title: "Vendor Application Rejected",
      body: `Your vendor application was not approved. Reason: ${reason}. You may reapply after addressing the issue.`,
      is_read: false,
    });

    await adminClient.from("audit_logs").insert({
      id: require("uuid").v4(),
      action: "VENDOR_REJECTED",
      actor_id: req.user.id,
      target_id: req.params.id,
      target_type: "vendor",
      details: { reason },
    });

    res.json({ success: true, message: "Vendor rejected." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/admin/vendors/:id/suspend
// For an already-approved vendor doing something that warrants pulling
// them offline immediately — as opposed to /reject, which is for an
// application that never should have been approved in the first
// place. requireApprovedVendor already blocks anything but
// status==="approved", so flipping this to "suspended" locks the
// vendor out of their dashboard/order flow the moment it's set —
// nothing else needs to change for the suspension to actually bite.
const suspendVendor = async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: "Suspension reason is required." });

    const { data, error } = await adminClient
      .from("vendors")
      .update({
        status: "suspended",
        suspension_reason: reason,
        suspended_by: req.user.id,
        suspended_at: new Date().toISOString(),
      })
      .eq("id", req.params.id)
      .select("user_id")
      .single();

    if (error) throw error;

    await adminClient.from("notifications").insert({
      id: require("uuid").v4(),
      user_id: data.user_id,
      title: "Vendor Account Suspended",
      body: `Your vendor account has been suspended. Reason: ${reason}. Contact support if you believe this is a mistake.`,
      is_read: false,
    });

    await adminClient.from("audit_logs").insert({
      id: require("uuid").v4(),
      action: "VENDOR_SUSPENDED",
      actor_id: req.user.id,
      target_id: req.params.id,
      target_type: "vendor",
      details: { reason },
    });

    res.json({ success: true, message: "Vendor suspended." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/admin/vendors/:id/reactivate
// Only meaningful from "suspended" — an application that was
// genuinely rejected goes through a fresh re-application, not this.
const reactivateVendor = async (req, res) => {
  try {
    const { data: vendor, error: fetchError } = await adminClient
      .from("vendors")
      .select("status, user_id")
      .eq("id", req.params.id)
      .single();

    if (fetchError || !vendor) return res.status(404).json({ success: false, message: "Vendor not found." });
    if (vendor.status !== "suspended") {
      return res.status(400).json({ success: false, message: "Only a suspended vendor can be reactivated." });
    }

    const { error } = await adminClient
      .from("vendors")
      .update({ status: "approved", suspension_reason: null, suspended_by: null, suspended_at: null })
      .eq("id", req.params.id);

    if (error) throw error;

    await adminClient.from("notifications").insert({
      id: require("uuid").v4(),
      user_id: vendor.user_id,
      title: "Vendor Account Reactivated",
      body: "Your vendor account has been reactivated. You're back online on Fidelx.",
      is_read: false,
    });

    await adminClient.from("audit_logs").insert({
      id: require("uuid").v4(),
      action: "VENDOR_REACTIVATED",
      actor_id: req.user.id,
      target_id: req.params.id,
      target_type: "vendor",
    });

    res.json({ success: true, message: "Vendor reactivated." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/admin/riders
const getAllRiders = async (req, res) => {
  try {
    const { status } = req.query;
    let query = adminClient.from("riders").select("*, users!user_id(full_name, email, phone)").order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, riders: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/admin/riders/:id/approve
// By default this now REQUIRES the rider's NIN to have already passed
// Prembly verification (nin_verified = true) — approving an unverified
// rider is a real safety gap, not a formality.
//
// For edge cases (Prembly is down, a legitimate NIN mismatch due to a
// name change, etc.), an admin can force approval by sending
// { "override": true, "override_reason": "..." } in the request body.
// The override reason is stored for audit purposes.
const approveRider = async (req, res) => {
  try {
    const { override, override_reason } = req.body || {};

    const { data: rider, error: fetchError } = await adminClient
      .from("riders")
      .select("id, user_id, nin_verified, nin_verification_status")
      .eq("id", req.params.id)
      .single();

    if (fetchError || !rider) {
      return res.status(404).json({ success: false, message: "Rider not found." });
    }

    if (!rider.nin_verified && !override) {
      return res.status(400).json({
        success: false,
        message:
          "This rider's NIN has not passed verification " +
          `(status: ${rider.nin_verification_status || "not_submitted"}). ` +
          "Resend with { override: true, override_reason: \"...\" } to approve anyway.",
      });
    }

    const updatePayload = { status: "approved" };
    if (override) {
      updatePayload.nin_verification_status = "manual_override";
      updatePayload.nin_verification_message = override_reason || "Manually approved by admin without passing NIN verification.";
    }

    const { data, error } = await adminClient
      .from("riders")
      .update(updatePayload)
      .eq("id", req.params.id)
      .select("user_id")
      .single();

    if (error) throw error;

    if (override) {
      await adminClient.from("rider_verification_logs").insert({
        id: require("uuid").v4(),
        rider_id: rider.id,
        verified: false,
        name_match: null,
        provider_reference: null,
        error_message: `MANUAL OVERRIDE by admin (user ${req.user.id}): ${override_reason || "no reason given"}`,
        raw_response: null,
      });
    }

    await adminClient.from("notifications").insert({
      id: require("uuid").v4(),
      user_id: data.user_id,
      title: "Rider Account Approved",
      body: "Your rider account is verified. You can now start accepting orders.",
      is_read: false,
    });

    res.json({ success: true, message: "Rider approved." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/admin/riders/:id/strike
// @route PUT /api/admin/riders/:id/reject
const rejectRider = async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: "Rejection reason is required." });

    const { data, error } = await adminClient
      .from("riders")
      .update({ status: "rejected", rejection_reason: reason, reviewed_by: req.user.id, reviewed_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .select("user_id")
      .single();

    if (error) throw error;

    await adminClient.from("notifications").insert({
      id: require("uuid").v4(),
      user_id: data.user_id,
      title: "Rider Application Rejected",
      body: `Your rider application was not approved: ${reason}. You may reapply.`,
      is_read: false,
    });

    res.json({ success: true, message: "Rider rejected." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const strikeRider = async (req, res) => {
  try {
    const { data: rider } = await adminClient
      .from("riders")
      .select("strike_count, user_id")
      .eq("id", req.params.id)
      .single();

    const newCount = rider.strike_count + 1;
    const updates = { strike_count: newCount };
    if (newCount >= 3) updates.status = "suspended";

    await adminClient.from("riders").update(updates).eq("id", req.params.id);

    if (newCount >= 3) {
      await adminClient.from("notifications").insert({
        id: require("uuid").v4(),
        user_id: rider.user_id,
        title: "Account Suspended",
        body: "Your rider account has been suspended due to 3 strikes. Contact support.",
        is_read: false,
      });
    }

    res.json({ success: true, message: `Strike issued. Total: ${newCount}`, suspended: newCount >= 3 });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/admin/orders
const getAllOrders = async (req, res) => {
  try {
    const { status } = req.query;
    let query = adminClient
      .from("orders")
      .select("*, users(full_name)")
      .order("created_at", { ascending: false })
      .limit(100);
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, orders: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/admin/disputes
const getAllDisputes = async (req, res) => {
  try {
    const { data, error } = await adminClient
      .from("disputes")
      .select("*, orders(id, subtotal, platform_fee, delivery_fee, discount_amount, total, payment_status, paystack_reference, paystack_fee, created_at), users(full_name)")
      .order("created_at", { ascending: false });
    if (error) throw error;
    const disputes = await Promise.all((data || []).map(async (dispute) => {
      const { data: subOrders, error: subOrderError } = await adminClient
        .from("sub_orders")
        .select("id, subtotal, platform_fee, delivery_fee, delivery_margin, vendor_payout, rider_payout, vendor_id, rider_id, status")
        .eq("order_id", dispute.order_id);
      if (subOrderError) throw subOrderError;

      const { data: payments, error: paymentError } = await adminClient
        .from("payments")
        .select("id, amount, status, total_refunded, paystack_reference, paystack_fee, created_at, processing_completed_at")
        .eq("order_id", dispute.order_id)
        .order("created_at", { ascending: false })
        .limit(1);
      if (paymentError) throw paymentError;

      const order = dispute.orders || null;
      const payment = payments?.[0] || null;
      const subOrderTotal = (subOrders || []).reduce((sum, so) =>
        sum + Number(so.subtotal || 0) + Number(so.platform_fee || 0) + Number(so.delivery_fee || 0), 0
      );

      return {
        ...dispute,
        // Explicit financial snapshot for the admin dispute UI. The
        // dispute itself is not the source of truth for order value.
        order_financials: order ? {
          subtotal: Number(order.subtotal || 0),
          platform_fee: Number(order.platform_fee || 0),
          delivery_fee: Number(order.delivery_fee || 0),
          discount_amount: Number(order.discount_amount || 0),
          total: Number(order.total || 0),
          payment_status: order.payment_status,
          paystack_reference: order.paystack_reference,
          paystack_fee: Number(order.paystack_fee || 0),
        } : null,
        payment: payment ? {
          id: payment.id,
          amount: Number(payment.amount || 0),
          status: payment.status,
          total_refunded: Number(payment.total_refunded || 0),
          paystack_reference: payment.paystack_reference,
          paystack_fee: Number(payment.paystack_fee || 0),
          processing_completed_at: payment.processing_completed_at,
        } : null,
        // Useful when an order has multiple sub-orders and the admin must
        // choose which economic slice is being refunded.
        sub_order_total: subOrderTotal,
        sub_orders: subOrders || [],
        evidence_urls: await getDisputeEvidenceUrls(dispute.evidence_urls || []),
        additional_evidence: await getDisputeEvidenceUrls(dispute.additional_evidence || []),
      };
    }));
    res.json({ success: true, disputes });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/admin/disputes/:id/resolve
const resolveDispute = async (req, res) => {
  try {
    const {
      decision,
      resolution_note,
      sub_order_id,
      fault_party,
      refund_type = "full",
      partial_amount,
    } = req.body;

    if (!["approved", "rejected"].includes(decision)) {
      return res.status(400).json({ success: false, message: "Invalid dispute decision." });
    }

    const { data: dispute, error: disputeError } = await adminClient
      .from("disputes")
      .select("id, order_id, customer_id, status, reason, evidence_urls")
      .eq("id", req.params.id)
      .single();

    if (disputeError || !dispute) {
      return res.status(404).json({ success: false, message: "Dispute not found." });
    }
    // ATOMIC CLAIM — closes the race where two admins (or one admin's
    // accidental double-click) resolve the same dispute at nearly the
    // same time. The old check above (dispute.status !== "open" && ...)
    // is a plain read and stays as a fast, friendly pre-check for the
    // common case, but claim_dispute_for_resolution's conditional
    // UPDATE is the actual guard: only the caller whose UPDATE matches
    // a still-open/appealed row can proceed to executeRefund at all.
    const { data: claimed, error: claimErr } = await adminClient.rpc("claim_dispute_for_resolution", {
      p_dispute_id: dispute.id,
    });
    if (claimErr) throw claimErr;
    if (!claimed) {
      return res.status(400).json({ success: false, message: "This dispute is already being resolved or has already been resolved." });
    }

    let refundResult = null;

    // An approved dispute now means a real Paystack refund is initiated as
    // part of the same admin action. We do not mark the dispute resolved
    // before Paystack accepts the refund request.
    if (decision === "approved") {
      if (!fault_party) return res.status(400).json({ success: false, message: "Select who is responsible for the refund." });

      try {
        refundResult = await executeRefund({
          order_id: dispute.order_id,
          sub_order_id,
          customer_id: dispute.customer_id,
          fault_party,
          refund_type,
          partial_amount,
          reason: resolution_note?.trim() || dispute.reason,
          evidence_urls: dispute.evidence_urls || [],
          admin_reviewer_id: req.user.id,
          refund_stage: "post_delivery",
          // A dispute can only be claimed for resolution once (the
          // claim above is itself one-shot), so this key can never
          // collide across two different real resolutions — but it
          // does mean a retried call after a transient network error
          // on the admin's end returns the same refund instead of
          // attempting a second one.
          idempotency_key: `dispute:${dispute.id}`,
        });
      } catch (refundError) {
        // The claim already moved the dispute to "processing" — if the
        // refund itself failed, put it back to "open" (not "resolved")
        // so it's clearly still awaiting action rather than silently
        // stuck in an intermediate state no one is looking at.
        await adminClient.from("disputes").update({ status: "open" }).eq("id", dispute.id);
        return res.status(502).json({
          success: false,
          message: refundError.message,
          refund_started: false,
        });
      }
    }

    const { error: updateError } = await adminClient.from("disputes").update({
      status: "resolved",
      decision,
      resolution_note,
      resolved_at: new Date().toISOString(),
    }).eq("id", req.params.id);

    if (updateError) throw updateError;

    await adminClient.from("notifications").insert({
      id: require("uuid").v4(),
      user_id: dispute.customer_id,
      title: decision === "approved" ? "Refund Initiated 💰" : "Dispute Resolved",
      body: decision === "approved"
        ? `Your refund of ₦${Number(refundResult.refund.amount).toLocaleString()} has been initiated and is currently ${refundResult.refund.status}.`
        : "Your dispute was reviewed and rejected. No refund will be issued.",
      is_read: false,
    });

    res.json({
      success: true,
      refund_id: refundResult?.refund.id || null,
      refund_status: refundResult?.refund.status || null,
      message: decision === "approved"
        ? `Dispute approved and refund initiated. Paystack status: ${refundResult.refund.status}.`
        : "Dispute rejected.",
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/admin/notifications/broadcast
// Sends a real notification to every user in a category — "real" in
// the same sense as everywhere else in this app: inserting into
// notifications is enough, since trg_push_on_notification (see
// push_notifications_migration.sql) automatically fires a real push
// for anyone with an active subscription. No separate push-vs-in-app
// decision needed here, this already does both.
const broadcastNotification = async (req, res) => {
  try {
    const { title, body, category } = req.body;
    const validCategories = ["customer", "vendor", "rider", "all"];

    if (!title?.trim() || !body?.trim()) {
      return res.status(400).json({ success: false, message: "Title and message are both required." });
    }
    if (!validCategories.includes(category)) {
      return res.status(400).json({ success: false, message: "category must be one of: customer, vendor, rider, all." });
    }

    let query = adminClient.from("users").select("id").eq("is_active", true);
    if (category !== "all") query = query.eq("role", category);

    const { data: recipients, error } = await query;
    if (error) throw error;
    if (!recipients?.length) {
      return res.json({ success: true, message: "No matching users to notify.", sent: 0 });
    }

    // One insert call, not a loop of hundreds — the push trigger still
    // fires once per row regardless of whether they arrive as a batch
    // or individually, so this is just the efficient way to do it.
    const rows = recipients.map((u) => ({
      id: require("uuid").v4(),
      user_id: u.id,
      title: title.trim(),
      body: body.trim(),
    }));

    const { error: insertError } = await adminClient.from("notifications").insert(rows);
    if (insertError) throw insertError;

    await adminClient.from("audit_logs").insert({
      id: require("uuid").v4(),
      action: "ADMIN_BROADCAST_SENT",
      actor_id: req.user.id,
      target_type: "broadcast",
      details: { category, title, recipient_count: rows.length },
    });

    res.json({ success: true, message: `Sent to ${rows.length} ${category === "all" ? "user" : category}${rows.length !== 1 ? "s" : ""}.`, sent: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/admin/notices
// Creates an urgent popup notice — distinct from broadcastNotification
// above, which lands quietly in the inbox. This interrupts with an
// actual popup the moment someone opens the app (see the frontend
// UrgentNoticePopup component), and can optionally carry an image
// uploaded separately via POST /api/uploads/notice-image first.
const createNotice = async (req, res) => {
  try {
    const { title, body, category, image_url } = req.body;
    const validCategories = ["customer", "vendor", "rider", "all"];

    if (!title?.trim() || !body?.trim()) {
      return res.status(400).json({ success: false, message: "Title and message are both required." });
    }
    if (!validCategories.includes(category)) {
      return res.status(400).json({ success: false, message: "category must be one of: customer, vendor, rider, all." });
    }

    const { data, error } = await adminClient
      .from("urgent_notices")
      .insert({
        title: title.trim(),
        body: body.trim(),
        image_url: image_url || null,
        category,
        created_by: req.user.id,
      })
      .select()
      .single();

    if (error) throw error;

    await adminClient.from("audit_logs").insert({
      id: require("uuid").v4(),
      action: "URGENT_NOTICE_CREATED",
      actor_id: req.user.id,
      target_id: data.id,
      target_type: "urgent_notice",
      details: { category, title },
    });

    res.json({ success: true, notice: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/admin/notices
// Full history, active and deactivated — for admin's own reference,
// not what's shown to end users (see getActiveNotices for that).
const getAllNotices = async (req, res) => {
  try {
    const { data, error } = await adminClient
      .from("urgent_notices")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ success: true, notices: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/admin/notices/:id/deactivate
// Turns a notice off early — e.g. it was posted with a mistake, or
// the situation it announced has already been resolved. Doesn't
// delete it; it stays in getAllNotices' history, just stops being
// served by getActiveNotices to anyone who hasn't already seen it.
const deactivateNotice = async (req, res) => {
  try {
    const { error } = await adminClient
      .from("urgent_notices")
      .update({ is_active: false })
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ success: true, message: "Notice deactivated." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/admin/analytics
const getAnalytics = async (req, res) => {
  try {
    const [vendors, riders, orders, payments] = await Promise.all([
      adminClient.from("vendors").select("id, status", { count: "exact" }),
      adminClient.from("riders").select("id, status", { count: "exact" }),
      adminClient.from("orders").select("id, status, total, created_at", { count: "exact" }),
      adminClient.from("payments").select("amount, status"),
    ]);

    const totalRevenue = payments.data
      ?.filter((p) => p.status === "successful")
      .reduce((sum, p) => sum + p.amount, 0) || 0;

    res.json({
      success: true,
      analytics: {
        total_vendors: vendors.count,
        approved_vendors: vendors.data?.filter((v) => v.status === "approved").length,
        total_riders: riders.count,
        approved_riders: riders.data?.filter((r) => r.status === "approved").length,
        total_orders: orders.count,
        delivered_orders: orders.data?.filter((o) => o.status === "DELIVERED").length,
        total_revenue: totalRevenue,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/admin/support-tickets
const getSupportTickets = async (req, res) => {
  try {
    const { data, error } = await adminClient
      .from("support_tickets")
      .select("*, users!user_id(full_name, email, role)")
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ success: true, tickets: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/admin/support-tickets/:id/reply
const replyToSupportTicket = async (req, res) => {
  try {
    const { message } = req.body;

    const { data: ticket } = await adminClient
      .from("support_tickets")
      .select("id, messages, user_id")
      .eq("id", req.params.id)
      .single();

    if (!ticket) {
      return res.status(404).json({ success: false, message: "Ticket not found." });
    }

    const messages = ticket.messages || [];
    messages.push({
      sender: "admin",
      sender_id: req.user.id,
      message,
      sent_at: new Date().toISOString(),
    });

    await adminClient.from("support_tickets").update({ messages, status: "IN_PROGRESS" }).eq("id", req.params.id);

    await adminClient.from("notifications").insert({
      id: require("uuid").v4(),
      user_id: ticket.user_id,
      title: "Support Reply",
      body: "Fidelx support has replied to your ticket.",
      is_read: false,
    });

    res.json({ success: true, message: "Reply sent." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/admin/reconcile-balances
// Surfaces reconcile_balances() (backend/supabase/atomic_functions.sql) —
// this SQL function already existed but was never wired to any route, so
// there was no way to actually run it. See the fix note on that function
// for what it can and can't catch reliably.
const reconcileBalances = async (req, res) => {
  try {
    const { data, error } = await adminClient.rpc("reconcile_balances");
    if (error) throw error;
    res.json({ success: true, mismatches: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/admin/reconcile-payments
// Manual trigger for the same job pg_cron runs on a schedule (see
// reconciliation_job_migration.sql) — lets an admin force a check
// immediately instead of waiting for the next scheduled run, and gives
// a visible result rather than only ever running invisibly in the
// background.
const reconcilePayments = async (req, res) => {
  try {
    const result = await reconcileStalePayments();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/admin/cancellation-refunds
// Lists sub-orders that were cancelled after payment where the
// automatic refund (initiatePreDeliveryCancellationRefund, fired from
// cancelSubOrder / updateSubOrderStatus) either was never triggered
// successfully or failed outright — the exact gap that previously had
// no admin-facing path at all, only a notification with nowhere to act
// on it. "Stuck" here means: the sub-order is CANCELLED, its parent
// order was actually paid for, and there is no refund row for it that
// is processing or already processed.
const getStuckCancellationRefunds = async (req, res) => {
  try {
    const { data: cancelledSubOrders, error } = await adminClient
      .from("sub_orders")
      .select("id, order_id, vendor_id, subtotal, platform_fee, delivery_fee, cancelled_at, orders!inner(payment_status, customer_id), vendors(business_name)")
      .eq("status", "CANCELLED")
      .eq("orders.payment_status", "successful")
      .order("cancelled_at", { ascending: false });

    if (error) throw error;
    if (!cancelledSubOrders?.length) return res.json({ success: true, stuck: [] });

    const subOrderIds = cancelledSubOrders.map((s) => s.id);
    const { data: existingRefunds } = await adminClient
      .from("refunds")
      .select("sub_order_id, status")
      .in("sub_order_id", subOrderIds)
      .in("status", ["processing", "processed"]);

    const handledIds = new Set((existingRefunds || []).map((r) => r.sub_order_id));
    const stuck = cancelledSubOrders
      .filter((s) => !handledIds.has(s.id))
      .map((s) => ({
        sub_order_id: s.id,
        order_id: s.order_id,
        vendor_name: s.vendors?.business_name,
        refundable_amount: Number(s.subtotal || 0) + Number(s.platform_fee || 0) + Number(s.delivery_fee || 0),
        cancelled_at: s.cancelled_at,
      }));

    res.json({ success: true, stuck });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/admin/cancellation-refunds/:subOrderId/retry
const retryCancellationRefund = async (req, res) => {
  try {
    const { data: subOrder } = await adminClient
      .from("sub_orders")
      .select("id, status, order_id, vendor_id, subtotal, platform_fee, delivery_fee, vendor_payout, rider_payout, rider_id")
      .eq("id", req.params.subOrderId)
      .single();

    if (!subOrder) return res.status(404).json({ success: false, message: "Sub-order not found." });
    if (subOrder.status !== "CANCELLED") {
      return res.status(400).json({ success: false, message: "This sub-order is not cancelled." });
    }

    const result = await initiatePreDeliveryCancellationRefund({
      subOrder,
      initiatedByRole: "admin_retry",
      initiatedByUserId: req.user.id,
    });

    res.json({ success: true, message: "Refund re-initiated.", refund: result?.refund });
  } catch (err) {
    res.status(502).json({ success: false, message: err.message });
  }
};

module.exports = {
  getAllVendors, approveVendor, rejectVendor, suspendVendor, reactivateVendor,
  getAllRiders, approveRider, rejectRider, strikeRider,
  getAllOrders, getAllDisputes, resolveDispute,
  getAnalytics, getSupportTickets, replyToSupportTicket,
  reconcileBalances,
  reconcilePayments,
  getStuckCancellationRefunds,
  retryCancellationRefund,
  broadcastNotification,
  createNotice, getAllNotices, deactivateNotice,
};
