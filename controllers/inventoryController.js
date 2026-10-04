const { adminClient } = require("../config/db");
const { v4: uuidv4 } = require("uuid");

// ============================================================
// ATOMIC RESERVE INVENTORY
// Uses a single UPDATE with WHERE guard to prevent overselling
// under concurrent requests
// If two requests arrive simultaneously, only one succeeds
// ============================================================
const reserveInventoryAtomic = async (items, orderId) => {
  const reservations = [];

  for (const item of items) {
    // Atomic update: only succeeds if enough stock is available
    // This prevents race conditions — no separate read then write
    const { data: updated, error } = await adminClient.rpc(
      "atomic_reserve_stock",
      {
        p_product_id: item.product_id,
        p_quantity: item.quantity,
      }
    );

    if (error || !updated) {
      // Rollback all previous reservations in this batch
      await rollbackReservations(reservations);
      throw new Error(
        `Not enough stock for product ${item.product_id}. Another order may have just taken the last unit.`
      );
    }

    // Handle variant stock atomically too
    if (item.variant_id) {
      const { data: variantUpdated, error: variantError } = await adminClient.rpc(
        "atomic_reserve_variant_stock",
        {
          p_variant_id: item.variant_id,
          p_quantity: item.quantity,
        }
      );

      if (variantError || !variantUpdated) {
        // Rollback product reservation we just made
        await adminClient.rpc("release_product_stock", {
          p_product_id: item.product_id,
          p_quantity: item.quantity,
        });
        await rollbackReservations(reservations);
        throw new Error(`Not enough stock for this variant.`);
      }
    }

    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 15);

    const reservation = {
      id: uuidv4(),
      product_id: item.product_id,
      variant_id: item.variant_id || null,
      order_id: orderId,
      quantity: item.quantity,
      status: "reserved",
      expires_at: expiresAt.toISOString(),
    };

    await adminClient.from("inventory_reservations").insert(reservation);
    reservations.push(reservation);
  }

  return reservations;
};

// ============================================================
// ROLLBACK RESERVATIONS
// Called if any item in the batch fails — releases all reserved
// ============================================================
const rollbackReservations = async (reservations) => {
  for (const res of reservations) {
    await adminClient.rpc("release_product_stock", {
      p_product_id: res.product_id,
      p_quantity: res.quantity,
    });

    if (res.variant_id) {
      await adminClient.rpc("release_variant_stock", {
        p_variant_id: res.variant_id,
        p_quantity: res.quantity,
      });
    }

    await adminClient
      .from("inventory_reservations")
      .update({ status: "released" })
      .eq("id", res.id);
  }
};

// ============================================================
// RELEASE INVENTORY
// Called on cancellation
// ============================================================
const releaseInventory = async (orderId) => {
  const { data: reservations } = await adminClient
    .from("inventory_reservations")
    .select("*")
    .eq("order_id", orderId)
    .eq("status", "reserved");

  if (!reservations || reservations.length === 0) return;

  await rollbackReservations(reservations);
};

// ============================================================
// CONFIRM INVENTORY
// Called after payment — deducts actual stock
// ============================================================
const confirmInventory = async (orderId) => {
  const { data: reservations } = await adminClient
    .from("inventory_reservations")
    .select("*")
    .eq("order_id", orderId)
    .eq("status", "reserved");

  if (!reservations) return;

  for (const res of reservations) {
    // Deduct actual stock atomically
    await adminClient.rpc("confirm_product_stock", {
      p_product_id: res.product_id,
      p_quantity: res.quantity,
    });

    if (res.variant_id) {
      await adminClient.rpc("confirm_variant_stock", {
        p_variant_id: res.variant_id,
        p_quantity: res.quantity,
      });
    }

    await adminClient
      .from("inventory_reservations")
      .update({ status: "confirmed" })
      .eq("id", res.id);
  }
};

module.exports = {
  reserveInventoryAtomic,
  releaseInventory,
  confirmInventory,
  rollbackReservations,
};
