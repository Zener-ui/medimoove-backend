const { adminClient } = require("../config/db");
const { v4: uuidv4 } = require("uuid");
const { notifyAdmins } = require("../utils/notifyAdmins");
// @route GET /api/onboarding/status
// ============================================================
const getOnboardingStatus = async (req, res) => {
  try {
    const { data, error } = await adminClient
      .from("onboarding_progress")
      .select("*")
      .eq("user_id", req.user.id)
      .single();

    if (error && error.code !== "PGRST116") throw error;

    if (!data) {
      // Create initial onboarding record
      const { data: created } = await adminClient
        .from("onboarding_progress")
        .insert({ id: uuidv4(), user_id: req.user.id, role: req.user.role })
        .select()
        .single();

      return res.json({ success: true, onboarding: created, completed: false });
    }

    res.json({ success: true, onboarding: data, completed: data.onboarding_completed });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================
// MARK ONBOARDING STEP COMPLETE
// @route PUT /api/onboarding/step
// Body: { step: "profile_completed" | "address_added" | etc }
// ============================================================
const markStepComplete = async (req, res) => {
  try {
    const { step } = req.body;
    const role = req.user.role;

    const validSteps = {
      customer: ["profile_completed", "address_added"],
      vendor: ["business_profile_completed", "documents_uploaded", "verification_submitted", "first_product_added"],
      rider: ["identity_submitted", "availability_set"],
    };

    const allowed = validSteps[role] || [];
    if (!allowed.includes(step)) {
      return res.status(400).json({ success: false, message: `Step "${step}" is not valid for role "${role}".` });
    }

    const { data: existing } = await adminClient
      .from("onboarding_progress")
      .select("*")
      .eq("user_id", req.user.id)
      .single();

    if (!existing) {
      await adminClient.from("onboarding_progress").insert({
        id: uuidv4(), user_id: req.user.id, role, [step]: true,
      });
    } else {
      await adminClient.from("onboarding_progress").update({
        [step]: true, updated_at: new Date().toISOString(),
      }).eq("user_id", req.user.id);
    }

    // Check if all steps for this role are complete
    const updated = await adminClient.from("onboarding_progress").select("*").eq("user_id", req.user.id).single();
    const progress = updated.data;

    let isComplete = false;
    if (role === "customer") isComplete = progress.profile_completed && progress.address_added;
    if (role === "vendor") isComplete = progress.business_profile_completed && progress.documents_uploaded && progress.verification_submitted && progress.first_product_added;
    if (role === "rider") isComplete = progress.identity_submitted && progress.availability_set;

    if (isComplete && !progress.onboarding_completed) {
      await adminClient.from("onboarding_progress").update({
        onboarding_completed: true,
        completed_at: new Date().toISOString(),
      }).eq("user_id", req.user.id);
    }

    res.json({ success: true, message: `Step "${step}" marked complete.`, onboarding_completed: isComplete });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================
// VENDOR REAPPLICATION
// @route POST /api/onboarding/vendor/reapply
// ============================================================
const reapplyVendor = async (req, res) => {
  try {
    const { data: vendor } = await adminClient
      .from("vendors")
      .select("id, status, reapplication_count")
      .eq("user_id", req.user.id)
      .single();

    if (!vendor) return res.status(404).json({ success: false, message: "Vendor profile not found." });
    if (vendor.status !== "rejected") return res.status(400).json({ success: false, message: "Only rejected vendors can reapply." });
    if (vendor.reapplication_count >= 3) return res.status(400).json({ success: false, message: "Maximum reapplication attempts reached. Contact support." });

    await adminClient.from("vendors").update({
      status: "pending",
      rejection_reason: null,
      reapplication_count: vendor.reapplication_count + 1,
      last_reapplied_at: new Date().toISOString(),
    }).eq("user_id", req.user.id);

    // Notify admin
    await notifyAdmins(
      "Vendor Reapplication",
      `A vendor has reapplied after rejection. Review #${vendor.reapplication_count + 1}.`
    );

    res.json({ success: true, message: "Reapplication submitted. We will review your account again." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================
// RIDER REAPPLICATION
// @route POST /api/onboarding/rider/reapply
// ============================================================
const reapplyRider = async (req, res) => {
  try {
    const { data: rider } = await adminClient
      .from("riders")
      .select("id, status, reapplication_count")
      .eq("user_id", req.user.id)
      .single();

    if (!rider) return res.status(404).json({ success: false, message: "Rider profile not found." });
    if (rider.status !== "rejected") return res.status(400).json({ success: false, message: "Only rejected riders can reapply." });
    if (rider.reapplication_count >= 3) return res.status(400).json({ success: false, message: "Maximum reapplication attempts reached. Contact support." });

    await adminClient.from("riders").update({
      status: "pending",
      rejection_reason: null,
      reapplication_count: rider.reapplication_count + 1,
      last_reapplied_at: new Date().toISOString(),
    }).eq("user_id", req.user.id);

    await notifyAdmins(
      "Rider Reapplication",
      `A rider has reapplied after rejection. Review #${rider.reapplication_count + 1}.`
    );

    res.json({ success: true, message: "Reapplication submitted." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { getOnboardingStatus, markStepComplete, reapplyVendor, reapplyRider };
