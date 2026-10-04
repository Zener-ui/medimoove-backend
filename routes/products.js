const express = require("express");
const router = express.Router();
const {
  getMyProducts, getAllProducts, getProductById, createProduct, updateProduct, deleteProduct,
} = require("../controllers/productController");
const { protect } = require("../middleware/auth");
const { roles } = require("../middleware/roles");
const { requireApprovedVendor } = require("../middleware/approval");

router.get("/", getAllProducts);
router.get("/mine", protect, roles("vendor"), requireApprovedVendor, getMyProducts);
router.get("/:id", getProductById);
router.post("/", protect, roles("vendor"), requireApprovedVendor, createProduct);
router.put("/:id", protect, roles("vendor"), requireApprovedVendor, updateProduct);
router.delete("/:id", protect, roles("vendor"), requireApprovedVendor, deleteProduct);

module.exports = router;
