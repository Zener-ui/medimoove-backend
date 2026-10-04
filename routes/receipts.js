const express = require("express");
const router = express.Router();
const { getMyReceipts, getReceiptById, getReceiptPdf, getReceiptByReference } = require("../controllers/receiptController");
const { protect } = require("../middleware/auth");

router.get("/", protect, getMyReceipts);
router.get("/by-reference/:referenceId", protect, getReceiptByReference);
router.get("/:id/pdf", protect, getReceiptPdf);
router.get("/:id", protect, getReceiptById);

module.exports = router;
