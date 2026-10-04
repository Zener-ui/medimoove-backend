const { adminClient } = require("../config/db");
const { v4: uuidv4 } = require("uuid");

// ============================================================
// SECTION 9 — MONITORING / ALERTS
// ============================================================

// @route GET /api/admin/alerts
const getAdminAlerts = async (req, res) => {
  try {
    const { severity, resolved = "false" } = req.query;
    let query = adminClient
      .from("admin_alerts")
      .select("*")
      .eq("is_resolved", resolved === "true")
      .order("created_at", { ascending: false });

    if (severity) query = query.eq("severity", severity);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, alerts: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/admin/alerts/:id/resolve
const resolveAlert = async (req, res) => {
  try {
    await adminClient.from("admin_alerts").update({
      is_resolved: true,
      resolved_by: req.user.id,
      resolved_at: new Date().toISOString(),
    }).eq("id", req.params.id);
    res.json({ success: true, message: "Alert resolved." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Internal helper — create alert
const createAlert = async (type, severity, title, description, reference_id = null, reference_type = null) => {
  await adminClient.from("admin_alerts").insert({
    id: uuidv4(), type, severity, title, description,
    reference_id, reference_type,
  });
};

// @route GET /api/admin/stuck-orders
const getStuckOrders = async (req, res) => {
  try {
    const { data, error } = await adminClient
      .from("stuck_orders")
      .select("*, orders(status, total), sub_orders(status)")
      .eq("resolved", false)
      .order("detected_at", { ascending: true });
    if (error) throw error;
    res.json({ success: true, stuck_orders: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/admin/stuck-orders/:id/resolve
const resolveStuckOrder = async (req, res) => {
  try {
    const { resolution_notes } = req.body;
    await adminClient.from("stuck_orders").update({
      resolved: true,
      resolution_notes,
      resolved_by: req.user.id,
      resolved_at: new Date().toISOString(),
    }).eq("id", req.params.id);
    res.json({ success: true, message: "Stuck order resolved." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/admin/failed-webhooks
const getFailedWebhooks = async (req, res) => {
  try {
    const { data, error } = await adminClient
      .from("failed_webhooks")
      .select("*")
      .eq("resolved", false)
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ success: true, failed_webhooks: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================
// SECTION 10 — LEGAL / POLICY SYSTEM
// ============================================================

// @route GET /api/policies
const getPolicies = async (req, res) => {
  try {
    const { data, error } = await adminClient
      .from("policies")
      .select("id, type, title, version, published_at, updated_at")
      .eq("is_active", true);
    if (error) throw error;
    res.json({ success: true, policies: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/policies/:type
const getPolicyByType = async (req, res) => {
  try {
    const { data, error } = await adminClient
      .from("policies")
      .select("*")
      .eq("type", req.params.type)
      .eq("is_active", true)
      .single();
    if (error || !data) return res.status(404).json({ success: false, message: "Policy not found." });
    res.json({ success: true, policy: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/policies/:type/status  [authenticated]
// Lets a flow like vendor/rider onboarding's Terms step check
// whether the current user already accepted (e.g. at registration
// time) before showing the acceptance UI again.
const getPolicyAcceptanceStatus = async (req, res) => {
  try {
    const { checkTermsAccepted } = require("../utils/checkTermsAccepted");
    if (req.params.type === "terms_of_service") {
      const result = await checkTermsAccepted(req.user.id);
      return res.json({ success: true, accepted: result.accepted });
    }

    const { data: policy } = await adminClient.from("policies").select("id, version").eq("type", req.params.type).eq("is_active", true).single();
    if (!policy) return res.json({ success: true, accepted: false });

    const { data: acceptance } = await adminClient
      .from("policy_acceptances")
      .select("id")
      .eq("user_id", req.user.id)
      .eq("policy_id", policy.id)
      .eq("policy_version", policy.version)
      .maybeSingle();

    res.json({ success: true, accepted: !!acceptance });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/admin/policies/:type (admin only)
const updatePolicy = async (req, res) => {
  try {
    const { title, content, version } = req.body;
    const { data: existing } = await adminClient.from("policies").select("id").eq("type", req.params.type).single();

    if (existing) {
      await adminClient.from("policies").update({
        title, content, version,
        published_by: req.user.id,
        updated_at: new Date().toISOString(),
      }).eq("type", req.params.type);
    } else {
      await adminClient.from("policies").insert({
        id: uuidv4(), type: req.params.type, title, content, version,
        published_by: req.user.id,
      });
    }

    await adminClient.from("audit_logs").insert({
      id: uuidv4(), action: "POLICY_UPDATED", actor_id: req.user.id,
      target_type: "policy", details: { type: req.params.type, version },
    });

    res.json({ success: true, message: "Policy updated." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/policies/accept
const acceptPolicy = async (req, res) => {
  try {
    const { policy_id, policy_version } = req.body;
    const ip = req.headers["x-forwarded-for"] || req.ip;

    await adminClient.from("policy_acceptances").upsert({
      id: uuidv4(),
      user_id: req.user.id,
      policy_id,
      policy_version,
      accepted_at: new Date().toISOString(),
      ip_address: ip,
    }, { onConflict: "user_id,policy_id,policy_version" });

    res.json({ success: true, message: "Policy acceptance recorded." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================
// SECTION 11 — PILOT LAUNCH
// ============================================================

// @route GET /api/pilot/settings
const getPilotSettings = async (req, res) => {
  try {
    const { data, error } = await adminClient.from("pilot_settings").select("*").single();
    if (error) throw error;
    res.json({ success: true, settings: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/admin/pilot/settings
const updatePilotSettings = async (req, res) => {
  try {
    const updates = req.body;
    updates.updated_by = req.user.id;
    updates.updated_at = new Date().toISOString();

    const { data: existing } = await adminClient.from("pilot_settings").select("id").single();

    if (existing) {
      await adminClient.from("pilot_settings").update(updates).eq("id", existing.id);
    } else {
      await adminClient.from("pilot_settings").insert({ id: uuidv4(), ...updates });
    }

    await adminClient.from("audit_logs").insert({
      id: uuidv4(), action: "PILOT_SETTINGS_UPDATED", actor_id: req.user.id,
      target_type: "pilot_settings", details: updates,
    });

    res.json({ success: true, message: "Pilot settings updated." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/admin/pilot/invite-codes/generate
const generateInviteCode = async (req, res) => {
  try {
    const { role, region_id, expires_days = 7 } = req.body;

    const code = `CM-${role.toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expires_days);

    const { data, error } = await adminClient.from("invite_codes").insert({
      id: uuidv4(), code, role, region_id: region_id || null,
      created_by: req.user.id,
      expires_at: expiresAt.toISOString(),
    }).select().single();

    if (error) throw error;
    res.json({ success: true, invite_code: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/pilot/validate-invite
const validateInviteCode = async (req, res) => {
  try {
    const { code, role } = req.body;

    const { data, error } = await adminClient
      .from("invite_codes")
      .select("*")
      .eq("code", code.toUpperCase())
      .eq("role", role)
      .eq("is_used", false)
      .single();

    if (error || !data) return res.status(400).json({ success: false, message: "Invalid or already used invite code." });

    if (data.expires_at && new Date(data.expires_at) < new Date()) {
      return res.status(400).json({ success: false, message: "This invite code has expired." });
    }

    res.json({ success: true, message: "Invite code valid.", region_id: data.region_id });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/pilot/use-invite
const useInviteCode = async (req, res) => {
  try {
    const { code } = req.body;

    const { data } = await adminClient.from("invite_codes").select("*").eq("code", code.toUpperCase()).eq("is_used", false).single();
    if (!data) return res.status(400).json({ success: false, message: "Invalid invite code." });

    await adminClient.from("invite_codes").update({
      is_used: true,
      used_by: req.user.id,
      used_at: new Date().toISOString(),
    }).eq("id", data.id);

    res.json({ success: true, message: "Invite code used." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================
// SECTION 12 — FAILURE OPERATIONS
// ============================================================

// @route GET /api/admin/failure-ops/customer-unreachable/:subOrderId
// Manual flow: mark customer as unreachable, trigger wait period
const markCustomerUnreachable = async (req, res) => {
  try {
    const { data: subOrder } = await adminClient.from("sub_orders").select("id, status, order_id").eq("id", req.params.subOrderId).single();
    if (!subOrder) return res.status(404).json({ success: false, message: "Sub-order not found." });

    // Log stuck order
    await adminClient.from("stuck_orders").insert({
      id: uuidv4(),
      order_id: subOrder.order_id,
      sub_order_id: subOrder.id,
      reason: "Customer unreachable at delivery address",
      detected_at: new Date().toISOString(),
    });

    // Create admin alert
    await createAlert("CUSTOMER_UNREACHABLE", "high", "Customer Unreachable",
      `Customer could not be reached for sub-order ${subOrder.id.slice(0, 8)}. Manual intervention required.`,
      subOrder.id, "sub_order"
    );

    res.json({
      success: true,
      message: "Marked as unreachable. Admin alerted. Rider should wait 10 minutes then contact support.",
      next_steps: [
        "Rider waits 10 minutes at delivery address",
        "Rider attempts in-app chat with customer",
        "If no response, rider contacts support via app",
        "Support team attempts to reach customer",
        "If still unreachable after 30 minutes, second delivery attempt scheduled",
        "If second attempt fails, order returned to vendor and customer refunded minus delivery fee",
      ],
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/admin/failure-ops/manual-intervention
const logManualIntervention = async (req, res) => {
  try {
    const { order_id, sub_order_id, reason, action_taken, resolution } = req.body;

    await adminClient.from("audit_logs").insert({
      id: uuidv4(),
      action: "MANUAL_INTERVENTION",
      actor_id: req.user.id,
      target_id: sub_order_id || order_id,
      target_type: sub_order_id ? "sub_order" : "order",
      details: { reason, action_taken, resolution },
    });

    if (sub_order_id) {
      await adminClient.from("stuck_orders").update({
        resolved: true,
        resolution_notes: `Manual intervention: ${action_taken}. Resolution: ${resolution}`,
        resolved_by: req.user.id,
        resolved_at: new Date().toISOString(),
      }).eq("sub_order_id", sub_order_id);
    }

    res.json({ success: true, message: "Manual intervention logged." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  getAdminAlerts, resolveAlert, createAlert,
  getStuckOrders, resolveStuckOrder, getFailedWebhooks,
  getPolicies, getPolicyByType, getPolicyAcceptanceStatus, updatePolicy, acceptPolicy,
  getPilotSettings, updatePilotSettings,
  generateInviteCode, validateInviteCode, useInviteCode,
  markCustomerUnreachable, logManualIntervention,
};
