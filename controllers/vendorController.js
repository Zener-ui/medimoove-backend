const { adminClient } = require("../config/db");
const { v4: uuidv4 } = require("uuid");
const { checkTermsAccepted } = require("../utils/checkTermsAccepted");

// Never trust the frontend dropdown alone — this is the actual
// enforcement point. A direct API call (Postman, curl) with an
// arbitrary category string is rejected here regardless of what the
// frontend sent.
const validateVendorCategory = async (category) => {
  const normalized = String(category || "").trim().toLowerCase();
  if (!normalized) return null;

  const { data, error } = await adminClient
    .from("product_categories")
    .select("id, name, slug")
    .eq("is_active", true)
    .eq("slug", normalized)
    .maybeSingle();

  if (error) throw error;
  return data || null;
};

// @route POST /api/vendors/register
const registerVendor = async (req, res) => {
  try {
    const {
      business_name, category, location, address,
      phone, whatsapp, cac_number, location_lat, location_lng,
    } = req.body;

    const categoryRecord = await validateVendorCategory(category);
    if (!categoryRecord) {
      return res.status(400).json({ success: false, message: "Please select a valid business category." });
    }

    const terms = await checkTermsAccepted(req.user.id);
    if (!terms.accepted) {
      return res.status(400).json({ success: false, message: terms.message });
    }

    const { data: existing } = await adminClient
      .from("vendors")
      .select("id")
      .eq("user_id", req.user.id)
      .single();

    if (existing) {
      return res.status(409).json({ success: false, message: "Vendor profile already exists." });
    }

    const { data, error } = await adminClient
      .from("vendors")
      .insert({
        id: uuidv4(),
        user_id: req.user.id,
        business_name,
        category: categoryRecord.slug,
        location,
        address,
        phone,
        whatsapp,
        cac_number: cac_number || null,
        location_lat: location_lat ?? null,
        location_lng: location_lng ?? null,
        is_verified: false,
        plan: "basic",
        rating: 0,
        strike_count: 0,
        status: "pending",
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({ success: true, vendor: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/vendors
const getAllVendors = async (req, res) => {
  try {
    const { category, location, search } = req.query;

    let query = adminClient
      .from("vendors")
      .select("id, business_name, category, location, address, rating, is_verified, plan, logo_url")
      .eq("status", "approved");

    if (category) query = query.eq("category", category);
    if (location) query = query.ilike("location", `%${location}%`);
    if (search) query = query.ilike("business_name", `%${search}%`);

    // Premium vendors first
    query = query.order("plan", { ascending: false }).order("rating", { ascending: false });

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, vendors: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/vendors/:id
const getVendorById = async (req, res) => {
  try {
    const { data, error } = await adminClient
      .from("vendors")
      .select("*, users!user_id(full_name, email)")
      .eq("id", req.params.id)
      .eq("status", "approved")
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, message: "Vendor not found." });
    }

    // Store profile page shows a delivery-radius figure — this comes
    // from the same per-region delivery_settings source of truth used
    // everywhere else (deliveryController.getDeliverySettings), unless
    // this vendor has set their own (smaller) override.
    let delivery_radius_km = 30;
    if (data.region_id) {
      const { data: settings } = await adminClient
        .from("delivery_settings")
        .select("maximum_delivery_radius")
        .eq("region_id", data.region_id)
        .single();
      if (settings?.maximum_delivery_radius) delivery_radius_km = settings.maximum_delivery_radius;
    }
    if (data.delivery_radius_km && data.delivery_radius_km < delivery_radius_km) {
      delivery_radius_km = data.delivery_radius_km;
    }

    // Direct Call/WhatsApp contact is only unlocked once a customer has
    // actually placed an order with this store — browsing customers
    // can't skip straight to contacting a vendor directly and paying
    // outside the platform, bypassing Fidelx's commission. This is
    // enforced here, not just hidden in the UI, since the phone/whatsapp
    // fields are stripped from the response itself for anyone who
    // doesn't qualify.
    const isOwnStore = req.user?.role === "vendor" && data.user_id === req.user.id;
    const isAdmin = req.user?.role === "admin";
    let hasOrdered = false;
    if (req.user?.role === "customer") {
      const { count } = await adminClient
        .from("sub_orders")
        .select("id, orders!inner(customer_id)", { count: "exact", head: true })
        .eq("vendor_id", data.id)
        .eq("orders.customer_id", req.user.id);
      hasOrdered = (count || 0) > 0;
    }

    const contactUnlocked = isOwnStore || isAdmin || hasOrdered;
    const vendor = { ...data, delivery_radius_km, contact_unlocked: contactUnlocked };
    if (!contactUnlocked) {
      delete vendor.phone;
      delete vendor.whatsapp;
    }

    res.json({ success: true, vendor });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/vendors/me
const getMyVendorProfile = async (req, res) => {
  try {
    const { data, error } = await adminClient
      .from("vendors")
      .select("*")
      .eq("user_id", req.user.id)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, message: "Vendor profile not found." });
    }

    res.json({ success: true, vendor: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/vendors/me
const updateVendorProfile = async (req, res) => {
  try {
    const { business_name, category, location, address, phone, whatsapp, description, location_lat, location_lng, delivery_radius_km } = req.body;

    const updates = { business_name, location, address, phone, whatsapp };
    if (description !== undefined) updates.description = description;
    // Only touch category if it was actually sent — an unrelated
    // profile edit (e.g. just changing phone number) shouldn't force
    // re-validation of a field that wasn't part of the request.
    if (category !== undefined) {
      const categoryRecord = await validateVendorCategory(category);
      if (!categoryRecord) {
        return res.status(400).json({ success: false, message: "Please select a valid business category." });
      }
      updates.category = categoryRecord.slug;
    }
    // Only touch coordinates if actually provided — an unrelated profile
    // edit (e.g. just changing phone number) shouldn't accidentally wipe
    // out a previously-set location.
    if (location_lat !== undefined) updates.location_lat = location_lat;
    if (location_lng !== undefined) updates.location_lng = location_lng;

    // A vendor may narrow their OWN delivery radius below the region
    // cap (e.g. a small kitchen with one bike) but never exceed it —
    // the platform-wide 30km limit is a logistics decision, not
    // something an individual store can override upward. null/empty
    // clears the override back to "use the region default".
    if (delivery_radius_km !== undefined) {
      if (delivery_radius_km === null || delivery_radius_km === "") {
        updates.delivery_radius_km = null;
      } else {
        const radius = Number(delivery_radius_km);
        if (!Number.isFinite(radius) || radius <= 0) {
          return res.status(400).json({ success: false, message: "Delivery radius must be a positive number." });
        }
        const { data: existingVendor } = await adminClient.from("vendors").select("region_id").eq("user_id", req.user.id).single();
        const { data: settings } = await adminClient.from("delivery_settings").select("maximum_delivery_radius").eq("region_id", existingVendor?.region_id).single();
        const regionMax = settings?.maximum_delivery_radius ?? 30;
        if (radius > regionMax) {
          return res.status(400).json({ success: false, message: `Delivery radius can't exceed the platform maximum of ${regionMax}km for your region.` });
        }
        updates.delivery_radius_km = radius;
      }
    }

    const { data, error } = await adminClient
      .from("vendors")
      .update(updates)
      .eq("user_id", req.user.id)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, vendor: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/vendors/me/earnings
const getVendorEarnings = async (req, res) => {
  try {
    const { data: vendor } = await adminClient
      .from("vendors")
      .select("id")
      .eq("user_id", req.user.id)
      .single();

    if (!vendor) return res.status(404).json({ success: false, message: "Vendor profile not found." });

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

    // Get sub-order history for this vendor
    const { data: subOrders, error } = await adminClient
      .from("sub_orders")
      .select("id, vendor_payout, status, created_at, withdrawal_available_at, order_id")
      .eq("vendor_id", vendor.id)
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
      orders: subOrders || [],
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/vendors/me/referrals
// Minimal reporting on the referral loop: how many customers came in
// through this vendor's shared storefront link, and roughly who/when.
// Not tied to any reward logic yet — this is purely "does sharing your
// link actually work," which is also the vendor's own best evidence
// for whether it's worth doing.
const getReferralStats = async (req, res) => {
  try {
    const { data: vendor } = await adminClient
      .from("vendors")
      .select("id")
      .eq("user_id", req.user.id)
      .single();

    if (!vendor) return res.status(404).json({ success: false, message: "Vendor profile not found." });

    const { data: referred, error, count } = await adminClient
      .from("users")
      .select("id, full_name, created_at", { count: "exact" })
      .eq("referred_by_vendor_id", vendor.id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      total_referred: count ?? (referred || []).length,
      // Recent referrals, first name only — a vendor doesn't need a
      // referred customer's full identity to see the count is real.
      recent_referrals: (referred || []).slice(0, 10).map((u) => ({
        first_name: (u.full_name || "").trim().split(" ")[0] || "Someone",
        joined_at: u.created_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  registerVendor,
  getAllVendors,
  getVendorById,
  getMyVendorProfile,
  updateVendorProfile,
  getVendorEarnings,
  getReferralStats,
};
