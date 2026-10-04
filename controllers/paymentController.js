const axios = require("axios");
const crypto = require("crypto");
const { adminClient } = require("../config/db");
const { v4: uuidv4 } = require("uuid");
const { confirmInventory } = require("./subOrderController");
const { createReceipt } = require("./receiptController");
const { finalizeProcessedRefund } = require("./operationalController");
const { notifyUser } = require("../utils/notify");

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const paystackHeaders = {
  Authorization: `Bearer ${PAYSTACK_SECRET}`,
  "Content-Type": "application/json",
};

const validatePaystackSignature = (req) => {
  // This route is mounted behind express.raw() in server.js specifically so
  // req.body arrives as the exact raw Buffer Paystack sent — required for
  // the HMAC to match. Hashing JSON.stringify(req.body) here would hash a
  // Buffer's JSON representation (e.g. {"type":"Buffer","data":[...]}),
  // which can never match Paystack's real signature.
  const hash = crypto
    .createHmac("sha512", PAYSTACK_SECRET)
    .update(req.body)
    .digest("hex");
  return hash === req.headers["x-paystack-signature"];
};

const validatePaystackOrderAmount = async (orderId, paystackAmountKobo) => {
  const { data: order, error } = await adminClient
    .from("orders")
    .select("id, total")
    .eq("id", orderId)
    .single();
  if (error || !order) throw error || new Error(`Order ${orderId} not found.`);

  const expectedKobo = Math.round(Number(order.total) * 100);
  const receivedKobo = Number(paystackAmountKobo);
  if (!Number.isFinite(receivedKobo) || receivedKobo !== expectedKobo) {
    console.error("[PAYMENT] Paystack amount/order total mismatch", {
      orderId, expectedKobo, receivedKobo: Number.isFinite(receivedKobo) ? receivedKobo : null,
    });
    return false;
  }
  return true;
};

const processSuccessfulPayment = async (orderId, reference, actorId, paystackFeeKobo) => {
  // Atomic conditional claim: the webhook and the redirect-based verify
  // endpoint can both call this function for the same payment at nearly
  // the same time. The previous version read payment.status, checked it
  // in JS, then wrote separately — two concurrent calls could both read
  // "pending" before either write landed, and both would then run every
  // side effect below (ledger entry, notifications, receipt) a second
  // time. Conditioning the UPDATE itself on the CURRENT status closes
  // that gap: only one caller's UPDATE can actually match a still-pending
  // row and get data back from .select(); the other gets nothing and
  // exits immediately, before any side effect runs.
  //
  // This claim mechanism is deliberately UNCHANGED from before — it was
  // already correct. What's new is everything after it: the actual side
  // effects are now in their own function, applyPaymentSideEffects,
  // which is safe to call AGAIN later for the same payment (by the
  // reconciliation job below) if the process crashes partway through
  // this first attempt. The claim protects against double-processing by
  // two SIMULTANEOUS callers; processing_completed_at is what lets a
  // single interrupted run be safely FINISHED later, which is a
  // different problem the claim alone never solved.
  const realPaystackFee = Number(paystackFeeKobo || 0) / 100;

  const { data: claimed, error: claimError } = await adminClient
    .from("payments")
    .update({ status: "successful", paystack_fee: realPaystackFee })
    .eq("paystack_reference", reference)
    .eq("order_id", orderId)
    .eq("status", "pending")
    .select()
    .single();

  if (claimError || !claimed) {
    // Either a concurrent/earlier call already claimed this payment, or
    // the reference doesn't exist. Either way, nothing further to do
    // FROM HERE — this is the correct, safe outcome for a duplicate
    // webhook retry. Deliberately NOT resuming an incomplete payment in
    // this branch: two near-simultaneous callers (a webhook delivery
    // racing the customer's redirect-triggered verify) could both land
    // here at once and both attempt to resume the same payment
    // concurrently, which is exactly the class of race this whole pass
    // is closing elsewhere. Recovery for an incomplete payment happens
    // in exactly two deliberate, non-overlapping places instead:
    // verifyPayment's own dedicated check (runs BEFORE attempting a
    // claim at all, so it only ever runs once per actual redirect) and
    // the reconcile-payment-processing cron job.
    return;
  }

  await applyPaymentSideEffects(claimed.id, orderId, actorId, realPaystackFee);
};

// Everything that needs to happen once a payment is confirmed —
// deliberately separated from the atomic claim above so it can be
// re-invoked for the SAME payment after a crash without re-claiming
// (the claim already succeeded once; re-claiming isn't the point).
// Every step here is either naturally idempotent (setting the same
// status twice) or explicitly guarded (credit_platform_revenue's own
// unique index, confirmInventory's atomic per-reservation claim, the
// ledger insert's (reference,type) unique index). The two genuinely
// unguarded side effects — vendor/customer notifications and the
// receipt — are harmless if occasionally duplicated on a resumed run
// (which only happens after a real server crash, expected to be rare),
// unlike everything else here which touches real money or real stock.
const applyPaymentSideEffects = async (paymentId, orderId, actorId, realPaystackFee) => {
  const { error: orderStateError } = await adminClient
    .from("orders")
    .update({ status: "PAYMENT_CONFIRMED", payment_status: "successful", paystack_fee: realPaystackFee })
    .eq("id", orderId);
  if (orderStateError) throw orderStateError;

  const { error: subOrderStateError } = await adminClient
    .from("sub_orders")
    .update({ status: "PAYMENT_CONFIRMED" })
    .eq("order_id", orderId);
  if (subOrderStateError) throw subOrderStateError;

  await confirmInventory(orderId);

  const { data: order, error: orderFetchError } = await adminClient
    .from("orders")
    .select("total, platform_fee, subtotal, customer_id")
    .eq("id", orderId)
    .single();
  if (orderFetchError || !order) throw orderFetchError || new Error(`Order ${orderId} could not be loaded after payment confirmation.`);

  // IMPORTANT: payment confirmation is not revenue recognition.
  // Platform fees are held with the order and are recognized only after
  // the entire order has successfully completed. This prevents a paid-then-
  // cancelled order from ever creating Fidelx revenue that later has to be
  // reversed. Paystack processing fees remain a separate cash/expense concern.
  // Deduplicated by (reference, type) — a resumed run after a crash
  // cannot create a second PAYMENT_CONFIRMED row for this order.
  const { error: ledgerError } = await adminClient.from("ledger_entries").insert({
    id: uuidv4(),
    reference: orderId,
    type: "PAYMENT_CONFIRMED",
    amount: order.total,
    fee: order.platform_fee,
    net: order.subtotal,
    source: "customer_payment",
    destination: "platform_escrow",
    actor_id: actorId || order.customer_id,
    description: `Payment confirmed for order ${orderId.slice(0, 8)}. Total: ₦${order.total}`,
  }).select().maybeSingle();
  if (ledgerError && ledgerError.code !== "23505") throw ledgerError;

  await notifyUser(order.customer_id, {
    title: "Payment Confirmed",
    body: `Your payment of ₦${order.total?.toLocaleString()} was successful. Your order is being prepared.`,
    preferenceKey: "email_payment_updates",
    emailSubject: "Payment confirmed — your order is being prepared",
    emailHtml: `<p>Your payment of <strong>₦${order.total?.toLocaleString()}</strong> was successful.</p><p>Your order is now being prepared. We'll let you know as it moves along.</p>`,
  });

  const { data: subOrders } = await adminClient.from("sub_orders").select("vendor_id, vendors(user_id)").eq("order_id", orderId);
  if (subOrders) {
    await Promise.all(
      subOrders.map((so) =>
        so.vendors?.user_id
          ? notifyUser(so.vendors.user_id, {
              title: "New Order Received",
              body: "A new paid order has arrived. Prepare it for pickup.",
              preferenceKey: "email_order_updates",
              emailSubject: "New order received",
              emailHtml: `<p>A new paid order has arrived on Fidelx.</p><p>Log in to your vendor dashboard to prepare it for pickup.</p>`,
            })
          : Promise.resolve()
      )
    );
  }

  // Auto-generate customer receipt
  const { data: orderItems } = await adminClient
    .from("order_items")
    .select("price, quantity, products(name)")
    .eq("order_id", orderId);

  await createReceipt("ORDER", order.customer_id, orderId, {
    order_id: orderId,
    subtotal: order.subtotal,
    platform_fee: order.platform_fee,
    delivery_fee: order.delivery_fee || 0,
    total: order.total,
    items: orderItems?.map(i => ({ name: i.products?.name, price: i.price, quantity: i.quantity })) || [],
    created_at: new Date().toISOString(),
  });

  // The recoverability marker — set ONLY here, after every step above
  // has actually run without throwing. If the process crashes at any
  // point before this line, processing_completed_at stays NULL forever
  // on its own; the reconciliation job in reconciliationController.js
  // is what notices that and calls applyPaymentSideEffects again for
  // the same payment — which is safe to do because every step above is
  // idempotent or harmlessly re-runnable, as documented above it.
  const { error: completionMarkerError } = await adminClient
    .from("payments")
    .update({ processing_completed_at: new Date().toISOString() })
    .eq("id", paymentId);
  if (completionMarkerError) throw completionMarkerError;
};

const initializePayment = async (req, res) => {
  try {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ success: false, message: "order_id is required." });

    const { data: order, error } = await adminClient.from("orders").select("id, total, customer_id, status, payment_status, paystack_reference").eq("id", order_id).single();
    if (error || !order) return res.status(404).json({ success: false, message: "Order not found." });
    if (order.customer_id !== req.user.id) return res.status(403).json({ success: false, message: "Not authorized." });
    if (order.status !== "PENDING_PAYMENT") return res.status(400).json({ success: false, message: "Order is not awaiting payment." });

    // Never create a second live Paystack transaction for the same order.
    // A customer can legitimately retry/refresh the checkout endpoint, and
    // without this guard two requests could create two Paystack references
    // for one order. If both were later paid, the first local payment would
    // win the atomic claim while the second real charge could be left
    // unmatched/refunded manually.
    const { data: existingPendingPayment, error: pendingPaymentError } = await adminClient
      .from("payments")
      .select("id, status, paystack_reference, authorization_url")
      .eq("order_id", order_id)
      .eq("status", "pending")
      .maybeSingle();
    if (pendingPaymentError) throw pendingPaymentError;

    if (existingPendingPayment) {
      if (existingPendingPayment.authorization_url) {
        return res.json({
          success: true,
          authorization_url: existingPendingPayment.authorization_url,
          reference: existingPendingPayment.paystack_reference,
          reused: true,
        });
      }
      return res.status(409).json({
        success: false,
        message: "A payment is already being initialized for this order. Please wait a moment and try again.",
        reference: existingPendingPayment.paystack_reference,
      });
    }

    const { data: existingSuccessfulPayment } = await adminClient
      .from("payments")
      .select("status, paystack_reference")
      .eq("order_id", order_id)
      .eq("status", "successful")
      .maybeSingle();
    if (existingSuccessfulPayment) {
      return res.json({ success: true, message: "Payment already completed.", already_paid: true, order_id });
    }

    const reference = `cm_${order_id.replace(/-/g, "")}_${Date.now()}`;
    const paymentId = uuidv4();

    // Create our pending payment record BEFORE calling Paystack. The external
    // API call cannot participate in our PostgreSQL transaction, so the local
    // record must exist first. Otherwise Paystack can successfully initialize
    // a transaction and the server can crash before the INSERT below, leaving
    // a real Paystack reference with no local payment row for the webhook or
    // reconciliation job to recover.
    const { error: paymentInsertError } = await adminClient.from("payments").insert({
      id: paymentId,
      order_id,
      amount: order.total,
      status: "pending",
      paystack_reference: reference,
      idempotency_key: reference,
      authorization_url: null,
    });
    if (paymentInsertError) throw paymentInsertError;

    let response;
    try {
      response = await axios.post("https://api.paystack.co/transaction/initialize", {
        email: req.user.email,
        amount: Math.round(order.total * 100),
        reference,
        metadata: { order_id, customer_id: req.user.id, cartmoove: true },
        callback_url: `${process.env.CLIENT_URL}/payment/verify?reference=${reference}`,
      }, { headers: paystackHeaders });
    } catch (paystackError) {
      // This reference never reached a usable checkout URL, so mark the
      // local attempt failed. Keeping the row is useful for reconciliation
      // and audit history, while failed rows are ignored by normal payment
      // processing.
      await adminClient.from("payments").update({
        status: "failed",
        gateway_response: paystackError.response?.data || { message: paystackError.message },
      }).eq("id", paymentId).eq("status", "pending");
      throw paystackError;
    }

    const { authorization_url } = response.data.data;

    // Persist the checkout URL so a repeated initialize request can safely
    // reuse the same live Paystack transaction instead of opening another.
    const { error: authorizationUrlError } = await adminClient
      .from("payments")
      .update({ authorization_url })
      .eq("id", paymentId)
      .eq("status", "pending");
    if (authorizationUrlError) throw authorizationUrlError;

    // Set the order reference only after Paystack has successfully created
    // the transaction. If the process crashes before this update, the local
    // payment row still gives webhook/reconciliation enough information to
    // recover the transaction by its reference.
    const { error: orderReferenceError } = await adminClient
      .from("orders")
      .update({ paystack_reference: reference })
      .eq("id", order_id);
    if (orderReferenceError) throw orderReferenceError;

    res.json({ success: true, authorization_url, reference });
  } catch (err) {
    // err.message here is a generic axios exception ("Request failed
    // with status code 401") when the failure came from the Paystack
    // call — it discards the specific reason Paystack actually gave
    // (bad key, currency not enabled, invalid payload, etc.), which is
    // in err.response.data. Surface that instead so the real cause is
    // visible instead of a dead end.
    const paystackMessage = err.response?.data?.message;
    res.status(500).json({ success: false, message: paystackMessage || err.message });
  }
};

const verifyPayment = async (req, res) => {
  try {
    const { reference } = req.params;
    const { data: existingPayment } = await adminClient.from("payments").select("id, status, order_id, paystack_fee, processing_completed_at").eq("paystack_reference", reference).single();

    if (!existingPayment) return res.status(404).json({ success: false, message: "Payment reference not found." });

    // A payment reference is not itself an authorization credential. The
    // previous flow only required a valid login, so any authenticated user
    // who learned another customer's reference could call this endpoint and
    // trigger processing for that customer's order. Keep the redirect/verify
    // path tied to the payment's actual owner before doing any state change.
    const { data: paymentOrder, error: paymentOrderError } = await adminClient
      .from("orders")
      .select("customer_id")
      .eq("id", existingPayment.order_id)
      .single();
    if (paymentOrderError || !paymentOrder) {
      return res.status(404).json({ success: false, message: "Payment order not found." });
    }
    if (paymentOrder.customer_id !== req.user.id) {
      return res.status(403).json({ success: false, message: "Not authorized to verify this payment." });
    }
    if (existingPayment.status === "successful") {
      if (!existingPayment.processing_completed_at) {
        // Payment was claimed successful but a prior crash left it
        // mid-processing — resume right now instead of telling the
        // customer "done" on an order that isn't actually fully
        // confirmed yet. applyPaymentSideEffects is safe to call again
        // (see its own comments on why each step is idempotent).
        await applyPaymentSideEffects(existingPayment.id, existingPayment.order_id, req.user.id, Number(existingPayment.paystack_fee || 0));
      }
      return res.json({ success: true, message: "Payment already verified.", order_id: existingPayment.order_id, already_processed: true });
    }

    const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, { headers: paystackHeaders });
    const { status, metadata, fees } = response.data.data;

    // The local payment row is the authoritative binding between this
    // Paystack reference and our order. Do not trust Paystack metadata to
    // redirect a verified payment into a different order if the two ever
    // disagree (for example because of a stale/corrupt local record).
    if (!metadata?.order_id || metadata.order_id !== existingPayment.order_id) {
      console.error("[PAYMENT] Paystack metadata/order mismatch", {
        reference,
        localOrderId: existingPayment.order_id,
        paystackOrderId: metadata?.order_id || null,
      });
      return res.status(409).json({ success: false, message: "Payment verification data does not match this order." });
    }

    if (status !== "success") {
      await adminClient.from("payments").update({ status: "failed" }).eq("paystack_reference", reference);
      return res.status(400).json({ success: false, message: "Payment was not successful." });
    }

    const amountMatches = await validatePaystackOrderAmount(metadata.order_id, response.data.data.amount);
    if (!amountMatches) {
      await adminClient.from("audit_logs").insert({
        id: uuidv4(), action: "PAYMENT_AMOUNT_MISMATCH", actor_id: req.user.id,
        target_id: existingPayment.order_id, target_type: "payment",
        details: { reference, paystack_amount_kobo: Number(response.data.data.amount), order_id: existingPayment.order_id },
      });
      return res.status(409).json({ success: false, message: "Payment amount does not match the order. It has been flagged for reconciliation." });
    }

    await processSuccessfulPayment(metadata.order_id, reference, req.user.id, fees);
    res.json({ success: true, message: "Payment verified. Order confirmed.", order_id: metadata.order_id });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const completeVendorRiderWithdrawal = async (withdrawal, paystackStatus = "success") => {
  // Complete the withdrawal and every money-side effect in ONE database
  // transaction. Previously the controller changed PROCESSING -> COMPLETED
  // first, then updated total_withdrawn / ledger / fee revenue in separate
  // calls. If any later call failed, retries could no longer enter the
  // PROCESSING guard, leaving accounting permanently incomplete.
  const { data: completed, error: completionError } = await adminClient.rpc("complete_vendor_rider_withdrawal", {
    p_withdrawal_id: withdrawal.id,
    p_paystack_status: paystackStatus,
  });
  if (completionError) throw completionError;
  if (!completed) return false;

  const { error: notificationError } = await adminClient.from("notifications").insert({
    id: uuidv4(), user_id: withdrawal.requester_id, title: "Withdrawal Completed",
    body: `Your withdrawal of ₦${Number(withdrawal.net_payout).toLocaleString()} has been sent to your bank account.`, is_read: false,
  });
  if (notificationError) console.warn("[WITHDRAWAL] Completion notification failed:", notificationError.message);
  return true;
};

const failVendorRiderWithdrawal = async (withdrawal, paystackStatus, reason) => {
  // Financial failure handling is atomic. Previously this changed
  // PROCESSING -> FAILED first and restored the user's balance in a
  // separate query. A crash between those two operations permanently
  // deducted the balance, and a retry could not repair it because the
  // withdrawal was already FAILED. The RPC performs both operations in
  // one PostgreSQL transaction and is idempotent for duplicate webhooks
  // or reconciliation attempts.
  const { data: failed, error: failureError } = await adminClient.rpc("fail_vendor_rider_withdrawal", {
    p_withdrawal_id: withdrawal.id,
    p_paystack_status: paystackStatus,
    p_failure_reason: reason,
  });
  if (failureError) throw failureError;
  if (!failed) return false;

  // Notification is deliberately outside the financial transaction. A
  // notification failure must never roll back or block the balance restore.
  const { error: notificationError } = await adminClient.from("notifications").insert({
    id: uuidv4(), user_id: withdrawal.requester_id, title: "Withdrawal Failed",
    body: `Your withdrawal could not be completed by Paystack. Your balance has been restored — please try again or contact support.`, is_read: false,
  });
  if (notificationError) console.warn("[WITHDRAWAL] Failure notification failed:", notificationError.message);
  return true;
};

const paystackWebhook = async (req, res) => {
  try {
    if (!validatePaystackSignature(req)) {
      console.warn("[WEBHOOK] Invalid Paystack signature.");
      return res.status(401).json({ message: "Invalid signature." });
    }

    // req.body is still the raw Buffer at this point (see note above) —
    // it was only ever used un-parsed for the signature check, so parse
    // it now to actually read the event data.
    const event = JSON.parse(req.body.toString("utf8"));

    if (["transfer.success", "transfer.failed", "transfer.reversed"].includes(event.event)) {
      const data = event.data || {};
      const transferId = data.id ? String(data.id) : null;
      const reference = data.reference || null;

      // Never query platform withdrawals without a trustworthy identifier.
      // A malformed/unexpected transfer webhook used to fall through with an
      // unfiltered `limit(1)` query and could therefore act on an arbitrary
      // platform withdrawal.
      let platformWithdrawal = null;
      if (transferId || (reference && reference.startsWith("cartmoove-platform-"))) {
        let query = adminClient.from("platform_withdrawals").select("id, amount, status, paystack_reference").limit(1);
        if (transferId) query = query.eq("paystack_transfer_id", transferId);
        else query = query.eq("id", reference.replace("cartmoove-platform-", ""));

        const { data, error } = await query.maybeSingle();
        if (error) throw error;
        platformWithdrawal = data;
      }

      if (platformWithdrawal) {
        if (event.event === "transfer.success") {
          // The completion RPC is atomic (PROCESSING -> COMPLETED). If the
          // webhook wins the race with approval/reconciliation, a later
          // retry/reconciliation can safely finish the transition.
          await adminClient.rpc("complete_platform_withdrawal", {
            p_withdrawal_id: platformWithdrawal.id,
            p_admin_id: null,
          });
        } else if (event.event === "transfer.reversed") {
          // A reversal is different from a failed transfer: Paystack has
          // reversed money that our ledger may already have counted as
          // COMPLETED. Restore the platform balance exactly once and move
          // COMPLETED -> REVERSED. Never route this through FAILED because
          // FAILED is for PROCESSING/CLAIMED transfers whose reservation has
          // not completed.
          await adminClient.rpc("reverse_platform_withdrawal", {
            p_withdrawal_id: platformWithdrawal.id,
            p_paystack_status: data.status || event.event,
            p_failure_reason: data.reason || "Paystack transfer reversed",
          });
        } else {
          // Failure must restore the balance and mark the withdrawal failed
          // in one atomic DB operation. Doing these as two separate calls
          // allowed duplicate/concurrent failure webhooks to restore the
          // same platform balance more than once.
          await adminClient.rpc("fail_platform_withdrawal", {
            p_withdrawal_id: platformWithdrawal.id,
            p_failure_reason: data.reason || `Paystack transfer ${event.event}`,
            p_paystack_status: data.status || event.event,
          });
        }
        return res.sendStatus(200);
      }

      // Not a platform withdrawal — check vendor/rider withdrawals.
      // This case was previously unhandled: the function returned 200
      // above unconditionally, so a transfer.success/transfer.failed
      // event for a vendor/rider withdrawal was silently discarded and
      // the withdrawal stayed stuck on PROCESSING forever.
      let vrQuery = adminClient.from("withdrawals").select("id, status, requester_id, gross_amount, withdrawal_fee, net_payout, account_name").limit(1);
      if (transferId) vrQuery = vrQuery.eq("paystack_transfer_id", transferId);
      else if (reference) vrQuery = vrQuery.eq("paystack_reference", reference);
      else return res.sendStatus(200);

      const { data: withdrawal } = await vrQuery.maybeSingle();
      if (!withdrawal) return res.sendStatus(200);

      if (event.event === "transfer.success") {
        // Atomic PROCESSING -> COMPLETED claim makes duplicate webhook
        // deliveries harmless and keeps all completion side effects in
        // one shared helper used by reconciliation too.
        await completeVendorRiderWithdrawal(withdrawal, data.status || event.event);
      } else if (event.event === "transfer.reversed") {
        // Reversal is a post-completion accounting event, not a failure.
        // Restore the requester's gross balance exactly once and mark the
        // withdrawal COMPLETED -> REVERSED.
        const { data: reversed, error: reversalError } = await adminClient.rpc("reverse_vendor_rider_withdrawal", {
          p_withdrawal_id: withdrawal.id,
          p_paystack_status: data.status || event.event,
          p_failure_reason: data.reason || "Paystack transfer reversed",
        });
        if (reversalError) throw reversalError;
        if (reversed) {
          const { error: notificationError } = await adminClient.from("notifications").insert({
            id: uuidv4(), user_id: withdrawal.requester_id, title: "Withdrawal Reversed",
            body: `Your completed withdrawal of ₦${Number(withdrawal.net_payout).toLocaleString()} was reversed by the payment provider. The withdrawn amount has been restored to your balance.`, is_read: false,
          });
          if (notificationError) console.warn("[WITHDRAWAL] Reversal notification failed:", notificationError.message);
        }
      } else {
        await failVendorRiderWithdrawal(
          withdrawal,
          data.status || event.event,
          data.reason || `Paystack transfer ${event.event}`
        );
      }

      return res.sendStatus(200);
    }

    if (event.event === "charge.success") {
      const { reference, metadata, fees } = event.data;

      // Promotions funding is a separate Paystack transaction. It must never
      // enter the normal customer-order payment pipeline. The DB function is
      // idempotent, so a webhook retry cannot credit the budget twice.
      if (metadata?.promotions_funding === true) {
        const { data: funding } = await adminClient
          .from("promotions_funding_transactions")
          .select("id, amount, status")
          .eq("reference", reference)
          .maybeSingle();

        if (!funding) return res.sendStatus(200);

        const expectedKobo = Math.round(Number(funding.amount) * 100);
        const receivedKobo = Number(event.data?.amount || 0);
        if (receivedKobo !== expectedKobo) {
          console.error("[PROMOTIONS] Paystack amount mismatch", { reference, expectedKobo, receivedKobo });
          await adminClient.from("promotions_funding_transactions")
            .update({ paystack_status: "amount_mismatch", updated_at: new Date().toISOString() })
            .eq("id", funding.id)
            .eq("status", "pending");
          return res.sendStatus(200);
        }

        await adminClient.rpc("complete_promotions_funding", {
          p_reference: reference,
          p_paystack_fee: Number(fees || 0) / 100,
        });
        return res.sendStatus(200);
      }

      if (!metadata?.cartmoove) return res.sendStatus(200);

      const amountMatches = await validatePaystackOrderAmount(metadata.order_id, event.data?.amount);
      if (!amountMatches) {
        await adminClient.from("audit_logs").insert({
          id: uuidv4(), action: "PAYMENT_AMOUNT_MISMATCH", actor_id: null,
          target_id: metadata.order_id, target_type: "payment",
          details: { reference, paystack_amount_kobo: Number(event.data?.amount), order_id: metadata.order_id },
        });
        // Do not claim or confirm the order. Reconciliation will verify the
        // transaction again and, if the mismatch is real, refund the amount
        // actually charged instead of treating it as a normal order payment.
        return res.sendStatus(200);
      }

      // Was passing the literal string "webhook" here, which flows into
      // credit_platform_revenue's p_actor_id (a UUID column). Postgres
      // rejects that at the type level, silently breaking the platform
      // fee credit for every payment confirmed via webhook — the normal
      // real-world path. null correctly falls back to the customer's id
      // instead (see the `actorId || order.customer_id` line above).
      await processSuccessfulPayment(metadata.order_id, reference, null, fees);
    }

    const refundEvents = new Set([
      "refund.pending",
      "refund.processing",
      "refund.needs-attention",
      "refund.failed",
      "refund.processed",
    ]);

    if (refundEvents.has(event.event)) {
      const data = event.data || {};
      const refundReference = data.refund_reference || data.id || null;
      const transactionReference = data.transaction_reference || data.transaction?.reference || null;

      let query = adminClient.from("refunds").select("id, status, paystack_refund_id").limit(1);
      if (refundReference) {
        query = query.eq("paystack_refund_id", String(refundReference));
      } else if (transactionReference) {
        query = query.eq("paystack_transaction_reference", transactionReference).in("status", ["pending", "processing", "needs_attention"]);
      } else {
        return res.sendStatus(200);
      }

      const { data: refund } = await query.maybeSingle();
      if (!refund) return res.sendStatus(200);

      const statusMap = {
        "refund.pending": "pending",
        "refund.processing": "processing",
        "refund.needs-attention": "needs_attention",
        "refund.failed": "failed",
        "refund.processed": "processed",
      };
      const nextStatus = statusMap[event.event];

      // Paystack webhooks are retried and can arrive out of order. Never let
      // an older/intermediate event move a refund backwards after a terminal
      // state has already been recorded. In particular, a late
      // refund.failed/refund.processing event must not overwrite a refund that
      // was already processed and financially finalized. A later processed
      // event is still allowed to advance a previously-failed refund because
      // Paystack's processed event is the stronger final settlement signal.
      if (refund.status === "processed") {
        if (nextStatus === "processed") {
          // Safe recovery path: the status is already terminal, but the
          // financial finalization may have crashed after the status update.
          await finalizeProcessedRefund(refund.id);
        }
      } else if (nextStatus === "failed") {
        // Do not downgrade an already-processed refund. The conditional
        // status check also makes concurrent processed/failed deliveries safe.
        await adminClient.from("refunds").update({
          status: "failed",
          paystack_status: "failed",
          failure_reason: data.reason || data.message || "Paystack refund failed.",
          failed_at: new Date().toISOString(),
        }).eq("id", refund.id).neq("status", "processed");
      } else if (nextStatus === "processed") {
        await adminClient.from("refunds").update({
          status: "processed",
          paystack_status: "processed",
          processed_at: new Date().toISOString(),
        }).eq("id", refund.id).neq("status", "processed");
        await finalizeProcessedRefund(refund.id);
      } else if (refund.status !== "failed") {
        // Once failed, ignore late intermediate events. A later processed
        // event is handled above and can still settle the refund.
        await adminClient.from("refunds").update({
          status: nextStatus,
          paystack_status: nextStatus,
        }).eq("id", refund.id).not("status", "in", "(failed,processed)");
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("[WEBHOOK] Error:", err.message);
    res.sendStatus(500);
  }
};

module.exports = { initializePayment, verifyPayment, paystackWebhook, processSuccessfulPayment, applyPaymentSideEffects, completeVendorRiderWithdrawal, failVendorRiderWithdrawal, validatePaystackOrderAmount };
