const { adminClient } = require("../config/db");

// ============================================================
// PILOT MODE MIDDLEWARE
// Checks pilot settings before allowing registration
// Apply to: POST /api/auth/register
// ============================================================
const pilotGuard = async (req, res, next) => {
  let settings;
  try {
    const result = await adminClient.from("pilot_settings").select("*").single();
    settings = result.data;
  } catch (err) {
    // Settings fetch itself failed (DB unreachable, etc). Pilot mode is an
    // availability feature, not the security boundary here — allow through
    // so a Supabase hiccup doesn't take down all registration.
    return next();
  }

  if (!settings) return next(); // No settings row = pilot mode not configured = open

  // Maintenance mode blocks everything
  if (settings.maintenance_mode) {
    return res.status(503).json({
      success: false,
      message: settings.maintenance_message || "Fidelx is currently under maintenance.",
      maintenance: true,
    });
  }

  // Onboarding paused
  if (settings.onboarding_paused) {
    return res.status(403).json({
      success: false,
      message: "New registrations are temporarily paused. Please check back soon.",
    });
  }

  const { role, invite_code } = req.body;
  const inviteRequired =
    (role === "vendor" && settings.vendor_invite_only) ||
    (role === "rider" && settings.rider_invite_only);

  if (!inviteRequired) return next();

  if (!invite_code) {
    return res.status(403).json({
      success: false,
      message: `${role === "vendor" ? "Vendor" : "Rider"} registration is currently invite-only. Please use your invite code.`,
      invite_required: true,
    });
  }

  // This IS the security boundary — any failure here must reject the
  // registration, not silently pass it through. Previously a shared
  // try/catch around the whole function meant a DB error here would
  // fall through to next() and skip invite validation entirely.
  try {
    const { data: code } = await adminClient
      .from("invite_codes")
      .select("*")
      .eq("code", invite_code.toUpperCase())
      .eq("role", role)
      .eq("is_used", false)
      .single();

    if (!code || (code.expires_at && new Date(code.expires_at) < new Date())) {
      return res.status(403).json({ success: false, message: "Invalid or expired invite code." });
    }

    req.invite_code = code; // Pass to controller for marking used
    next();
  } catch (err) {
    return res.status(503).json({
      success: false,
      message: "Could not verify invite code right now. Please try again shortly.",
    });
  }
};

// ============================================================
// MAINTENANCE MODE CHECK
// Apply to all routes during downtime
// ============================================================
const maintenanceCheck = async (req, res, next) => {
  // Skip health check
  if (req.path === "/") return next();

  try {
    const { data: settings } = await adminClient
      .from("pilot_settings")
      .select("maintenance_mode, maintenance_message")
      .single();

    if (settings?.maintenance_mode) {
      return res.status(503).json({
        success: false,
        message: settings.maintenance_message || "Fidelx is currently under maintenance.",
        maintenance: true,
      });
    }

    next();
  } catch (err) {
    next(); // Don't block if check fails
  }
};

module.exports = { pilotGuard, maintenanceCheck };
