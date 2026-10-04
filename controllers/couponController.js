const { adminClient } = require("../config/db");
const { v4: uuidv4 } = require("uuid");

// Shared by the checkout preview (validateCoupon) and actual order
// creation (subOrderController) — both must agree on what a coupon
// is worth, and order creation must NEVER trust a client-supplied
// discount figure, only re-derive it here itself.
//
// IMPORTANT: this never touches platform fee logic. The returned
// discount is subtracted only from the final customer-facing total
// in subOrderController — platform_fee and vendor_payout are
// computed on the undiscounted subtotal exactly as before.
const resolveCoupon = async ({ code, customerId, vendorId, subtotal, deliveryFee, skipVendorEligibility = false }) => {
  if (!code) return { valid: false, message: "No coupon code provided." };

  const { data: coupon } = await adminClient
    .from("coupons")
    .select("*")
    .ilike("code", code.trim())
    .single();

  if (!coupon) return { valid: false, message: "Invalid coupon code." };
  if (!coupon.is_active) return { valid: false, message: "This coupon is no longer active." };
  if (coupon.restricted_customer_id && coupon.restricted_customer_id !== customerId) {
    return { valid: false, message: "This coupon is reserved for another customer." };
  }

  const now = new Date();
  if (coupon.starts_at && new Date(coupon.starts_at) > now) {
    return { valid: false, message: "This coupon isn't active yet." };
  }
  if (coupon.expires_at && new Date(coupon.expires_at) < now) {
    return { valid: false, message: "This coupon has expired." };
  }
  if (!skipVendorEligibility && coupon.vendor_id && coupon.vendor_id !== vendorId) {
    return { valid: false, message: "This coupon isn't valid for this store." };
  }
  if (subtotal < (coupon.min_order_amount || 0)) {
    return { valid: false, message: `This coupon requires a minimum order of ₦${coupon.min_order_amount.toLocaleString()}.` };
  }
  if (coupon.usage_limit && coupon.times_used >= coupon.usage_limit) {
    return { valid: false, message: "This coupon has reached its usage limit." };
  }
  if (customerId) {
    const { count } = await adminClient
      .from("coupon_redemptions")
      .select("id", { count: "exact", head: true })
      .eq("coupon_id", coupon.id)
      .eq("customer_id", customerId);
    if ((count || 0) >= (coupon.usage_limit_per_customer ?? 1)) {
      return { valid: false, message: "You've already used this coupon." };
    }
  }

  let discount_amount = 0;
  if (coupon.type === "percentage") {
    discount_amount = Math.round(subtotal * (coupon.value / 100));
    if (coupon.max_discount_amount) discount_amount = Math.min(discount_amount, coupon.max_discount_amount);
  } else if (coupon.type === "fixed") {
    discount_amount = Math.min(coupon.value, subtotal);
  } else if (coupon.type === "free_delivery") {
    // A free-delivery coupon must only be redeemable when there is an
    // actual delivery charge to waive. Otherwise a customer could use
    // up the coupon on a pickup order (or another zero-delivery case)
    // without receiving any benefit.
    const eligibleDeliveryFee = Number(deliveryFee || 0);
    if (eligibleDeliveryFee <= 0) {
      return { valid: false, message: "This coupon is only valid on delivery orders." };
    }
    discount_amount = eligibleDeliveryFee;
  }

  return { valid: true, coupon, discount_amount };
};

// @route POST /api/coupons/validate  [customer]
// Preview only — does NOT redeem. Real redemption happens inside
// order creation, where the discount is recomputed server-side again
// rather than trusting whatever this endpoint returned earlier.
const validateCoupon = async (req, res) => {
  try {
    const { code, vendor_id, subtotal, delivery_fee } = req.body;
    if (!code || subtotal === undefined) {
      return res.status(400).json({ success: false, message: "code and subtotal are required." });
    }

    const result = await resolveCoupon({
      code, customerId: req.user.id, vendorId: vendor_id,
      subtotal: Number(subtotal), deliveryFee: Number(delivery_fee || 0),
    });

    if (!result.valid) return res.status(400).json({ success: false, message: result.message });

    res.json({
      success: true,
      discount_amount: result.discount_amount,
      coupon: { id: result.coupon.id, code: result.coupon.code, type: result.coupon.type, description: result.coupon.description },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/coupons  [admin]
const createCoupon = async (req, res) => {
  try {
    const { code, description, type, value, max_discount_amount, min_order_amount, vendor_id, usage_limit, usage_limit_per_customer, starts_at, expires_at, restricted_customer_id } = req.body;

    if (!code || !type) return res.status(400).json({ success: false, message: "code and type are required." });
    if (!["percentage", "fixed", "free_delivery"].includes(type)) {
      return res.status(400).json({ success: false, message: "type must be percentage, fixed, or free_delivery." });
    }
    if (type !== "free_delivery" && (!value || value <= 0)) {
      return res.status(400).json({ success: false, message: "value must be a positive number for this coupon type." });
    }
    if (type === "percentage" && value > 100) {
      return res.status(400).json({ success: false, message: "A percentage discount can't exceed 100." });
    }

    const { data: coupon, error } = await adminClient
      .from("coupons")
      .insert({
        id: uuidv4(),
        code: code.trim().toUpperCase(),
        description: description || null,
        type,
        value: type === "free_delivery" ? null : value,
        max_discount_amount: max_discount_amount || null,
        min_order_amount: min_order_amount || 0,
        vendor_id: vendor_id || null,
        restricted_customer_id: restricted_customer_id || null,
        usage_limit: usage_limit || null,
        usage_limit_per_customer: usage_limit_per_customer || 1,
        starts_at: starts_at || new Date().toISOString(),
        expires_at: expires_at || null,
        created_by: req.user.id,
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") return res.status(409).json({ success: false, message: "A coupon with this code already exists." });
      throw error;
    }

    res.status(201).json({ success: true, coupon });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/coupons  [admin]
const getAllCoupons = async (req, res) => {
  try {
    const { data, error } = await adminClient
      .from("coupons")
      .select("*, vendors(business_name)")
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ success: true, coupons: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/coupons/:id/toggle  [admin]
const toggleCoupon = async (req, res) => {
  try {
    const { data: coupon } = await adminClient.from("coupons").select("is_active").eq("id", req.params.id).single();
    if (!coupon) return res.status(404).json({ success: false, message: "Coupon not found." });

    const { data: updated, error } = await adminClient
      .from("coupons")
      .update({ is_active: !coupon.is_active })
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, coupon: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { resolveCoupon, validateCoupon, createCoupon, getAllCoupons, toggleCoupon };
