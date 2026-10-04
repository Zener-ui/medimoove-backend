const { adminClient } = require("../config/db");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");

const BUDGET_ID = "00000000-0000-0000-0000-000000000002";

// @route GET /api/promotions/budget
// Admin view: current balance + a recent activity trail. Everything
// that has ever drawn on this pool (coupons, later referral rewards)
// shows up here, so "why did this campaign stop working" is always
// answerable from the dashboard instead of a support ticket.
const getPromotionsBudget = async (req, res) => {
  try {
    const { data: budget, error: budgetError } = await adminClient
      .from("promotions_budget")
      .select("balance, total_deposited, total_spent, updated_at")
      .eq("id", BUDGET_ID)
      .single();

    if (budgetError) throw budgetError;

    const { data: recent, error: ledgerError } = await adminClient
      .from("promotions_ledger_entries")
      .select("id, type, amount, reference, description, actor_id, created_at")
      .order("created_at", { ascending: false })
      .limit(50);

    if (ledgerError) throw ledgerError;

    res.json({ success: true, budget, recent_activity: recent || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/promotions/budget/deposit
// Starts a REAL Paystack payment. The promotions budget is credited only
// after Paystack confirms the transaction (webhook/verify endpoint).
const depositToBudget = async (req, res) => {
  try {
    const { amount, description } = req.body;
    const parsedAmount = Number(amount);

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ success: false, message: "A positive amount is required." });
    }

    const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
    if (!PAYSTACK_SECRET) {
      return res.status(500).json({ success: false, message: "PAYSTACK_SECRET_KEY is not configured on the backend." });
    }
    if (!req.user?.email) {
      return res.status(400).json({ success: false, message: "Your admin account needs an email address before funding promotions." });
    }

    const reference = `fidelx_promo_${uuidv4().replace(/-/g, "")}`;
    const { data: funding, error: insertError } = await adminClient
      .from("promotions_funding_transactions")
      .insert({
        reference,
        admin_id: req.user.id,
        amount: parsedAmount,
        description: description || null,
        status: "pending",
      })
      .select("id, reference, amount, status")
      .single();

    if (insertError) throw insertError;

    try {
      const response = await axios.post("https://api.paystack.co/transaction/initialize", {
        email: req.user.email,
        amount: Math.round(parsedAmount * 100),
        reference,
        metadata: {
          fidelx: true,
          promotions_funding: true,
          funding_id: funding.id,
          admin_id: req.user.id,
          description: description || null,
        },
        callback_url: `${process.env.CLIENT_URL}/admin/promotions-budget?funding_reference=${encodeURIComponent(reference)}`,
      }, {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          "Content-Type": "application/json",
        },
      });

      const authorizationUrl = response.data?.data?.authorization_url;
      if (!authorizationUrl) throw new Error("Paystack did not return an authorization URL.");

      await adminClient.from("promotions_funding_transactions")
        .update({ authorization_url: authorizationUrl, updated_at: new Date().toISOString() })
        .eq("id", funding.id);

      return res.json({ success: true, authorization_url: authorizationUrl, reference });
    } catch (paystackError) {
      await adminClient.from("promotions_funding_transactions")
        .update({ status: "failed", paystack_status: paystackError.response?.data?.message || "initialization_failed", updated_at: new Date().toISOString() })
        .eq("id", funding.id)
        .eq("status", "pending");
      throw paystackError;
    }
  } catch (err) {
    const paystackMessage = err.response?.data?.message;
    res.status(500).json({ success: false, message: paystackMessage || err.message });
  }
};

const verifyPromotionsFunding = async (req, res) => {
  try {
    const { reference } = req.params;
    if (!reference) return res.status(400).json({ success: false, message: "reference is required." });

    const { data: funding, error: fundingError } = await adminClient
      .from("promotions_funding_transactions")
      .select("id, reference, admin_id, amount, description, status")
      .eq("reference", reference)
      .eq("admin_id", req.user.id)
      .single();

    if (fundingError || !funding) return res.status(404).json({ success: false, message: "Promotions funding transaction not found." });
    if (funding.status === "successful") return res.json({ success: true, status: "successful", already_processed: true });
    if (funding.status === "failed") return res.status(400).json({ success: false, message: "This promotions funding attempt failed." });

    const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
    const response = await axios.get(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
    });
    const transaction = response.data?.data;

    if (transaction?.status !== "success") {
      await adminClient.from("promotions_funding_transactions")
        .update({ paystack_status: transaction?.status || "not_successful", updated_at: new Date().toISOString() })
        .eq("id", funding.id)
        .eq("status", "pending");
      return res.json({ success: true, status: transaction?.status || "pending" });
    }

    const expectedKobo = Math.round(Number(funding.amount) * 100);
    if (Number(transaction.amount) !== expectedKobo) {
      return res.status(409).json({ success: false, message: "Paystack amount does not match the requested promotions funding amount." });
    }

    const { data: completed, error: completeError } = await adminClient.rpc("complete_promotions_funding", {
      p_reference: reference,
      p_paystack_fee: Number(transaction.fees || 0) / 100,
    });
    if (completeError) throw completeError;
    if (!completed) return res.status(409).json({ success: false, message: "The promotions funding could not be completed safely." });

    res.json({ success: true, status: "successful" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
};

// Internal helper — NOT an HTTP route. Called by whatever controller
// is about to apply a promotional discount/reward (coupons today,
// referral payouts later). Returns true only if the spend actually
// went through against a real, sufficient balance; false means the
// caller must refuse to apply the discount/reward rather than let it
// through unfunded.
const spendFromPromotionsBudget = async ({ reference, type, amount, actorId, description }) => {
  if (!amount || amount <= 0) return true; // nothing to spend is trivially fine
  const { data: success, error } = await adminClient.rpc("spend_promotions_budget", {
    p_reference: reference,
    p_type: type,
    p_amount: amount,
    p_actor_id: actorId || null,
    p_description: description || null,
  });
  if (error) return false;
  return !!success;
};

// Internal helper — reverses a spend if the larger operation it was
// part of (e.g. order creation) then failed and rolled back. Without
// this, a failed order would still have permanently spent budget for
// a discount that was never actually given to anyone.
const refundToPromotionsBudget = async ({ reference, type }) => {
  const { data: success } = await adminClient.rpc("refund_promotions_budget", {
    p_reference: reference,
    p_type: type,
  });
  return !!success;
};


// @route GET /api/promotions/budget/reconcile
// Read-only money reconciliation for the promotions pool. It compares
// successful Paystack funding, promotion ledger entries, and the budget
// singleton without moving or correcting money automatically.
const reconcilePromotionsBudget = async (req, res) => {
  try {
    const { data, error } = await adminClient.rpc("reconcile_promotions_budget");
    if (error) throw error;
    res.json({ success: true, reconciliation: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  getPromotionsBudget,
  depositToBudget,
  verifyPromotionsFunding,
  spendFromPromotionsBudget,
  refundToPromotionsBudget,
  reconcilePromotionsBudget,
};
