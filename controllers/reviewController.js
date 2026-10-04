const { adminClient } = require("../config/db");
const { v4: uuidv4 } = require("uuid");

// "Ada Okafor" -> "Ada O." — reviews show first name + last initial
// rather than a customer's full name, per the existing privacy
// convention used for customer-facing display elsewhere in the app.
const anonymizeName = (fullName) => {
  if (!fullName) return "Customer";
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
};

const recalculateVendorRating = async (vendorId) => {
  const { data: vendorReviews } = await adminClient
    .from("reviews")
    .select("vendor_rating")
    .eq("vendor_id", vendorId)
    .eq("is_removed", false)
    .not("vendor_rating", "is", null);

  const ratings = vendorReviews || [];
  const avg = ratings.length ? ratings.reduce((sum, r) => sum + r.vendor_rating, 0) / ratings.length : 0;

  await adminClient
    .from("vendors")
    .update({ rating: parseFloat(avg.toFixed(1)) })
    .eq("id", vendorId);
};

const recalculateRiderRating = async (riderId) => {
  if (!riderId) return;
  const { data: riderReviews } = await adminClient
    .from("reviews")
    .select("rider_rating")
    .eq("rider_id", riderId)
    .eq("is_removed", false)
    .not("rider_rating", "is", null);

  const ratings = riderReviews || [];
  const avg = ratings.length ? ratings.reduce((sum, r) => sum + r.rider_rating, 0) / ratings.length : 0;

  await adminClient
    .from("riders")
    .update({ rating: parseFloat(avg.toFixed(1)) })
    .eq("id", riderId);
};

// @route POST /api/reviews
// Reviews attach to a SUB-order, not the parent order — the reviews
// table schema already reflects this (sub_order_id with a UNIQUE
// constraint, one review per vendor/rider pairing), since a single
// order can span multiple vendors.
const createReview = async (req, res) => {
  try {
    const { sub_order_id, vendor_rating, rider_rating, title, comment, photo_urls } = req.body;

    if (!vendor_rating || vendor_rating < 1 || vendor_rating > 5) {
      return res.status(400).json({ success: false, message: "A 1-5 star rating is required." });
    }
    if (photo_urls && (!Array.isArray(photo_urls) || photo_urls.length > 4)) {
      return res.status(400).json({ success: false, message: "Up to 4 photos are allowed." });
    }

    const { data: subOrder } = await adminClient
      .from("sub_orders")
      .select("id, status, vendor_id, rider_id, orders(customer_id)")
      .eq("id", sub_order_id)
      .single();

    if (!subOrder) return res.status(404).json({ success: false, message: "Order not found." });
    if (subOrder.orders?.customer_id !== req.user.id) {
      return res.status(403).json({ success: false, message: "Not authorized." });
    }
    if (subOrder.status !== "DELIVERED") {
      return res.status(400).json({ success: false, message: "Order not yet delivered." });
    }

    // Check no existing review (the sub_order_id UNIQUE constraint backs
    // this up at the DB level too)
    const { data: existing } = await adminClient
      .from("reviews")
      .select("id")
      .eq("sub_order_id", sub_order_id)
      .single();

    if (existing) return res.status(409).json({ success: false, message: "Review already submitted. You can edit your existing review instead." });

    const { data: review, error } = await adminClient
      .from("reviews")
      .insert({
        id: uuidv4(),
        sub_order_id,
        customer_id: req.user.id,
        vendor_id: subOrder.vendor_id,
        rider_id: subOrder.rider_id,
        vendor_rating,
        rider_rating: subOrder.rider_id ? rider_rating || null : null,
        title: title || null,
        comment,
        photo_urls: photo_urls?.length ? photo_urls : null,
      })
      .select()
      .single();

    if (error) throw error;

    await recalculateVendorRating(subOrder.vendor_id);
    if (subOrder.rider_id) await recalculateRiderRating(subOrder.rider_id);

    // Notify the vendor a new review landed on their store.
    const { data: vendor } = await adminClient.from("vendors").select("user_id, business_name").eq("id", subOrder.vendor_id).single();
    if (vendor?.user_id) {
      await adminClient.from("notifications").insert({
        id: uuidv4(),
        user_id: vendor.user_id,
        title: "New Review Received",
        body: `A customer left a ${vendor_rating}-star review for ${vendor.business_name}.`,
        is_read: false,
      });
    }

    res.status(201).json({ success: true, review });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/reviews/:id
// Customers may edit their own review (rating/title/comment) — but
// never create a second one for the same order (the sub_order_id
// UNIQUE constraint plus the createReview check above already
// prevent that).
const updateReview = async (req, res) => {
  try {
    const { vendor_rating, rider_rating, title, comment, photo_urls } = req.body;

    const { data: review } = await adminClient
      .from("reviews")
      .select("id, customer_id, vendor_id, rider_id")
      .eq("id", req.params.id)
      .single();

    if (!review) return res.status(404).json({ success: false, message: "Review not found." });
    if (review.customer_id !== req.user.id) {
      return res.status(403).json({ success: false, message: "You can only edit your own review." });
    }

    if (vendor_rating && (vendor_rating < 1 || vendor_rating > 5)) {
      return res.status(400).json({ success: false, message: "Rating must be between 1 and 5." });
    }
    if (photo_urls && (!Array.isArray(photo_urls) || photo_urls.length > 4)) {
      return res.status(400).json({ success: false, message: "Up to 4 photos are allowed." });
    }

    const updates = { updated_at: new Date().toISOString() };
    if (vendor_rating) updates.vendor_rating = vendor_rating;
    if (rider_rating !== undefined) updates.rider_rating = rider_rating;
    if (title !== undefined) updates.title = title;
    if (comment !== undefined) updates.comment = comment;
    if (photo_urls !== undefined) updates.photo_urls = photo_urls?.length ? photo_urls : null;

    const { data: updated, error } = await adminClient
      .from("reviews")
      .update(updates)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw error;

    await recalculateVendorRating(review.vendor_id);
    if (review.rider_id) await recalculateRiderRating(review.rider_id);

    res.json({ success: true, review: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/reviews/vendor/:vendorId
// params: { page, limit, sort: 'recent'|'highest'|'lowest' }
// Every review in this table is already from a verified completed
// purchase (createReview enforces DELIVERED + ownership before
// insert), so "Verified Purchase" is unconditionally true here —
// there is no separate flag to filter on.
const getVendorReviews = async (req, res) => {
  try {
    const { page = 1, limit = 10, sort = "recent", with_photos } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    let query = adminClient
      .from("reviews")
      .select("id, vendor_rating, title, comment, photo_urls, helpful_count, vendor_reply, vendor_reply_at, created_at, updated_at, users(full_name)", { count: "exact" })
      .eq("vendor_id", req.params.vendorId)
      .eq("is_removed", false);

    if (with_photos === "true") {
      query = query.not("photo_urls", "is", null);
    }

    switch (sort) {
      case "highest":
        query = query.order("vendor_rating", { ascending: false }).order("created_at", { ascending: false });
        break;
      case "lowest":
        query = query.order("vendor_rating", { ascending: true }).order("created_at", { ascending: false });
        break;
      default:
        query = query.order("created_at", { ascending: false });
    }

    query = query.range(offset, offset + limitNum - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    const reviews = (data || []).map((r) => ({
      id: r.id,
      rating: r.vendor_rating,
      title: r.title,
      comment: r.comment,
      photo_urls: r.photo_urls || [],
      helpful_count: r.helpful_count,
      vendor_reply: r.vendor_reply,
      vendor_reply_at: r.vendor_reply_at,
      created_at: r.created_at,
      edited: !!r.updated_at,
      customer_name: anonymizeName(r.users?.full_name),
      verified_purchase: true,
    }));

    res.json({
      success: true,
      reviews,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count || 0,
        pages: Math.ceil((count || 0) / limitNum),
        has_next: offset + limitNum < (count || 0),
        has_prev: pageNum > 1,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/reviews/vendor/:vendorId/summary
// Average rating, total count, and star-by-star breakdown — computed
// separately from the paginated list above so the breakdown reflects
// ALL reviews, not just the current page.
const getVendorRatingSummary = async (req, res) => {
  try {
    const { data, error } = await adminClient
      .from("reviews")
      .select("vendor_rating, vendor_reply")
      .eq("vendor_id", req.params.vendorId)
      .eq("is_removed", false)
      .not("vendor_rating", "is", null);

    if (error) throw error;

    const ratings = data || [];
    const total = ratings.length;
    const average = total ? ratings.reduce((sum, r) => sum + r.vendor_rating, 0) / total : 0;

    const breakdown = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    ratings.forEach((r) => { breakdown[r.vendor_rating] = (breakdown[r.vendor_rating] || 0) + 1; });

    // Response rate: % of reviews this store has replied to. Only
    // meaningful field of the two originally requested ("response
    // rate", "average prep time") we actually have real data for —
    // prep time would need per-status-change timestamps that don't
    // exist anywhere in the schema, so it's still omitted rather than
    // faked.
    const responseRate = total ? Math.round((ratings.filter((r) => !!r.vendor_reply).length / total) * 100) : null;

    const { count: completedOrders } = await adminClient
      .from("sub_orders")
      .select("id", { count: "exact", head: true })
      .eq("vendor_id", req.params.vendorId)
      .eq("status", "DELIVERED");

    res.json({
      success: true,
      summary: {
        average: parseFloat(average.toFixed(1)),
        total_reviews: total,
        breakdown,
        completed_orders: completedOrders || 0,
        response_rate: responseRate,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/reviews/:id/helpful
// One vote per (review, customer) — enforced by the review_helpful_votes
// UNIQUE constraint, not just this check, so a race between two
// requests from the same person still can't double-count.
const markReviewHelpful = async (req, res) => {
  try {
    // Vote insertion and counter increment happen in one PostgreSQL
    // transaction. This prevents lost increments and also prevents a
    // successful vote from being left behind if the counter update fails.
    const { data, error } = await adminClient.rpc("mark_review_helpful_atomic", {
      p_review_id: req.params.id,
      p_user_id: req.user.id,
    });

    if (error) {
      if (error.message?.toLowerCase().includes("not found")) {
        return res.status(404).json({ success: false, message: "Review not found." });
      }
      throw error;
    }

    const result = Array.isArray(data) ? data[0] : data;
    if (!result) throw new Error("Unable to record helpful vote.");

    if (!result.voted) {
      return res.status(409).json({
        success: false,
        message: "You've already marked this review as helpful.",
        helpful_count: Number(result.helpful_count || 0),
      });
    }

    res.json({ success: true, helpful_count: Number(result.helpful_count || 0) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/reviews/:id/reply  [vendor]
// A vendor may reply to a review about their own store — but never
// edit or remove the customer's rating/comment itself.
const replyToReview = async (req, res) => {
  try {
    const { reply } = req.body;
    if (!reply || !reply.trim()) {
      return res.status(400).json({ success: false, message: "Reply cannot be empty." });
    }

    const { data: vendor } = await adminClient.from("vendors").select("id").eq("user_id", req.user.id).single();
    if (!vendor) return res.status(404).json({ success: false, message: "Vendor profile not found." });

    const { data: review } = await adminClient.from("reviews").select("id, vendor_id, customer_id").eq("id", req.params.id).single();
    if (!review) return res.status(404).json({ success: false, message: "Review not found." });
    if (review.vendor_id !== vendor.id) {
      return res.status(403).json({ success: false, message: "You can only reply to reviews of your own store." });
    }

    const { data: updated, error } = await adminClient
      .from("reviews")
      .update({ vendor_reply: reply.trim(), vendor_reply_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw error;

    // Notify the customer their review got a reply.
    const { data: vendorInfo } = await adminClient.from("vendors").select("business_name").eq("id", vendor.id).single();
    if (review.customer_id) {
      await adminClient.from("notifications").insert({
        id: uuidv4(),
        user_id: review.customer_id,
        title: "Store Replied to Your Review",
        body: `${vendorInfo?.business_name || "A store"} replied to your review.`,
        is_read: false,
      });
    }

    res.json({ success: true, review: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/reviews/vendor/me  [vendor]
// The vendor's own reviews dashboard — same shape as getVendorReviews
// but resolved from the authenticated vendor rather than a public id.
const getMyVendorReviews = async (req, res) => {
  try {
    const { data: vendor } = await adminClient.from("vendors").select("id").eq("user_id", req.user.id).single();
    if (!vendor) return res.status(404).json({ success: false, message: "Vendor profile not found." });
    req.params.vendorId = vendor.id;
    return getVendorReviews(req, res);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================
// ADMIN MODERATION
// ============================================================

// @route GET /api/admin/reviews
const getAllReviewsAdmin = async (req, res) => {
  try {
    const { flagged } = req.query;
    let query = adminClient
      .from("reviews")
      .select("*, users(full_name), vendors(business_name)")
      .order("created_at", { ascending: false });

    if (flagged === "true") query = query.eq("is_flagged", true);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, reviews: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/admin/reviews/:id/flag
const flagReview = async (req, res) => {
  try {
    await adminClient.from("reviews").update({ is_flagged: true }).eq("id", req.params.id);
    res.json({ success: true, message: "Review flagged for review." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/admin/reviews/:id/remove
// Soft-delete: hides the review from customers and excludes it from
// the store's rating average, without touching any OTHER genuine
// review or rating.
const removeReview = async (req, res) => {
  try {
    const { reason } = req.body;
    const { data: review } = await adminClient.from("reviews").select("vendor_id, rider_id").eq("id", req.params.id).single();
    if (!review) return res.status(404).json({ success: false, message: "Review not found." });

    await adminClient.from("reviews").update({
      is_removed: true,
      removed_reason: reason || null,
    }).eq("id", req.params.id);

    await recalculateVendorRating(review.vendor_id);
    if (review.rider_id) await recalculateRiderRating(review.rider_id);

    res.json({ success: true, message: "Review removed." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/admin/reviews/:id/restore
const restoreReview = async (req, res) => {
  try {
    const { data: review } = await adminClient.from("reviews").select("vendor_id, rider_id").eq("id", req.params.id).single();
    if (!review) return res.status(404).json({ success: false, message: "Review not found." });

    await adminClient.from("reviews").update({ is_removed: false, is_flagged: false, removed_reason: null }).eq("id", req.params.id);

    await recalculateVendorRating(review.vendor_id);
    if (review.rider_id) await recalculateRiderRating(review.rider_id);

    res.json({ success: true, message: "Review restored." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  createReview,
  updateReview,
  getVendorReviews,
  getVendorRatingSummary,
  markReviewHelpful,
  replyToReview,
  getMyVendorReviews,
  getAllReviewsAdmin,
  flagReview,
  removeReview,
  restoreReview,
};
