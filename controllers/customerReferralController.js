const { adminClient } = require("../config/db");
const { v4: uuidv4 } = require("uuid");

const SETTINGS_ID = "00000000-0000-0000-0000-000000000003";

// @route GET /api/admin/referral-settings
const getReferralSettings = async (req, res) => {
  try {
    const { data, error } = await adminClient
      .from("referral_settings")
      .select("threshold, rewards_enabled, updated_at")
      .eq("id", SETTINGS_ID)
      .single();
    if (error) throw error;
    res.json({ success: true, settings: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/admin/referral-settings
// Turning rewards_enabled off does NOT stop attribution or counting —
// referrals keep being tracked normally either way. It only stops new
// milestones from firing, and flips what the customer sees on their
// own referral screen to "rewards are paused" instead of hiding the
// feature outright — sharing/tracking keep working either way.
const updateReferralSettings = async (req, res) => {
  try {
    const { threshold, rewards_enabled } = req.body;
    const updates = {};
    if (threshold !== undefined) {
      if (!Number.isInteger(threshold) || threshold <= 0) {
        return res.status(400).json({ success: false, message: "threshold must be a positive whole number." });
      }
      updates.threshold = threshold;
    }
    if (rewards_enabled !== undefined) updates.rewards_enabled = !!rewards_enabled;
    updates.updated_at = new Date().toISOString();

    const { data, error } = await adminClient
      .from("referral_settings")
      .update(updates)
      .eq("id", SETTINGS_ID)
      .select()
      .single();
    if (error) throw error;

    res.json({ success: true, settings: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/admin/referral-milestones?reward_sent=false
const getReferralMilestones = async (req, res) => {
  try {
    let query = adminClient
      .from("referral_milestones")
      .select("*, referrer:referrer_id(id, full_name, email, phone)")
      .order("reached_at", { ascending: false });

    if (req.query.reward_sent !== undefined) {
      query = query.eq("reward_sent", req.query.reward_sent === "true");
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, milestones: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/admin/referral-milestones/:id/reward
// Creates a one-off coupon and sends it directly to the referrer who
// crossed this milestone. The coupon is technically restricted to that
// customer in the coupon engine, so leaking the code cannot let another
// customer redeem it.
const sendReferralReward = async (req, res) => {
  try {
    const { type, value, max_discount_amount, expires_at } = req.body;
    if (!["percentage", "fixed", "free_delivery"].includes(type)) {
      return res.status(400).json({ success: false, message: "type must be percentage, fixed, or free_delivery." });
    }
    if (type !== "free_delivery" && (!value || value <= 0)) {
      return res.status(400).json({ success: false, message: "value must be a positive number for this coupon type." });
    }

    const { data: milestone, error: milestoneError } = await adminClient
      .from("referral_milestones")
      .select("id, referrer_id, milestone_count, reward_sent")
      .eq("id", req.params.id)
      .single();

    if (milestoneError || !milestone) return res.status(404).json({ success: false, message: "Milestone not found." });
    if (milestone.reward_sent) return res.status(400).json({ success: false, message: "A reward was already sent for this milestone." });

    const code = `REF-${uuidv4().replace(/-/g, "").slice(0, 10).toUpperCase()}`;

    const { data: coupon, error: couponError } = await adminClient
      .from("coupons")
      .insert({
        id: uuidv4(),
        code,
        description: `Referral reward — ${milestone.milestone_count} referrals`,
        type,
        value: type === "free_delivery" ? null : value,
        max_discount_amount: max_discount_amount || null,
        min_order_amount: 0,
        vendor_id: null,
        restricted_customer_id: milestone.referrer_id,
        usage_limit: 1,
        usage_limit_per_customer: 1,
        expires_at: expires_at || null,
        created_by: req.user.id,
      })
      .select()
      .single();

    if (couponError) throw couponError;

    await adminClient
      .from("referral_milestones")
      .update({
        reward_sent: true,
        reward_sent_at: new Date().toISOString(),
        reward_sent_by: req.user.id,
        coupon_id: coupon.id,
      })
      .eq("id", milestone.id);

    const rewardDescription =
      type === "percentage" ? `${value}% off` : type === "fixed" ? `₦${value} off` : "free delivery";

    await adminClient.from("notifications").insert({
      id: uuidv4(),
      user_id: milestone.referrer_id,
      title: "🎉 Your referral reward is here!",
      body: `You've referred ${milestone.milestone_count} friends who've now shopped on Fidelx — thank you! Here's your reward: ${rewardDescription} with code ${code}. Use it on your next order.`,
      is_read: false,
    });

    res.json({ success: true, message: "Reward sent.", coupon });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/customers/me/referrals
// A customer's own view of their referral program: their progress,
// and whether rewards are currently active — needed so the frontend
// can show an honest "rewards paused" state instead of a progress bar
// that silently goes nowhere when an admin turns rewards off.
const getMyReferralStats = async (req, res) => {
  try {
    const { count: totalCredited } = await adminClient
      .from("users")
      .select("id", { count: "exact", head: true })
      .eq("referred_by_customer_id", req.user.id)
      .eq("referral_credited", true);

    const { count: totalReferred } = await adminClient
      .from("users")
      .select("id", { count: "exact", head: true })
      .eq("referred_by_customer_id", req.user.id);

    const { data: settings } = await adminClient
      .from("referral_settings")
      .select("threshold, rewards_enabled")
      .eq("id", SETTINGS_ID)
      .single();

    const threshold = settings?.threshold || 5;
    const credited = totalCredited || 0;
    const progressTowardNext = credited % threshold;

    res.json({
      success: true,
      total_credited: credited,
      // People who signed up through the link but haven't completed
      // their first order yet — not counted toward rewards, but worth
      // showing so the number isn't confusingly lower than what they
      // remember sharing.
      total_pending: Math.max((totalReferred || 0) - credited, 0),
      threshold,
      progress_toward_next: progressTowardNext,
      rewards_enabled: settings?.rewards_enabled ?? true,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  getReferralSettings,
  updateReferralSettings,
  getReferralMilestones,
  sendReferralReward,
  getMyReferralStats,
};
