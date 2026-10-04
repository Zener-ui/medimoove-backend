// ============================================================
// CARTMOOVE ORDER STATE MACHINE
// Only valid transitions are allowed
// ============================================================

const STATUSES = {
  PENDING_PAYMENT: "PENDING_PAYMENT",
  PAYMENT_CONFIRMED: "PAYMENT_CONFIRMED",
  PREPARING: "PREPARING",
  READY_FOR_PICKUP: "READY_FOR_PICKUP",
  WAITING_RIDER: "WAITING_RIDER",
  RIDER_ASSIGNED: "RIDER_ASSIGNED",
  PICKED_UP: "PICKED_UP",
  DELIVERING: "DELIVERING",
  DELIVERED: "DELIVERED",
  DISPUTED: "DISPUTED",
  REFUNDED: "REFUNDED",
  CANCELLED: "CANCELLED",
  // Reached only by the payment reconciliation job (see
  // paymentReconciliation.js) when an order has sat unpaid past the
  // abandonment window with zero successful charges found across every
  // payment attempt tied to it. Stock is released same as CANCELLED.
  EXPIRED: "EXPIRED",
  // Reached only if the reconciliation job later discovers a genuinely
  // successful charge on an order that already expired — meaning the
  // customer WAS charged, but too much time has passed to safely send
  // the order to a vendor (food/stock may no longer be available). This
  // is never auto-resolved further; it's a flag for an admin to review
  // and refund, same treatment as a double-charge finding.
  FAILED_BUT_CHARGED: "FAILED_BUT_CHARGED",
};

// Map of valid transitions: currentStatus → [allowedNextStatuses]
//
// CANCELLED is only reachable from PENDING_PAYMENT and
// PAYMENT_CONFIRMED — i.e. before a vendor has actually started
// preparing the order. This used to also be reachable from
// WAITING_RIDER and RIDER_ASSIGNED, which meant a customer could
// cancel for free after the vendor had already cooked and packaged
// the order, and even after a rider had been assigned to pick it up
// — the vendor was left with wasted inventory and zero compensation.
// PREPARING is the explicit lock: once a vendor accepts an order,
// cancellation is no longer available through the app, matching the
// Terms of Service (see Section 3.2).
const VALID_TRANSITIONS = {
  PENDING_PAYMENT:   ["PAYMENT_CONFIRMED", "CANCELLED", "EXPIRED"],
  PAYMENT_CONFIRMED: ["PREPARING", "CANCELLED"],
  PREPARING:         ["READY_FOR_PICKUP", "WAITING_RIDER"],
  READY_FOR_PICKUP:  ["WAITING_RIDER", "DELIVERED"],
  WAITING_RIDER:     ["RIDER_ASSIGNED"],
  RIDER_ASSIGNED:    ["PICKED_UP", "WAITING_RIDER"],
  PICKED_UP:         ["DELIVERING"],
  DELIVERING:        ["DELIVERED", "DISPUTED"],
  DELIVERED:         ["DISPUTED"],
  DISPUTED:          ["REFUNDED", "DELIVERED"],
  REFUNDED:          [],
  CANCELLED:         [],
  EXPIRED:           ["FAILED_BUT_CHARGED"],
  FAILED_BUT_CHARGED: [],
};

// Who can trigger which transitions
const ROLE_PERMISSIONS = {
  PAYMENT_CONFIRMED: ["admin", "system"],
  PREPARING:         ["vendor", "admin"],
  READY_FOR_PICKUP:  ["vendor", "admin"],
  WAITING_RIDER:     ["vendor", "system", "admin"],
  RIDER_ASSIGNED:    ["system", "admin"],
  PICKED_UP:         ["rider", "admin"],
  DELIVERING:        ["rider", "admin"],
  DELIVERED:         ["rider", "customer", "vendor", "admin", "system"],
  DISPUTED:          ["customer", "admin"],
  REFUNDED:          ["admin"],
  CANCELLED:         ["customer", "vendor", "admin", "system"],
  EXPIRED:           ["system"],
  FAILED_BUT_CHARGED: ["system"],
};

const canTransition = (currentStatus, nextStatus) => {
  const allowed = VALID_TRANSITIONS[currentStatus] || [];
  return allowed.includes(nextStatus);
};

const isRoleAllowed = (nextStatus, role) => {
  const allowed = ROLE_PERMISSIONS[nextStatus] || [];
  return allowed.includes(role);
};

const validateTransition = (currentStatus, nextStatus, role) => {
  if (!canTransition(currentStatus, nextStatus)) {
    return {
      valid: false,
      message: `Cannot transition from ${currentStatus} to ${nextStatus}.`,
    };
  }

  if (!isRoleAllowed(nextStatus, role)) {
    return {
      valid: false,
      message: `Your role (${role}) cannot set status to ${nextStatus}.`,
    };
  }

  return { valid: true };
};

module.exports = { STATUSES, VALID_TRANSITIONS, validateTransition, canTransition };
