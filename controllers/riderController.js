const { adminClient } = require("../config/db");
const { v4: uuidv4 } = require("uuid");
const { verifyNIN } = require("../services/premblyService");
const { checkTermsAccepted } = require("../utils/checkTermsAccepted");

/**
 * Runs Prembly verification for a rider and persists the result —
 * used by both registerRider (first attempt) and retryNinVerification
 * (subsequent attempts after a failure, e.g. provider was down or
 * the person mistyped their NIN).
 */
const runNinVerification = async (riderId, nin, accountFullName) => {
  const result = await verifyNIN(nin, accountFullName);

  await adminClient
    .from("riders")
    .update({
      nin_verified: result.verified,
      nin_verification_status: result.verified ? "verified" : "failed",
      nin_verification_message: result.errorMessage,
      nin_verification_reference: result.reference,
      nin_verified_at: result.verified ? new Date().toISOString() : null,
    })
    .eq("id", riderId);

  // Increment attempts via a safe read-modify-write (avoids needing a
  // raw SQL expression through the JS client).
  const { data: current } = await adminClient
    .from("riders")
    .select("nin_verification_attempts")
    .eq("id", riderId)
    .single();
  await adminClient
    .from("riders")
    .update({ nin_verification_attempts: (current?.nin_verification_attempts || 0) + 1 })
    .eq("id", riderId);

  await adminClient.from("rider_verification_logs").insert({
    id: uuidv4(),
    rider_id: riderId,
    verified: result.verified,
    name_match: result.nameMatch,
    provider_reference: result.reference,
    error_message: result.errorMessage,
    raw_response: result.rawResponse,
  });

  // If verified, auto-approve the rider so they don't sit in "pending"
  // waiting on an admin for something Prembly already confirmed.
  // Admins can still suspend/strike afterward if something looks off.
  if (result.verified) {
    const { data: rider } = await adminClient
      .from("riders")
      .update({ status: "approved" })
      .eq("id", riderId)
      .select("user_id")
      .single();

    if (rider) {
      await adminClient.from("notifications").insert({
        id: uuidv4(),
        user_id: rider.user_id,
        title: "Identity Verified",
        body: "Your NIN has been verified and your rider account is approved. You can start accepting orders.",
        is_read: false,
      });
    }
  } else {
    const { data: rider } = await adminClient
      .from("riders")
      .select("user_id")
      .eq("id", riderId)
      .single();

    if (rider) {
      await adminClient.from("notifications").insert({
        id: uuidv4(),
        user_id: rider.user_id,
        title: "Identity Verification Failed",
        body: result.errorMessage || "We couldn't verify your NIN. Please check your details and try again.",
        is_read: false,
      });
    }
  }

  return result;
};

// @route POST /api/riders/register
const registerRider = async (req, res) => {
  try {
    const { nin, phone, vehicle_type } = req.body;

    if (!nin || !/^\d{11}$/.test(nin)) {
      return res.status(400).json({ success: false, message: "A valid 11-digit NIN is required." });
    }

    // Registration is idempotent. The account-registration flow creates the
    // rider row before NIN verification runs. If verification fails or the
    // client loses the response, the rider already exists and must be treated
    // as an existing application — never as a duplicate-registration error.
    const { data: existing, error: existingError } = await adminClient
      .from("riders")
      .select("*")
      .eq("user_id", req.user.id)
      .maybeSingle();

    if (existingError) throw existingError;

    if (existing) {
      return res.status(200).json({
        success: true,
        existing: true,
        rider: existing,
        verification: {
          verified: Boolean(existing.nin_verified),
          status: existing.nin_verification_status,
          message: existing.nin_verification_message || null,
        },
        message: existing.status === "rejected"
          ? "Your rider application already exists and was rejected. You can reapply from the review page."
          : existing.status === "approved"
            ? "Your rider application is already approved."
            : "Your rider application already exists and is being processed.",
      });
    }

    const terms = await checkTermsAccepted(req.user.id);
    if (!terms.accepted) {
      return res.status(400).json({ success: false, message: terms.message });
    }

    // Look up the account holder's name to cross-check against the NIN record.
    const { data: account } = await adminClient
      .from("users")
      .select("full_name")
      .eq("id", req.user.id)
      .single();

    const { data, error } = await adminClient
      .from("riders")
      .insert({
        id: uuidv4(),
        user_id: req.user.id,
        nin,
        nin_verified: false,
        nin_verification_status: "pending",
        phone,
        vehicle_type,
        is_active: false,
        rating: 0,
        strike_count: 0,
        status: "pending",
      })
      .select()
      .single();

    if (error) throw error;

    // Verify synchronously — Prembly typically responds in a few seconds,
    // and the rider is sitting on the onboarding screen waiting anyway.
    const result = await runNinVerification(data.id, nin, account?.full_name || "");

    const { data: finalRider } = await adminClient
      .from("riders")
      .select("*")
      .eq("id", data.id)
      .single();

    res.status(201).json({
      success: true,
      rider: finalRider,
      verification: {
        verified: result.verified,
        message: result.verified
          ? "Your identity has been verified. Your rider account is approved."
          : result.errorMessage,
      },
      message: result.verified
        ? "Registration complete and verified."
        : "Registration submitted, but NIN verification did not pass. You can retry from your profile.",
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/riders/verify-nin/retry
// Lets a rider retry verification after a failure — e.g. they mistyped
// their NIN, or Prembly was briefly unavailable. Does not create a new
// rider row; updates the existing pending/failed one.
const retryNinVerification = async (req, res) => {
  try {
    const { nin } = req.body;

    const { data: rider } = await adminClient
      .from("riders")
      .select("id, status, nin_verification_status, nin_verification_attempts")
      .eq("user_id", req.user.id)
      .single();

    if (!rider) {
      return res.status(404).json({ success: false, message: "Rider profile not found." });
    }

    if (rider.status === "approved") {
      return res.status(400).json({ success: false, message: "This rider is already verified and approved." });
    }

    if (rider.nin_verification_attempts >= 5) {
      return res.status(429).json({
        success: false,
        message: "Too many verification attempts. Please contact support for manual review.",
      });
    }

    const newNin = nin && /^\d{11}$/.test(nin) ? nin : null;
    if (nin && !newNin) {
      return res.status(400).json({ success: false, message: "A valid 11-digit NIN is required." });
    }

    if (newNin) {
      await adminClient.from("riders").update({ nin: newNin }).eq("id", rider.id);
    }

    const { data: account } = await adminClient
      .from("users")
      .select("full_name")
      .eq("id", req.user.id)
      .single();

    const { data: riderRow } = await adminClient
      .from("riders")
      .select("nin")
      .eq("id", rider.id)
      .single();

    const result = await runNinVerification(rider.id, riderRow.nin, account?.full_name || "");

    res.json({
      success: true,
      verification: {
        verified: result.verified,
        message: result.verified
          ? "Your identity has been verified. Your rider account is approved."
          : result.errorMessage,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/riders/me
const getMyRiderProfile = async (req, res) => {
  try {
    const { data, error } = await adminClient
      .from("riders")
      .select("*")
      .eq("user_id", req.user.id)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, message: "Rider profile not found." });
    }

    res.json({ success: true, rider: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/riders/location
const updateRiderLocation = async (req, res) => {
  try {
    const { lat, lng } = req.body;

    const { error } = await adminClient
      .from("riders")
      .update({ location_lat: lat, location_lng: lng, last_seen: new Date().toISOString() })
      .eq("user_id", req.user.id);

    if (error) throw error;

    res.json({ success: true, message: "Location updated." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/riders/availability
const toggleAvailability = async (req, res) => {
  try {
    const { is_active } = req.body;

    const { data, error } = await adminClient
      .from("riders")
      .update({ is_active })
      .eq("user_id", req.user.id)
      .select("is_active")
      .single();

    if (error) throw error;

    res.json({ success: true, is_active: data.is_active });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/riders/available-orders
// Riders see orders available in their region
const getAvailableOrders = async (req, res) => {
  try {
    const { data: rider } = await adminClient
      .from("riders")
      .select("id, status")
      .eq("user_id", req.user.id)
      .single();

    if (!rider || rider.status !== "approved") {
      return res.status(403).json({ success: false, message: "Your rider account is not approved." });
    }

    // Query sub_orders (new system) for available deliveries
    const { data: orders, error } = await adminClient
      .from("sub_orders")
      .select("*, vendors(business_name, address, location, location_lat, location_lng)")
      .eq("status", "WAITING_RIDER")
      .is("rider_id", null)
      .eq("delivery_type", "delivery")
      .order("created_at", { ascending: true });

    if (error) throw error;

    res.json({ success: true, orders });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/riders/accept-order/:orderId
// NOTE: This endpoint now redirects to sub-order acceptance.
// The canonical accept endpoint is POST /api/sub-orders/:subOrderId/accept
// This endpoint is kept for backward compatibility but delegates to sub_orders
const acceptOrder = async (req, res) => {
  try {
    const { data: rider } = await adminClient
      .from("riders")
      .select("id, status, is_active")
      .eq("user_id", req.user.id)
      .single();

    if (!rider || rider.status !== "approved" || !rider.is_active) {
      return res.status(403).json({ success: false, message: "You are not available to accept orders." });
    }

    // Accept via sub_orders (new system) — atomic assignment
    const { data, error } = await adminClient
      .from("sub_orders")
      .update({ rider_id: rider.id, status: "RIDER_ASSIGNED" })
      .eq("id", req.params.orderId)
      .eq("status", "PAYMENT_CONFIRMED")
      .is("rider_id", null)
      .select()
      .single();

    if (error || !data) {
      return res.status(400).json({ success: false, message: "Order is no longer available." });
    }

    res.json({ success: true, message: "Order accepted.", order: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/riders/earnings
const getRiderEarnings = async (req, res) => {
  try {
    const { data: rider } = await adminClient
      .from("riders")
      .select("id")
      .eq("user_id", req.user.id)
      .single();

    if (!rider) return res.status(404).json({ success: false, message: "Rider profile not found." });

    // Get balance from balances table (source of truth)
    const { data: balance } = await adminClient
      .from("balances")
      .select("available_balance, pending_balance, total_earned, total_withdrawn")
      .eq("user_id", req.user.id)
      .single();

    const { data: liabilities, error: liabilityError } = await adminClient
      .from("refund_liabilities")
      .select("id, refund_id, responsible_type, original_amount, recovered_amount, status, created_at, updated_at")
      .eq("responsible_user_id", req.user.id)
      .in("status", ["OPEN", "PARTIALLY_RECOVERED"])
      .order("created_at", { ascending: true });
    if (liabilityError && liabilityError.code !== "42P01") throw liabilityError;
    const outstanding_refund_liability = (liabilities || []).reduce((sum, x) => sum + Number(x.original_amount || 0) - Number(x.recovered_amount || 0), 0);

    // Get sub-order delivery history
    const { data: orders, error } = await adminClient
      .from("sub_orders")
      .select("id, rider_payout, status, delivered_at, created_at, order_id")
      .eq("rider_id", rider.id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      available_balance: balance?.available_balance ?? 0,
      pending_balance: balance?.pending_balance ?? 0,
      total_earned: balance?.total_earned ?? 0,
      total_withdrawn: balance?.total_withdrawn ?? 0,
      outstanding_refund_liability,
      refund_liabilities: liabilities || [],
      orders: orders || [],
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  registerRider,
  retryNinVerification,
  getMyRiderProfile,
  updateRiderLocation,
  toggleAvailability,
  getAvailableOrders,
  acceptOrder,
  getRiderEarnings,
};
