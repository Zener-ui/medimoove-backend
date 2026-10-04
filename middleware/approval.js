const { adminClient } = require("../config/db");

// Enforced server-side so a pending/rejected vendor or rider cannot
// reach normal dashboard/API functionality just because the frontend
// route was hidden — a direct API call with a valid JWT must be
// blocked here too. Must run after `protect` (needs req.user) and
// after `roles(...)` (assumes the role check already passed).

const requireApprovedVendor = async (req, res, next) => {
  try {
    const { data: vendor, error } = await adminClient
      .from("vendors")
      .select("id, status, rejection_reason")
      .eq("user_id", req.user.id)
      .single();

    if (error || !vendor) {
      return res.status(404).json({ success: false, message: "Vendor profile not found." });
    }

    if (vendor.status !== "approved") {
      return res.status(403).json({
        success: false,
        message:
          vendor.status === "rejected"
            ? "Your vendor application was not approved."
            : vendor.status === "suspended"
            ? "Your vendor account has been suspended. Contact support if you believe this is a mistake."
            : "Your vendor account is pending approval.",
        vendor_status: vendor.status,
        rejection_reason: vendor.status === "rejected" ? vendor.rejection_reason : undefined,
      });
    }

    req.vendor = vendor;
    next();
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const requireApprovedRider = async (req, res, next) => {
  try {
    const { data: rider, error } = await adminClient
      .from("riders")
      .select("id, status, rejection_reason")
      .eq("user_id", req.user.id)
      .single();

    if (error || !rider) {
      return res.status(404).json({ success: false, message: "Rider profile not found." });
    }

    if (rider.status !== "approved") {
      return res.status(403).json({
        success: false,
        message:
          rider.status === "rejected"
            ? "Your rider application was not approved."
            : "Your rider account is pending approval.",
        rider_status: rider.status,
        rejection_reason: rider.status === "rejected" ? rider.rejection_reason : undefined,
      });
    }

    req.rider = rider;
    next();
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { requireApprovedVendor, requireApprovedRider };
