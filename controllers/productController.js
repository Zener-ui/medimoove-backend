const { adminClient } = require("../config/db");
const { v4: uuidv4 } = require("uuid");

// @route GET /api/products
// @route GET /api/products/mine
// The public listing (getAllProducts below) only shows available,
// in-stock, non-deleted products — a vendor needs to see their FULL
// catalog to manage it, including out-of-stock and paused items.
// This was a confirmed gap: no such endpoint existed before.
// Soft-deleted products are excluded by default (a vendor managing
// their live catalog usually doesn't want deleted items cluttering
// it) but can be included with ?include_deleted=true for an
// archive/audit view.
const getMyProducts = async (req, res) => {
  try {
    const { data: vendor } = await adminClient
      .from("vendors")
      .select("id")
      .eq("user_id", req.user.id)
      .single();

    if (!vendor) {
      return res.status(404).json({ success: false, message: "Vendor profile not found." });
    }

    const { include_deleted } = req.query;

    let query = adminClient
      .from("products")
      .select("*")
      .eq("vendor_id", vendor.id);

    if (include_deleted !== "true") {
      query = query.is("deleted_at", null);
    }

    const { data, error } = await query.order("created_at", { ascending: false });
    if (error) throw error;

    res.json({ success: true, products: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const getAllProducts = async (req, res) => {
  try {
    const { category, vendor_id, search, min_price, max_price } = req.query;

    let query = adminClient
      .from("products")
      .select("*, vendors!inner(business_name, location, rating, is_verified, plan, status)")
      .eq("is_available", true)
      .is("deleted_at", null)
      .gt("stock_quantity", 0)
      .eq("vendors.status", "approved");

    if (category) query = query.eq("category", category);
    if (vendor_id) query = query.eq("vendor_id", vendor_id);
    if (search) query = query.ilike("name", `%${search}%`);
    if (min_price) query = query.gte("price", min_price);
    if (max_price) query = query.lte("price", max_price);

    const { data, error } = await query.order("created_at", { ascending: false });
    if (error) throw error;

    res.json({ success: true, products: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/products/:id
const getProductById = async (req, res) => {
  try {
    const { data: product, error } = await adminClient
      .from("products")
      .select("*, vendors!inner(id, business_name, location, rating, is_verified, status)")
      .eq("id", req.params.id)
      .eq("vendors.status", "approved")
      .single();

    if (error || !product) {
      return res.status(404).json({ success: false, message: "Product not found." });
    }

    // Get variants
    const { data: variants } = await adminClient
      .from("product_variants")
      .select("*")
      .eq("product_id", product.id);

    res.json({ success: true, product: { ...product, variants: variants || [] } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/products
const createProduct = async (req, res) => {
  try {
    const { name, description, price, category_id, images, stock_quantity, variants } = req.body;

    if (!category_id) {
      return res.status(400).json({ success: false, message: "Please select a category." });
    }

    const { data: vendor } = await adminClient
      .from("vendors")
      .select("id, status")
      .eq("user_id", req.user.id)
      .single();

    if (!vendor || vendor.status !== "approved") {
      return res.status(403).json({ success: false, message: "Your vendor account is not approved yet." });
    }

    // `category` (free text) is kept alongside category_id purely for
    // any older display code still reading the plain-text field —
    // derived automatically from the selected category's real name so
    // it can never drift into an inconsistent value again. category_id
    // is the field that actually powers filtering/search going forward.
    const { data: categoryRow } = await adminClient
      .from("product_categories")
      .select("name")
      .eq("id", category_id)
      .single();
    if (!categoryRow) {
      return res.status(400).json({ success: false, message: "Invalid category selected." });
    }

    const productId = uuidv4();

    const { data: product, error } = await adminClient
      .from("products")
      .insert({
        id: productId,
        vendor_id: vendor.id,
        name,
        description,
        price,
        category_id,
        category: categoryRow.name,
        images: images || [],
        stock_quantity,
        is_available: true,
      })
      .select()
      .single();

    if (error) throw error;

    // Insert variants if provided
    if (variants && variants.length > 0) {
      const variantRows = variants.map((v) => ({
        id: uuidv4(),
        product_id: productId,
        name: v.name,
        value: v.value,
        price_adjustment: v.price_adjustment || 0,
        stock_quantity: v.stock_quantity || 0,
      }));

      await adminClient.from("product_variants").insert(variantRows);
    }

    res.status(201).json({ success: true, product });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/products/:id
const updateProduct = async (req, res) => {
  try {
    const { name, description, price, category_id, images, stock_quantity, is_available } = req.body;

    const { data: vendor } = await adminClient
      .from("vendors")
      .select("id")
      .eq("user_id", req.user.id)
      .single();

    if (!vendor) {
      return res.status(404).json({ success: false, message: "Vendor profile not found." });
    }

    const { data: product } = await adminClient
      .from("products")
      .select("vendor_id")
      .eq("id", req.params.id)
      .single();

    if (!product || product.vendor_id !== vendor.id) {
      return res.status(403).json({ success: false, message: "Not authorized to update this product." });
    }

    const updates = { name, description, price, images, stock_quantity, is_available };

    // Same derivation as createProduct — only touch category/category_id
    // if the edit form actually sent a new category_id, so a partial
    // update (e.g. just changing stock) can't accidentally wipe it.
    if (category_id) {
      const { data: categoryRow } = await adminClient
        .from("product_categories")
        .select("name")
        .eq("id", category_id)
        .single();
      if (!categoryRow) {
        return res.status(400).json({ success: false, message: "Invalid category selected." });
      }
      updates.category_id = category_id;
      updates.category = categoryRow.name;
    }

    const { data, error } = await adminClient
      .from("products")
      .update(updates)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, product: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route DELETE /api/products/:id
// Soft delete only — a hard delete would fail with a foreign key
// constraint error the moment a product has any order_items pointing
// to it (order_items.product_id has no ON DELETE clause), and would
// destroy the product info that past order history needs to display.
const deleteProduct = async (req, res) => {
  try {
    const { data: vendor } = await adminClient
      .from("vendors")
      .select("id")
      .eq("user_id", req.user.id)
      .single();

    if (!vendor) {
      return res.status(404).json({ success: false, message: "Vendor profile not found." });
    }

    const { data: product } = await adminClient
      .from("products")
      .select("vendor_id")
      .eq("id", req.params.id)
      .single();

    if (!product || product.vendor_id !== vendor.id) {
      return res.status(403).json({ success: false, message: "Not authorized to delete this product." });
    }

    await adminClient
      .from("products")
      .update({ is_available: false, deleted_at: new Date().toISOString() })
      .eq("id", req.params.id);

    res.json({ success: true, message: "Product deleted." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { getMyProducts, getAllProducts, getProductById, createProduct, updateProduct, deleteProduct };
