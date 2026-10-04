const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const { adminClient } = require("../config/db");
const { processSuccessfulPayment, applyPaymentSideEffects, completeVendorRiderWithdrawal, failVendorRiderWithdrawal, validatePaystackOrderAmount } = require("./paymentController");
const { releaseInventory } = require("./subOrderController");
const { finalizeProcessedRefund, initiatePreDeliveryCancellationRefund } = require("./operationalController");
const { refundToPromotionsBudget } = require("./promotionsController");
const { notifyAdmins } = require("../utils/notifyAdmins");

// Shared by both real order-void paths below (expired-unpaid, and
// paid-too-late-then-refunded) — undoes every coupon side-effect that
// was applied at order-creation time, now that the order has turned
// out to never be a real sale. Deliberately quiet on failure: this
// runs inside a background reconciliation loop, and a coupon-reversal
// hiccup shouldn't stop the rest of that loop (inventory release,
// order status, etc.) from completing for this or other orders.
const reverseCouponEffectsForVoidedOrder = async (order) => {
  if (!order.coupon_id) return;
  try {
    await refundToPromotionsBudget({ reference: order.id, type: "COUPON_DISCOUNT" });
    await adminClient.rpc("reverse_coupon_redemption", { p_order_id: order.id });
  } catch (err) {
    console.error(`[reconciliation] Failed to reverse coupon effects for voided order ${order.id}:`, err.message);
  }
};

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const paystackHeaders = { Authorization: `Bearer ${PAYSTACK_SECRET}`, "Content-Type": "application/json" };

// Don't bother re-verifying against Paystack for very fresh orders —
// avoids unnecessary API calls and avoids catching a customer literally
// mid-payment.
const MIN_CHECK_AGE_MINUTES = 10;

// Hard cutoff for two different decisions: below this age, a lone
// success is safe to process normally (recovers a genuinely dropped
// webhook). At or above it, the order is considered too old to safely
// send to a vendor even if a payment did succeed — food/stock may no
// longer be available — so it's refunded instead of fulfilled.
const ABANDONMENT_TTL_MINUTES = 60;

// Paystack doesn't publish an exact rate limit anywhere I could confirm
// (checked before building this), so this throttle is deliberately
// conservative rather than tuned to a specific number: every Paystack
// call in this job runs strictly sequentially with a fixed delay
// between them, never in parallel/Promise.all. A slower background job
// is a fine tradeoff for not risking a 429 burst against a live
// integration.
const PAYSTACK_CALL_DELAY_MS = 350;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Recover cancellation side effects that may have been interrupted after the
// sub-order status was atomically changed to CANCELLED. Inventory release and
// Paystack refund initiation are deliberately retryable/idempotent, so a crash
// between those steps cannot leave a cancelled paid order permanently stuck.
const recoverCancelledSubOrders = async () => {
  const { data: cancelled, error } = await adminClient
    .from("sub_orders")
    .select("id, order_id, status, vendor_id, rider_id, vendor_payout, rider_payout, delivery_type")
    .eq("status", "CANCELLED")
    .order("cancelled_at", { ascending: true })
    .limit(200);

  if (error) throw error;
  if (!cancelled?.length) return;

  for (const subOrder of cancelled) {
    try {
      // Safe to call repeatedly: each reservation is claimed atomically and
      // already-released reservations simply return false.
      await releaseInventory(subOrder.order_id, subOrder.id);

      const { data: parentOrder, error: orderError } = await adminClient
        .from("orders")
        .select("customer_id, payment_status")
        .eq("id", subOrder.order_id)
        .single();

      if (orderError || !parentOrder) continue;

      if (parentOrder.payment_status === "successful") {
        await initiatePreDeliveryCancellationRefund({
          subOrder,
          initiatedByRole: "system",
          initiatedByUserId: null,
        });
      }
    } catch (err) {
      // One broken cancellation must not prevent recovery of the rest. The
      // same sub-order will be retried on the next reconciliation run.
      console.error(`[reconciliation] Failed to recover cancelled sub-order ${subOrder.id}:`, err.message);
    }
  }
};

// A refund here has no vendor/rider fault — nobody was ever paid out
// for this order (it never even reached PAYMENT_CONFIRMED), so this
// mirrors operationalController's existing "platform fault" refund
// path (REFUND_RULES.platform: "Technical error, payment failure,
// system bug" — this is exactly that). Reuses the same refunds-table
// shape and the same webhook-driven finalization
// (paymentController.paystackWebhook already listens for
// refund.processed/refund.failed and calls finalizeProcessedRefund) —
// this does NOT mark the refund "processed" itself; Paystack's own
// webhook does that asynchronously, same as every other refund in
// this codebase.
const issueAutomaticRefund = async (order, payment) => {
  const idempotencyKey = `reconcile-abandoned-${payment.id}`;
  const amount = Number(payment.amount);

  // Reconciliation can revisit the same abandoned order. If a refund row
  // already exists, never start a second Paystack refund: the existing row
  // is the idempotency boundary for this automatic refund. This is especially
  // important after a process crash immediately after Paystack accepted the
  // refund but before our database update below.
  const { data: existingRefund, error: existingRefundError } = await adminClient
    .from("refunds")
    .select("*")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (existingRefundError) throw existingRefundError;
  if (existingRefund) {
    return { refund: existingRefund, already_existed: true };
  }

  const refundId = uuidv4();

  const { data: claimedAmount, error: claimError } = await adminClient.rpc("claim_refund_amount", {
    p_payment_id: payment.id,
    p_requested_amount: amount,
  });
  if (claimError || Number(claimedAmount || 0) < amount) {
    console.error(`[reconciliation] Could not reserve refund amount for order ${order.id}:`, claimError?.message || "refund cap already consumed");
    await notifyAdmins("Charged order needs manual refund", `Order ${order.id} was charged after its abandonment window, but its refund amount could not be reserved safely.`);
    return;
  }

  const { error: insertError } = await adminClient.from("refunds").insert({
    id: refundId,
    order_id: order.id,
    sub_order_id: null,
    payment_id: payment.id,
    customer_id: order.customer_id,
    amount,
    reason: "Payment succeeded after this order's abandonment window — order could not be safely fulfilled and was refunded automatically.",
    evidence_urls: [],
    fault_party: "platform",
    refund_type: "full",
    deducted_from: "platform_revenue",
    admin_reviewer_id: null,
    status: "pending",
    refund_stage: "pre_delivery",
    idempotency_key: idempotencyKey,
  });
  if (insertError) {
    await adminClient.rpc("release_refund_claim", { p_payment_id: payment.id, p_amount: amount });
    console.error(`[reconciliation] Failed to create refund record for order ${order.id}:`, insertError.message);
    await notifyAdmins(
      "Charged order needs manual refund",
      `Order ${order.id} was charged (ref ${payment.paystack_reference}) after its abandonment window, but creating the automatic refund record failed. Needs manual handling.`
    );
    return;
  }

  let paystackResponse;
  try {
    paystackResponse = await axios.post(
      "https://api.paystack.co/refund",
      {
        transaction: payment.paystack_reference,
        amount: Math.round(amount * 100),
        currency: "NGN",
        customer_note: `Fidelx refund for order ${order.id.slice(0, 8)}`,
        merchant_note: `Automatic reconciliation refund ${refundId.slice(0, 8)} — order too old to fulfill after a late-arriving payment success.`,
      },
      { headers: paystackHeaders }
    );
  } catch (err) {
    // The Paystack call itself failed, so no external refund was accepted by
    // this request. Release the reserved amount so a later/manual refund is
    // not blocked by a failed attempt.
    await adminClient.from("refunds").update({
      status: "failed",
      paystack_status: "failed",
      failure_reason: err.response?.data?.message || err.message,
      failed_at: new Date().toISOString(),
    }).eq("id", refundId).eq("status", "pending");
    await adminClient.rpc("release_refund_claim", { p_payment_id: payment.id, p_amount: amount });

    console.error(`[reconciliation] Paystack refund call failed for order ${order.id}:`, err.response?.data || err.message);
    await notifyAdmins(
      "Charged order — automatic refund FAILED",
      `Order ${order.id} was charged after its abandonment window, and the automatic Paystack refund attempt failed. This needs manual review and a manual refund.`
    );
    return;
  }

  // From this point onward Paystack has accepted the refund request. A local
  // database failure must NOT be treated as a Paystack failure, because doing
  // so would release the refund claim and could cause a second refund attempt.
  const paystackRefund = paystackResponse.data?.data;
  const paystackStatus = paystackRefund?.status || "pending";
  const { error: refundUpdateError } = await adminClient
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
  if (refundUpdateError) {
    console.error(`[reconciliation] Paystack accepted automatic refund ${refundId}, but saving its result failed:`, refundUpdateError.message);
    await notifyAdmins(
      "Automatic refund accepted — database sync failed",
      `Paystack accepted the automatic refund for order ${order.id}, but Fidelx could not save the Paystack refund ID. Do not issue another refund; reconciliation will attempt to recover it.`
    );
    return;
  }

  await notifyAdmins(
    "Charged order auto-refunded",
    `Order ${order.id} was charged after its abandonment window. A refund was automatically issued via Paystack — no action needed unless it fails.`
  );
};

// ============================================================
// STUCK REFUND RECONCILIATION
// Safety net for finalizeProcessedRefund's normal path (the
// paystackWebhook handler reacting to refund.processed) — covers the
// case where Paystack's webhook for a specific refund is dropped,
// delayed, or never successfully delivered. Without this, a refund
// Paystack actually completed could sit in "pending" in our own DB
// indefinitely, with the responsible vendor/rider's balance never
// debited.
// ============================================================
const reconcileStalePayments = async () => {
  const cutoff = new Date(Date.now() - MIN_CHECK_AGE_MINUTES * 60 * 1000).toISOString();

  const { data: staleOrders, error } = await adminClient
    .from("orders")
    .select("id, created_at, customer_id, coupon_id")
    .eq("status", "PENDING_PAYMENT")
    .lte("created_at", cutoff);

  if (error) throw error;
  if (!staleOrders?.length) return { checked: 0, resolved: 0 };

  let resolvedCount = 0;

  for (const order of staleOrders) {
    const ageMinutes = (Date.now() - new Date(order.created_at).getTime()) / 60000;

    const { data: paymentRows } = await adminClient
      .from("payments")
      .select("id, paystack_reference, status, amount")
      .eq("order_id", order.id);

    const successfulPayments = [];

    for (const payment of paymentRows || []) {
      if (payment.status === "successful") {
        successfulPayments.push(payment);
        continue;
      }
      if (payment.status === "failed") continue;

      await sleep(PAYSTACK_CALL_DELAY_MS);

      try {
        const response = await axios.get(
          `https://api.paystack.co/transaction/verify/${payment.paystack_reference}`,
          { headers: paystackHeaders }
        );
        const { status: paystackStatus, fees } = response.data.data;

        if (paystackStatus === "success") {
          await adminClient.from("payments").update({ status: "successful" }).eq("id", payment.id);
          successfulPayments.push({ ...payment, fees });
        } else if (paystackStatus === "failed" || paystackStatus === "abandoned") {
          await adminClient.from("payments").update({ status: "failed" }).eq("id", payment.id);
        }
      } catch (err) {
        console.error(`[reconciliation] Verify failed for ${payment.paystack_reference}:`, err.response?.data || err.message);
      }
    }

    if (successfulPayments.length === 0) {
      if (ageMinutes >= ABANDONMENT_TTL_MINUTES) {
        await adminClient.from("orders").update({ status: "EXPIRED" }).eq("id", order.id);
        await releaseInventory(order.id);
        await reverseCouponEffectsForVoidedOrder(order);
        resolvedCount++;
      }
      continue;
    }

    if (successfulPayments.length === 1) {
      const payment = successfulPayments[0];
      if (ageMinutes < ABANDONMENT_TTL_MINUTES) {
        await processSuccessfulPayment(order.id, payment.paystack_reference, null, payment.fees);
      } else {
        await adminClient.from("orders").update({ status: "FAILED_BUT_CHARGED" }).eq("id", order.id);
        await issueAutomaticRefund(order, payment);
        await reverseCouponEffectsForVoidedOrder(order);
      }
      resolvedCount++;
      continue;
    }

    await adminClient.from("audit_logs").insert({
      id: uuidv4(),
      action: "MULTIPLE_SUCCESSFUL_PAYMENTS_DETECTED",
      actor_id: null,
      target_id: order.id,
      target_type: "order",
      details: {
        references: successfulPayments.map((p) => p.paystack_reference),
        amounts: successfulPayments.map((p) => p.amount),
      },
    });
    await notifyAdmins(
      "URGENT: Customer charged multiple times for one order",
      `Order ${order.id} has ${successfulPayments.length} successful Paystack charges. This needs manual review to decide which charge to keep and refund the rest — check audit_logs for the full reference list.`
    );
  }

  return { checked: staleOrders.length, resolved: resolvedCount };
};

const REFUND_STUCK_CHECK_AGE_MINUTES = 30;

// Recover automatic reconciliation refunds whose Paystack request may have
// succeeded but whose local paystack_refund_id was never saved (for example,
// a process crash in the tiny window between Paystack accepting the refund
// and our UPDATE). We deliberately DO NOT create another refund when no match
// is found: an ambiguous external outcome must never be resolved by guessing.
const reconcileUnlinkedAutomaticRefunds = async () => {
  const cutoff = new Date(Date.now() - REFUND_STUCK_CHECK_AGE_MINUTES * 60 * 1000).toISOString();

  const { data: refunds, error } = await adminClient
    .from("refunds")
    .select("id, payment_id, amount, status, created_at, idempotency_key")
    .like("idempotency_key", "reconcile-abandoned-%")
    .is("paystack_refund_id", null)
    .in("status", ["pending", "processing", "needs_attention"])
    .lt("created_at", cutoff)
    .limit(100);

  if (error) throw error;
  if (!refunds?.length) return { checked: 0, linked: 0 };

  let linked = 0;

  for (const refund of refunds) {
    try {
      const { data: payment, error: paymentError } = await adminClient
        .from("payments")
        .select("paystack_reference")
        .eq("id", refund.payment_id)
        .single();
      if (paymentError || !payment?.paystack_reference) {
        console.error(`[reconcile-refunds] Missing Paystack reference for automatic refund ${refund.id}.`);
        continue;
      }

      // Paystack's List Refunds API filters by the numeric transaction id,
      // so first resolve our transaction reference to that id.
      const transactionResponse = await axios.get(
        `https://api.paystack.co/transaction/verify/${payment.paystack_reference}`,
        { headers: paystackHeaders }
      );
      const transactionId = transactionResponse.data?.data?.id;
      if (!transactionId) continue;

      await sleep(PAYSTACK_CALL_DELAY_MS);
      const refundListResponse = await axios.get("https://api.paystack.co/refund", {
        headers: paystackHeaders,
        params: { transaction: String(transactionId), perPage: 50, page: 1 },
      });
      const candidates = refundListResponse.data?.data || [];
      const expectedAmountKobo = Math.round(Number(refund.amount) * 100);
      const marker = refund.id.slice(0, 8);
      const match = candidates.find((candidate) =>
        Number(candidate.amount) === expectedAmountKobo &&
        String(candidate.merchant_note || "").includes(marker)
      );

      if (!match?.id) {
        // Do not retry automatically. The absence of a matching refund after
        // an ambiguous external outcome is a manual-review condition, not a
        // safe invitation to issue a second refund.
        await notifyAdmins(
          "Automatic refund needs verification",
          `Refund ${refund.id} for order payment ${payment.paystack_reference} has no linked Paystack refund record after ${REFUND_STUCK_CHECK_AGE_MINUTES} minutes. It may have failed before creation or the result was lost; verify Paystack before retrying.`
        );
        continue;
      }

      const paystackStatus = match.status || "pending";
      const { data: claimed, error: updateError } = await adminClient
        .from("refunds")
        .update({
          status: ["pending", "processing", "needs_attention"].includes(paystackStatus) ? paystackStatus : "pending",
          paystack_refund_id: String(match.id),
          paystack_status: paystackStatus,
          paystack_transaction_reference: payment.paystack_reference,
        })
        .eq("id", refund.id)
        .is("paystack_refund_id", null)
        .select("id")
        .maybeSingle();
      if (updateError) throw updateError;

      if (claimed) {
        linked += 1;
        if (paystackStatus === "processed") {
          await finalizeProcessedRefund(refund.id);
        }
      }
    } catch (err) {
      console.error(`[reconcile-refunds] Could not recover unlinked automatic refund ${refund.id}:`, err.response?.data || err.message);
    }

    await sleep(PAYSTACK_CALL_DELAY_MS);
  }

  return { checked: refunds.length, linked };
};

const reconcileStuckRefunds = async () => {
  await reconcileUnlinkedAutomaticRefunds();
  const cutoff = new Date(Date.now() - REFUND_STUCK_CHECK_AGE_MINUTES * 60 * 1000).toISOString();

  const { data: stuckRefunds, error } = await adminClient
    .from("refunds")
    .select("id, paystack_refund_id, status, created_at")
    .in("status", ["pending", "processing", "needs_attention"])
    .not("paystack_refund_id", "is", null)
    .lt("created_at", cutoff);

  if (error) throw error;
  if (!stuckRefunds?.length) return { checked: 0, finalized: 0, failed: 0 };

  let finalized = 0;
  let failed = 0;

  for (const refund of stuckRefunds) {
    try {
      const { data } = await axios.get(
        `https://api.paystack.co/refund/${refund.paystack_refund_id}`,
        { headers: paystackHeaders }
      );
      const paystackStatus = data?.data?.status;

      if (paystackStatus === "processed") {
        // Reconciliation races with Paystack webhooks. Only advance a refund
        // that is still in an intermediate state; never overwrite a terminal
        // state that another worker/webhook has already recorded.
        const { data: claimed } = await adminClient.from("refunds").update({
          status: "processed",
          paystack_status: "processed",
          processed_at: new Date().toISOString(),
        }).eq("id", refund.id)
          .in("status", ["pending", "processing", "needs_attention"])
          .select("id")
          .maybeSingle();

        if (claimed) {
          await finalizeProcessedRefund(refund.id);
          finalized += 1;
        }
      } else if (paystackStatus === "failed") {
        // Never let a reconciliation response downgrade a refund that a
        // webhook has already marked processed. The status predicate makes
        // the transition atomic from the caller's perspective.
        const { data: claimed } = await adminClient.from("refunds").update({
          status: "failed",
          paystack_status: "failed",
          failure_reason: "Reconciliation: Paystack reports this refund failed.",
          failed_at: new Date().toISOString(),
        }).eq("id", refund.id)
          .in("status", ["pending", "processing", "needs_attention"])
          .select("id")
          .maybeSingle();

        if (claimed) failed += 1;
      } else if (paystackStatus && paystackStatus !== refund.status) {
        await adminClient.from("refunds").update({ paystack_status: paystackStatus }).eq("id", refund.id);
      }
    } catch (err) {
      console.error(`[reconcile-refunds] Failed to check refund ${refund.id}:`, err.response?.data || err.message);
      await notifyAdmins(
        "Refund reconciliation check failed",
        `Refund ${refund.id} could not be verified against Paystack automatically. Needs manual review.`
      );
    }

    await sleep(PAYSTACK_CALL_DELAY_MS);
  }

  return { checked: stuckRefunds.length, finalized, failed };
};

// ============================================================
// STUCK PAYMENT-PROCESSING RECOVERY (item 9)
// Safety net for the one gap the atomic payment claim doesn't cover on
// its own: the claim (payments.status pending -> successful) makes it
// impossible for two callers to both process a payment, but it also
// means that if the server crashes AFTER the claim succeeds but BEFORE
// every side effect (inventory confirmation, platform revenue credit,
// ledger entry, notifications, receipt) finishes, nothing will ever
// retry it — the claim can't be won a second time.
// processing_completed_at is the marker: NULL means some side effect
// never finished. applyPaymentSideEffects is safe to call again for
// the same payment (see paymentController.js's comments on why each
// step is idempotent or harmlessly re-runnable), so recovering here is
// just: find stuck payments, call it again, done.
// ============================================================
const PAYMENT_STUCK_CHECK_AGE_MINUTES = 5;

const reconcileIncompletePaymentProcessing = async () => {
  const cutoff = new Date(Date.now() - PAYMENT_STUCK_CHECK_AGE_MINUTES * 60 * 1000).toISOString();

  const { data: stuckPayments, error } = await adminClient
    .from("payments")
    .select("id, order_id, paystack_fee")
    .eq("status", "successful")
    .is("processing_completed_at", null)
    .lt("created_at", cutoff);

  if (error) throw error;
  if (!stuckPayments?.length) return { checked: 0, resumed: 0, failed: 0 };

  let resumed = 0;
  let failed = 0;

  for (const payment of stuckPayments) {
    try {
      await applyPaymentSideEffects(payment.id, payment.order_id, null, Number(payment.paystack_fee || 0));
      resumed += 1;
    } catch (err) {
      failed += 1;
      console.error(`[reconcile-payments] Failed to resume payment ${payment.id}:`, err.message);
      await notifyAdmins(
        "Payment processing could not be resumed",
        `Payment ${payment.id} (order ${payment.order_id}) was marked successful but never finished processing, and the automatic retry also failed (${err.message}). Needs manual review.`
      );
    }
  }

  return { checked: stuckPayments.length, resumed, failed };
};

// ============================================================
// STUCK WITHDRAWAL CLAIM RECOVERY (item 5's crash-recovery requirement)
// A withdrawal stuck in CLAIMED past a reasonable window means either:
// (a) the process crashed before even calling Paystack — safe to reset
//     to PENDING for a clean retry, or
// (b) the process crashed AFTER calling Paystack but before recording
//     the result — we do NOT know the outcome from our own DB, and
//     must ask Paystack directly rather than guess or blindly retry
//     (which could send a genuine second transfer).
// The deterministic reference (cartmoove-withdraw-<id>) is what makes
// asking Paystack meaningful: if a transfer with that exact reference
// exists, that tells us definitively what happened; if it doesn't,
// nothing was ever sent and a fresh approval attempt is safe.
// ============================================================
const WITHDRAWAL_CLAIM_STUCK_AGE_MINUTES = 15;

const reconcileStuckWithdrawalClaims = async () => {
  const cutoff = new Date(Date.now() - WITHDRAWAL_CLAIM_STUCK_AGE_MINUTES * 60 * 1000).toISOString();

  const { data: stuck, error } = await adminClient
    .from("withdrawals")
    .select("id, requester_id, gross_amount, withdrawal_fee, net_payout, account_name, claimed_at")
    .eq("status", "CLAIMED")
    .lt("claimed_at", cutoff);

  if (error) throw error;
  if (!stuck?.length) return { checked: 0, resolved: 0 };

  let resolved = 0;

  for (const withdrawal of stuck) {
    const reference = `cartmoove-withdraw-${withdrawal.id}`;
    try {
      const { data } = await axios.get(
        `https://api.paystack.co/transfer/verify/${reference}`,
        { headers: paystackHeaders }
      );
      const transferData = data?.data;

      if (transferData) {
        // A transfer really was sent — bring our record into line with
        // whatever Paystack says happened, using the SAME atomic-claim
        // and webhook-equivalent logic as the normal path, never a
        // second transfer call.
        const { data: moved, error: moveError } = await adminClient.from("withdrawals").update({
          status: "PROCESSING",
          paystack_transfer_id: transferData.id ? String(transferData.id) : null,
          paystack_transfer_code: transferData.transfer_code || null,
          paystack_reference: reference,
          paystack_status: transferData.status,
        }).eq("id", withdrawal.id).eq("status", "CLAIMED").select("id").maybeSingle();
        if (moveError) throw moveError;

        if (moved && transferData.status === "success") {
          // The webhook may have arrived before approveWithdrawal finished
          // recording the transfer. Reconciliation therefore completes the
          // already-successful transfer itself instead of waiting for a
          // webhook that may already have been acknowledged and lost.
          await completeVendorRiderWithdrawal(withdrawal, transferData.status);
        } else if (moved && ["failed", "reversed"].includes(String(transferData.status).toLowerCase())) {
          // This reconciliation loop only processes CLAIMED/PROCESSING
          // withdrawals, so a reversed transfer has not completed our
          // withdrawal accounting. Treat it as a failure and release the
          // reservation; COMPLETED -> REVERSED is handled by the normal
          // webhook path for post-completion reversals.
          await failVendorRiderWithdrawal(withdrawal, transferData.status, transferData.reason || `Paystack transfer ${transferData.status}`);
        }
      } else {
        // No transfer exists with this reference at all — nothing was
        // ever sent. Safe to reset for a normal retry.
        await adminClient.from("withdrawals").update({ status: "PENDING" }).eq("id", withdrawal.id).eq("status", "CLAIMED");
      }
      resolved += 1;
    } catch (err) {
      if (err.response?.status === 404) {
        // Paystack has no record of this reference — confirms nothing
        // was ever sent.
        await adminClient.from("withdrawals").update({ status: "PENDING" }).eq("id", withdrawal.id).eq("status", "CLAIMED");
        resolved += 1;
      } else {
        console.error(`[reconcile-withdrawals] Could not check stuck claim ${withdrawal.id}:`, err.response?.data || err.message);
        await notifyAdmins(
          "Stuck withdrawal claim could not be reconciled",
          `Withdrawal ${withdrawal.id} has been stuck CLAIMED and could not be automatically verified against Paystack (${err.message}). Needs manual review before any retry.`
        );
      }
    }
    await sleep(PAYSTACK_CALL_DELAY_MS);
  }

  const { data: platformStuck, error: platformError } = await adminClient
    .from("platform_withdrawals")
    .select("id, amount, paystack_reference, claimed_at, status")
    .eq("status", "CLAIMED")
    .lt("claimed_at", cutoff);
  if (platformError) throw platformError;

  for (const withdrawal of (platformStuck || [])) {
    const reference = withdrawal.paystack_reference || `cartmoove-platform-${withdrawal.id}`;
    try {
      const { data } = await axios.get(`https://api.paystack.co/transfer/verify/${reference}`, { headers: paystackHeaders });
      const transferData = data?.data;
      if (transferData) {
        // First claim CLAIMED -> PROCESSING atomically. This prevents a
        // webhook and reconciliation from both treating the same transfer
        // as a fresh state transition.
        const { data: moved, error: moveError } = await adminClient
          .from("platform_withdrawals")
          .update({
            status: "PROCESSING", paystack_transfer_id: transferData.id ? String(transferData.id) : null,
            paystack_transfer_code: transferData.transfer_code || null, paystack_reference: reference,
            paystack_status: transferData.status || "pending"
          })
          .eq("id", withdrawal.id).eq("status", "CLAIMED")
          .select("id").maybeSingle();
        if (moveError) throw moveError;

        if (moved) {
          const transferStatus = String(transferData.status || "").toLowerCase();
          if (transferStatus === "success") {
            await adminClient.rpc("complete_platform_withdrawal", {
              p_withdrawal_id: withdrawal.id, p_admin_id: null
            });
          } else if (["failed", "reversed"].includes(transferStatus)) {
            // CLAIMED -> PROCESSING is still pre-completion, so a reversed
            // transfer belongs on the failure path here. Post-completion
            // reversals are handled by the webhook's COMPLETED -> REVERSED
            // path.
            await adminClient.rpc("fail_platform_withdrawal", {
              p_withdrawal_id: withdrawal.id,
              p_failure_reason: transferData.reason || `Paystack transfer ${transferStatus}`,
              p_paystack_status: transferData.status || transferStatus
            });
          }
        }
      } else {
        await adminClient.from("platform_withdrawals").update({ status: "PENDING" }).eq("id", withdrawal.id).eq("status", "CLAIMED");
      }
      resolved += 1;
    } catch (err) {
      if (err.response?.status === 404) {
        await adminClient.from("platform_withdrawals").update({ status: "PENDING" }).eq("id", withdrawal.id).eq("status", "CLAIMED");
        resolved += 1;
      } else {
        await notifyAdmins("Stuck platform withdrawal claim could not be reconciled", `Platform withdrawal ${withdrawal.id} could not be verified against Paystack: ${err.message}. Manual review is required before retry.`);
      }
    }
  }

  return { checked: stuck.length + (platformStuck?.length || 0), resolved };
};

module.exports = { reconcileStalePayments, reconcileStuckRefunds, reconcileIncompletePaymentProcessing, reconcileStuckWithdrawalClaims };
