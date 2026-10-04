const { adminClient } = require("../config/db");

// ============================================================
// SEARCH PRODUCTS
// @route GET /api/search/products
// Supports: q, category, category_id, min_price, max_price,
//           sort, page, limit, vendor_id, featured
// ============================================================
const searchProducts = async (req, res) => {
  try {
    const {
      q,
      category,
      category_id,
      min_price,
      max_price,
      sort = "newest",
      page = 1,
      limit = 20,
      vendor_id,
      featured,
      region_id,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    let query = adminClient
      .from("products")
      .select(
        `id, name, description, price, images, stock_quantity,
         is_featured, view_count, created_at,
         vendors!inner(id, business_name, location, rating, is_verified, plan, availability_status, region_id),
         product_categories(name, slug, icon)`,
        { count: "exact" }
      )
      .eq("is_available", true)
      .gt("stock_quantity", 0)
      .is("deleted_at", null)
      .eq("moderation_flag", false)
      .eq("vendors.status", "approved");

    // Text search
    if (q) {
      // Trigram fuzzy matching (fuzzy_search_migration.sql) — falls
      // back to the old exact-substring ILIKE behavior if that
      // migration hasn't been run yet, rather than breaking search
      // entirely on a missing function.
      const { data: fuzzyIds, error: fuzzyError } = await adminClient.rpc("search_products_fuzzy", { p_query: q });
      if (!fuzzyError && fuzzyIds) {
        const ids = fuzzyIds.map((r) => r.id);
        query = query.in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
      } else {
        query = query.or(`name.ilike.%${q}%,description.ilike.%${q}%`);
      }
    }

    // Category filter
    if (category_id) {
      query = query.eq("category_id", category_id);
    } else if (category) {
      query = query.ilike("category", `%${category}%`);
    }

    // Price range
    if (min_price) query = query.gte("price", parseFloat(min_price));
    if (max_price) query = query.lte("price", parseFloat(max_price));

    // Vendor filter
    if (vendor_id) query = query.eq("vendor_id", vendor_id);

    // Featured filter
    if (featured === "true") query = query.eq("is_featured", true);

    // Region filter — filter by vendor region
    if (region_id) {
      query = query.eq("vendors.region_id", region_id);
    }

    // Sorting
    switch (sort) {
      case "price_asc":
        query = query.order("price", { ascending: true });
        break;
      case "price_desc":
        query = query.order("price", { ascending: false });
        break;
      case "rating":
        // Supabase's client doesn't accept "table.column" as a plain
        // string here — ordering by a joined table's column needs the
        // foreignTable option, or Postgres just ignores/errors on the
        // dotted path. This was previously silently broken.
        query = query.order("rating", { foreignTable: "vendors", ascending: false });
        break;
      case "popular":
        query = query.order("view_count", { ascending: false });
        break;
      case "newest":
      default:
        query = query.order("created_at", { ascending: false });
        break;
    }

    // Pagination
    query = query.range(offset, offset + limitNum - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    // Empty state handling
    if (!data || data.length === 0) {
      return res.json({
        success: true,
        products: [],
        pagination: { page: pageNum, limit: limitNum, total: 0, pages: 0 },
        empty_state: q
          ? `No products found for "${q}". Try different keywords.`
          : "No products found in this category.",
      });
    }

    // Increment view count in background (fire and forget)
    const ids = data.map((p) => p.id);
    adminClient.rpc("increment_product_views", { product_ids: ids }).then(() => {}).catch(() => {});

    res.json({
      success: true,
      products: data,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count,
        pages: Math.ceil(count / limitNum),
        has_next: offset + limitNum < count,
        has_prev: pageNum > 1,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================
// SEARCH VENDORS
// @route GET /api/search/vendors
// ============================================================
const searchVendors = async (req, res) => {
  try {
    const {
      q,
      category,
      region_id,
      featured,
      sort = "rating",
      page = 1,
      limit = 20,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    let query = adminClient
      .from("vendors")
      .select("id, business_name, category, location, rating, is_verified, plan, logo_url, availability_status, is_featured", { count: "exact" })
      .eq("status", "approved")
      .is("deleted_at", null);

    if (q) query = query.ilike("business_name", `%${q}%`);
    if (category) query = query.ilike("category", `%${category}%`);
    if (region_id) query = query.eq("region_id", region_id);
    if (featured === "true") query = query.eq("is_featured", true);

    // Premium vendors first, then by sort
    switch (sort) {
      case "rating":
        query = query.order("plan", { ascending: false }).order("rating", { ascending: false });
        break;
      case "newest":
        query = query.order("created_at", { ascending: false });
        break;
      default:
        query = query.order("plan", { ascending: false }).order("rating", { ascending: false });
    }

    query = query.range(offset, offset + limitNum - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({
      success: true,
      vendors: data || [],
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count,
        pages: Math.ceil(count / limitNum),
        has_next: offset + limitNum < count,
        has_prev: pageNum > 1,
      },
      empty_state: !data?.length ? "No vendors found." : null,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================
// GET CATEGORIES
// @route GET /api/search/categories
// ============================================================
const getCategories = async (req, res) => {
  try {
    const { data, error } = await adminClient
      .from("product_categories")
      .select("id, name, slug, icon")
      .eq("is_active", true)
      .order("sort_order", { ascending: true });

    if (error) throw error;
    res.json({ success: true, categories: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================
// GET FEATURED / HOMEPAGE DATA
// @route GET /api/search/homepage
// ============================================================
const getHomepageData = async (req, res) => {
  try {
    const { region_id } = req.query;

    const { data: categories } = await adminClient
      .from("product_categories")
      .select("id, name, slug, icon")
      .eq("is_active", true)
      .order("sort_order")
      .limit(8);

    // Previously this only ever showed vendors an admin had manually
    // flagged is_featured — meaning a brand-new vendor could never
    // appear on the home page at all without someone remembering to
    // flag them by hand. Now: real vendors, grouped by their actual
    // category, ranked by real rating — with created_at as the
    // tiebreaker so brand-new vendors (rating still at the default 0)
    // surface by recency instead of being permanently buried behind
    // any vendor that has ever received a single review.
    const vendorsByCategory = await Promise.all(
      (categories || []).map(async (cat) => {
        let q = adminClient
          .from("vendors")
          .select("id, business_name, category, rating, logo_url, is_verified, availability_status, created_at")
          .eq("status", "approved")
          .eq("category", cat.slug)
          .order("rating", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(6);
        if (region_id) q = q.eq("region_id", region_id);

        const { data: vendors } = await q;
        return { ...cat, vendors: vendors || [] };
      })
    );

    // Same reasoning applied to products: newest first, rather than
    // only ever showing manually-flagged ones — a new vendor's first
    // listed product previously had no path to visibility here either.
    let productQuery = adminClient
      .from("products")
      .select("id, name, price, images, vendors(business_name)")
      .eq("is_available", true)
      .gt("stock_quantity", 0)
      .order("created_at", { ascending: false })
      .limit(8);

    const { data: featuredProducts } = await productQuery;

    res.json({
      success: true,
      categories: vendorsByCategory,
      featured_products: featuredProducts || [],
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { searchProducts, searchVendors, getCategories, getHomepageData };
