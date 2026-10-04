const { adminClient } = require("../config/db");
const { v4: uuidv4 } = require("uuid");
const { validateTransition, canTransition, STATUSES } = require("../config/orderStateMachine");
const { calculateDeliveryFee, getDeliverySettings, getEffectiveDeliveryRadius, haversineDistance } = require("./deliveryController");
const { resolveCoupon } = require("./couponController");
const { spendFromPromotionsBudget, refundToPromotionsBudget } = require("./promotionsController");
const { initiatePreDeliveryCancellationRefund } = require("./operationalController");
const { notifyAdmins } = require("../utils/notifyAdmins");

const getPlatformFeeRate = async () => {
  const { data, error } = await adminClient
    .from("fee_settings")
    .select("platform_fee_percentage")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return Number(data?.platform_fee_percentage ?? 3) / 100;
};

// ============================================================
// RESERVE INVENTORY
// Locks stock so no other order can claim it
// ============================================================
const reserveInventory = async (items, orderId) => {
  const reservations = [];

  for (const item of items) {
    const { data: product, error: productError } = await adminClient
      .from("products")
      .select("id, name")
      .eq("id", item.product_id)
      .single();

    if (productError || !product) throw new Error(`Product ${item.product_id} not found.`);

    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 15);

    // Product/variant stock and the reservation row are created by one
    // PostgreSQL transaction. A crash can no longer leave reserved stock
    // with no reservation row that the expiry job could release.
    const { data: reservationId, error: reserveError } = await adminClient.rpc(
      "reserve_inventory_item",
      {
        p_product_id: item.product_id,
        p_variant_id: item.variant_id || null,
        p_order_id: orderId,
        p_quantity: item.quantity,
        p_expires_at: expiresAt.toISOString(),
      }
    );

    if (reserveError) {
      const message = reserveError.message || "Unable to reserve inventory.";
      if (message.toLowerCase().includes("not enough stock")) {
        throw new Error(`"${product.name}" doesn't have enough stock available.`);
      }
      if (message.toLowerCase().includes("variant")) {
        throw new Error(`Selected variant of "${product.name}" isn't available in the requested quantity.`);
      }
      throw reserveError;
    }

    reservations.push({
      id: reservationId,
      product_id: item.product_id,
      variant_id: item.variant_id || null,
      order_id: orderId,
      quantity: item.quantity,
      status: "reserved",
      expires_at: expiresAt.toISOString(),
    });
  }

  return reservations;
};

// ============================================================
// RELEASE INVENTORY RESERVATIONS
// Called on cancellation or payment failure
// ============================================================
const releaseInventory = async (orderId, subOrderId = null) => {
  const { data: allReservations, error: reservationError } = await adminClient
    .from("inventory_reservations")
    .select("id, product_id, variant_id, quantity")
    .eq("order_id", orderId)
    .eq("status", "reserved");

  if (reservationError) throw reservationError;
  if (!allReservations?.length) return;

  let reservations = allReservations;

  if (subOrderId) {
    // A parent order can contain multiple vendor sub-orders. Inventory
    // reservations currently belong to the parent order, so a cancellation
    // of ONE sub-order must be narrowed to that sub-order's actual items.
    // Releasing every reservation for the parent order would incorrectly
    // unlock stock belonging to the other vendors' sub-orders.
    const { data: orderItems, error: itemError } = await adminClient
      .from("order_items")
      .select("product_id, variant_id, quantity")
      .eq("sub_order_id", subOrderId)
      .eq("order_id", orderId);

    if (itemError) throw itemError;
    if (!orderItems?.length) return;

    // Products belong to exactly one vendor, so matching the reservation
    // to this sub-order's order_items identifies the correct stock claim.
    // Quantity is an additional guard against selecting a different cart line.
    const matches = new Map();
    for (const item of orderItems) {
      const key = `${item.product_id}:${item.variant_id || ""}`;
      matches.set(key, (matches.get(key) || 0) + Number(item.quantity || 0));
    }

    reservations = allReservations.filter((reservation) => {
      const key = `${reservation.product_id}:${reservation.variant_id || ""}`;
      const needed = matches.get(key) || 0;
      if (needed < Number(reservation.quantity || 0)) return false;
      matches.set(key, needed - Number(reservation.quantity || 0));
      return true;
    });
  }

  for (const res of reservations) {
    // Status transition and reserved-stock restoration happen in one
    // PostgreSQL transaction. Repeated cancellation/reconciliation is safe.
    const { error: releaseError } = await adminClient.rpc(
      "release_inventory_reservation",
      { p_reservation_id: res.id }
    );
    if (releaseError) throw releaseError;
  }
};

// ============================================================
// CONFIRM INVENTORY (after payment verified)
// Deducts actual stock
// ============================================================
const confirmInventory = async (orderId) => {
  const { data: reservations, error } = await adminClient
    .from("inventory_reservations")
    .select("id")
    .eq("order_id", orderId)
    .eq("status", "reserved");

  if (error) throw error;
  if (!reservations || reservations.length === 0) return;

  for (const res of reservations) {
    // Reservation status + real stock deduction are one PostgreSQL
    // transaction. A crash cannot leave a confirmed reservation with
    // stock still reserved/not deducted. Repeated payment processing is safe.
    const { error: confirmError } = await adminClient.rpc(
      "confirm_inventory_reservation",
      { p_reservation_id: res.id }
    );
    if (confirmError) throw confirmError;
  }
};

// ============================================================
// GROUP CART ITEMS BY VENDOR
// ============================================================
const groupItemsByVendor = (items, products) => {
  const vendorMap = {};

  for (const item of items) {
    const product = products.find((p) => p.id === item.product_id);
    if (!product) throw new Error(`Product ${item.product_id} not found.`);

    const vendorId = product.vendor_id;

    if (!vendorMap[vendorId]) {
      vendorMap[vendorId] = {
        vendor_id: vendorId,
        region_id: product.vendors?.region_id,
        vendor_location_lat: product.vendors?.location_lat,
        vendor_location_lng: product.vendors?.location_lng,
        delivery_radius_km: product.vendors?.delivery_radius_km,
        items: [],
      };
    }

    vendorMap[vendorId].items.push({ ...item, product });
  }

  return Object.values(vendorMap);
};

// ============================================================
// CREATE ORDER WITH SUB-ORDERS
// @route POST /api/sub-orders/create
//
// Body:
// {
//   items: [{ product_id, variant_id?, quantity }],
//   delivery_type: "delivery" | "pickup",
//   delivery_address: string,
//   delivery_lat: number,
//   delivery_lng: number,
//   idempotency_key: string  ← client generates this UUID
// }
// ============================================================
const createOrderWithSubOrders = async (req, res) => {
  try {
    const {
      items,
      delivery_type,
      delivery_address,
      delivery_lat,
      delivery_lng,
      delivery_description,
      delivery_voice_note_url,
      idempotency_key,
      coupon_code,
    } = req.body;

    // Validate required fields
    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, message: "Cart is empty." });
    }

    if (!idempotency_key) {
      return res.status(400).json({ success: false, message: "idempotency_key is required." });
    }

    // The frontend already blocks submitting a delivery order without a
    // confirmed map pin, but the backend shouldn't silently trust that —
    // a missing delivery_lat/lng here would otherwise flow straight
    // into the same "silently skip the fee calculation" trap as the
    // vendor-location check below.
    if (delivery_type === "delivery" && (!delivery_lat || !delivery_lng)) {
      return res.status(400).json({
        success: false,
        message: "A delivery location is required. Please search for your address or drop a pin on the map.",
      });
    }

    // Idempotency check — prevent duplicate orders
    const { data: existingOrder } = await adminClient
      .from("orders")
      .select("id, status")
      .eq("idempotency_key", idempotency_key)
      .single();

    if (existingOrder) {
      // Keep the response shape consistent with a newly-created order.
      // Checkout expects order.id before it initializes Paystack.
      return res.status(200).json({
        success: true,
        message: "Order already exists for this session.",
        order: {
          id: existingOrder.id,
          status: existingOrder.status,
        },
        order_id: existingOrder.id,
      });
    }

    // Fetch all products with vendor info in one query
    const productIds = items.map((i) => i.product_id);
    const { data: products, error: pErr } = await adminClient
      .from("products")
      .select("id, name, price, stock_quantity, reserved_quantity, vendor_id, vendors(id, region_id, location_lat, location_lng, status, delivery_radius_km)")
      .in("id", productIds);

    if (pErr) throw pErr;

    // Validate all products belong to approved vendors
    for (const product of products) {
      if (product.vendors?.status !== "approved") {
        return res.status(400).json({
          success: false,
          message: `Vendor for "${product.name}" is not currently active.`,
        });
      }
    }

    // Group items by vendor
    const vendorGroups = groupItemsByVendor(items, products);

    // ONE STORE PER CART/ORDER (Fidelx pilot rule): the frontend cart
    // already blocks mixing stores, but that's UX only — this is the
    // real guarantee. A rider should only ever pick up from one store
    // per delivery.
    if (vendorGroups.length > 1) {
      return res.status(400).json({
        success: false,
        message: "An order can only contain items from one store. Please check out from each store separately.",
      });
    }

    // SAFETY CHECK: a delivery-type order must never silently compute a
    // ₦0 delivery fee just because a vendor hasn't set their location.
    // Previously, calculateDeliveryFee was simply skipped whenever
    // vendor_location_lat was missing, defaulting deliveryFee to 0 with
    // no error — meaning every delivery from a vendor without a
    // location was effectively free, silently. Block checkout instead
    // and tell the customer specifically which vendor is the problem.
    if (delivery_type === "delivery") {
      const vendorMissingLocation = vendorGroups.find(
        (g) => !g.vendor_location_lat || !g.vendor_location_lng
      );
      if (vendorMissingLocation) {
        const { data: vendorInfo } = await adminClient
          .from("vendors")
          .select("business_name")
          .eq("id", vendorMissingLocation.vendor_id)
          .single();
        return res.status(400).json({
          success: false,
          message: `"${vendorInfo?.business_name || "This vendor"}" hasn't set up their store location yet, so delivery isn't available from them right now. Try pickup instead, or check back later.`,
        });
      }
    }

    // MAX DELIVERY RADIUS: the frontend calls /api/delivery/estimate
    // before checkout and blocks submission beyond the service radius,
    // but that's advisory only — someone calling this endpoint directly
    // could otherwise place a delivery order from any distance. Enforce
    // the same radius here, per vendor, before any totals are computed.
    if (delivery_type === "delivery") {
      for (const group of vendorGroups) {
        const distanceKm = haversineDistance(
          group.vendor_location_lat, group.vendor_location_lng,
          parseFloat(delivery_lat), parseFloat(delivery_lng)
        );
        const settings = await getDeliverySettings(group.region_id);
        const effectiveRadius = getEffectiveDeliveryRadius(group, settings);
        if (distanceKm > effectiveRadius) {
          const { data: vendorInfo } = await adminClient
            .from("vendors")
            .select("business_name")
            .eq("id", group.vendor_id)
            .single();
          return res.status(400).json({
            success: false,
            message: `"${vendorInfo?.business_name || "This vendor"}" is outside the ${effectiveRadius}km delivery radius for your address.`,
          });
        }
      }
    }

    // Calculate totals per vendor group
    // fee_settings is the single source of truth for customer platform fees.
    const platformFeeRate = await getPlatformFeeRate();
    let grandSubtotal = 0;
    let grandPlatformFee = 0;
    let grandDeliveryFee = 0;

    const vendorGroupsWithTotals = await Promise.all(
      vendorGroups.map(async (group) => {
        let groupSubtotal = 0;

        for (const item of group.items) {
          let itemPrice = item.product.price;

          if (item.variant_id) {
            const { data: variant } = await adminClient
              .from("product_variants")
              .select("price_adjustment")
              .eq("id", item.variant_id)
              .single();
            if (variant) itemPrice += variant.price_adjustment;
          }

          item.final_price = itemPrice;
          groupSubtotal += itemPrice * item.quantity;
        }

        const platformFee = Math.round(groupSubtotal * platformFeeRate);

        // Calculate delivery fee for this vendor group
        let deliveryFee = 0;
        let deliveryMargin = 0;
        let riderPayout = 0;

        // By this point both vendor location and customer delivery
        // coordinates have already been validated above — this check
        // is a defense-in-depth backstop, not the primary safety
        // mechanism. It intentionally still skips (rather than errors)
        // if somehow reached with missing data, since the real
        // rejection already happened earlier with a clear message.
        if (delivery_type === "delivery" && group.vendor_location_lat && delivery_lat) {
          const distanceKm = haversineDistance(
            group.vendor_location_lat, group.vendor_location_lng,
            parseFloat(delivery_lat), parseFloat(delivery_lng)
          );

          const settings = await getDeliverySettings(group.region_id);
          const calc = calculateDeliveryFee(distanceKm, settings);
          deliveryFee = calc.delivery_fee;
          deliveryMargin = calc.delivery_margin;
          riderPayout = calc.rider_payout;
        }

        grandSubtotal += groupSubtotal;
        grandPlatformFee += platformFee;
        grandDeliveryFee += deliveryFee;

        return {
          ...group,
          subtotal: groupSubtotal,
          platform_fee: platformFee,
          delivery_fee: deliveryFee,
          delivery_margin: deliveryMargin,
          rider_payout: riderPayout,
          vendor_payout: groupSubtotal, // Vendor gets full product price
        };
      })
    );

    const grandTotal = grandSubtotal + grandPlatformFee + grandDeliveryFee;

    // Coupon is re-validated and re-computed here from scratch — never
    // trust a client-supplied discount amount. Only reduces the final
    // customer-facing total; platform_fee and vendor_payout above were
    // already computed on the undiscounted subtotal and are untouched.
    let appliedCoupon = null;
    let discountAmount = 0;
    if (coupon_code) {
      // Coupon eligibility is resolved from the ACTUAL vendor groups in the
      // cart. Do not assume vendorGroupsWithTotals[0] is the coupon vendor.
      // A vendor-specific coupon may only discount that vendor's eligible
      // subtotal/delivery portion; a platform-wide coupon may use the full
      // order totals.
      const firstGroup = vendorGroupsWithTotals[0];
      const couponResult = await resolveCoupon({
        code: coupon_code,
        customerId: req.user.id,
        // Pass the first vendor only for the lookup/preview fallback. The
        // authoritative vendor-specific check below uses the actual coupon
        // vendor returned by resolveCoupon and the complete cart groups.
        vendorId: firstGroup?.vendor_id,
        subtotal: grandSubtotal,
        deliveryFee: grandDeliveryFee,
        skipVendorEligibility: true,
      });
      if (!couponResult.valid) {
        return res.status(400).json({ success: false, message: couponResult.message });
      }

      appliedCoupon = couponResult.coupon;

      if (appliedCoupon.vendor_id) {
        const eligibleGroup = vendorGroupsWithTotals.find(
          (group) => group.vendor_id === appliedCoupon.vendor_id
        );

        if (!eligibleGroup) {
          return res.status(400).json({
            success: false,
            message: "This coupon is only valid for a store in your cart.",
          });
        }

        // Recompute the discount against only the eligible vendor's portion.
        // Never allow a vendor-specific coupon to discount another vendor's
        // items or the entire multi-vendor delivery charge.
        const eligibleResult = await resolveCoupon({
          code: coupon_code,
          customerId: req.user.id,
          vendorId: eligibleGroup.vendor_id,
          subtotal: eligibleGroup.subtotal,
          deliveryFee: eligibleGroup.delivery_fee,
        });

        if (!eligibleResult.valid) {
          return res.status(400).json({ success: false, message: eligibleResult.message });
        }

        discountAmount = Math.min(eligibleResult.discount_amount, eligibleGroup.subtotal + eligibleGroup.delivery_fee);
      } else {
        // Platform-wide coupon: the existing whole-order calculation remains.
        discountAmount = Math.min(couponResult.discount_amount, grandTotal);
      }
    }

    const finalTotal = grandTotal - discountAmount;

    // Order id generated here (rather than further down, where it
    // used to live) because the promotions-budget spend below needs
    // a reference to tie itself to — reserveInventory/order creation
    // further down just reuse this same id, no other change.
    const mainOrderId = uuidv4();
    let orderCreated = false;

    // The actual fix for the "discount comes from nowhere" gap: a
    // coupon discount is only allowed to go through if the
    // promotions budget can actually cover it. platform_fee and
    // vendor_payout stay exactly as computed above (undiscounted) —
    // this spend is what now explicitly accounts for the difference,
    // instead of it silently coming out of the platform's real cash
    // position with no trail and no limit.
    if (discountAmount > 0) {
      const funded = await spendFromPromotionsBudget({
        reference: mainOrderId,
        type: "COUPON_DISCOUNT",
        amount: discountAmount,
        actorId: req.user.id,
        description: `Coupon ${appliedCoupon?.code || coupon_code} on order ${mainOrderId}`,
      });
      if (!funded) {
        return res.status(400).json({
          success: false,
          message: "This promotion isn't available right now. Please remove the coupon and try again.",
        });
      }
    }

    // Get customer region (use first vendor's region for now)
    const region_id = vendorGroupsWithTotals[0]?.region_id;

    // Reserve inventory BEFORE the atomic create — each reservation is
    // already individually atomic (atomic_reserve_stock), and we need
    // to know reservation succeeded before writing the order itself.
    // If order creation then fails for any reason, the catch block
    // below releases these reservations (see the try/catch added
    // around this whole section).
    await reserveInventory(items, mainOrderId);

    const subOrderIds = [];
    const vendorGroupPayload = vendorGroupsWithTotals.map((group) => {
      const subOrderId = uuidv4();
      subOrderIds.push(subOrderId);
      const withdrawalAvailableAt = new Date();
      withdrawalAvailableAt.setHours(withdrawalAvailableAt.getHours() + 1); // matches the DELIVERED-time value; overwritten there regardless

      return {
        id: subOrderId,
        vendor_id: group.vendor_id,
        status: STATUSES.PENDING_PAYMENT,
        delivery_type,
        delivery_address: delivery_type === "delivery" ? delivery_address : null,
        delivery_lat: delivery_type === "delivery" ? parseFloat(delivery_lat) : null,
        delivery_lng: delivery_type === "delivery" ? parseFloat(delivery_lng) : null,
        delivery_description: delivery_type === "delivery" ? (delivery_description || null) : null,
        delivery_voice_note_url: delivery_type === "delivery" ? (delivery_voice_note_url || null) : null,
        subtotal: group.subtotal,
        platform_fee: group.platform_fee,
        delivery_fee: group.delivery_fee,
        delivery_margin: group.delivery_margin,
        vendor_payout: group.vendor_payout,
        rider_payout: group.rider_payout,
        withdrawal_available_at: withdrawalAvailableAt.toISOString(),
        items: group.items.map((item) => ({
          product_id: item.product_id,
          variant_id: item.variant_id || null,
          quantity: item.quantity,
          price: item.final_price,
        })),
      };
    });

    // The entire order + coupon redemption + sub-orders + order_items
    // insert sequence now happens inside ONE Postgres transaction
    // (create_order_with_sub_orders, financial_safety_migration.sql).
    // If any part of it fails, Postgres rolls back everything — no more
    // orphaned order rows or sub-orders missing their items from a
    // mid-sequence crash (audit item 10).
    let rpcError;
    try {
      const { error } = await adminClient.rpc("create_order_with_sub_orders", {
        p_payload: {
          order_id: mainOrderId,
          customer_id: req.user.id,
          region_id: vendorGroupsWithTotals[0]?.region_id,
          status: STATUSES.PENDING_PAYMENT,
          subtotal: grandSubtotal,
          platform_fee: grandPlatformFee,
          delivery_fee: grandDeliveryFee,
          coupon_id: appliedCoupon?.id || null,
          discount_amount: discountAmount,
          total: finalTotal,
          payment_status: "pending",
          idempotency_key,
          coupon_redemption: appliedCoupon
            ? { coupon_id: appliedCoupon.id, discount_amount: discountAmount }
            : null,
          vendor_groups: vendorGroupPayload,
        },
      });
      rpcError = error;
    } catch (err) {
      rpcError = err;
    }

    if (rpcError) {
      // Order was never actually created (the whole RPC rolled back) —
      // release what we reserved above so stock isn't stuck locked
      // against a phantom order, and give back any promotions budget
      // we already spent for this order's coupon.
      await releaseInventory(mainOrderId);
      if (discountAmount > 0) {
        await refundToPromotionsBudget({ reference: mainOrderId, type: "COUPON_DISCOUNT" });
      }
      throw rpcError;
    }

    orderCreated = true;

    // Ledger entry for order creation — amount reflects what's actually
    // charged (post-discount), since that's the real money movement
    // this record needs to reconcile against. Deduplicated by
    // (reference, type) — see financial_safety_migration.sql — so a
    // retried request after a transient failure here can't double-log.
    await adminClient.from("ledger_entries").insert({
      id: uuidv4(),
      reference: mainOrderId,
      type: "ORDER_CREATED",
      amount: finalTotal,
      fee: grandPlatformFee,
      net: grandSubtotal,
      source: "customer",
      destination: "pending_payment",
      actor_id: req.user.id,
      description: `Order created with ${vendorGroupsWithTotals.length} vendor(s). Total: ₦${finalTotal.toLocaleString()}${discountAmount > 0 ? ` (₦${discountAmount.toLocaleString()} discount applied)` : ""}`,
    }).select().maybeSingle(); // duplicate (reference,type) hits the unique index and is silently ignored rather than thrown as a hard error

    res.status(201).json({
      success: true,
      message: "Order created. Proceed to payment.",
      order: {
        id: mainOrderId,
        subtotal: grandSubtotal,
        platform_fee: grandPlatformFee,
        delivery_fee: grandDeliveryFee,
        discount_amount: discountAmount,
        total: finalTotal,
        vendor_count: vendorGroupsWithTotals.length,
        sub_order_count: subOrderIds.length,
        status: STATUSES.PENDING_PAYMENT,
      },
    });
  } catch (err) {
    const message = String(err?.message || "");

    // Inventory is reserved before the order transaction so stock can be
    // checked safely. If reservation fails part-way through, or anything
    // before the order is actually created throws, clean up the already-
    // reserved stock and any promotion-budget spend. The cleanup is only
    // allowed while the order is known NOT to exist, so a later error after
    // successful order creation cannot accidentally release real stock or
    // refund a legitimate promotion spend.
    if (!orderCreated && mainOrderId) {
      try {
        await releaseInventory(mainOrderId);
      } catch (cleanupError) {
        console.error(`[create-order] Inventory cleanup failed for ${mainOrderId}:`, cleanupError.message);
      }
      if (discountAmount > 0) {
        try {
          await refundToPromotionsBudget({ reference: mainOrderId, type: "COUPON_DISCOUNT" });
        } catch (cleanupError) {
          console.error(`[create-order] Promotion-budget cleanup failed for ${mainOrderId}:`, cleanupError.message);
        }
      }
    }

    if (
      message.includes("coupon") ||
      message.includes("Coupon")
    ) {
      return res.status(400).json({ success: false, message });
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================
// GET ORDER WITH ALL SUB-ORDERS
// @route GET /api/sub-orders/order/:orderId
// ============================================================
const getOrderWithSubOrders = async (req, res) => {
  try {
    const { data: order, error: oErr } = await adminClient
      .from("orders")
      .select("*")
      .eq("id", req.params.orderId)
      .eq("customer_id", req.user.id)
      .single();

    if (oErr || !order) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    const { data: subOrders, error: soErr } = await adminClient
      .from("sub_orders")
      .select("*, vendors(business_name, address, phone, logo_url), riders(users!user_id(full_name, phone)), reviews(id, vendor_rating, rider_rating, title, comment, photo_urls, created_at, updated_at)")
      .eq("order_id", req.params.orderId);

    if (soErr) throw soErr;

    // Attach items to each sub-order
    const subOrdersWithItems = await Promise.all(
      subOrders.map(async (subOrder) => {
        const { data: items } = await adminClient
          .from("order_items")
          .select("*, products(name, images), product_variants(name, value)")
          .eq("sub_order_id", subOrder.id);

        return { ...subOrder, items };
      })
    );

    res.json({
      success: true,
      order: { ...order, sub_orders: subOrdersWithItems },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================
// UPDATE SUB-ORDER STATUS
// @route PUT /api/sub-orders/:subOrderId/status
// ============================================================
const updateSubOrderStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const role = req.user.role;

    const { data: subOrder, error } = await adminClient
      .from("sub_orders")
      .select("id, status, order_id, vendor_id, rider_id, vendor_payout, rider_payout, delivery_type")
      .eq("id", req.params.subOrderId)
      .single();

    if (error || !subOrder) {
      return res.status(404).json({ success: false, message: "Sub-order not found." });
    }

    // Ownership check — the role-based transition rules below only
    // confirm a role is ALLOWED to set a given status in general, not
    // that this specific caller is the vendor/rider/customer tied to
    // THIS sub-order. Without this, any vendor could mark any other
    // vendor's order ready, any rider could mark any other rider's
    // delivery complete, and any customer could dispute/cancel someone
    // else's order.
    if (role === "vendor") {
      const { data: vendor } = await adminClient.from("vendors").select("id").eq("user_id", req.user.id).single();
      if (!vendor || vendor.id !== subOrder.vendor_id) {
        return res.status(403).json({ success: false, message: "Not authorized." });
      }
    } else if (role === "rider") {
      const { data: rider } = await adminClient.from("riders").select("id").eq("user_id", req.user.id).single();
      if (!rider || rider.id !== subOrder.rider_id) {
        return res.status(403).json({ success: false, message: "Not authorized." });
      }
    } else if (role === "customer") {
      const { data: parentOrder } = await adminClient.from("orders").select("customer_id").eq("id", subOrder.order_id).single();
      if (!parentOrder || parentOrder.customer_id !== req.user.id) {
        return res.status(403).json({ success: false, message: "Not authorized." });
      }
    } else if (role !== "admin") {
      return res.status(403).json({ success: false, message: "Not authorized." });
    }

    // Validate state transition
    const { valid, message } = validateTransition(subOrder.status, status, role);
    if (!valid) {
      return res.status(400).json({ success: false, message });
    }

    // READY_FOR_PICKUP -> DELIVERED is only legal for genuine self-pickup
    // orders (the customer collects it in person, no rider is ever
    // involved). For a real delivery-type order this same transition
    // would let a vendor falsely mark it delivered without any rider
    // ever picking it up — block that specifically, even though the
    // state machine itself allows the transition generically.
    if (
      subOrder.status === STATUSES.READY_FOR_PICKUP &&
      status === STATUSES.DELIVERED &&
      subOrder.delivery_type !== "pickup"
    ) {
      return res.status(400).json({
        success: false,
        message: "This is a delivery order — it must go through a rider, not be marked delivered directly.",
      });
    }

    // Delivery verification code — the rider must ask the customer for the
    // 4-digit code shown in their app and enter it here before a genuine
    // rider delivery can be marked complete. This never applies to
    // self-pickup orders (no rider involved, nothing to verify), and is
    // only enforced for the rider's own request — an admin override stays
    // possible without a code, for legitimate support cases.
    if (status === STATUSES.DELIVERED && role === "rider" && subOrder.delivery_type !== "pickup") {
      const { data: codeRow } = await adminClient
        .from("sub_orders")
        .select("delivery_code")
        .eq("id", req.params.subOrderId)
        .single();

      const submittedCode = (req.body.delivery_code || "").trim();
      if (!submittedCode || submittedCode !== codeRow?.delivery_code) {
        return res.status(400).json({
          success: false,
          message: "Incorrect delivery code. Ask the customer for the code shown in their app.",
        });
      }
    }

    const updates = { status };

    // A vendor marking a DELIVERY sub-order ready has nowhere further to
    // go on its own — WAITING_RIDER can only be set by "system"/"admin"
    // per the role rules above, and nothing else in the codebase ever
    // makes that transition. Without this, a delivery order would sit at
    // READY_FOR_PICKUP forever and no rider could ever accept it. Since
    // this handler already validated the vendor's transition is legal,
    // immediately chain it to WAITING_RIDER as the system actor.
    // Pickup-type orders correctly stop at READY_FOR_PICKUP — no rider
    // needed, the customer collects it themselves.
    if (status === STATUSES.READY_FOR_PICKUP && subOrder.delivery_type === "delivery") {
      updates.status = STATUSES.WAITING_RIDER;
    }

    if (status === STATUSES.DELIVERED) {
      const withdrawalAt = new Date();
      withdrawalAt.setHours(withdrawalAt.getHours() + 1);
      updates.delivered_at = new Date().toISOString();
      updates.withdrawal_available_at = withdrawalAt.toISOString();
    }

    if (status === STATUSES.CANCELLED) {
      updates.cancelled_at = new Date().toISOString();
    }

    // ATOMIC CLAIM — this is the fix for the DELIVERED double-credit
    // race (audit item 4). The old code did a plain, unconditional
    // .update() here: two concurrent requests for the same sub-order
    // (a genuine bad-network double-tap) could both pass the
    // validateTransition check above and both reach this point before
    // either write landed, then both go on to credit balances below.
    // claim_sub_order_transition's UPDATE ... WHERE status = <expected>
    // is a single atomic statement — Postgres serializes concurrent
    // UPDATEs to the same row, so only ONE of the two requests can ever
    // see claimed === true. The loser returns immediately, having
    // changed nothing, rather than falling through to credit anyone.
    const { data: claimed, error: claimErr } = await adminClient.rpc("claim_sub_order_transition", {
      p_sub_order_id: req.params.subOrderId,
      p_expected_status: subOrder.status,
      p_new_status: updates.status,
    });
    if (claimErr) throw claimErr;
    if (!claimed) {
      // Someone else's concurrent request already made this exact
      // transition (or the state moved on) between our read and now.
      // Not an error from the caller's point of view — the end state
      // they wanted is already true.
      return res.json({ success: true, message: `Sub-order status is already ${updates.status}.`, already_applied: true });
    }

    // Everything below this line is guaranteed to run for this
    // transition EXACTLY ONCE, platform-wide, no matter how many
    // concurrent/retried requests arrived for it.
    const remainingUpdates = { ...updates };
    delete remainingUpdates.status; // already applied atomically above
    if (Object.keys(remainingUpdates).length > 0) {
      await adminClient.from("sub_orders").update(remainingUpdates).eq("id", req.params.subOrderId);
    }

    // If delivered — finalize ALL delivery financial side effects through one
    // idempotent recovery function. The function repairs any partial delivery
    // credit left behind by a crash (vendor/rider/platform/ledger) and is also
    // safe to call repeatedly from reconciliation.
    if (status === STATUSES.DELIVERED) {
      const { error: deliveryFinancialsError } = await adminClient.rpc(
        "repair_delivered_sub_order_financials",
        { p_sub_order_id: subOrder.id, p_actor_id: req.user.id }
      );
      if (deliveryFinancialsError) throw deliveryFinancialsError;
    }

    // If cancelled — release inventory and, if the customer had already
    // paid, actually start a refund. Previously this branch only
    // released inventory and left a paid order's money sitting in
    // Paystack indefinitely with no automated path back (audit items
    // 2 and 7 — this exact gap applies whether a vendor or a customer
    // is the one cancelling, since both go through this same handler).
    if (status === STATUSES.CANCELLED) {
      await releaseInventory(subOrder.order_id, subOrder.id);

      const { data: parentOrder } = await adminClient
        .from("orders")
        .select("payment_status")
        .eq("id", subOrder.order_id)
        .single();

      if (parentOrder?.payment_status === "successful") {
        try {
          await initiatePreDeliveryCancellationRefund({
            subOrder,
            initiatedByRole: role,
            initiatedByUserId: req.user.id,
          });
        } catch (refundErr) {
          console.error(`[cancel-sub-order] Refund initiation failed for ${subOrder.id}:`, refundErr.message);
          await notifyAdmins(
            "Cancellation refund failed to initiate",
            `Sub-order ${subOrder.id} was cancelled after payment, but the automatic refund could not be started (${refundErr.message}). Needs manual review.`
          );
        }
      }
    }

    // Check if ALL sub-orders for the main order are now delivered
    // If yes — update main order status too
    const { data: allSubOrders } = await adminClient
      .from("sub_orders")
      .select("status")
      .eq("order_id", subOrder.order_id);

    const allDelivered = allSubOrders?.every((so) => so.status === STATUSES.DELIVERED);
    const allCancelled = allSubOrders?.every((so) => so.status === STATUSES.CANCELLED);

    if (allDelivered) {
      const { error: orderDeliveryError } = await adminClient
        .from("orders")
        .update({ status: STATUSES.DELIVERED })
        .eq("id", subOrder.order_id);

      if (orderDeliveryError) throw orderDeliveryError;

      // Referral credit happens ONLY after the customer's entire order
      // has completed (all sub-orders are DELIVERED). Payment success
      // alone is deliberately not enough: a customer can still cancel
      // or be refunded after payment, and those orders must not count as
      // successful referrals. The database function remains idempotent
      // via users.referral_credited, so retries cannot award the same
      // referral twice. A referral failure must never undo delivery.
      try {
        const { data: completedOrder } = await adminClient
          .from("orders")
          .select("customer_id")
          .eq("id", subOrder.order_id)
          .single();

        if (completedOrder?.customer_id) {
          const { data: milestoneResult, error: referralError } = await adminClient.rpc(
            "credit_customer_referral",
            { p_referred_user_id: completedOrder.customer_id }
          );

          if (referralError) throw referralError;

          const result = milestoneResult?.[0];
          if (result?.milestone_reached) {
            await adminClient.from("admin_alerts").insert({
              id: uuidv4(),
              type: "REFERRAL_MILESTONE",
              severity: "low",
              title: "Customer referral milestone reached",
              description: `A customer has reached ${result.milestone_count} credited referrals — review and send their reward from the Referral Milestones page.`,
              reference_id: result.referrer_id,
              reference_type: "customer_referral",
              is_resolved: false,
            });
          }
        }
      } catch (err) {
        // Referral processing is non-financial and must never cause a
        // completed delivery to fail. It can be retried/admin-reviewed
        // separately if the referral RPC or alert insertion fails.
        console.error(`[referral] Failed to process completed order ${subOrder.order_id}:`, err.message);
      }
    }

    if (allCancelled) {
      await adminClient.from("orders").update({ status: STATUSES.CANCELLED }).eq("id", subOrder.order_id);
    }

    // Notify customer
    const { data: order } = await adminClient
      .from("orders")
      .select("customer_id")
      .eq("id", subOrder.order_id)
      .single();

    if (order) {
      await adminClient.from("notifications").insert({
        id: uuidv4(),
        user_id: order.customer_id,
        title: "Order Update",
        body: `Part of your order is now: ${status.replace(/_/g, " ")}.`,
        is_read: false,
      });
    }

    res.json({ success: true, message: `Sub-order status updated to ${updates.status}.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================
// CANCEL SUB-ORDER
// @route POST /api/sub-orders/:subOrderId/cancel
// ============================================================
const cancelSubOrder = async (req, res) => {
  try {
    const { data: subOrder } = await adminClient
      .from("sub_orders")
      .select("id, status, order_id, vendor_id")
      .eq("id", req.params.subOrderId)
      .single();

    if (!subOrder) {
      return res.status(404).json({ success: false, message: "Sub-order not found." });
    }

    // Ownership check — the route restricts this to role=customer, but
    // that alone doesn't confirm THIS customer placed THIS order.
    const { data: parentOrder } = await adminClient.from("orders").select("customer_id").eq("id", subOrder.order_id).single();
    if (!parentOrder || parentOrder.customer_id !== req.user.id) {
      return res.status(403).json({ success: false, message: "Not authorized." });
    }

    // Cancellability is derived from the state machine's own transition
    // rules (CANCELLED is only reachable from PENDING_PAYMENT and
    // PAYMENT_CONFIRMED — see orderStateMachine.js) rather than a
    // separate hardcoded list here. Keeping one source of truth is the
    // whole point: a duplicated list is exactly how WAITING_RIDER and
    // RIDER_ASSIGNED ended up still cancellable after the vendor had
    // already prepared the order — this list quietly drifted out of
    // sync with the actual intended flow.
    if (!canTransition(subOrder.status, STATUSES.CANCELLED)) {
      return res.status(400).json({
        success: false,
        message: "This order can no longer be cancelled — the store has already started preparing it.",
      });
    }

    // ATOMIC CLAIM — same mechanism as updateSubOrderStatus's DELIVERED
    // fix. Two concurrent cancel requests for the same sub-order (audit
    // test scenario 6) can now only have one of them proceed past this
    // point; the loser gets back "already_applied" instead of racing
    // through inventory release and refund initiation a second time.
    const { data: claimed, error: claimErr } = await adminClient.rpc("claim_sub_order_transition", {
      p_sub_order_id: req.params.subOrderId,
      p_expected_status: subOrder.status,
      p_new_status: STATUSES.CANCELLED,
    });
    if (claimErr) throw claimErr;
    if (!claimed) {
      return res.json({ success: true, message: "Sub-order is already cancelled.", already_applied: true });
    }
    await adminClient.from("sub_orders").update({ cancelled_at: new Date().toISOString() }).eq("id", req.params.subOrderId);

    // Release inventory for this sub-order's items
    await releaseInventory(subOrder.order_id, subOrder.id);

    // If payment was actually collected, start the refund now — this
    // route previously just said "refund will be processed" without
    // ever actually triggering one (audit item 2's other half; the
    // generic updateSubOrderStatus CANCELLED branch already got this
    // fix, this dedicated customer route had been missed).
    const { data: parentOrderForRefund } = await adminClient
      .from("orders")
      .select("payment_status")
      .eq("id", subOrder.order_id)
      .single();

    if (parentOrderForRefund?.payment_status === "successful") {
      try {
        await initiatePreDeliveryCancellationRefund({
          subOrder,
          initiatedByRole: "customer",
          initiatedByUserId: req.user.id,
        });
      } catch (refundErr) {
        console.error(`[cancel-sub-order] Refund initiation failed for ${subOrder.id}:`, refundErr.message);
        await notifyAdmins(
          "Cancellation refund failed to initiate",
          `Sub-order ${subOrder.id} was cancelled by the customer after payment, but the automatic refund could not be started (${refundErr.message}). Needs manual review.`
        );
      }
    }

    res.json({ success: true, message: "Sub-order cancelled. Refund will be processed if payment was made." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================
// CREDIT PENDING BALANCE HELPER
// Wraps the atomic credit_pending_balance() SQL function (see
// settlement_hold_migration.sql). Replaces the old upsertBalance,
// which did a non-atomic read-then-write in application code — a real
// race condition if two of a vendor's/rider's deliveries completed
// close together (both reads could happen before either write landed,
// silently losing one credit). Also now credits pending_balance
// instead of available_balance directly — money only becomes
// withdrawable once release_matured_sub_order_balances() moves it
// across, after withdrawal_available_at has passed.
// ============================================================
const creditPendingBalance = async (userId, amount) => {
  const { error } = await adminClient.rpc("credit_pending_balance", { p_user_id: userId, p_amount: amount });
  if (error) throw error;
};

// ============================================================
// GET VENDOR'S SUB-ORDERS
// @route GET /api/sub-orders/vendor
// ============================================================
const getVendorSubOrders = async (req, res) => {
  try {
    const { data: vendor } = await adminClient
      .from("vendors")
      .select("id")
      .eq("user_id", req.user.id)
      .single();

    if (!vendor) {
      return res.status(404).json({ success: false, message: "Vendor profile not found." });
    }

    const { data, error } = await adminClient
      .from("sub_orders")
      .select("*, order_items(*, products(name, images))")
      .eq("vendor_id", vendor.id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json({ success: true, sub_orders: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================
// GET RIDER'S ACTIVE SUB-ORDERS
// @route GET /api/sub-orders/rider
// ============================================================
const getRiderSubOrders = async (req, res) => {
  try {
    const { data: rider } = await adminClient
      .from("riders")
      .select("id")
      .eq("user_id", req.user.id)
      .single();

    if (!rider) {
      return res.status(404).json({ success: false, message: "Rider profile not found." });
    }

    const { data, error } = await adminClient
      .from("sub_orders")
      .select("*, vendors(business_name, address, location_lat, location_lng), order_items(*, products(name)), orders(users(phone))")
      .eq("rider_id", rider.id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json({ success: true, sub_orders: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================
// RIDER ACCEPTS A SUB-ORDER
// @route POST /api/sub-orders/:subOrderId/accept
// ============================================================
const riderAcceptSubOrder = async (req, res) => {
  try {
    const { data: rider } = await adminClient
      .from("riders")
      .select("id, status, is_active")
      .eq("user_id", req.user.id)
      .single();

    if (!rider || rider.status !== "approved" || !rider.is_active) {
      return res.status(403).json({ success: false, message: "You are not available to accept orders." });
    }

    const { data: subOrder } = await adminClient
      .from("sub_orders")
      .select("id, status, rider_id, delivery_type")
      .eq("id", req.params.subOrderId)
      .single();

    if (!subOrder) {
      return res.status(404).json({ success: false, message: "Sub-order not found." });
    }

    if (subOrder.delivery_type === "pickup") {
      return res.status(400).json({ success: false, message: "This order is a pickup — no rider needed." });
    }

    if (subOrder.rider_id) {
      return res.status(400).json({ success: false, message: "This order has already been taken by another rider." });
    }

    if (subOrder.status !== STATUSES.WAITING_RIDER) {
      return res.status(400).json({ success: false, message: "This order is not available for pickup." });
    }

    // Atomic assignment — prevent race condition
    const { data: updated, error } = await adminClient
      .from("sub_orders")
      .update({ rider_id: rider.id, status: STATUSES.RIDER_ASSIGNED })
      .eq("id", req.params.subOrderId)
      .eq("status", STATUSES.WAITING_RIDER) // Double check
      .is("rider_id", null)                  // Double check
      .select()
      .single();

    if (error || !updated) {
      return res.status(400).json({ success: false, message: "Order was just taken by another rider." });
    }

    // Notify vendor
    await adminClient.from("notifications").insert({
      id: uuidv4(),
      user_id: updated.vendor_id,
      title: "Rider Assigned",
      body: "A rider has been assigned to your order and is on the way.",
      is_read: false,
    });

    res.json({ success: true, message: "Order accepted. Head to the vendor.", sub_order: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  createOrderWithSubOrders,
  getOrderWithSubOrders,
  updateSubOrderStatus,
  cancelSubOrder,
  getVendorSubOrders,
  getRiderSubOrders,
  riderAcceptSubOrder,
  releaseInventory,
  confirmInventory,
};
