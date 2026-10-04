// Canonical Medimoove healthcare categories.
// Keep the legacy export name for compatibility with any older imports.
const FIDELX_CATEGORIES = [
  "Medicines & Pharmacy",
  "Medical Supplies",
  "Diagnostic & Laboratory",
  "Medical Equipment",
  "Surgical & Clinical",
  "PPE & Infection Control",
  "Healthcare Consumables",
  "Other Healthcare Supplies",
];

const normalizeCategory = (value) => String(value || "").trim();

const isValidCategory = (value) =>
  FIDELX_CATEGORIES.includes(normalizeCategory(value));

module.exports = { FIDELX_CATEGORIES, normalizeCategory, isValidCategory };
