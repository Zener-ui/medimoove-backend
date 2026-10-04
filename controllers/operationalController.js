const { adminClient } = require("../config/db");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
const { notifyAdmins } = require("../utils/notifyAdmins");
const { refundToPromotionsBudget } = require("./promotionsController");

// ============================================================
// SECTION 5 — VENDOR AVAILABILITY
// ============================================================

// @route PUT /api/vendors/me/availability
const updateVendorAvailability = async (req, res) => {
  try {
    const { availability_status, unavailable_until, unavailable_reason } = req.body;

    const validStatuses = ["OPEN", "BUSY", "CLOSED", "TEMPORARILY_UNAVAILABLE"];
    if (!validStatuses.includes(availability_status)) {
      return res.status(400).json({ success: false, message: "Invalid availability status." });
    }

    const updates = { availability_status };
    if (unavailable_until) updates.unavailable_until = unavailable_until;
    if (unavailable_reason) updates.unavailable_reason = unavailable_reason;

    const { error } = await adminClient.from("vendors").update(updates).eq("user_id", req.user.id);
    if (error) throw error;

    res.json({ success: true, message: `Store status updated to ${availability_status}.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================
// SECTION 6 — NOTIFICATION PREFERENCES
// ============================================================

// @route GET /api/preferences/notifications
const getNotificationPreferences = async (req, res) => {
  try {
    const { data, error } = await adminClient
      .from("notification_preferences")
      .select("*")
      .eq("user_id", req.user.id)
      .single();

    if (error && error.code !== "PGRST116") throw error;

    // Return defaults if no preferences set yet
    if (!data) {
      return res.json({
        success: true,
        preferences: {
          email_order_updates: true,
          email_payment_updates: true,
          email_withdrawal_updates: true,
          email_dispute_updates: true,
          email_account_updates: true,
          email_marketing: false,
          push_order_updates: true,
          push_delivery_updates: true,
          push_payment_updates: true,
          push_marketing: false,
          in_app_all: true,
        },
      });
    }

    res.json({ success: true, preferences: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/preferences/notifications
const updateNotificationPreferences = async (req, res) => {
  try {
    const updates = req.body;
    const allowedFields = [
      "email_order_updates", "email_payment_updates", "email_withdrawal_updates",
      "email_dispute_updates", "email_account_updates", "email_marketing",
      "push_order_updates", "push_delivery_updates", "push_payment_updates",
      "push_marketing", "in_app_all",
    ];

    const filtered = Object.fromEntries(Object.entries(updates).filter(([k]) => allowedFields.includes(k)));
    filtered.updated_at = new Date().toISOString();

    const { data: existing } = await adminClient
      .from("notification_preferences")
      .select("id")
      .eq("user_id", req.user.id)
      .single();

    if (existing) {
      await adminClient.from("notification_preferences").update(filtered).eq("user_id", req.user.id);
    } else {
      await adminClient.from("notification_preferences").insert({ id: uuidv4(), user_id: req.user.id, ...filtered });
    }

    res.json({ success: true, message: "Notification preferences updated." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================
// SECTION 7 — REFUND RESPONSIBILITY MATRIX
// ============================================================

const REFUND_RULES = {
  vendor: {
    description: "Wrong item, damaged item, not as described",
    who_pays: "vendor",
    deducted_from: "vendor_balance",
    vendor_penalty: true,
    rider_penalty: false,
  },
  rider: {
    description: "Item damaged during delivery, theft",
    who_pays: "rider",
    deducted_from: "rider_balance",
    vendor_penalty: false,
    rider_penalty: true,
  },
  customer: {
    description: "Customer changed mind, false claim",
    who_pays: "customer",
    deducted_from: null,
    vendor_penalty: false,
    rider_penalty: false,
  },
  platform: {
    description: "Technical error, payment failure, system bug",
    who_pays: "platform",
    deducted_from: "platform_revenue",
    vendor_penalty: false,
    rider_penalty: false,
  },
};

// @route POST /api/refunds (admin only)
const getRefundPayment = async (orderId) => {
  const { data: payment, error } = await adminClient
    .from("payments")
    .select("id, amount, status, paystack_reference")
    .eq("order_id", orderId)
    .eq("status", "successful")
    .maybeSingle();

  if (error) throw error;
  if (!payment) throw new Error("No successful payment was found for this order.");
  if (!payment.paystack_reference) throw new Error("The successful payment has no Paystack reference.");
  return payment;
};

const findRefundSubOrder = async (orderId, subOrderId) => {
  if (subOrderId) {
    const { data, error } = await adminClient
      .from("sub_orders")
      .select("id, order_id, subtotal, platform_fee, delivery_fee, delivery_margin, vendor_payout, rider_payout, vendor_id, rider_id, status")
      .eq("id", subOrderId)
      .eq("order_id", orderId)
      .single();
    if (error || !data) throw new Error("The selected sub-order does not belong to this order.");
    return data;
  }

  const { data, error } = await adminClient
    .from("sub_orders")
    .select("id, order_id, subtotal, platform_fee, delivery_fee, delivery_margin, vendor_payout, rider_payout, vendor_id, rider_id, status")
    .eq("order_id", orderId);

  if (error) throw error;
  if (!data?.length) throw new Error("No sub-order was found for this order.");
  if (data.length > 1) {
    throw new Error("This order contains multiple sub-orders. Select the affected sub-order before issuing a refund.");
  }
  return data[0];
};

const executeRefund = async ({
  order_id,
  sub_order_id,
  customer_id,
  fault_party,
  refund_type = "full",
  partial_amount,
  reason,
  evidence_urls = [],
  admin_reviewer_id,
  refund_stage = "post_delivery", // "pre_delivery" (cancellation) or "post_delivery" (dispute)
  idempotency_key = null,
}) => {
  if (!REFUND_RULES[fault_party]) throw new Error("Invalid fault_party.");
  if (!reason?.trim()) throw new Error("A refund reason is required.");

  const payment = await getRefundPayment(order_id);
  const subOrder = await findRefundSubOrder(order_id, sub_order_id);

  const { data: order, error: orderError } = await adminClient
    .from("orders")
    .select("id, customer_id, total")
    .eq("id", order_id)
    .single();
  if (orderError || !order) throw new Error("Order not found.");
  if (customer_id && order.customer_id !== customer_id) throw new Error("Refund customer does not match the order.");

  // FIX for the audit's core finding: a Paystack transaction covers the
  // WHOLE multi-vendor order, but a sub-order's "full refund" only ever
  // means a full refund of THIS sub-order's own share — its subtotal,
  // its slice of the platform fee, and its slice of the delivery fee —
  // never the parent transaction as a whole. The old code used only
  // `subOrder.subtotal` here, which under-counted the true amount even
  // on a single-vendor order (it ignored platform_fee and delivery_fee
  // entirely), and separately omitted `amount` from the Paystack call
  // below for "full" refunds — which told Paystack to refund the
  // ENTIRE parent transaction regardless of which sub-order this was.
  // Both problems are fixed together here: this is the real per-
  // sub-order amount, and it's always what gets sent to Paystack,
  // explicitly, below.
  const subOrderFullAmount =
    Number(subOrder.subtotal || 0) + Number(subOrder.platform_fee || 0) + Number(subOrder.delivery_fee || 0);
  const requestedAmount = refund_type === "partial" ? Number(partial_amount) : subOrderFullAmount;
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
    throw new Error("Refund amount must be greater than zero.");
  }

  // Reserve the refund amount AND create the refund row in one database
  // transaction. This closes a subtle idempotency race: the old code
  // checked idempotency, claimed money, then inserted the refund as three
  // separate operations. Two concurrent requests with the same key could
  // both pass the check, both consume refund capacity, and only then have
  // one INSERT lose the unique-key race.
  const { data: reservation, error: reservationError } = await adminClient.rpc("create_refund_reservation", {
    p_payment_id: payment.id,
    p_order_id: order_id,
    p_sub_order_id: subOrder.id,
    p_customer_id: order.customer_id,
    p_requested_amount: requestedAmount,
    p_reason: reason.trim(),
    p_evidence_urls: Array.isArray(evidence_urls) ? evidence_urls : [],
    p_fault_party: fault_party,
    p_refund_type: refund_type,
    p_admin_reviewer_id: admin_reviewer_id || null,
    p_refund_stage: refund_stage,
    p_idempotency_key: idempotency_key || null,
  });
  if (reservationError) throw reservationError;
  if (!reservation?.refund_id) {
    throw new Error("Refund reservation failed.");
  }

  const refundId = reservation.refund_id;
  const amount = Number(reservation.amount);

  // If this idempotency key already belongs to a refund, never create a
  // second refund. A previously-created pending refund is returned to the
  // caller; Paystack handling below can continue using the same refund id.
  if (reservation.already_existed) {
    const { data: existingRefund, error: existingRefundError } = await adminClient
      .from("refunds").select("*").eq("id", refundId).single();
    if (existingRefundError || !existingRefund) throw existingRefundError || new Error("Existing refund record not found.");
    if (existingRefund.paystack_refund_id || ["processed", "processing", "needs_attention", "failed"].includes(existingRefund.status)) {
      return { refund: existingRefund, payment, subOrder, already_existed: true };
    }
  }

  const { data: refund, error: refundReadError } = await adminClient
    .from("refunds").select("*").eq("id", refundId).single();
  if (refundReadError || !refund) throw refundReadError || new Error("Refund record not found after reservation.");

  try {
    const paystackResponse = await axios.post(
      "https://api.paystack.co/refund",
      {
        transaction: payment.paystack_reference,
        // Always explicit now, for both "full" and "partial" — never
        // omitted. This is what stops a one-sub-order refund from ever
        // refunding the entire parent Paystack transaction.
        amount: Math.round(amount * 100),
        currency: "NGN",
        customer_note: `Fidelx refund for order ${order_id.slice(0, 8)}`,
        merchant_note: `Fidelx refund ${refundId.slice(0, 8)} — ${reason.trim()}`,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const paystackRefund = paystackResponse.data?.data;
    const paystackStatus = paystackRefund?.status || "pending";

    const { error: updateError } = await adminClient
      .from("refunds")
      .update({
        status: ["pending", "processing", "needs_attention"].includes(paystackStatus)
          ? paystackStatus
          : "pending",
        paystack_refund_id: paystackRefund?.id ? String(paystackRefund.id) : null,
        paystack_status: paystackStatus,
        paystack_transaction_reference: payment.paystack_reference,
      })
      .eq("id", refundId);

    if (updateError) throw updateError;

    await adminClient.from("notifications").insert({
      id: uuidv4(),
      user_id: order.customer_id,
      title: "Refund Initiated",
      body: `A refund of ₦${amount.toLocaleString()} has been initiated and sent to Paystack. It can take several business days to reflect on your original payment method.`,
      is_read: false,
    });

    return { refund: { ...refund, status: paystackStatus, paystack_refund_id: paystackRefund?.id }, payment, subOrder };
  } catch (err) {
    const paystackMessage = err.response?.data?.message || err.message;
    await adminClient.from("refunds").update({
      status: "failed",
      paystack_status: "failed",
      failure_reason: paystackMessage,
      failed_at: new Date().toISOString(),
    }).eq("id", refundId);
    // The refund never actually went through on Paystack's side —
    // give back the reserved amount so it doesn't count against the
    // payment's cap and block a legitimate future refund attempt.
    await adminClient.rpc("release_refund_claim", { p_payment_id: payment.id, p_amount: amount });
    throw new Error(`Paystack refund failed: ${paystackMessage}`);
  }
};

// ============================================================
// PRE-DELIVERY CANCELLATION REFUND
// Called from subOrderController when a sub-order that had already
// been paid for (payment_status === "successful") is cancelled — by
// either the customer or the vendor — before the vendor has started
// preparing it. This is deliberately NOT the same code path as a
// post-delivery dispute refund: at this stage nothing has been paid
// out to the vendor yet (vendor_payout only credits at DELIVERED), so
// there is no available_balance to claw back, only platform revenue
// that was already booked at payment-confirmation time and needs to be
// reversed since the sale it was earned on never actually happened.
// ============================================================
const initiatePreDeliveryCancellationRefund = async ({ subOrder, initiatedByRole, initiatedByUserId }) => {
  // fault_party here is recorded for reporting only ("who cancelled")
  // — no strike/penalty is applied for a pre-delivery cancellation
  // regardless of this value (see finalizeProcessedRefund). Inventing
  // a new penalty policy for cancellations wasn't part of what was
  // asked; only making the refund actually happen was.
  const faultParty = initiatedByRole === "vendor" ? "vendor" : "customer";

  return executeRefund({
    order_id: subOrder.order_id,
    sub_order_id: subOrder.id,
    fault_party: faultParty,
    refund_type: "full",
    reason: `Order cancelled by ${initiatedByRole} before vendor preparation.`,
    admin_reviewer_id: initiatedByUserId,
    refund_stage: "pre_delivery",
    // A given sub-order can only ever be cancelled once (CANCELLED is
    // a terminal state in the order state machine) — this key makes
    // that fact the idempotency boundary, so even if this function
    // were somehow invoked twice for the same cancellation, only one
    // refund is ever created or sent to Paystack.
    idempotency_key: `cancel:${subOrder.id}`,
  });
};

// Apply the accounting side only after Paystack confirms the refund was
// actually processed. This prevents a queued/failed refund from reducing
// a vendor/rider balance prematurely.
const finalizeProcessedRefund = async (refundId) => {
  // Paystack has confirmed the customer refund. Financial accounting is
  // performed by ONE database transaction so we never get the old
  // "claim succeeded, then server died before the debit" failure mode.
  const { data: result, error: financialError } = await adminClient.rpc("apply_refund_financials", {
    p_refund_id: refundId,
  });
  if (financialError) throw financialError;
  if (!result) throw new Error("Refund financial finalization returned no result.");

  const { data: refund, error } = await adminClient
    .from("refunds")
    .select("id, order_id, sub_order_id, payment_id, customer_id, amount, refund_type, refund_stage, fault_party, deducted_from, status, admin_reviewer_id, reason")
    .eq("id", refundId)
    .single();
  if (error || !refund) throw new Error("Refund record not found after financial finalization.");
  // Do not return early when the financial transaction was already finalized.
  // The previous attempt may have committed the money-side transaction and
  // then crashed before synchronizing order/payment state below. A retry must
  // still repair those non-financial state markers.

  // Keep order/payment state synchronized with the confirmed refund.
  if (refund.refund_stage === "post_delivery" && refund.refund_type === "full" && refund.sub_order_id) {
    await adminClient.from("sub_orders").update({ status: "REFUNDED" }).eq("id", refund.sub_order_id);
  }
  if (refund.payment_id) {
    const { data: payment } = await adminClient.from("payments").select("amount,total_refunded").eq("id", refund.payment_id).single();
    if (payment && Number(payment.total_refunded) >= Number(payment.amount) - 0.000001) {
      await adminClient.from("payments").update({ status: "refunded" }).eq("id", refund.payment_id);
    }
  }

  // A full pre-delivery cancellation means this order never became a
  // real sale — same principle as the EXPIRED/FAILED_BUT_CHARGED cases
  // in reconciliationController.js, just reached via a different path
  // (customer/vendor cancelling before prep, instead of payment never
  // completing). Undo whatever coupon effects were applied at
  // order-creation time. Both calls are already safe no-ops if this
  // order never had a coupon, or if it's already been reversed.
  //
  // Deliberately scoped to pre_delivery + full only — a post_delivery
  // dispute/partial refund means the sale genuinely happened, so the
  // coupon already did its job and shouldn't be undone. Currently the
  // platform only allows one vendor per order (see
  // subOrderController.createOrderWithSubOrders), so a single
  // sub-order's cancellation is always the whole order's cancellation
  // — this stays correct without changes if multi-vendor orders are
  // ever enabled, since it keys off the order, not assumptions about
  // sub-order count.
  if (refund.refund_stage === "pre_delivery" && refund.refund_type === "full") {
    try {
      await refundToPromotionsBudget({ reference: refund.order_id, type: "COUPON_DISCOUNT" });
      await adminClient.rpc("reverse_coupon_redemption", { p_order_id: refund.order_id });
    } catch (err) {
      console.error(`[refund] Failed to reverse coupon effects for cancelled order ${refund.order_id}:`, err.message);
    }
  }

  // Strikes/suspension are deliberately separate from money movement.
  if (refund.refund_stage === "post_delivery" && (refund.fault_party === "vendor" || refund.fault_party === "rider")) {
    if (refund.fault_party === "vendor") {
      const { data: subOrder } = await adminClient.from("sub_orders").select("vendor_id").eq("id", refund.sub_order_id).single();
      if (subOrder?.vendor_id) {
        const { data: vendorRow } = await adminClient.from("vendors").select("strike_count").eq("id", subOrder.vendor_id).single();
        await adminClient.from("vendors").update({ strike_count: (vendorRow?.strike_count || 0) + 1 }).eq("id", subOrder.vendor_id);
      }
    } else {
      const { data: subOrder } = await adminClient.from("sub_orders").select("rider_id").eq("id", refund.sub_order_id).single();
      if (subOrder?.rider_id) {
        const { data: rider } = await adminClient.from("riders").select("strike_count").eq("id", subOrder.rider_id).single();
        const newCount = (rider?.strike_count || 0) + 1;
        await adminClient.from("riders").update({ strike_count: newCount, ...(newCount >= 3 ? { status: "suspended" } : {}) }).eq("id", subOrder.rider_id);
      }
    }
  }

  // Customer-facing and responsibility notifications are outside the money
  // transaction. The financial RPC is the source of truth and is idempotent,
  // so duplicate webhook deliveries cannot duplicate these notifications.
  await adminClient.from("notifications").insert({
    id: uuidv4(),
    user_id: refund.customer_id,
    title: "Refund Completed",
    body: `Your refund of ₦${Number(refund.amount).toLocaleString()} has been processed through Paystack.`,
    is_read: false,
  });

  const responsibleType = result.responsible_type;
  const responsibleUserId = result.responsible_user_id;
  const recoveredNow = Number(result.recovered_now || 0);
  const outstanding = Number(result.outstanding || 0);
  const refundAmount = Number(refund.amount || 0);

  // Tell the party whose balance/liability bears the refund cost.
  // Vendor/rider gross earnings remain historical totals; this notification
  // explains the reduction in withdrawable funds without rewriting that total.
  if ((responsibleType === "vendor" || responsibleType === "rider") && responsibleUserId) {
    const partyLabel = responsibleType === "vendor" ? "vendor" : "rider";
    const title = recoveredNow > 0
      ? "Refund Recovery — Funds Deducted"
      : "Refund Responsibility — Recovery Pending";
    const body = recoveredNow > 0
      ? `A ₦${refundAmount.toLocaleString()} customer refund was assigned to you because you were found responsible for the issue (${refund.reason}). ₦${recoveredNow.toLocaleString()} has been recovered from your available ${partyLabel} earnings. Remaining refund liability: ₦${Math.max(outstanding, 0).toLocaleString()}.`
      : `A ₦${refundAmount.toLocaleString()} customer refund was assigned to you because you were found responsible for the issue (${refund.reason}). Your current available balance was insufficient, so the outstanding ₦${Math.max(outstanding, 0).toLocaleString()} refund liability will be recovered from future earnings.`;

    await adminClient.from("notifications").insert({
      id: uuidv4(),
      user_id: responsibleUserId,
      title,
      body,
      is_read: false,
    });
  }

  // Platform-funded refunds are a Fidelx loss, so notify every real admin
  // rather than writing a fake user_id such as "admin".
  if (!responsibleType) {
    await notifyAdmins(
      "Platform Refund Cost",
      `A ₦${refundAmount.toLocaleString()} customer refund was finalized as a Fidelx/platform responsibility. This amount is a platform cash expense for refund ${refund.id}. Reason: ${refund.reason}`
    );
  }

  return refund;
};

// @route POST /api/refunds (admin only)
const processRefund = async (req, res) => {
  try {
    const result = await executeRefund({
      ...req.body,
      admin_reviewer_id: req.user.id,
    });

    res.json({
      success: true,
      message: `Refund initiated for ₦${Number(result.refund.amount).toLocaleString()}. Paystack status: ${result.refund.status}.`,
      refund_id: result.refund.id,
      refund_status: result.refund.status,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/refunds/rules (public reference)
const getRefundRules = async (req, res) => {
  res.json({ success: true, rules: REFUND_RULES });
};

module.exports = {
  updateVendorAvailability,
  getNotificationPreferences,
  updateNotificationPreferences,
  processRefund,
  executeRefund,
  finalizeProcessedRefund,
  initiatePreDeliveryCancellationRefund,
  getRefundRules,
};
