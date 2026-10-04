const express = require("express");
const router = express.Router();
const { searchProducts, searchVendors, getCategories, getHomepageData } = require("../controllers/searchController");
const { protect } = require("../middleware/auth");

router.get("/products", searchProducts);
router.get("/vendors", searchVendors);
router.get("/categories", getCategories);
router.get("/homepage", getHomepageData);

module.exports = router;
